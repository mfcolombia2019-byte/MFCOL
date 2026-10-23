import test, { mock } from "node:test";
import assert from "node:assert/strict";

// Almacén en memoria con la semántica condicional de Netlify Blobs usada por el outbox.
const data = new Map();
let etagCounter = 0;
let writeCount = 0;
const mockStore = {
  async get(key) { const e = data.get(key); return e ? structuredClone(e.value) : null; },
  async getWithMetadata(key) {
    const e = data.get(key);
    return e ? { data: structuredClone(e.value), etag: e.etag, metadata: {} } : null;
  },
  async setJSON(key, value, opts = {}) {
    writeCount++;
    const e = data.get(key);
    if (opts.onlyIfNew && e) return { modified: false };
    if (opts.onlyIfMatch !== undefined && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
    const etag = "etag-" + (++etagCounter);
    data.set(key, { value: structuredClone(value), etag });
    return { modified: true, etag };
  },
  async list({ prefix = "" } = {}) {
    return { blobs: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
  }
};

mock.module("@netlify/blobs", { exports: { getStore() { return mockStore; } } });

const { enqueuePurchase, processOutboxKey } = await import("../netlify/functions/_meta-outbox.mjs");
const { applyBoldPaymentEvent } = await import("../netlify/functions/_orders.mjs");
const { summarizeMetaOutbox, metaEnvStatus } = await import("../netlify/functions/order-diagnostic.mjs");

// Credenciales ficticias solo para este proceso de prueba (cada archivo corre en su propio proceso).
process.env.ADMIN_PASSWORD = "test-admin-password";
process.env.ADMIN_SESSION_SECRET = "test-session-secret";
const { sessionCookie } = await import("../netlify/functions/_admin.mjs");
const ADMIN_COOKIE = sessionCookie("admin").split(";")[0];
const { default: outboxHandler, assessRecovery, RECOVERY_MAX_AGE_SECONDS } = await import("../netlify/functions/meta-outbox.mjs");

const ENV_NAMES = ["META_CAPI_ACCESS_TOKEN", "META_GRAPH_API_VERSION", "META_DATASET_ID", "META_TEST_EVENT_CODE"];
const GOOD_ENV = { META_CAPI_ACCESS_TOKEN: "test-token", META_GRAPH_API_VERSION: "v25.0" };

async function withEnv(values, callback) {
  const previous = Object.fromEntries(ENV_NAMES.map(n => [n, process.env[n]]));
  for (const n of ENV_NAMES) {
    if (Object.hasOwn(values, n)) process.env[n] = values[n];
    else delete process.env[n];
  }
  try { return await callback(); }
  finally {
    for (const n of ENV_NAMES) {
      if (previous[n] === undefined) delete process.env[n];
      else process.env[n] = previous[n];
    }
  }
}

function approvedOrder(reference = "MFTEST0001", paymentId = "PAY-1", eventId = "evt-1") {
  return applyBoldPaymentEvent(
    { reference, total: 150000, name: "Ana Perez", phone: "3001234567", items: [{ id: "shoe-1", qty: 1, unitPrice: 150000 }], paymentStatus: "pendiente" },
    {
      id: eventId, type: "SALE_APPROVED", subject: paymentId, time: 1761063334000000000,
      data: { payment_id: paymentId, amount: { currency: "COP", total: 150000 }, metadata: { reference } }
    },
    "2026-10-23T12:00:00.000Z"
  );
}

const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function mockMeta(t, responder) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return responder(calls.length);
  });
  return calls;
}

function patchRecord(key, fn) {
  const e = data.get(key);
  const value = fn(structuredClone(e.value));
  data.set(key, { value, etag: "etag-" + (++etagCounter) });
}

async function queued(order = approvedOrder()) {
  data.clear();
  return enqueuePurchase(order);
}

