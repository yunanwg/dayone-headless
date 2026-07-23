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
 * DAYONE_DEVICE_INFO. Secrets are read from env and never logged.
 */

import { ApiError, AuthError, ConfigError } from "../../errors.ts";

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
}

/** A plausible web-client user-agent; overridable via DAYONE_X_USER_AGENT. */
const DEFAULT_X_USER_AGENT = "DayOneWeb/2026.15 (en-US; dayone-headless; Server; Release/1; Core/1.0.0)";

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
export function apiConfigFromEnv(): DayOneApiConfig {
  const token = process.env.DAYONE_API_TOKEN;
  const email = process.env.DAYONE_EMAIL;
  const password = process.env.DAYONE_PASSWORD;
  if (!token && !(email && password)) {
    throw new ConfigError("provide DAYONE_API_TOKEN, or DAYONE_EMAIL + DAYONE_PASSWORD to mint one");
  }
  const xUserAgent = process.env.DAYONE_X_USER_AGENT || DEFAULT_X_USER_AGENT;
  const deviceInfo =
    process.env.DAYONE_DEVICE_INFO || buildDeviceInfo(process.env.DAYONE_DEVICE_ID || randomHex(16));
  return { token, xUserAgent, deviceInfo, credentials: email && password ? { email, password } : undefined };
}

/**
 * Mint a fresh 32-char API token from email + password.
 * `POST /api/v3/users/login {email,password}` → `{token, user, …}`. No 2FA on the
 * password path; renewal is just calling this again.
 */
export async function login(
  creds: Credentials,
  opts: { baseUrl?: string; xUserAgent?: string; deviceInfo?: string } = {},
): Promise<string> {
  const r = await fetch(`${opts.baseUrl ?? "https://dayone.me"}/api/v3/users/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.xUserAgent ? { "x-user-agent": opts.xUserAgent } : {}),
      ...(opts.deviceInfo ? { "device-info": opts.deviceInfo } : {}),
    },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (!r.ok) throw new AuthError(`login failed: ${r.status} — check DAYONE_EMAIL / DAYONE_PASSWORD`);
  const j = (await r.json()) as { token?: string };
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
    });
  }

  /** Fetch with one automatic token-renewal + retry on 401 (if credentials are set). */
  private async req(path: string): Promise<Response> {
    await this.ensureToken();
    let res = await fetch(this.url(path), { headers: this.headers() });
    if (res.status === 401 && this.cfg.credentials) {
      this.cfg.token = await this.renew();
      res = await fetch(this.url(path), { headers: this.headers() });
    }
    return res;
  }

  async getJournals(): Promise<any[]> {
    const r = await this.req("/api/v6/sync/journals");
    if (!r.ok) throw new ApiError(`GET /api/v6/sync/journals → ${r.status}`, r.status);
    return r.json();
  }

  /** Entries feed (NDJSON-ish: one JSON object per line; some lines may be framing). */
  async getEntriesFeed(journalId: string): Promise<FeedItem[]> {
    const r = await this.req(`/api/v2/sync/entries/${journalId}/feed`);
    if (!r.ok) throw new ApiError(`GET .../entries/${journalId}/feed → ${r.status}`, r.status);
    return (await r.text())
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as FeedItem;
        } catch {
          return null;
        }
      })
      .filter((x): x is FeedItem => x !== null && !!x.revision?.entryId);
  }

  /** Per-entry encrypted blob: `<JSON header>` ‖ `\n` ‖ D1 ciphertext. */
  async getEntryContent(journalId: string, entryId: string): Promise<Uint8Array> {
    const r = await this.req(`/api/v2/sync/entries/${journalId}/${entryId}`);
    if (!r.ok) throw new ApiError(`GET entry ${entryId} → ${r.status}`, r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  /**
   * Download one attachment's ENCRYPTED blob. The endpoint 307-redirects to the
   * ciphertext on S3 (`vnd/day-one-encrypted`); `fetch` follows the redirect. The
   * bytes are a D1 envelope — decrypt with `decryptAttachment` (media.ts).
   * `attachmentId` is the moment/media `identifier`.
   */
  async getAttachment(journalId: string, attachmentId: string): Promise<Uint8Array> {
    const r = await this.req(`/api/journals/${journalId}/attachments/${attachmentId}/download`);
    if (!r.ok) throw new ApiError(`GET attachment ${attachmentId} → ${r.status}`, r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** The passphrase-wrapped user key material (for the full passphrase decrypt path). */
  async getUserKey(): Promise<{ publicKey: string; encryptedPrivateKey: string; fingerprint: string }> {
    const r = await this.req("/api/users/key");
    if (!r.ok) throw new ApiError(`GET /api/users/key → ${r.status}`, r.status);
    return r.json();
  }
}
