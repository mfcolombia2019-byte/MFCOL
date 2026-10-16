import test, { mock } from "node:test";
import assert from "node:assert/strict";

// Regresión del 400 / código 190 de Meta ("Invalid JSON for postcard"): el token de la variable de
// entorno llegaba sin normalizar a la URL y el evento guardado quedaba terminal sin recuperación.

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
const { buildMetaPurchase, sendMetaEvent, normalizeMetaToken } = await import("../netlify/functions/_meta.mjs");

const GOOD_TOKEN = "TSTBsecretTokenValue123|abc-def_ghi.jkl";
const ORDER = {
  reference: "MF-REG-1",
  paymentId: "PAY-REG-1",
  webhookEventId: "evt-reg-1",
  purchaseEventId: "purchase_MF-REG-1_PAY-REG-1",
  paymentStatus: "aprobado",
  webhookType: "SALE_APPROVED",
  confirmedAmount: 803800,
  confirmedCurrency: "COP",
  paymentEventTime: 1792000000,
  name: "Ana Perez",
  phone: "3115551234",
  fbp: "fb.1.1700000000.123",
  clientUserAgent: "UA-test",
  eventSourceUrl: "https://example.test/checkout",
  items: [{ id: "shoe-1", qty: 1, unitPrice: 803800 }]
};

function setEnv(values = {}) {
  for (const name of ["META_CAPI_ACCESS_TOKEN", "META_GRAPH_API_VERSION", "META_DATASET_ID", "META_TEST_EVENT_CODE"]) delete process.env[name];
  Object.assign(process.env, { META_CAPI_ACCESS_TOKEN: GOOD_TOKEN, META_GRAPH_API_VERSION: "v21.0" }, values);
}

function mockMeta(t, responder) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options, body: options?.body });
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

function tokenParam(url) {
  return new URL(url).searchParams.get("access_token");
}

test.beforeEach(() => { blobs.clear(); setEnv(); });

test("normalizeMetaToken recorta espacios, saltos de línea y comillas envolventes", () => {
  assert.equal(normalizeMetaToken("  tok\n"), "tok");
  assert.equal(normalizeMetaToken('"tok"'), "tok");
  assert.equal(normalizeMetaToken("'tok'\r\n"), "tok");
  assert.equal(normalizeMetaToken(' " tok " '), "tok");
  assert.equal(normalizeMetaToken(undefined), "");
});

test("endpoint, versión, método y JSON enviados son exactamente los de la Conversions API", async t => {
  const calls = mockMeta(t, () => reply(200, { events_received: 1, fbtrace_id: "T" }));
  setEnv({ META_GRAPH_API_VERSION: "21.0", META_DATASET_ID: " 1092821839891082 ", META_TEST_EVENT_CODE: " TEST777\n" });

  await sendMetaEvent(buildMetaPurchase(ORDER));

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://graph.facebook.com/v21.0/1092821839891082/events");
  assert.equal(tokenParam(calls[0].url), GOOD_TOKEN);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");

  // Cuerpo: JSON válido, sin undefined/NaN serializados, event_time entero en segundos.
  const body = JSON.parse(calls[0].body);
  assert.equal(body.test_event_code, "TEST777");
  assert.equal(Array.isArray(body.data) && body.data.length, 1);
  const event = body.data[0];
  assert.equal(event.event_name, "Purchase");
  assert.equal(event.event_id, ORDER.purchaseEventId);
  assert.equal(event.action_source, "website");
  assert.ok(Number.isInteger(event.event_time) && event.event_time < 1e11, "event_time debe estar en segundos");
  assert.equal(event.custom_data.value, 803800);
  assert.equal(event.custom_data.currency, "COP");
  assert.ok(!/NaN|undefined/.test(calls[0].body));
  assert.match(event.user_data.fn[0], /^[0-9a-f]{64}$/);
});