test("outbox pendiente: se crea una vez y un segundo webhook del mismo pago no duplica la compra", async () => {
  data.clear();
  const first = await enqueuePurchase(approvedOrder("MFTEST0001", "PAY-1", "evt-1"));
  const second = await enqueuePurchase(approvedOrder("MFTEST0001", "PAY-1", "evt-2"));
  assert.equal(first.created, true);
  assert.equal(first.status, "pending");
  assert.equal(second.created, false);
  assert.equal(second.key, first.key);
  assert.equal(second.eventId, first.eventId);
  assert.equal([...data.keys()].filter(k => k.startsWith("meta-outbox/")).length, 1);
});

test("Meta responde bien: queda sent con events_received y no se reenvía; solo se llama a events de Graph", async t => {
  const { key } = await queued();
  const calls = mockMeta(t, () => res({ events_received: 1, messages: [], fbtrace_id: "TRACE1" }));
  const out = await withEnv(GOOD_ENV, () => processOutboxKey(key));
  assert.equal(out.status, "sent");
  const record = (await mockStore.get(key));
  assert.equal(record.status, "sent");
  assert.equal(record.eventsReceived, 1);
  assert.equal(record.fbtraceId, "TRACE1");
  assert.equal(record.testEventCodeActive, false);

  const again = await withEnv(GOOD_ENV, () => processOutboxKey(key));
  assert.equal(again.reason, "sent");
  assert.equal(calls.length, 1);
  // Independencia de WhatsApp: la única llamada saliente es a Graph /events.
  assert.match(calls[0].url, /graph\.facebook\.com\/v25\.0\/\d+\/events\?/);
  assert.ok(!/messages/.test(calls[0].url));
});

test("HTTP 200 con events_received=0 no se marca como enviado y queda reintentable", async t => {
  const { key } = await queued();
  t.mock.method(console, "error", () => {});
  mockMeta(t, () => res({ events_received: 0, fbtrace_id: "TRACE0" }));
  await assert.rejects(withEnv(GOOD_ENV, () => processOutboxKey(key)), /sin eventos recibidos/);
  const record = await mockStore.get(key);
  assert.equal(record.status, "error");
  assert.ok(record.nextAttemptAt, "debe programarse reintento");
  assert.equal(record.lastErrorDetail?.fbtraceId, "TRACE0");
  assert.equal(record.sentAt, undefined);
});

test("HTTP 200 sin events_received no se marca como enviado y queda reintentable", async t => {
  const { key } = await queued();
  t.mock.method(console, "error", () => {});
  mockMeta(t, () => res({ fbtrace_id: "TRACE_MISSING" }));
  await assert.rejects(
    withEnv(GOOD_ENV, () => processOutboxKey(key)),
    /sin eventos recibidos/
  );
  const record = await mockStore.get(key);
  assert.equal(record.status, "error");
  assert.ok(record.nextAttemptAt, "debe programarse reintento");
  assert.equal(record.sentAt, undefined);
});

test("Meta rechaza el evento (token inválido): error terminal visible, detalle sanitizado y log", async t => {
  const { key } = await queued();
  const logs = t.mock.method(console, "error", () => {});
  mockMeta(t, () => res({
    error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190, fbtrace_id: "TRACE190" }
  }, 400));
  const out = await withEnv(GOOD_ENV, () => processOutboxKey(key));
  assert.deepEqual({ ok: out.ok, status: out.status, retryable: out.retryable }, { ok: false, status: "error", retryable: false });

  const record = await mockStore.get(key);
  assert.equal(record.status, "error");
  assert.equal(record.nextAttemptAt, "");
  assert.equal(record.lastMetaStatus, 400);
  assert.equal(record.lastErrorDetail.code, 190);
  assert.equal(record.lastErrorDetail.type, "OAuthException");
  assert.equal(record.lastErrorDetail.fbtraceId, "TRACE190");
  assert.ok(!JSON.stringify(record).includes("test-token"));
  assert.equal(logs.mock.calls.length, 1);
  assert.equal(logs.mock.calls[0].arguments[0], "Meta CAPI Purchase falló");
  assert.equal(logs.mock.calls[0].arguments[1].terminal, true);
  assert.ok(!JSON.stringify(logs.mock.calls[0].arguments).includes("test-token"));
});

