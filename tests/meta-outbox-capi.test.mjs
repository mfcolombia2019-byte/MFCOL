import test, { mock } from "node:test";
import assert from "node:assert/strict";

// Almacén en memoria con semántica onlyIfNew / onlyIfMatch y etag, como @netlify/blobs 10.x.
const blobs = new Map();
let etagSeq = 0;
const memoryStore = {
  async get(key) { return blobs.has(key) ? structuredClone(blobs.get(key).data) : null; },
  async getWithMetadata(key) {
    const row = blobs.get(key);
    return row ? { data: structuredClone(row.data), etag: row.etag } : null;
  },
  async setJSON(key, value, options = {}) {
    const row = blobs.get(key);
    if (options.onlyIfNew && row) return { modified: false };
    if (options.onlyIfMatch && (!row || row.etag !== options.onlyIfMatch)) return { modified: false };
    const etag = "etag-" + (++etagSeq);
    blobs.set(key, { data: structuredClone(value), etag });
    return { modified: true, etag };
  },
  async list() { return { blobs: [...blobs.keys()].map(key => ({ key })) }; }
};

mock.module("@netlify/blobs", { exports: { getStore: () => memoryStore } });

const { enqueuePurchase, processOutboxKey } = await import("../netlify/functions/_meta-outbox.mjs");
const { sendMetaEvent, summarizeMetaError } = await import("../netlify/functions/_meta.mjs");

const TOKEN = "EAAG-secret-token-do-not-leak";
const ORDER = {
  reference: "MF-CAPI-1",
  paymentId: "PAY-CAPI-1",
  webhookEventId: "evt-capi-1",
  purchaseEventId: "purchase_MF-CAPI-1_PAY-CAPI-1",
  paymentStatus: "aprobado",
  webhookType: "SALE_APPROVED",
  confirmedAmount: 199900,
  confirmedCurrency: "COP",
  name: "Ana Perez",
  phone: "3115551234",
  clientUserAgent: "UA-test",
  eventSourceUrl: "https://example.test/checkout",
  items: [{ id: "shoe-1", qty: 1, unitPrice: 199900 }]
};

function setEnv(values = {}) {
  for (const name of ["META_CAPI_ACCESS_TOKEN", "META_GRAPH_API_VERSION", "META_DATASET_ID", "META_TEST_EVENT_CODE"]) delete process.env[name];
  Object.assign(process.env, { META_CAPI_ACCESS_TOKEN: TOKEN, META_GRAPH_API_VERSION: "v25.0" }, values);
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k];
}

function mockMeta(t, responder) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return responder(calls.length);
  });
  return calls;
}
const reply = (status, body) => new Response(JSON.stringify(body), { status });

function captureLogs(t) {
  const lines = [];
  const grab = (...a) => lines.push(a.map(String).join(" "));
  t.mock.method(console, "log", grab);
  t.mock.method(console, "warn", grab);
  t.mock.method(console, "error", grab);
  return lines;
}

test.beforeEach(() => { blobs.clear(); setEnv(); });

