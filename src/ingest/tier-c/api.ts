/**
 * Tier C REST client — pure `fetch`, no browser. Talks to Day One's sync API with
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

export function apiConfigFromEnv(): DayOneApiConfig {
  const token = process.env.DAYONE_API_TOKEN;
  const email = process.env.DAYONE_EMAIL;
  const password = process.env.DAYONE_PASSWORD;
  const xUserAgent = process.env.DAYONE_X_USER_AGENT;
  const deviceInfo = process.env.DAYONE_DEVICE_INFO;
  if (!xUserAgent || !deviceInfo) throw new Error("missing DAYONE_X_USER_AGENT / DAYONE_DEVICE_INFO");
  if (!token && !(email && password)) {
    throw new Error("provide DAYONE_API_TOKEN, or DAYONE_EMAIL + DAYONE_PASSWORD to mint one");
  }
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
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const j = (await r.json()) as { token?: string };
  if (!j.token) throw new Error("login response had no token");
  return j.token;
}

export interface FeedItem {
  cursor: number;
  revision: {
    entryId: string; // 32-hex — the JSON-export uuid
    journalId: string;
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
    if (!this.cfg.credentials) throw new Error("token missing/expired and no credentials to renew");
    return login(this.cfg.credentials, { baseUrl: this.cfg.baseUrl, xUserAgent: this.cfg.xUserAgent, deviceInfo: this.cfg.deviceInfo });
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
    if (!r.ok) throw new Error(`journals ${r.status}`);
    return r.json();
  }

  /** Entries feed (NDJSON-ish: one JSON object per line; some lines may be framing). */
  async getEntriesFeed(journalId: string): Promise<FeedItem[]> {
    const r = await this.req(`/api/v2/sync/entries/${journalId}/feed`);
    if (!r.ok) throw new Error(`feed ${r.status}`);
    return (await r.text())
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as FeedItem; } catch { return null; } })
      .filter((x): x is FeedItem => x !== null && !!x.revision?.entryId);
  }

  /** Per-entry encrypted blob: `<JSON header>` ‖ `\n` ‖ D1 ciphertext. */
  async getEntryContent(journalId: string, entryId: string): Promise<Uint8Array> {
    const r = await this.req(`/api/v2/sync/entries/${journalId}/${entryId}`);
    if (!r.ok) throw new Error(`entry ${entryId} ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** The passphrase-wrapped user key material (for the full passphrase decrypt path). */
  async getUserKey(): Promise<{ publicKey: string; encryptedPrivateKey: string; fingerprint: string }> {
    const r = await this.req("/api/users/key");
    if (!r.ok) throw new Error(`users/key ${r.status}`);
    return r.json();
  }
}
