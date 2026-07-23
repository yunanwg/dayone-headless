/**
 * REST client for Day One's private sync API.
 *
 * Every outbound operation is time-bounded. Only idempotent GETs receive a
 * finite retry budget; login POSTs are never automatically replayed.
 */

import { ApiError, AuthError, ConfigError } from "../../errors.ts";
import { readSecret } from "../../secret-config.ts";

export interface Credentials {
  email: string;
  password: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const DEFAULT_GET_RETRIES = 2;
export const DEFAULT_INFLIGHT_RESPONSE_BYTES = 256 * 1024 * 1024;
export const MAX_JOURNALS = 1_024;
export const MAX_ENTRY_FEED_ITEMS = 25_000;
export const ENDPOINT_BODY_LIMITS = {
  login: 64 * 1024,
  userKey: 1 * 1024 * 1024,
  journals: 4 * 1024 * 1024,
  entryFeed: 32 * 1024 * 1024,
  entryContent: 4 * 1024 * 1024,
  attachment: 64 * 1024 * 1024,
} as const;
export const MAX_JOURNALS_PER_SYNC = MAX_JOURNALS;
export const MAX_FEED_ITEMS_PER_JOURNAL = MAX_ENTRY_FEED_ITEMS;
export const UPSTREAM_RESPONSE_LIMITS = {
  login: ENDPOINT_BODY_LIMITS.login,
  journalManifest: ENDPOINT_BODY_LIMITS.journals,
  entriesFeed: ENDPOINT_BODY_LIMITS.entryFeed,
  entry: ENDPOINT_BODY_LIMITS.entryContent,
  attachment: ENDPOINT_BODY_LIMITS.attachment,
  userKey: ENDPOINT_BODY_LIMITS.userKey,
} as const;
const MAX_HTTP_TIMEOUT_MS = 300_000;
const MAX_GET_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const RETRYABLE_GET_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface DayOneApiConfig {
  token?: string;
  xUserAgent: string;
  deviceInfo: string;
  credentials?: Credentials;
  baseUrl?: string;
  timeoutMs?: number;
  /** Compatibility alias for callers introduced by the deployment hardening. */
  requestTimeoutMs?: number;
  getRetries?: number;
  retryBaseDelayMs?: number;
  /** Aggregate raw response budget; test/deployment seam, default 256 MiB. */
  maxInflightResponseBytes?: number;
  /** Synthetic test seam; production uses global fetch. */
  fetchImpl?: FetchLike;
}

export interface LoginOptions {
  baseUrl?: string;
  xUserAgent?: string;
  deviceInfo?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_X_USER_AGENT = "DayOneWeb/2026.15 (en-US; dayone-headless; Server; Release/1; Core/1.0.0)";

const randomHex = (n: number): string =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function buildDeviceInfo(id: string): string {
  return `Id="${id}"; Model="dayone-headless"; Name="dayone-headless"; Language="en-US"; Country="US"; app_id="com.bloombuilt.dayone-web"`;
}

function boundedEnvInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
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
  const timeoutMs = boundedEnvInteger(
    env.DAYONE_HTTP_TIMEOUT_MS,
    DEFAULT_HTTP_TIMEOUT_MS,
    1_000,
    MAX_HTTP_TIMEOUT_MS,
    "DAYONE_HTTP_TIMEOUT_MS",
  );
  return {
    token,
    xUserAgent,
    deviceInfo,
    credentials: email && password ? { email, password } : undefined,
    timeoutMs,
    requestTimeoutMs: timeoutMs,
    getRetries: boundedEnvInteger(
      env.DAYONE_HTTP_RETRIES,
      DEFAULT_GET_RETRIES,
      0,
      MAX_GET_RETRIES,
      "DAYONE_HTTP_RETRIES",
    ),
  };
}

class TransportFailure extends Error {
  constructor(readonly timedOut: boolean) {
    super(timedOut ? "timeout" : "network");
  }
}

export class UpstreamResponseLimitError extends Error {
  override name = "UpstreamResponseLimitError";
}

/** FIFO weighted semaphore used to bound aggregate concurrent response bodies. */
export class ByteBudget {
  private available: number;
  private readonly waiters: {
    weight: number;
    resolve: (release: () => void) => void;
  }[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new ConfigError("byte budget capacity must be a positive safe integer");
    }
    this.available = capacity;
  }

