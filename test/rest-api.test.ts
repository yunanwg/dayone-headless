import { expect, test } from "bun:test";
import {
  DayOneApi,
  ENDPOINT_BODY_LIMITS,
  type FetchLike,
  login,
  MAX_JOURNALS,
} from "../src/ingest/rest/api.ts";

const config = (fetchImpl: FetchLike, overrides: Record<string, unknown> = {}) => ({
  token: "synthetic-token",
  xUserAgent: "synthetic-agent",
  deviceInfo: "synthetic-device",
  fetchImpl,
  timeoutMs: 50,
  getRetries: 0,
  retryBaseDelayMs: 0,
  ...overrides,
});

test("idempotent GET retries are finite and recover from transient network/status failures", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async (_input, init) => {
    calls++;
    expect(init?.method).toBe("GET");
    if (calls === 1) throw new Error("credential=must-not-leak");
    if (calls === 2) return new Response("private response body", { status: 503 });
    return Response.json([{ id: "SYNTHETIC-JOURNAL" }]);
  };
  const api = new DayOneApi(config(fetchImpl, { getRetries: 2 }));

  expect(await api.getJournals()).toEqual([{ id: "SYNTHETIC-JOURNAL" }]);
  expect(calls).toBe(3);
});

test("GET timeout is bounded, retried only to budget, and reports a stable generic error", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = (_input, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("secret=query&path=/private/account")), {
        once: true,
      });
    });
  };
  const api = new DayOneApi(config(fetchImpl, { timeoutMs: 10, getRetries: 1 }));

  await expect(api.getJournals()).rejects.toThrow("Day One journals request timed out");
  expect(calls).toBe(2);
  try {
    await api.getJournals();
  } catch (error) {
    expect(String(error)).not.toContain("secret=");
    expect(String(error)).not.toContain("/private/account");
  }
});

test("GET timeout also bounds response-body consumption", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return new Response(
      new ReadableStream({
        pull: () => new Promise<never>(() => {}),
      }),
    );
  };
  const api = new DayOneApi(config(fetchImpl, { timeoutMs: 10, getRetries: 1 }));

  await expect(api.getJournals()).rejects.toThrow("Day One journals request timed out");
  expect(calls).toBe(2);
});

test("entry feed fails closed on any malformed line, wrong shape, or missing cursor", async () => {
  const journalId = "SYNTHETIC-JOURNAL";
  const valid = JSON.stringify({
    cursor: 1,
    revision: {
      entryId: "SYNTHETIC-ENTRY",
      journalId,
      revisionId: 1,
      editDate: 1,
      saveDate: 1,
      moments: [],
      deletionRequested: null,
    },
    contentLength: 1,
    encrypted: true,
  });
  const validApi = new DayOneApi(config(async () => new Response(valid)));
  expect(await validApi.getEntriesFeed(journalId)).toHaveLength(1);
  for (const invalid of [
    "{truncated",
    JSON.stringify({ cursor: 2, revision: {} }),
    JSON.stringify({
      revision: {
        entryId: "OTHER",
        journalId,
        revisionId: 2,
        editDate: 2,
        saveDate: 2,
        moments: [],
        deletionRequested: null,
      },
      contentLength: 1,
      encrypted: true,
    }),
  ]) {
    const api = new DayOneApi(config(async () => new Response(`${valid}\n${invalid}`)));
    await expect(api.getEntriesFeed(journalId)).rejects.toThrow("Day One entry feed response was invalid");
  }
});

test("endpoint byte caps reject declared and streamed oversize bodies", async () => {
  const declared = new DayOneApi(
    config(
      async () =>
        new Response("[]", {
          headers: { "content-length": String(ENDPOINT_BODY_LIMITS.journals + 1) },
        }),
    ),
  );
  await expect(declared.getJournals()).rejects.toThrow("Day One journals response was invalid");

  let posts = 0;
  const streamed: FetchLike = async () => {
    posts++;
    return new Response(new Uint8Array(ENDPOINT_BODY_LIMITS.login + 1));
  };
  await expect(
    login(
      { email: "synthetic@example.invalid", password: "synthetic-password" },
      { fetchImpl: streamed, timeoutMs: 100 },
    ),
  ).rejects.toThrow("login response was invalid");
  expect(posts).toBe(1);
});