test("200 con events_received=1: Purchase queda sent, con fbtrace_id y log meta_capi_sent", async t => {
  const logs = captureLogs(t);
  const calls = mockMeta(t, () => reply(200, { events_received: 1, messages: [], fbtrace_id: "TRACE-OK" }));
  const queued = await enqueuePurchase(ORDER);
  assert.equal(queued.created, true);

  const result = await processOutboxKey(queued.key);
  assert.deepEqual([result.ok, result.status], [true, "sent"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.data[0].event_id, ORDER.purchaseEventId);
  const saved = blobs.get(queued.key).data;
  assert.equal(saved.status, "sent");
  assert.equal(saved.fbtraceId, "TRACE-OK");
  assert.ok(logs.some(l => l.includes("meta_capi_enqueued")));
  assert.ok(logs.some(l => l.includes("meta_capi_sent") && l.includes("TRACE-OK")));
});

test("idempotencia: encolar dos veces crea un solo registro y un sent no vuelve a llamar a Meta", async t => {
  captureLogs(t);
  const calls = mockMeta(t, () => reply(200, { events_received: 1 }));
  const a = await enqueuePurchase(ORDER);
  const b = await enqueuePurchase(ORDER);
  assert.equal(a.key, b.key);
  assert.equal(b.created, false);
  assert.equal(blobs.size, 1);

  await processOutboxKey(a.key);
  const again = await processOutboxKey(a.key);
  assert.equal(again.skipped, true);
  assert.equal(calls.length, 1);
});

test("400 de Meta: NO se marca sent, queda error terminal con causa saneada y se registra (antes era silencioso)", async t => {
  const logs = captureLogs(t);
  mockMeta(t, () => reply(400, { error: { message: "Invalid parameter", type: "OAuthException", code: 100, error_subcode: 2804050, fbtrace_id: "TRACE-400" } }));
  const queued = await enqueuePurchase(ORDER);

  const result = await processOutboxKey(queued.key);
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(result.retryable, false);
  const saved = blobs.get(queued.key).data;
  assert.equal(saved.status, "error");
  assert.equal(saved.nextAttemptAt, "");
  assert.equal(saved.lastHttpStatus, 400);
  assert.deepEqual([saved.lastMetaError.code, saved.lastMetaError.subcode, saved.lastMetaError.fbtraceId], [100, 2804050, "TRACE-400"]);
  assert.match(saved.lastError, /code=100\/2804050/);
  assert.equal(saved.sentAt, undefined);
  const failedLog = logs.find(l => l.includes("meta_capi_failed"));
  assert.ok(failedLog, "debe existir un log meta_capi_failed");
  assert.match(failedLog, /TRACE-400/);
});

test("200 sin events_received>=1 no cuenta como aceptación", async t => {
  captureLogs(t);
  for (const body of [{}, { events_received: 0 }]) {
    blobs.clear();
    t.mock.restoreAll();
    captureLogs(t);
    mockMeta(t, () => reply(200, body));
    const queued = await enqueuePurchase(ORDER);
    const result = await processOutboxKey(queued.key);
    assert.equal(result.ok, false);
    assert.equal(blobs.get(queued.key).data.status, "error");
    assert.match(blobs.get(queued.key).data.lastError, /events_received/);
  }
});

test("5xx y errores transitorios de Meta se reintentan con nextAttemptAt; el evento sigue sin enviarse", async t => {
  captureLogs(t);
  mockMeta(t, n => n === 1
    ? reply(503, { error: { message: "down", code: 2, fbtrace_id: "T5" } })
    : reply(400, { error: { message: "busy", code: 4, is_transient: true, fbtrace_id: "T6" } }));
  const queued = await enqueuePurchase(ORDER);

  await assert.rejects(processOutboxKey(queued.key), /503/);
  let saved = blobs.get(queued.key).data;
  assert.equal(saved.status, "error");
  assert.ok(Date.parse(saved.nextAttemptAt) > Date.now());

  saved.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  blobs.set(queued.key, { data: saved, etag: "forced-" + (++etagSeq) });
  await assert.rejects(processOutboxKey(queued.key), /busy|400/);
  saved = blobs.get(queued.key).data;
  assert.equal(saved.attempts, 2);
  assert.ok(Date.parse(saved.nextAttemptAt) > Date.now());
});

test("falta META_CAPI_ACCESS_TOKEN o versión inválida: error terminal visible en logs, sin llamar a Meta", async t => {
  for (const [env, pattern] of [
    [{ META_CAPI_ACCESS_TOKEN: undefined }, /META_CAPI_ACCESS_TOKEN/],
    [{ META_GRAPH_API_VERSION: undefined }, /META_GRAPH_API_VERSION/]
  ]) {
    blobs.clear();
    t.mock.restoreAll();
    const logs = captureLogs(t);
    const calls = mockMeta(t, () => reply(200, { events_received: 1 }));
    setEnv(env);
    const queued = await enqueuePurchase(ORDER);
    const result = await processOutboxKey(queued.key);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
    assert.match(blobs.get(queued.key).data.lastError, pattern);
    assert.ok(logs.some(l => l.includes("meta_capi_failed") && pattern.test(l)));
  }
});

test("el token nunca aparece en errores, registros del outbox ni logs (HTTP 400 y fallo de red)", async t => {
  const logs = captureLogs(t);
  mockMeta(t, n => {
    if (n === 1) return reply(400, { error: { message: "Bad token " + TOKEN, code: 190, fbtrace_id: "T190" } });
    throw Object.assign(new TypeError("fetch failed: https://graph.facebook.com/v25.0/1/events?access_token=" + TOKEN), { name: "TypeError" });
  });

  const first = await enqueuePurchase(ORDER);
  await processOutboxKey(first.key);

  blobs.clear();
  const second = await enqueuePurchase(ORDER);
  await assert.rejects(processOutboxKey(second.key));

  const everything = JSON.stringify([...blobs.values()]) + logs.join("\n");
  assert.ok(!everything.includes(TOKEN), "el token se filtró");
  assert.ok(!everything.includes("access_token="), "la URL con token se filtró");
});

test("el cuerpo enviado respeta test_event_code y dataset configurables", async t => {
  captureLogs(t);
  setEnv({ META_TEST_EVENT_CODE: "TEST12345", META_DATASET_ID: "42" });
  const calls = mockMeta(t, () => reply(200, { events_received: 1 }));
  await sendMetaEvent({ event_name: "Purchase", event_id: "x" });
  assert.equal(calls[0].body.test_event_code, "TEST12345");
  assert.match(calls[0].url, /\/v25\.0\/42\/events\?/);
});

test("summarizeMetaError ignora cuerpos sin error", () => {
  assert.equal(summarizeMetaError({}), null);
  assert.equal(summarizeMetaError(null), null);
});