test("fallo transitorio de Meta (500): reintento posterior reutiliza el mismo event_id y no duplica", async t => {
  const { key } = await queued();
  t.mock.method(console, "error", () => {});
  const calls = mockMeta(t, n => (n === 1 ? res({ error: { message: "temporary", code: 2 } }, 500) : res({ events_received: 1 })));

  await assert.rejects(withEnv(GOOD_ENV, () => processOutboxKey(key)), /500/);
  let record = await mockStore.get(key);
  assert.equal(record.status, "error");
  assert.ok(record.nextAttemptAt);

  const early = await withEnv(GOOD_ENV, () => processOutboxKey(key));
  assert.equal(early.reason, "not_due");
  assert.equal(calls.length, 1);

  patchRecord(key, r => ({ ...r, nextAttemptAt: new Date(Date.now() - 1000).toISOString() }));
  const retry = await withEnv(GOOD_ENV, () => processOutboxKey(key));
  assert.equal(retry.status, "sent");
  assert.equal(retry.attempts, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.data[0].event_id, calls[1].body.data[0].event_id);
  record = await mockStore.get(key);
  assert.equal(record.status, "sent");
  assert.equal(record.lastErrorDetail, null);
});

test("token ausente: no llama a Meta, queda en error terminal y ahora se registra en logs", async t => {
  const { key } = await queued();
  const logs = t.mock.method(console, "error", () => {});
  const calls = mockMeta(t, () => res({ events_received: 1 }));
  const out = await withEnv({ META_GRAPH_API_VERSION: "v25.0" }, () => processOutboxKey(key));
  assert.equal(out.retryable, false);
  assert.equal(calls.length, 0);
  const record = await mockStore.get(key);
  assert.equal(record.status, "error");
  assert.equal(record.nextAttemptAt, "");
  assert.match(record.lastError, /META_CAPI_ACCESS_TOKEN/);
  assert.equal(logs.mock.calls.length, 1);
});

test("META_TEST_EVENT_CODE activo: el payload lleva test_event_code y el registro lo deja anotado", async t => {
  const { key } = await queued();
  const calls = mockMeta(t, () => res({ events_received: 1 }));
  await withEnv({ ...GOOD_ENV, META_TEST_EVENT_CODE: "TEST12345" }, () => processOutboxKey(key));
  assert.equal(calls[0].body.test_event_code, "TEST12345");
  const record = await mockStore.get(key);
  assert.equal(record.testEventCodeActive, true);
  assert.equal(summarizeMetaOutbox(record).testEventCodeActive, true);
});

test("diagnóstico: marca dead letter y no expone evento, datos del cliente ni secretos", async () => {
  const record = {
    kind: "Purchase", status: "error", attempts: 1, nextAttemptAt: "", lastError: "Meta CAPI rechazó Purchase (400)",
    lastMetaStatus: 400,
    lastErrorDetail: { type: "OAuthException", code: 190, subcode: null, message: "Invalid OAuth access token", fbtraceId: "T" },
    event: { user_data: { ph: ["hash"] } }, metaResponse: { raw: true }
  };
  const summary = summarizeMetaOutbox(record);
  assert.equal(summary.deadLetter, true);
  assert.equal(summary.lastErrorDetail.code, 190);
  const text = JSON.stringify(summary);
  assert.ok(!text.includes("user_data") && !text.includes("raw"));

  const reader = name => ({ META_CAPI_ACCESS_TOKEN: "super-secret-token", META_GRAPH_API_VERSION: "v25.0", META_TEST_EVENT_CODE: "TEST999" }[name] || "");
  const envStatus = metaEnvStatus(reader);
  assert.equal(envStatus.capiTokenPresent, true);
  assert.equal(envStatus.capiTokenValidityVerified, false);
  assert.equal(envStatus.testEventCodePresent, true);
  assert.equal(envStatus.boldApiKeyPresent, false);
  const envText = JSON.stringify(envStatus);
  assert.ok(!envText.includes("super-secret-token") && !envText.includes("TEST999"));
});

// ===================================================================
// Endpoint admin meta-outbox: dryRun, reenvío individual y guardas
// ===================================================================