test("token guardado con salto de línea, espacios o comillas llega limpio a Meta (antes iba tal cual en la URL)", async t => {
  for (const stored of [GOOD_TOKEN + "\n", " " + GOOD_TOKEN + " ", '"' + GOOD_TOKEN + '"', "'" + GOOD_TOKEN + "'\r\n"]) {
    t.mock.restoreAll();
    const calls = mockMeta(t, () => reply(200, { events_received: 1 }));
    setEnv({ META_CAPI_ACCESS_TOKEN: stored });
    await sendMetaEvent({ event_name: "Purchase", event_id: "x" });
    assert.equal(tokenParam(calls[0].url), GOOD_TOKEN);
    assert.ok(!/%0A|%0D|%20|%22|%27/.test(new URL(calls[0].url).search), "la URL no debe llevar residuos del valor guardado");
  }
});

test("token con formato inválido (JSON, 'Bearer ...', espacio interno) se rechaza sin llamar a Meta ni filtrar el valor", async t => {
  const logs = captureLogs(t);
  const calls = mockMeta(t, () => reply(200, { events_received: 1 }));

  for (const bad of ['{"access_token":"TSTBsecret"}', "Bearer TSTBsecret", "TSTB secret", "TSTB\nsecret"]) {
    blobs.clear();
    setEnv({ META_CAPI_ACCESS_TOKEN: bad });
    const queued = await enqueuePurchase(ORDER);
    const result = await processOutboxKey(queued.key);
    assert.equal(result.ok, false);
    assert.equal(result.recoverable, true);
    const saved = blobs.get(queued.key).data;
    assert.equal(saved.lastErrorClass, "config");
    assert.match(saved.lastError, /META_CAPI_ACCESS_TOKEN con formato inválido/);
    assert.ok(!saved.lastError.includes("TSTBsecret"));
    assert.ok(Date.parse(saved.nextAttemptAt) > Date.now(), "debe quedar programado para recuperarse");
  }

  assert.equal(calls.length, 0);
  assert.ok(!logs.join("\n").includes("TSTBsecret"), "el valor del token se filtró a los logs");
});

test("190 de Meta: queda recuperable con espera larga, sin filtrar el token y sin lanzar excepción", async t => {
  const logs = captureLogs(t);
  const rawStored = '"' + GOOD_TOKEN + '"\n';
  setEnv({ META_CAPI_ACCESS_TOKEN: rawStored });
  mockMeta(t, () => reply(400, { error: { message: "Invalid JSON for postcard " + rawStored.trim() + " / " + GOOD_TOKEN, type: "OAuthException", code: 190, fbtrace_id: "T190" } }));
  const queued = await enqueuePurchase(ORDER);

  const result = await processOutboxKey(queued.key);
  assert.deepEqual([result.ok, result.status, result.retryable, result.recoverable], [false, "error", false, true]);

  const saved = blobs.get(queued.key).data;
  assert.equal(saved.status, "error");
  assert.equal(saved.lastErrorClass, "auth");
  assert.equal(saved.lastHttpStatus, 400);
  assert.equal(saved.lastMetaError.code, 190);
  assert.equal(saved.lastMetaError.fbtraceId, "T190");
  const wait = Date.parse(saved.nextAttemptAt) - Date.now();
  assert.ok(wait > 10 * 60 * 1000 && wait <= 15 * 60 * 1000 + 5000, "primera espera de ~15 min, no 30 s");

  const everything = JSON.stringify([...blobs.values()]) + logs.join("\n");
  assert.ok(!everything.includes(GOOD_TOKEN), "el token se filtró");
  assert.ok(!everything.includes("access_token="), "la URL con token se filtró");
  const failedLog = logs.find(l => l.includes("meta_capi_failed"));
  assert.match(failedLog, /"errorClass":"auth"/);
  assert.match(failedLog, /"recoverable":true/);
});

