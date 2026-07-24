/**
 * REST client — pure `fetch`, no browser. Talks to Day One's sync API with
 * a 32-char bearer token. Ciphertext in; decryption is crypto.ts + d1.ts.
 *
 * Auth: every request needs `authorization: <token>` plus `x-user-agent` and
 * `device-info` (a cookie alone → 403). The token is minted by a plain
 * `POST /api/v3/users/login {email,password}` — no OAuth, no browser — so the
 * client can self-authenticate from env and auto-renew on 401.
 *
 * Env: DAYONE_API_TOKEN (or DAYONE_EMAIL + DAYONE_PASSWORD), DAYONE_X_USER_AGENT,
 * DAYONE_DEVICE_INFO, DAYONE_HTTP_TIMEOUT_MS. Secrets are read from env or their
 * `_FILE` companion and never logged.
 */

import { ApiError, AuthError, ConfigError } from "../../errors.ts";
import { readSecret } from "../../secret-config.ts";

export interface Credentials {
  email: string;
  password: string;
}

export interface DayOneApiConfig {
  /** A current bearer token; optional if `credentials` are given (then it's minted). */
  token?: string;
  xUserAgent: string;
  deviceInfo: string;
  /** If present, the client mints/renews the token itself (headless). */
  credentials?: Credentials;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

/** A plausible web-client user-agent; overridable via DAYONE_X_USER_AGENT. */
const DEFAULT_X_USER_AGENT = "DayOneWeb/2026.15 (en-US; dayone-headless; Server; Release/1; Core/1.0.0)";
export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const MIN_HTTP_TIMEOUT_MS = 1_000;
const MAX_HTTP_TIMEOUT_MS = 300_000;
const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * Hard decoded-body limits for upstream responses. Timeouts and worker pools
 * bound duration/concurrency; these caps separately bound aggregation memory
 * even when an upstream responds very quickly or lies about Content-Length.
 */
export const UPSTREAM_RESPONSE_LIMITS = {
  login: 64 * KIB,
  journalManifest: 4 * MIB,
  entriesFeed: 32 * MIB,
  entry: 4 * MIB,
  attachment: 64 * MIB,
  userKey: 4 * MIB,
} as const;
export const MAX_JOURNALS_PER_SYNC = 1_024;
export const MAX_FEED_ITEMS_PER_JOURNAL = 25_000;

export class UpstreamResponseLimitError extends ApiError {
  override name = "UpstreamResponseLimitError";