function call(method, body, { cookie = ADMIN_COOKIE, query = "" } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return outboxHandler(new Request("https://tienda.test/.netlify/functions/meta-outbox" + query, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

function freshOrder(reference, ageSeconds = 3600, paymentId = "PAY-1", eventId = "evt-1") {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return applyBoldPaymentEvent(
    { reference, total: 150000, name: "Ana Perez", phone: "3001234567", items: [{ id: "shoe-1", qty: 1, unitPrice: 150000 }], paymentStatus: "pendiente" },
    {
      id: eventId, type: "SALE_APPROVED", subject: paymentId, time: (nowSeconds - ageSeconds) * 1e9,
      data: { payment_id: paymentId, amount: { currency: "COP", total: 150000 }, metadata: { reference } }
    },
    new Date().toISOString()
  );
}

function seedOrder(order) {
  data.set("orders/" + order.reference, { value: structuredClone(order), etag: "etag-" + (++etagCounter) });
}

function patchOrder(reference, fn) {
  const e = data.get("orders/" + reference);
  data.set("orders/" + reference, { value: fn(structuredClone(e.value)), etag: "etag-" + (++etagCounter) });
}

const TERMINAL_400 = r => ({
  ...r, status: "error", attempts: 1, nextAttemptAt: "",
  lastError: "Meta CAPI rechazó Purchase (400)", lastMetaStatus: 400
});

// Deja un único evento en el outbox (y su pedido) y devuelve su clave.
async function setup(order, patch) {
  data.clear();
  seedOrder(order);
  const { key } = await enqueuePurchase(order);
  if (patch) patchRecord(key, patch);
  return key;
}

function auditEntries() {
  return [...data.entries()].filter(([k]) => k.startsWith("meta-outbox-audit/")).map(([, e]) => e.value);
}

function noFetch(t) {
  return t.mock.method(globalThis, "fetch", async () => { throw new Error("fetch no debe llamarse"); });
}

test("autenticación: sin sesión de admin, GET y POST responden 401 y no tocan Meta", async t => {
  const key = await setup(freshOrder("MFAUTH0001"), TERMINAL_400);
  const spy = noFetch(t);
  const writes = writeCount;
  assert.equal((await call("GET", undefined, { cookie: "" })).status, 401);
  assert.equal((await call("POST", { key, confirm: "x" }, { cookie: "" })).status, 401);
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(writeCount, writes);
});

test("GET: distingue sent, pending y error con antigüedad y posibilidad de recuperación; solo lectura", async t => {
  data.clear();
  const sentOrder = freshOrder("MFSENT0001", 3600, "PAY-S", "evt-s");
  const pendOrder = freshOrder("MFPEND0001", 7200, "PAY-P", "evt-p");
  const errOrder = freshOrder("MFERR00001", 10800, "PAY-E", "evt-e");
  for (const o of [sentOrder, pendOrder, errOrder]) { seedOrder(o); await enqueuePurchase(o); }
  const keyOf = o => "meta-outbox/" + o.purchaseEventId;
  patchRecord(keyOf(sentOrder), r => ({ ...r, status: "sent", sentAt: new Date().toISOString(), nextAttemptAt: "", eventsReceived: 1 }));
  patchRecord(keyOf(errOrder), TERMINAL_400);

  const spy = noFetch(t);
  const writes = writeCount;
  const res1 = await call("GET");
  assert.equal(res1.status, 200);
  const body = await res1.json();
  const byRef = Object.fromEntries(body.items.map(i => [i.orderReference, i]));

  assert.equal(byRef.MFSENT0001.status, "sent");
  assert.equal(byRef.MFSENT0001.recoverable, false);
  assert.equal(byRef.MFSENT0001.reason, "already_sent");
  assert.equal(byRef.MFPEND0001.status, "pending");
  assert.equal(byRef.MFPEND0001.recoverable, true);
  assert.equal(byRef.MFERR00001.status, "error");
  assert.equal(byRef.MFERR00001.recoverable, true);
  assert.equal(byRef.MFERR00001.deadLetter, true);
  assert.equal(byRef.MFERR00001.priorAttempt, "rejected_by_meta");
  assert.ok(byRef.MFERR00001.ageSeconds >= 10800 - 5 && byRef.MFERR00001.ageSeconds < 10800 + 120);
  assert.equal(body.summary.total, 3);
  assert.equal(body.summary.sent, 1);
  assert.equal(body.summary.deadLetters, 1);
  assert.equal(JSON.stringify(body).includes("user_data"), false);
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(writeCount, writes);

  const filtered = await (await call("GET", undefined, { query: "?status=error" })).json();
  assert.deepEqual(filtered.items.map(i => i.orderReference), ["MFERR00001"]);
});

test("dryRun (explícito o por ausencia de confirm) es estrictamente de solo lectura", async t => {
  const order = freshOrder("MFDRY00001");
  const key = await setup(order, TERMINAL_400);
  const eventId = order.purchaseEventId;
  const spy = noFetch(t);
  const snapshot = JSON.stringify([...data]);
  const writes = writeCount;

  const explicit = await (await withEnv(GOOD_ENV, () => call("POST", { key, dryRun: true, confirm: eventId }))).json();
  const implicit = await (await withEnv(GOOD_ENV, () => call("POST", { key }))).json();
  for (const plan of [explicit, implicit]) {
    assert.equal(plan.dryRun, true);
    assert.equal(plan.recoverable, true);
    assert.equal(plan.orderChecked, true);
    assert.equal(plan.reason, "ok");
    assert.equal(plan.wouldSend.eventId, eventId);
    assert.equal(plan.orderReference, "MFDRY00001");
    assert.equal(plan.config.readyToSend, true);
    assert.ok(plan.ageSeconds >= 0);
    assert.equal(plan.lastMetaStatus, 400);
  }
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(writeCount, writes);
  assert.equal(JSON.stringify([...data]), snapshot);
});

test("reenvío individual con confirm: conserva event_id y contenido, registra resultado y auditoría", async t => {
  const order = freshOrder("MFSEND0001");
  const key = await setup(order, TERMINAL_400);
  const before = (await mockStore.get(key)).event;
  const calls = mockMeta(t, () => res({ events_received: 1, fbtrace_id: "TRACEM" }));

  const response = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal(response.status, 200);
  const out = await response.json();
  assert.equal(out.outcome, "sent");
  assert.equal(out.eventsReceived, 1);
  assert.equal(out.fbtraceId, "TRACEM");
  assert.equal(out.eventUnchanged, true);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.data[0], before);
  assert.equal(calls[0].body.data[0].event_id, order.purchaseEventId);
  const record = await mockStore.get(key);
  assert.equal(record.status, "sent");
  assert.deepEqual(record.event, before);

  const audit = auditEntries();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "sent");
  assert.equal(audit[0].eventsReceived, 1);
  assert.equal(audit[0].fbtraceId, "TRACEM");
  assert.equal(audit[0].eventUnchanged, true);
  assert.ok(!(JSON.stringify(out) + JSON.stringify(audit)).includes("test-token"));
  assert.ok(![...data.keys()].some(k => k.startsWith("meta-outbox/") && k !== key));

  // Segundo intento sobre el mismo evento: ya está sent, no se reenvía.
  const again = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).reason, "already_sent");
  assert.equal(calls.length, 1);
});