test("recuperación: tras corregir el token el mismo evento se envía una sola vez (misma event_id) y no se duplica", async t => {
  captureLogs(t);
  setEnv({ META_CAPI_ACCESS_TOKEN: "TOKEN-VIEJO-INVALIDO" });
  const calls = mockMeta(t, n => n === 1
    ? reply(400, { error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190, fbtrace_id: "T1" } })
    : reply(200, { events_received: 1, fbtrace_id: "T2" }));
  const queued = await enqueuePurchase(ORDER);

  await processOutboxKey(queued.key);
  assert.equal(blobs.get(queued.key).data.status, "error");

  // Sin force, la espera programada se respeta (el barrido no martilla a Meta).
  const early = await processOutboxKey(queued.key);
  assert.equal(early.reason, "not_due");
  assert.equal(calls.length, 1);

  // El operador corrige el token y reprocesa desde el panel (force).
  setEnv({ META_CAPI_ACCESS_TOKEN: GOOD_TOKEN });
  const fixed = await processOutboxKey(queued.key, { force: true });
  assert.deepEqual([fixed.ok, fixed.status], [true, "sent"]);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].body).data[0].event_id, JSON.parse(calls[1].body).data[0].event_id);
  assert.equal(blobs.get(queued.key).data.status, "sent");

  // Ni el reproceso manual ni el barrido reenvían un evento ya enviado.
  for (const opts of [{ force: true }, {}]) {
    const again = await processOutboxKey(queued.key, opts);
    assert.equal(again.skipped, true);
  }
  assert.equal(calls.length, 2);
  assert.equal(blobs.size, 1, "no se crea otro registro de outbox");
});

test("evento ya guardado como error terminal (versión anterior, sin nextAttemptAt) se recupera con reproceso manual", async t => {
  captureLogs(t);
  const calls = mockMeta(t, () => reply(200, { events_received: 1 }));
  const queued = await enqueuePurchase(ORDER);
  // Estado exacto que dejó el código anterior ante el 190.
  const legacy = {
    ...blobs.get(queued.key).data,
    status: "error", attempts: 1, nextAttemptAt: "", processingAt: "",
    lastHttpStatus: 400, lastError: "Meta CAPI rechazó Purchase (400)",
    lastMetaError: { code: 190, message: "Invalid JSON for postcard", type: "OAuthException", fbtraceId: "OLD" }
  };
  blobs.set(queued.key, { data: legacy, etag: "legacy-etag" });

  const result = await processOutboxKey(queued.key, { force: true });
  assert.deepEqual([result.ok, result.status], [true, "sent"]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body).data[0].event_id, ORDER.purchaseEventId);
  assert.equal(blobs.get(queued.key).data.lastError, "");
});

test("un evento en processing activo no se reenvía ni con force", async t => {
  captureLogs(t);
  const calls = mockMeta(t, () => reply(200, { events_received: 1 }));
  const queued = await enqueuePurchase(ORDER);
  blobs.set(queued.key, {
    data: { ...blobs.get(queued.key).data, status: "processing", processingAt: new Date().toISOString() },
    etag: "busy-etag"
  });
  const result = await processOutboxKey(queued.key, { force: true });
  assert.equal(result.reason, "busy");
  assert.equal(calls.length, 0);
});

test("un rechazo del evento (código 100) sigue siendo terminal; un 190 agota la recuperación tras 8 intentos", async t => {
  captureLogs(t);
  mockMeta(t, () => reply(400, { error: { message: "Invalid parameter", type: "OAuthException", code: 100, fbtrace_id: "T100" } }));
  const a = await enqueuePurchase(ORDER);
  const r = await processOutboxKey(a.key);
  assert.deepEqual([r.retryable, r.recoverable], [false, false]);
  assert.equal(blobs.get(a.key).data.nextAttemptAt, "");

  blobs.clear();
  t.mock.restoreAll();
  captureLogs(t);
  mockMeta(t, () => reply(400, { error: { message: "Invalid OAuth access token", code: 190, fbtrace_id: "T190" } }));
  const b = await enqueuePurchase(ORDER);
  blobs.set(b.key, { data: { ...blobs.get(b.key).data, attempts: 7 }, etag: "seven" });
  const last = await processOutboxKey(b.key, { force: true });
  assert.equal(last.recoverable, false);
  assert.equal(blobs.get(b.key).data.attempts, 8);
  assert.equal(blobs.get(b.key).data.nextAttemptAt, "");
});

test("fallos 5xx/red siguen reintentándose en segundos-minutos (política transitoria intacta)", async t => {
  captureLogs(t);
  mockMeta(t, () => reply(503, { error: { message: "down", code: 2, fbtrace_id: "T5" } }));
  const queued = await enqueuePurchase(ORDER);
  await assert.rejects(processOutboxKey(queued.key), /503/);
  const wait = Date.parse(blobs.get(queued.key).data.nextAttemptAt) - Date.now();
  assert.ok(wait > 0 && wait <= 60 * 1000, "primer reintento transitorio en ~30 s");
});