  constructor(kind: keyof typeof UPSTREAM_RESPONSE_LIMITS, maximumBytes: number) {
    super(`upstream ${kind} response exceeded the ${maximumBytes}-byte safety limit`);
  }
}

/**
 * Consume a response stream with an exact decoded-byte ceiling. Never call
 * text(), json(), or arrayBuffer() first: those APIs aggregate without a cap.
 */
export async function readUpstreamBytes(
  response: Response,
  kind: keyof typeof UPSTREAM_RESPONSE_LIMITS,
): Promise<Uint8Array> {
  const maximumBytes = UPSTREAM_RESPONSE_LIMITS[kind];
  const declaredLength = declaredResponseLength(response);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    throw new UpstreamResponseLimitError(kind, maximumBytes);
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new UpstreamResponseLimitError(kind, maximumBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readUpstreamText(
  response: Response,
  kind: keyof typeof UPSTREAM_RESPONSE_LIMITS,
): Promise<string> {
  return new TextDecoder().decode(await readUpstreamBytes(response, kind));
}

async function readUpstreamJson<T>(
  response: Response,
  kind: keyof typeof UPSTREAM_RESPONSE_LIMITS,
): Promise<T> {
  return JSON.parse(await readUpstreamText(response, kind)) as T;
}

function declaredResponseLength(response: Response): number | null {
  const value = response.headers.get("content-length");
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

const randomHex = (n: number): string =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Build the `device-info` header. `Id` is the client-generated device identity;
 * pin it via DAYONE_DEVICE_ID so repeat runs are the SAME device (not a new one). */
export function buildDeviceInfo(id: string): string {
  return `Id="${id}"; Model="dayone-headless"; Name="dayone-headless"; Language="en-US"; Country="US"; app_id="com.bloombuilt.dayone-web"`;
}

/**
 * Self-contained config from env — a real deployment only needs credentials:
 *   DAYONE_ENCRYPTION_KEY (for decryption, read elsewhere) + auth below.
 * Auth: DAYONE_API_TOKEN, or DAYONE_EMAIL + DAYONE_PASSWORD (self-minted).
 * Optional: DAYONE_DEVICE_ID (pin the device), DAYONE_X_USER_AGENT/DEVICE_INFO.
 */
function httpTimeoutFromEnv(value: string | undefined): number {
  if (value === undefined) return DEFAULT_HTTP_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_HTTP_TIMEOUT_MS || parsed > MAX_HTTP_TIMEOUT_MS) {
    throw new ConfigError(
      `DAYONE_HTTP_TIMEOUT_MS must be an integer from ${MIN_HTTP_TIMEOUT_MS} to ${MAX_HTTP_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

export function apiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DayOneApiConfig {
  const token = readSecret("DAYONE_API_TOKEN", env);
  const email = readSecret("DAYONE_EMAIL", env);
  const password = readSecret("DAYONE_PASSWORD", env);
  if (!token && !(email && password)) {
    throw new ConfigError("provide DAYONE_API_TOKEN, or DAYONE_EMAIL + DAYONE_PASSWORD to mint one");
  }
  const xUserAgent = env.DAYONE_X_USER_AGENT || DEFAULT_X_USER_AGENT;
  const deviceInfo = env.DAYONE_DEVICE_INFO || buildDeviceInfo(env.DAYONE_DEVICE_ID || randomHex(16));
  return {
    token,
    xUserAgent,
    deviceInfo,
    credentials: email && password ? { email, password } : undefined,
    requestTimeoutMs: httpTimeoutFromEnv(env.DAYONE_HTTP_TIMEOUT_MS),
  };
}

/**
 * Mint a fresh 32-char API token from email + password.
 * `POST /api/v3/users/login {email,password}` → `{token, user, …}`. No 2FA on the
 * password path; renewal is just calling this again.
 */
export async function login(
  creds: Credentials,
  opts: {
    baseUrl?: string;
    xUserAgent?: string;
    deviceInfo?: string;
    requestTimeoutMs?: number;
  } = {},
): Promise<string> {
  const r = await fetch(`${opts.baseUrl ?? "https://dayone.me"}/api/v3/users/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.xUserAgent ? { "x-user-agent": opts.xUserAgent } : {}),
      ...(opts.deviceInfo ? { "device-info": opts.deviceInfo } : {}),
    },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
    signal: AbortSignal.timeout(opts.requestTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
  });
  if (!r.ok) throw new AuthError(`login failed: ${r.status} — check DAYONE_EMAIL / DAYONE_PASSWORD`);
  const j = await readUpstreamJson<{ token?: string }>(r, "login");
  if (!j.token) throw new AuthError("login response had no token");
  return j.token;
}

export interface FeedItem {
  cursor: number;
  revision: {
    entryId: string; // 32-hex — the JSON-export uuid
    journalId: string;
    revisionId: number; // bumps on every edit — the incremental-sync key
    editDate: number;
    saveDate: number;
    moments: unknown[];
    deletionRequested: number | null;
    [k: string]: unknown;
  };
  contentLength: number;
  encrypted: boolean;
}

function decodeLine(chunks: readonly Uint8Array[], byteLength: number): string {
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const line = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    line.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(line);
}

/**
 * Parse the entries feed in one streaming pass.
 *
 * The feed is NOT plain NDJSON: it is length-delimited. Each record is a JSON
 * header line, then `\n`, then `contentLength` bytes of the entry's BINARY D1
 * content — and that binary contains 0x0a bytes of its own. Splitting on 0x0a
 * therefore shreds every inline blob into many non-JSON fragments. Those
 * fragments carry no feed item, so they are skipped (never fatal); only lines
 * that parse into a real feed item (with `revision.entryId`) are kept and count
 * toward the item budget. The inline binary is intentionally discarded here —
 * entry content is re-fetched per entry via `getEntryContent`.
 */
export async function readEntriesFeed(response: Response): Promise<FeedItem[]> {
  const maximumBytes = UPSTREAM_RESPONSE_LIMITS.entriesFeed;
  const declaredLength = declaredResponseLength(response);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    throw new UpstreamResponseLimitError("entriesFeed", maximumBytes);
  }
  if (!response.body) return [];

  const reader = response.body.getReader();
  const items: FeedItem[] = [];
  let totalBytes = 0;
  let lineCount = 0;
  let lineBytes = 0;
  let lineChunks: Uint8Array[] = [];

  const consumeLine = (): void => {
    const line = decodeLine(lineChunks, lineBytes).trim();
    lineChunks = [];
    lineBytes = 0;
    if (!line) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A fragment of inline binary D1 content, not a JSON header line. Skip it;
      // it carries no feed item and is fetched per entry elsewhere.
      return;
    }
    const candidate = parsed as Partial<FeedItem> | null;
    if (!candidate?.revision?.entryId) return;

    lineCount++;
    if (lineCount > MAX_FEED_ITEMS_PER_JOURNAL) {
      throw new ApiError(
        `upstream entries feed exceeded the ${MAX_FEED_ITEMS_PER_JOURNAL}-item safety limit`,
      );
    }
    items.push(candidate as FeedItem);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new UpstreamResponseLimitError("entriesFeed", maximumBytes);
      }