test("evento sent: nunca se reenvía, ni con confirm ni con acknowledgeAmbiguous", async t => {
  const order = freshOrder("MFSENT0002");
  const key = await setup(order, r => ({ ...r, status: "sent", sentAt: new Date().toISOString(), nextAttemptAt: "", eventsReceived: 1 }));
  const spy = noFetch(t);
  const writes = writeCount;
  const response = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId, acknowledgeAmbiguous: true }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "already_sent");
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(writeCount, writes);
});

test("confirm ausente de coincidencia: 400 sin enviar ni escribir", async t => {
  const order = freshOrder("MFCONF0001");
  const key = await setup(order, TERMINAL_400);
  const spy = noFetch(t);
  const writes = writeCount;
  const response = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: "purchase_otro_evento" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).reason, "confirm_mismatch");
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(writeCount, writes);
});

test("sin reenvíos masivos: keys, all o key como arreglo se rechazan", async t => {
  const order = freshOrder("MFBULK0001");
  const key = await setup(order, TERMINAL_400);
  const spy = noFetch(t);
  const writes = writeCount;
  for (const body of [{ keys: [key] }, { key: [key, key] }, { all: true }, { status: "error" }, { key, limit: 50, confirm: order.purchaseEventId }]) {
    const response = await withEnv(GOOD_ENV, () => call("POST", body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).reason, "bulk_not_allowed");
  }
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(writeCount, writes);
});