  async acquire(requestedWeight: number): Promise<() => void> {
    const weight = Math.min(this.capacity, Math.max(1, Math.ceil(requestedWeight)));
    if (this.waiters.length === 0 && weight <= this.available) {
      this.available -= weight;
      return this.releaseFor(weight);
    }
    return new Promise((resolve) => {
      this.waiters.push({ weight, resolve });
      this.drain();
    });
  }

  private releaseFor(weight: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available += weight;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters[0] && this.waiters[0].weight <= this.available) {
      const waiter = this.waiters.shift()!;
      this.available -= waiter.weight;
      waiter.resolve(this.releaseFor(waiter.weight));
    }
  }
}

function deadline(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new TransportFailure(true);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new TransportFailure(true));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Transport cleanup must never replace the stable public request error.
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers?.get("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes) {
      await discardResponseBody(response);
      throw new UpstreamResponseLimitError();
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new UpstreamResponseLimitError();
      }
      chunks.push(value);
      total += value.byteLength;
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

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readResponseBytes(response, maxBytes));
}

async function readResponseJson<T>(response: Response, maxBytes: number): Promise<T> {
  return JSON.parse(await readResponseText(response, maxBytes)) as T;
}

export function readUpstreamBytes(
  response: Response,
  kind: keyof typeof UPSTREAM_RESPONSE_LIMITS,
): Promise<Uint8Array> {
  return readResponseBytes(response, UPSTREAM_RESPONSE_LIMITS[kind]);
}

/** Login is deliberately single-attempt: a timed-out POST is never blindly replayed. */
export async function login(creds: Credentials, opts: LoginOptions = {}): Promise<string> {
  const timeoutMs = boundedInteger(
    opts.timeoutMs,
    DEFAULT_HTTP_TIMEOUT_MS,
    1,
    MAX_HTTP_TIMEOUT_MS,
    "login timeout",
  );
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const requestDeadline = deadline(timeoutMs);
  try {
    let response: Response;
    try {
      response = await beforeDeadline(
        fetchImpl(`${opts.baseUrl ?? "https://dayone.me"}/api/v3/users/login`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(opts.xUserAgent ? { "x-user-agent": opts.xUserAgent } : {}),
            ...(opts.deviceInfo ? { "device-info": opts.deviceInfo } : {}),
          },
          body: JSON.stringify({ email: creds.email, password: creds.password }),
          signal: requestDeadline.signal,
        }),
        requestDeadline.signal,
      );
    } catch {
      throw new AuthError(
        requestDeadline.signal.aborted ? "login request timed out" : "login request failed",
      );
    }
    if (!response.ok) {
      await discardResponseBody(response);
      throw new AuthError(`login failed (HTTP ${response.status}) — check DAYONE_EMAIL / DAYONE_PASSWORD`);
    }
    let json: unknown;
    try {
      json = await beforeDeadline(
        readResponseJson<unknown>(response, ENDPOINT_BODY_LIMITS.login),
        requestDeadline.signal,
      );
    } catch {
      throw new AuthError(
        requestDeadline.signal.aborted ? "login request timed out" : "login response was invalid",
      );
    }
    if (!isRecord(json) || typeof json.token !== "string" || json.token.length === 0) {
      throw new AuthError("login response had no token");
    }
    return json.token;
  } finally {
    requestDeadline.clear();
  }
}