      let start = 0;
      while (start < value.byteLength) {
        const newline = value.indexOf(0x0a, start);
        const end = newline < 0 ? value.byteLength : newline;
        if (end > start) {
          const segment = value.subarray(start, end);
          lineChunks.push(segment);
          lineBytes += segment.byteLength;
        }
        if (newline < 0) break;
        consumeLine();
        start = newline + 1;
      }
    }
    if (lineBytes > 0) consumeLine();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return items;
}

export class DayOneApi {
  constructor(private cfg: DayOneApiConfig) {}

  private headers(): Record<string, string> {
    if (!this.cfg.token) throw new Error("no token (call ensureToken first)");
    return {
      authorization: this.cfg.token,
      "x-user-agent": this.cfg.xUserAgent,
      "device-info": this.cfg.deviceInfo,
    };
  }
  private url(path: string): string {
    return `${this.cfg.baseUrl ?? "https://dayone.me"}${path}`;
  }
  private async fetchPath(path: string): Promise<Response> {
    try {
      return await fetch(this.url(path), {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError("upstream request failed");
    }
  }

  /** Mint a token from credentials if we don't have one yet. */
  async ensureToken(): Promise<void> {
    if (!this.cfg.token) this.cfg.token = await this.renew();
  }
  private renew(): Promise<string> {
    if (!this.cfg.credentials)
      throw new AuthError("token expired and no DAYONE_EMAIL/PASSWORD (or DAYONE_API_TOKEN) to renew");
    return login(this.cfg.credentials, {
      baseUrl: this.cfg.baseUrl,
      xUserAgent: this.cfg.xUserAgent,
      deviceInfo: this.cfg.deviceInfo,
      requestTimeoutMs: this.cfg.requestTimeoutMs,
    });
  }

  /** Fetch with one automatic token-renewal + retry on 401 (if credentials are set). */
  private async req(path: string): Promise<Response> {
    await this.ensureToken();
    let res = await this.fetchPath(path);
    if (res.status === 401 && this.cfg.credentials) {
      this.cfg.token = await this.renew();
      res = await this.fetchPath(path);
    }
    return res;
  }

  async getJournals(): Promise<any[]> {
    const r = await this.req("/api/v6/sync/journals");
    if (!r.ok) throw new ApiError(`GET /api/v6/sync/journals → ${r.status}`, r.status);
    const journals = await readUpstreamJson<any[]>(r, "journalManifest");
    if (!Array.isArray(journals) || journals.length > MAX_JOURNALS_PER_SYNC) {
      throw new ApiError(
        `upstream journal manifest exceeded the ${MAX_JOURNALS_PER_SYNC}-journal safety limit`,
      );
    }
    return journals;
  }

  /** Entries feed (NDJSON-ish: one JSON object per line; some lines may be framing). */
  async getEntriesFeed(journalId: string): Promise<FeedItem[]> {
    const r = await this.req(`/api/v2/sync/entries/${journalId}/feed`);
    if (!r.ok) throw new ApiError(`GET entries feed → ${r.status}`, r.status);
    return readEntriesFeed(r);
  }

  /** Per-entry encrypted blob: `<JSON header>` ‖ `\n` ‖ D1 ciphertext. */
  async getEntryContent(journalId: string, entryId: string): Promise<Uint8Array> {
    const r = await this.req(`/api/v2/sync/entries/${journalId}/${entryId}`);
    if (!r.ok) throw new ApiError(`GET entry content → ${r.status}`, r.status);
    return readUpstreamBytes(r, "entry");
  }

  /**
   * Download one attachment's ENCRYPTED blob. The endpoint 307-redirects to the
   * ciphertext on S3 (`vnd/day-one-encrypted`); `fetch` follows the redirect. The
   * bytes are a D1 envelope — decrypt with `decryptAttachment` (media.ts).
   * `attachmentId` is the moment/media `identifier`.
   */
  async getAttachment(journalId: string, attachmentId: string): Promise<Uint8Array> {
    const r = await this.req(`/api/journals/${journalId}/attachments/${attachmentId}/download`);
    if (!r.ok) throw new ApiError(`GET attachment → ${r.status}`, r.status);
    return readUpstreamBytes(r, "attachment");
  }

  /** The passphrase-wrapped user key material (for the full passphrase decrypt path). */
  async getUserKey(): Promise<{ publicKey: string; encryptedPrivateKey: string; fingerprint: string }> {
    const r = await this.req("/api/users/key");
    if (!r.ok) throw new ApiError(`GET /api/users/key → ${r.status}`, r.status);
    return readUpstreamJson(r, "userKey");
  }
}