test("evento vencido (más de 6.5 días): no recuperable, no se envía y no se altera su event_time", async t => {
  const order = freshOrder("MFOLD00001", 8 * 24 * 3600);
  const key = await setup(order, TERMINAL_400);
  const spy = noFetch(t);
  const writes = writeCount;
  const plan = await (await withEnv(GOOD_ENV, () => call("POST", { key }))).json();
  assert.equal(plan.recoverable, false);
  assert.equal(plan.reason, "expired");
  assert.equal(plan.wouldSend, null);

  const response = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "expired");
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(writeCount, writes);
  assert.equal(RECOVERY_MAX_AGE_SECONDS, 7 * 86400 - 12 * 3600);
});

test("verificación previa: event_id, clave, referencia, event_time y coherencia con el pedido", async () => {
  const order = freshOrder("MFCHK00001");
  const key = await setup(order, TERMINAL_400);
  const record = await mockStore.get(key);
  const now = Date.now();
  const assess = (rec, opts = {}) => assessRecovery(key, rec, { now, ...opts });
  const mutate = fn => { const r = structuredClone(record); fn(r); return r; };

  assert.equal(assess(record).reason, "ok");
  assert.equal(assess(mutate(r => { r.event.event_id = "otro"; })).reason, "event_id_mismatch");
  assert.equal(assessRecovery("meta-outbox/otra_clave", record, { now }).reason, "key_mismatch");
  assert.equal(assess(mutate(r => { r.orderReference = "OTRAREF001"; })).reason, "reference_mismatch");
  assert.equal(assess(mutate(r => { r.event.event_time = Date.now(); })).reason, "event_time_invalid");
  assert.equal(assess(mutate(r => { r.event.event_time = Math.floor(now / 1000) + 3600; })).reason, "event_time_in_future");
  assert.equal(assess(mutate(r => { r.kind = "Lead"; })).reason, "invalid_record");

  assert.equal(assess(record, { order: null, orderChecked: true }).reason, "order_not_found");
  assert.equal(assess(record, { order: { ...order, paymentStatus: "anulado" }, orderChecked: true }).reason, "order_not_approved");
  assert.equal(assess(record, { order: { ...order, purchaseEventId: "otro" }, orderChecked: true }).reason, "order_event_id_mismatch");
  assert.equal(assess(record, { order: { ...order, confirmedAmount: 1 }, orderChecked: true }).reason, "order_amount_mismatch");
  assert.equal(assess(record, { order, orderChecked: true }).reason, "ok");
});

test("el endpoint se niega a reenviar si el pedido ya no está aprobado o falta", async t => {
  const order = freshOrder("MFORD00001");
  const key = await setup(order, TERMINAL_400);
  const spy = noFetch(t);
  patchOrder("MFORD00001", o => ({ ...o, paymentStatus: "anulado" }));
  const voided = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal(voided.status, 409);
  assert.equal((await voided.json()).reason, "order_not_approved");
  data.delete("orders/MFORD00001");
  const missing = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal((await missing.json()).reason, "order_not_found");
  assert.equal(spy.mock.calls.length, 0);
});