export interface FeedItem {
  cursor: number;
  revision: {
    entryId: string;
    journalId: string;
    revisionId: number;
    editDate: number;
    saveDate: number;
    moments: unknown[];
    deletionRequested: number | null;
    [key: string]: unknown;
  };
  contentLength: number;
  encrypted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validatedFeedItem(value: unknown, expectedJournalId: string): FeedItem {
  if (!isRecord(value) || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0) {
    throw new ApiError("Day One entry feed response was invalid");
  }
  const revision = value.revision;
  if (
    !isRecord(revision) ||
    typeof revision.entryId !== "string" ||
    revision.entryId.length === 0 ||
    typeof revision.journalId !== "string" ||
    revision.journalId !== expectedJournalId ||
    typeof revision.revisionId !== "number" ||
    !Number.isFinite(revision.revisionId) ||
    typeof revision.editDate !== "number" ||
    !Number.isFinite(revision.editDate) ||
    typeof revision.saveDate !== "number" ||
    !Number.isFinite(revision.saveDate) ||
    !Array.isArray(revision.moments) ||
    (revision.deletionRequested !== null &&
      (typeof revision.deletionRequested !== "number" || !Number.isFinite(revision.deletionRequested))) ||
    !Number.isSafeInteger(value.contentLength) ||
    (value.contentLength as number) < 0 ||
    typeof value.encrypted !== "boolean"
  ) {
    throw new ApiError("Day One entry feed response was invalid");
  }
  return value as unknown as FeedItem;
}

function decodeLine(chunks: readonly Uint8Array[], byteLength: number): string {
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return new TextDecoder("utf-8", { fatal: true }).decode(chunks[0]);
  const line = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    line.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(line);
}

/**
 * Parse the feed in one bounded streaming pass. Every non-empty protocol line
 * consumes the cardinality budget before JSON parsing or result allocation.
 */
export async function readEntriesFeed(response: Response, expectedJournalId?: string): Promise<FeedItem[]> {
  const maximumBytes = ENDPOINT_BODY_LIMITS.entryFeed;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)) {
    await discardResponseBody(response);
    throw new UpstreamResponseLimitError();
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
    lineCount++;
    if (lineCount > MAX_ENTRY_FEED_ITEMS) {
      throw new ApiError(`upstream entries feed exceeded the ${MAX_ENTRY_FEED_ITEMS}-item safety limit`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ApiError(
        expectedJournalId === undefined
          ? "upstream entries feed contained malformed JSON"
          : "Day One entry feed response was invalid",
      );
    }
    if (!isRecord(parsed) || !("revision" in parsed)) return;
    if (expectedJournalId === undefined) {
      const candidate = parsed as Partial<FeedItem>;
      if (candidate.revision?.entryId) items.push(candidate as FeedItem);
      return;
    }
    items.push(validatedFeedItem(parsed, expectedJournalId));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) throw new UpstreamResponseLimitError();

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

type GetAttempt<T> = { kind: "ok"; value: T } | { kind: "status"; status: number };

export class DayOneApi {
  private readonly timeoutMs: number;
  private readonly getRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly responseBudget: ByteBudget;

  constructor(private cfg: DayOneApiConfig) {
    this.timeoutMs = boundedInteger(
      cfg.timeoutMs ?? cfg.requestTimeoutMs,
      DEFAULT_HTTP_TIMEOUT_MS,
      1,
      MAX_HTTP_TIMEOUT_MS,
      "HTTP timeout",
    );
    this.getRetries = boundedInteger(cfg.getRetries, DEFAULT_GET_RETRIES, 0, MAX_GET_RETRIES, "GET retries");
    this.retryBaseDelayMs = boundedInteger(
      cfg.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      0,
      30_000,
      "retry base delay",
    );
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
    this.responseBudget = new ByteBudget(
      boundedInteger(
        cfg.maxInflightResponseBytes,
        DEFAULT_INFLIGHT_RESPONSE_BYTES,
        1,
        Number.MAX_SAFE_INTEGER,
        "in-flight response byte budget",
      ),
    );
  }

  private headers(): Record<string, string> {
    if (!this.cfg.token) throw new AuthError("no API token available");
    return {
      authorization: this.cfg.token,
      "x-user-agent": this.cfg.xUserAgent,
      "device-info": this.cfg.deviceInfo,
    };
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl ?? "https://dayone.me"}${path}`;
  }

  async ensureToken(): Promise<void> {
    if (!this.cfg.token) this.cfg.token = await this.renew();
  }

  private renew(): Promise<string> {
    if (!this.cfg.credentials) {
      throw new AuthError("token expired and no DAYONE_EMAIL/PASSWORD (or DAYONE_API_TOKEN) to renew");
    }
    return login(this.cfg.credentials, {
      baseUrl: this.cfg.baseUrl,
      xUserAgent: this.cfg.xUserAgent,
      deviceInfo: this.cfg.deviceInfo,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  private async getAttempt<T>(
    path: string,
    label: string,
    consume: (response: Response) => Promise<T>,
  ): Promise<GetAttempt<T>> {
    const requestDeadline = deadline(this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await beforeDeadline(
          this.fetchImpl(this.url(path), {
            method: "GET",
            headers: this.headers(),
            signal: requestDeadline.signal,
          }),
          requestDeadline.signal,
        );
      } catch {
        throw new TransportFailure(requestDeadline.signal.aborted);
      }
      if (response.status === 401 || RETRYABLE_GET_STATUSES.has(response.status)) {
        await discardResponseBody(response);
        return { kind: "status", status: response.status };
      }
      if (!response.ok) {
        await discardResponseBody(response);
        throw new ApiError(`Day One ${label} request failed (HTTP ${response.status})`, response.status);
      }
      try {
        return {
          kind: "ok",
          value: await beforeDeadline(consume(response), requestDeadline.signal),
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (requestDeadline.signal.aborted) throw new TransportFailure(true);
        throw new ApiError(`Day One ${label} response was invalid`);
      }
    } finally {
      requestDeadline.clear();
    }
  }

  private async req<T>(
    path: string,
    label: string,
    maxResponseBytes: number,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    await this.ensureToken();
    const releaseBudget = await this.responseBudget.acquire(maxResponseBytes);
    let retries = 0;
    let renewed = false;
    try {
      while (true) {
        let attempt: GetAttempt<T>;
        try {
          attempt = await this.getAttempt(path, label, consume);
        } catch (error) {
          if (!(error instanceof TransportFailure)) throw error;
          if (retries < this.getRetries) {
            await Bun.sleep(this.retryBaseDelayMs * 2 ** retries);
            retries++;
            continue;
          }
          throw new ApiError(
            error.timedOut ? `Day One ${label} request timed out` : `Day One ${label} request failed`,
          );
        }
        if (attempt.kind === "ok") return attempt.value;
        if (attempt.status === 401 && this.cfg.credentials && !renewed) {
          this.cfg.token = await this.renew();
          renewed = true;
          retries = 0;
          continue;
        }
        if (RETRYABLE_GET_STATUSES.has(attempt.status) && retries < this.getRetries) {
          await Bun.sleep(this.retryBaseDelayMs * 2 ** retries);
          retries++;
          continue;
        }
        throw new ApiError(`Day One ${label} request failed (HTTP ${attempt.status})`, attempt.status);
      }
    } finally {
      releaseBudget();
    }
  }

  getJournals(): Promise<any[]> {
    return this.req("/api/v6/sync/journals", "journals", ENDPOINT_BODY_LIMITS.journals, async (response) => {
      const journals = await readResponseJson<unknown>(response, ENDPOINT_BODY_LIMITS.journals);
      if (!Array.isArray(journals) || journals.length > MAX_JOURNALS) {
        throw new ApiError("Day One journals response was invalid");
      }
      return journals;
    });
  }

  getEntriesFeed(journalId: string): Promise<FeedItem[]> {
    return this.req(
      `/api/v2/sync/entries/${journalId}/feed`,
      "GET entries feed",
      ENDPOINT_BODY_LIMITS.entryFeed,
      (response) => readEntriesFeed(response, journalId),
    );
  }

  getEntryContent(journalId: string, entryId: string): Promise<Uint8Array> {
    return this.req(
      `/api/v2/sync/entries/${journalId}/${entryId}`,
      "entry content",
      ENDPOINT_BODY_LIMITS.entryContent,
      (response) => readResponseBytes(response, ENDPOINT_BODY_LIMITS.entryContent),
    );
  }

  getAttachment(journalId: string, attachmentId: string): Promise<Uint8Array> {
    return this.req(
      `/api/journals/${journalId}/attachments/${attachmentId}/download`,
      "attachment",
      ENDPOINT_BODY_LIMITS.attachment,
      (response) => readResponseBytes(response, ENDPOINT_BODY_LIMITS.attachment),
    );
  }

  getUserKey(): Promise<{ publicKey: string; encryptedPrivateKey: string; fingerprint: string }> {
    return this.req("/api/users/key", "user key", ENDPOINT_BODY_LIMITS.userKey, (response) =>
      readResponseJson(response, ENDPOINT_BODY_LIMITS.userKey),
    );
  }
}