test("aggregate response budget serializes concurrent bodies at the configured ceiling", async () => {
  let activeBodies = 0;
  let maxActiveBodies = 0;
  const fetchImpl: FetchLike = async () =>
    new Response(
      new ReadableStream({
        async pull(controller) {
          activeBodies++;
          maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
          await Bun.sleep(5);
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
          activeBodies--;
        },
      }),
    );
  const api = new DayOneApi(config(fetchImpl, { maxInflightResponseBytes: 1 }));
  await Promise.all([
    api.getEntryContent("SYNTHETIC-JOURNAL", "ENTRY-A"),
    api.getEntryContent("SYNTHETIC-JOURNAL", "ENTRY-B"),
    api.getEntryContent("SYNTHETIC-JOURNAL", "ENTRY-C"),
  ]);
  expect(maxActiveBodies).toBe(1);
});

test("journal response cardinality is capped independently of response bytes", async () => {
  const api = new DayOneApi(
    config(async () => Response.json(Array.from({ length: MAX_JOURNALS + 1 }, () => ({})))),
  );
  await expect(api.getJournals()).rejects.toThrow("Day One journals response was invalid");
});

test("one 401 renews with one login POST and retries the original GET once", async () => {
  let gets = 0;
  let posts = 0;
  const fetchImpl: FetchLike = async (_input, init) => {
    if (init?.method === "POST") {
      posts++;
      return Response.json({ token: "renewed-synthetic-token" });
    }
    gets++;
    return gets === 1 ? new Response("", { status: 401 }) : Response.json([]);
  };
  const api = new DayOneApi(
    config(fetchImpl, {
      credentials: {
        email: "synthetic@example.invalid",
        password: "synthetic-password",
      },
    }),
  );

  expect(await api.getJournals()).toEqual([]);
  expect(gets).toBe(2);
  expect(posts).toBe(1);
});

test("a second 401 after renewal fails without another login or GET replay", async () => {
  let gets = 0;
  let posts = 0;
  const fetchImpl: FetchLike = async (_input, init) => {
    if (init?.method === "POST") {
      posts++;
      return Response.json({ token: "renewed-synthetic-token" });
    }
    gets++;
    return new Response("", { status: 401 });
  };
  const api = new DayOneApi(
    config(fetchImpl, {
      credentials: {
        email: "synthetic@example.invalid",
        password: "synthetic-password",
      },
    }),
  );

  await expect(api.getJournals()).rejects.toThrow("Day One journals request failed (HTTP 401)");
  expect(gets).toBe(2);
  expect(posts).toBe(1);
});

test("HTTP failures never include response bodies or request identifiers", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response("credential=synthetic&private=query", { status: 500 });
  const api = new DayOneApi(config(fetchImpl));

  try {
    await api.getEntryContent("PRIVATE-JOURNAL-ID", "PRIVATE-ENTRY-ID");
    throw new Error("expected request to fail");
  } catch (error) {
    const message = String(error);
    expect(message).toContain("Day One entry content request failed (HTTP 500)");
    expect(message).not.toContain("credential=");
    expect(message).not.toContain("PRIVATE-JOURNAL-ID");
    expect(message).not.toContain("PRIVATE-ENTRY-ID");
  }
});

test("login POST times out once and is never automatically replayed", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = (_input, init) => {
    calls++;
    expect(init?.method).toBe("POST");
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("password=must-not-leak")), {
        once: true,
      });
    });
  };

  await expect(
    login(
      { email: "synthetic@example.invalid", password: "synthetic-password" },
      { fetchImpl, timeoutMs: 10 },
    ),
  ).rejects.toThrow("login request timed out");
  expect(calls).toBe(1);
});

test("login network and response errors are generic and never expose bodies", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    if (calls === 1) throw new Error("password=must-not-leak");
    return new Response("private diagnostic body", { status: 403 });
  };

  await expect(
    login(
      { email: "synthetic@example.invalid", password: "synthetic-password" },
      { fetchImpl, timeoutMs: 50 },
    ),
  ).rejects.toThrow("login request failed");
  await expect(
    login(
      { email: "synthetic@example.invalid", password: "synthetic-password" },
      { fetchImpl, timeoutMs: 50 },
    ),
  ).rejects.toThrow("login failed (HTTP 403)");
  expect(calls).toBe(2);
});