test("META_TEST_EVENT_CODE activo o configuración incompleta bloquean el envío real sin revelar valores", async t => {
  const order = freshOrder("MFCFG00001");
  const key = await setup(order, TERMINAL_400);
  const spy = noFetch(t);
  const writes = writeCount;

  const withCode = await withEnv({ ...GOOD_ENV, META_TEST_EVENT_CODE: "TESTSECRET1" }, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal(withCode.status, 409);
  const text = await withCode.text();
  assert.match(text, /send_config_not_ready/);
  assert.ok(text.includes('"testEventCodeActive":true'));
  assert.ok(!text.includes("TESTSECRET1") && !text.includes("test-token"));

  const noToken = await withEnv({ META_GRAPH_API_VERSION: "v25.0" }, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal(noToken.status, 409);
  assert.equal((await noToken.json()).config.tokenPresent, false);
  assert.equal(spy.mock.calls.length, 0);
  assert.equal(writeCount, writes);
});

test("Meta rechaza el reenvío manual: 502, error registrado y auditado sin secretos; el evento no cambia", async t => {
  const order = freshOrder("MFREJ00001");
  const key = await setup(order, TERMINAL_400);
  const before = (await mockStore.get(key)).event;
  t.mock.method(console, "error", () => {});
  mockMeta(t, () => res({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190, fbtrace_id: "TRACE190" } }, 400));

  const response = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal(response.status, 502);
  const out = await response.json();
  assert.equal(out.outcome, "error");
  assert.equal(out.lastErrorDetail.code, 190);
  assert.equal(out.fbtraceId, "TRACE190");
  assert.equal(out.eventUnchanged, true);

  const record = await mockStore.get(key);
  assert.equal(record.status, "error");
  assert.deepEqual(record.event, before);
  const audit = auditEntries();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "error");
  assert.equal(audit[0].errorCode, 190);
  assert.equal(audit[0].lastMetaStatus, 400);
  assert.ok(!(JSON.stringify(out) + JSON.stringify(audit)).includes("test-token"));
});

test("intento previo incierto (5xx): exige acknowledgeAmbiguous y entonces reenvía una sola vez", async t => {
  const order = freshOrder("MFAMB00001");
  const key = await setup(order, r => ({
    ...r, status: "error", attempts: 8, nextAttemptAt: "",
    lastError: "Meta CAPI rechazó Purchase (500)", lastMetaStatus: 500
  }));
  const calls = mockMeta(t, () => res({ events_received: 1, fbtrace_id: "TRACEA" }));

  const plan = await (await withEnv(GOOD_ENV, () => call("POST", { key }))).json();
  assert.equal(plan.priorAttempt, "unknown");
  assert.equal(plan.requiresAcknowledgement, true);

  const refused = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId }));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).reason, "acknowledgement_required");
  assert.equal(calls.length, 0);

  const accepted = await withEnv(GOOD_ENV, () => call("POST", { key, confirm: order.purchaseEventId, acknowledgeAmbiguous: true }));
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(auditEntries()[0].acknowledgedAmbiguous, true);
});

test("concurrencia: cron (processOutboxKey) y reenvío manual simultáneos envían una sola vez", async t => {
  const order = freshOrder("MFRACE0001");
  const key = await setup(order);
  const calls = mockMeta(t, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return res({ events_received: 1, fbtrace_id: "TRACER" });
  });

  const settled = await withEnv(GOOD_ENV, () => Promise.allSettled([
    processOutboxKey(key),
    call("POST", { key, confirm: order.purchaseEventId })
  ]));
  assert.ok(settled.every(s => s.status === "fulfilled"));
  assert.equal(calls.length, 1, "Meta debe recibir el evento una sola vez");
  const record = await mockStore.get(key);
  assert.equal(record.status, "sent");
  assert.equal(record.attempts, 1);
  const manual = settled[1].value;
  assert.ok([200, 409].includes(manual.status));
});

test("concurrencia: dos reenvíos manuales simultáneos del mismo evento envían una sola vez", async t => {
  const order = freshOrder("MFRACE0002");
  const key = await setup(order, TERMINAL_400);
  const calls = mockMeta(t, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return res({ events_received: 1, fbtrace_id: "TRACER2" });
  });

  const responses = await withEnv(GOOD_ENV, () => Promise.all([
    call("POST", { key, confirm: order.purchaseEventId }),
    call("POST", { key, confirm: order.purchaseEventId })
  ]));
  assert.equal(calls.length, 1);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await mockStore.get(key)).status, "sent");
});
