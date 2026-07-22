/**
 * Tier C REST client — pure `fetch`, no browser. Talks to Day One's sync API with
 * an env-provided auth token. This is the browser-free data-access half of Tier C
 * (ciphertext in; decryption is crypto.ts). Validated end-to-end from Node.
 *
 * Auth: every request needs `authorization: <token>` plus `x-user-agent` and
 * `device-info` (a cookie alone → 403). These come from the environment; this
 * module never holds them at rest.
 *
 *   DAYONE_API_TOKEN, DAYONE_X_USER_AGENT, DAYONE_DEVICE_INFO
 */

export interface DayOneApiConfig {
  token: string;
  xUserAgent: string;
  deviceInfo: string;
  baseUrl?: string;
}

export function apiConfigFromEnv(): DayOneApiConfig {
  const token = process.env.DAYONE_API_TOKEN;
  const xUserAgent = process.env.DAYONE_X_USER_AGENT;
  const deviceInfo = process.env.DAYONE_DEVICE_INFO;
  if (!token || !xUserAgent || !deviceInfo) {
    throw new Error("missing DAYONE_API_TOKEN / DAYONE_X_USER_AGENT / DAYONE_DEVICE_INFO");
  }
  return { token, xUserAgent, deviceInfo };
}

/** One feed record: entry revision metadata + how much encrypted content exists. */
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
  constructor(private readonly cfg: DayOneApiConfig) {}

  private headers(): Record<string, string> {
    return {
      authorization: this.cfg.token,
      "x-user-agent": this.cfg.xUserAgent,
      "device-info": this.cfg.deviceInfo,
    };
  }
  private url(path: string): string {
    return `${this.cfg.baseUrl ?? "https://dayone.me"}${path}`;
  }

  async getJournals(): Promise<any[]> {
    const r = await fetch(this.url("/api/v6/sync/journals"), { headers: this.headers() });
    if (!r.ok) throw new Error(`journals ${r.status}`);
    return r.json();
  }

  /** The entries feed (NDJSON-ish: one JSON object per line; some lines may be framing). */
  async getEntriesFeed(journalId: string): Promise<FeedItem[]> {
    const r = await fetch(this.url(`/api/v2/sync/entries/${journalId}/feed`), { headers: this.headers() });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    const text = await r.text();
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as FeedItem; } catch { return null; } })
      .filter((x): x is FeedItem => x !== null && !!x.revision?.entryId);
  }

  /** Per-entry encrypted content blob: `D1` envelope (JSON header ‖ \n ‖ ciphertext). */
  async getEntryContent(journalId: string, entryId: string): Promise<Uint8Array> {
    const r = await fetch(this.url(`/api/v2/sync/entries/${journalId}/${entryId}`), { headers: this.headers() });
    if (!r.ok) throw new Error(`entry ${entryId} ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async getAttachmentDownloadUrl(journalId: string, attachmentId: string): Promise<string | null> {
    const r = await fetch(this.url(`/api/journals/${journalId}/attachments/${attachmentId}/download`), {
      headers: this.headers(), redirect: "manual",
    });
    return r.headers.get("location");
  }
}
