// Regresión del webhook de Bold con el código real de _orders, _meta, _meta-outbox,
// _whatsapp y _bold-webhook. Solo se simulan: el almacén de Blobs (_admin.mjs) y fetch.
// Todos los datos y credenciales son ficticios.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mock, test } from "node:test";

process.env.META_CAPI_ACCESS_TOKEN = "test-meta-token-not-real";
process.env.META_GRAPH_API_VERSION = "v24.0";
process.env.WHATSAPP_ACCESS_TOKEN = "test-wa-token-not-real";
process.env.WHATSAPP_PHONE_NUMBER_ID = "100200300";
delete process.env.META_TEST_EVENT_CODE;
delete process.env.META_DATASET_ID;

const state = new Map();
const etags = new Map();
let nextEtag = 0;

const store = {
  async get(key) { return state.has(key) ? structuredClone(state.get(key)) : null; },
  async getWithMetadata(key) {
    return state.has(key)
      ? { data: structuredClone(state.get(key)), etag: etags.get(key) }
      : { data: null, etag: undefined };
  },
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && state.has(key)) return { modified: false };
    if (options.onlyIfMatch && etags.get(key) !== options.onlyIfMatch) return { modified: false };
    const etag = '"e' + (++nextEtag) + '"';
    state.set(key, structuredClone(value));
    etags.set(key, etag);
    return { modified: true, etag };
  },
  async list({ prefix = "" } = {}) {
    return { blobs: [...state.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
  }
};

const fnUrl = name => new URL("../netlify/functions/" + name, import.meta.url).href;

// CI usa Node 24 (opción `exports`); Node 22 solo conoce `namedExports`.
function mockModule(url, exports) {
  const major = Number(process.versions.node.split(".")[0]);
  mock.module(url, major >= 24 ? { exports } : { namedExports: exports });
}

mockModule(fnUrl("_admin.mjs"), {
  store,
  getJson: async key => state.has(key) ? structuredClone(state.get(key)) : null,
  json: (data, status = 200) => Response.json(data, { status }),
  requireAdmin: () => null
});

const calls = { meta: [], whatsapp: [], form: [] };
let metaStatus = 200;
let whatsappStatus = 200;
const logs = [];

mock.method(globalThis, "fetch", async (url, options = {}) => {
  const u = new URL(url);
  if (u.hostname === "graph.facebook.com" && u.pathname.endsWith("/events")) {
    calls.meta.push({ url: u, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(metaStatus === 200 ? { events_received: 1 } : { error: { message: "fallo simulado" } }), { status: metaStatus });
  }
  if (u.hostname === "graph.facebook.com" && u.pathname.endsWith("/messages")) {
    calls.whatsapp.push({ url: u, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(whatsappStatus === 200 ? { messages: [{ id: "wamid.TEST" }] } : { error: { message: "fallo simulado" } }), { status: whatsappStatus });
  }
  if (u.origin === "https://example.test") {
    calls.form.push({ method: options.method, body: String(options.body || "") });
    return new Response("OK", { status: 200 });
  }
  throw new Error("fetch inesperado hacia " + u.origin);
});
for (const level of ["error", "warn", "log"]) {
  mock.method(console, level, (...args) => { logs.push(args.map(a => String(a?.message || a)).join(" ")); });
}

const core = await import(fnUrl("_bold-webhook.mjs"));
const webhook = await import(fnUrl("bold-webhook.mjs"));
const retry = await import(fnUrl("bold-webhook-retry.mjs"));
const replay = await import(fnUrl("webhook-replay.mjs"));
const metaOutbox = await import(fnUrl("_meta-outbox.mjs"));
const whatsapp = await import(fnUrl("_whatsapp.mjs"));

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const ORDER_KEY = "orders/MF-TEST-1";
const PURCHASE_ID = "purchase_MF-TEST-1_PAY-TEST-1";
const PAYER = "pagador.secreto@example.com";

function put(key, value) {
  state.set(key, structuredClone(value));
  etags.set(key, '"seed-' + (++nextEtag) + '"');
}

function reset() {
  state.clear(); etags.clear(); nextEtag = 0;
  calls.meta.length = 0; calls.whatsapp.length = 0; calls.form.length = 0;
  logs.length = 0;
  metaStatus = 200; whatsappStatus = 200;
  process.env.CONTEXT = "branch-deploy";
}

function order(overrides = {}) {
  return {
    reference: "MF-TEST-1",
    total: 199900,
    paymentStatus: "pendiente",
    name: "María Fernanda Pérez",
    phone: "300 123 4567",
    address: "Calle 1 # 2-3",
    city: "Bogotá",
    fbp: "fb.1.123.456",
    clientUserAgent: "UA-test",
    eventSourceUrl: "https://example.test/checkout",
    items: [{ id: "p1", name: "Sandalia", size: "37", color: "negro", qty: 1, unitPrice: 179900 }],
    ...overrides
  };
}

function event(overrides = {}, amount = { currency: "COP", total: 199900 }) {
  return {
    id: "evt-test-1",
    type: "SALE_APPROVED",
    subject: "PAY-TEST-1",
    time: 1761063334000000000,
    data: {
      payment_id: "PAY-TEST-1",
      amount,
      metadata: { reference: "MF-TEST-1" },
      payment_method: "CARD_WEB",
      payer_email: PAYER
    },
    ...overrides
  };
}

function signature(body, secret = "") {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8").toString("base64")).digest("hex");
}

function request(body, sig, method = "POST") {
  return new Request("https://example.test/.netlify/functions/bold-webhook", {
    method,
    headers: sig ? { "x-bold-signature": sig, "content-type": "application/json" } : {},
    body: method === "POST" ? body : undefined
  });
}

async function deliver(e, sig) {
  const body = JSON.stringify(e);
  let background;
  const response = await webhook.default(request(body, sig ?? signature(body)), { waitUntil(p) { background = p; } });
  await background;
  return response;
}

const inbox = id => state.get("webhook-inbox/" + id);
const keysWith = prefix => [...state.keys()].filter(k => k.startsWith(prefix));
const logLine = evt => logs.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(l => l?.evt === evt);

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---------------------------------------------------------------- firma
test("firma: HMAC Base64 válido; cuerpo alterado, otra llave, cabecera ausente o malformada se rechazan", () => {
  const body = JSON.stringify(event());
  assert.equal(webhook.validSignature(body, signature(body, "k"), "k"), true);
  assert.equal(webhook.validSignature(body + " ", signature(body, "k"), "k"), false);
  assert.equal(webhook.validSignature(body, signature(body, "otra"), "k"), false);
  assert.equal(webhook.validSignature(body, "", "k"), false);
  assert.equal(webhook.validSignature(body, null, "k"), false);
  assert.equal(webhook.validSignature(body, "abc", "k"), false);
  assert.equal(webhook.validSignature(body, "z".repeat(64), "k"), false);
});

test("firma inválida: 400, no se escribe nada, no se llama a ningún servicio y no se registra la firma ni el cuerpo", async () => {
  reset();
  put(ORDER_KEY, order());
  const before = JSON.stringify([...state.entries()]);
  const body = JSON.stringify(event());
  const bad = signature(body, "llave-incorrecta");
  const response = await webhook.default(request(body, bad));
  assert.equal(response.status, 400);
  assert.equal(JSON.stringify([...state.entries()]), before);
  assert.deepEqual([calls.meta.length, calls.whatsapp.length, calls.form.length], [0, 0, 0]);
  const text = logs.join("\n");
  assert.equal(text.includes(bad), false, "no registra la firma recibida");
  assert.equal(text.includes("llave-incorrecta"), false);
  assert.equal(text.includes(PAYER), false, "no registra el cuerpo");
});

const PROD = { CONTEXT: "production", BOLD_API_KEY: "identidad-publica-ficticia", BOLD_SECRET_KEY: "secreta-ficticia" };

test("producción: sin BOLD_SECRET_KEY responde 500 aunque exista BOLD_API_KEY (sin respaldo) y no procesa nada", async () => {
  for (const secretValue of [undefined, "", "   "]) {
    reset();
    put(ORDER_KEY, order());
    const before = JSON.stringify([...state.entries()]);
    await withEnv({ ...PROD, BOLD_SECRET_KEY: secretValue }, async () => {
      const body = JSON.stringify(event());
      for (const key of ["identidad-publica-ficticia", ""]) {
        const response = await webhook.default(request(body, signature(body, key)));
        assert.equal(response.status, 500, "clave de firma usada por el atacante: " + (key || "(vacía)"));
      }
    });
    assert.equal(JSON.stringify([...state.entries()]), before);
    assert.deepEqual([calls.meta.length, calls.whatsapp.length, calls.form.length], [0, 0, 0]);
    assert.ok(logs.some(l => l.includes("BOLD_SECRET_KEY no está configurada")));
  }
});

test("producción: solo BOLD_SECRET_KEY firma; la llave de identidad, la vacía y las ajenas se rechazan con 400 sin escribir nada", async () => {
  reset();
  put(ORDER_KEY, order());
  await withEnv(PROD, async () => {
    const body = JSON.stringify(event());
    const before = JSON.stringify([...state.entries()]);
    for (const forged of ["identidad-publica-ficticia", "", "atacante"]) {
      const response = await webhook.default(request(body, signature(body, forged)));
      assert.equal(response.status, 400, "no debe aceptar la llave: " + (forged || "(vacía)"));
    }
    assert.equal(JSON.stringify([...state.entries()]), before);
    assert.deepEqual([calls.meta.length, calls.whatsapp.length, calls.form.length], [0, 0, 0]);

    const ok = await deliver(event(), signature(body, "secreta-ficticia"));
    assert.equal(ok.status, 200);
  });
  assert.equal(state.get(ORDER_KEY).paymentStatus, "aprobado");
  assert.equal(inbox("evt-test-1").status, "processed");
  const exposed = logs.join("\n");
  for (const secret of ["identidad-publica-ficticia", "secreta-ficticia", "atacante"]) {
    assert.equal(exposed.includes(secret), false, "los logs no deben contener llaves");
  }
});

test("producción con firma válida pero importe incorrecto: la firma pasa, el pedido NO se aprueba y el rechazo es terminal", async () => {
  reset();
  put(ORDER_KEY, order());
  await withEnv(PROD, async () => {
    const e = event({}, { currency: "COP", total: 1 });
    const body = JSON.stringify(e);
    const response = await deliver(e, signature(body, "secreta-ficticia"));
    assert.equal(response.status, 200);
  });
  assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
  assert.equal(inbox("evt-test-1").lastErrorCode, "AMOUNT_MISMATCH");
  assert.equal(inbox("evt-test-1").terminal, true);
});

test("fuera de producción se mantiene la clave vacía de pruebas de Bold e ignora ambas llaves", async () => {
  for (const context of ["branch-deploy", "deploy-preview", "dev"]) {
    reset();
    put(ORDER_KEY, order());
    await withEnv({ ...PROD, CONTEXT: context }, async () => {
      const body = JSON.stringify(event());
      assert.equal((await webhook.default(request(body, signature(body, "secreta-ficticia")))).status, 400);
      assert.equal((await webhook.default(request(body, signature(body, "identidad-publica-ficticia")))).status, 400);
      assert.equal((await deliver(event(), signature(body, ""))).status, 200);
    });
    assert.equal(state.get(ORDER_KEY).paymentStatus, "aprobado", context);
  }
});

test("BOLD_API_KEY sigue reservada a las consultas de API: el webhook no la referencia y las funciones de API la siguen usando", async () => {
  const { readFile } = await import("node:fs/promises");
  // Solo código: se ignoran los comentarios de línea (el comentario explica por qué no se usa).
  const read = async name => (await readFile(new URL("../netlify/functions/" + name, import.meta.url), "utf8"))
    .split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  assert.equal((await read("bold-webhook.mjs")).includes("BOLD_API_KEY"), false);
  assert.equal((await read("_bold-webhook.mjs")).includes("BOLD_API_KEY"), false);
  for (const name of ["bold-status.mjs", "admin-bold.mjs", "order-status.mjs", "crear-link-pago.mjs"]) {
    assert.ok((await read(name)).includes("BOLD_API_KEY"), name + " debe seguir usando BOLD_API_KEY para la API");
  }
  assert.ok((await read("crear-link-pago.mjs")).includes("BOLD_SECRET_KEY"), "el checkout ya depende de BOLD_SECRET_KEY");
});

test("un importe rechazado no cambia la validación de firma: con firma válida responde 200 y deja el error en el inbox", async () => {
  reset();
  put(ORDER_KEY, order());
  const response = await deliver(event({}, { currency: "COP", total: 1 }));
  assert.equal(response.status, 200);
  assert.equal(inbox("evt-test-1").lastErrorCode, "AMOUNT_MISMATCH");
});


// ---------------------------------------------------------------- importe
test("importe distinto: no aprueba, registra diagnóstico seguro y el error es terminal", async () => {
  reset();
  put(ORDER_KEY, order());
  const response = await deliver(event({}, { currency: "COP", total: 1 }));
  assert.equal(response.status, 200);

  assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
  const item = inbox("evt-test-1");
  assert.equal(item.status, "error");
  assert.equal(item.lastErrorCode, "AMOUNT_MISMATCH");
  assert.match(item.lastError, /no coincide con el pedido/);
  assert.equal(item.terminal, true);
  assert.equal(item.nextAttemptAt, "");
  assert.equal(item.attempts, 1);
  const d = item.lastErrorDetail;
  assert.equal(d.reference, "MF-TEST-1");
  assert.equal(d.eventId, "evt-test-1");
  assert.equal(d.eventType, "SALE_APPROVED");
  assert.equal(d.currency, "COP");
  assert.equal(d.boldTotal, 1);
  assert.equal(d.orderTotal, 199900);
  assert.equal(d.difference, -199899);
  assert.equal(d.boldTotalType, "number");
  assert.equal(d.orderTotalType, "number");

  const line = logLine("bold_webhook_amount_rejected");
  assert.ok(line, "debe existir un log JSON bold_webhook_amount_rejected");
  assert.equal(line.code, "AMOUNT_MISMATCH");
  assert.equal(line.reference, "MF-TEST-1");
  assert.equal(line.boldTotal, 1);
  assert.equal(line.orderTotal, 199900);

  const exposed = logs.join("\n") + JSON.stringify(item.lastErrorDetail);
  for (const secret of [PAYER, "María", "Pérez", "3001234567", "300 123 4567", "Calle 1", "test-meta-token", "test-wa-token"]) {
    assert.equal(exposed.includes(secret), false, "no debe exponer " + secret);
  }
  assert.deepEqual([calls.meta.length, calls.whatsapp.length, calls.form.length], [0, 0, 0]);
  assert.equal(keysWith("meta-outbox/").length, 0);
});

test("importe ausente, nulo, vacío o no numérico se reporta como inválido y no como importe 0", async () => {
  const variants = [
    { currency: "COP", total: null },
    { currency: "COP", total: "" },
    { currency: "COP", total: "abc" },
    { currency: "COP", total: true },
    { currency: "COP" },
    undefined
  ];
  for (const amount of variants) {
    reset();
    put(ORDER_KEY, order());
    const e = event({}, amount);
    if (amount === undefined) delete e.data.amount;
    await deliver(e);
    const item = inbox("evt-test-1");
    assert.equal(item.lastErrorCode, "AMOUNT_INVALID", JSON.stringify(amount));
    assert.equal(item.terminal, true);
    assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
  }
});

test("moneda distinta de COP o ausente se rechaza", async () => {
  for (const currency of ["USD", ""]) {
    reset();
    put(ORDER_KEY, order());
    await deliver(event({}, { currency, total: 199900 }));
    const item = inbox("evt-test-1");
    assert.equal(item.lastErrorCode, "CURRENCY_INVALID");
    assert.equal(item.lastErrorDetail.currency, currency);
    assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
  }
});

test("pedido sin total numérico se distingue de un importe distinto", async () => {
  for (const total of [undefined, null, ""]) {
    reset();
    put(ORDER_KEY, order({ total }));
    await deliver(event());
    const item = inbox("evt-test-1");
    assert.equal(item.lastErrorCode, "ORDER_TOTAL_INVALID", String(total));
    assert.equal(item.lastErrorDetail.orderTotal, null);
    assert.equal(item.lastErrorDetail.boldTotal, 199900);
    assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
  }
});

test("total del pedido guardado con formato de miles: sigue rechazándose y el diagnóstico muestra el valor crudo", async () => {
  reset();
  put(ORDER_KEY, order({ total: "199.900" }));
  await deliver(event());
  const item = inbox("evt-test-1");
  assert.equal(item.lastErrorCode, "AMOUNT_MISMATCH");
  assert.equal(item.lastErrorDetail.orderTotalRaw, "199.900");
  assert.equal(item.lastErrorDetail.orderTotalType, "string");
  assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
});

test("importes equivalentes (entero, texto, decimal .00) sí coinciden", async () => {
  for (const total of [199900, "199900", "199900.00", 199900.0]) {
    reset();
    put(ORDER_KEY, order());
    await deliver(event({}, { currency: "COP", total }));
    assert.equal(state.get(ORDER_KEY).paymentStatus, "aprobado", String(total));
    assert.equal(state.get(ORDER_KEY).confirmedAmount, 199900);
  }
});

test("referencia LNK_ se resuelve por el mapeo y valida el importe del pedido real", async () => {
  reset();
  put(ORDER_KEY, order());
  put("bold-links/LNK_TEST", { reference: "MF-TEST-1" });
  const e = event({}, { currency: "COP", total: 199900 });
  e.data.metadata.reference = "LNK_TEST";
  await deliver(e);
  assert.equal(state.get(ORDER_KEY).paymentStatus, "aprobado");
  assert.equal(inbox("evt-test-1").reference, "MF-TEST-1");
});

// ---------------------------------------------------------------- flujo completo
test("SALE_APPROVED: actualiza pedido, envía Purchase a Meta y WhatsApp, registra formulario", async () => {
  reset();
  put(ORDER_KEY, order());
  const response = await deliver(event());
  assert.equal(response.status, 200);

  const saved = state.get(ORDER_KEY);
  assert.equal(saved.paymentStatus, "aprobado");
  assert.equal(saved.confirmedAmount, 199900);
  assert.equal(saved.confirmedCurrency, "COP");
  assert.equal(saved.paymentId, "PAY-TEST-1");
  assert.equal(saved.webhookType, "SALE_APPROVED");
  assert.equal(saved.purchaseEventId, PURCHASE_ID);
  assert.equal(saved.total, 199900);
  assert.ok(saved.whatsappConfirmationSentAt);
  assert.equal(inbox("evt-test-1").status, "processed");
  assert.equal(inbox("evt-test-1").reference, "MF-TEST-1");

  assert.equal(calls.meta.length, 1);
  const meta = calls.meta[0];
  assert.equal(meta.url.pathname, "/v24.0/1092821839891082/events");
  assert.equal(meta.url.searchParams.get("access_token"), "test-meta-token-not-real");
  const purchase = meta.body.data[0];
  assert.equal(purchase.event_name, "Purchase");
  assert.equal(purchase.event_id, PURCHASE_ID);
  assert.equal(purchase.event_time, 1761063334);
  assert.equal(purchase.action_source, "website");
  assert.equal(purchase.custom_data.value, 199900);
  assert.equal(purchase.custom_data.currency, "COP");
  assert.equal(purchase.custom_data.order_id, "MF-TEST-1");
  assert.deepEqual(purchase.custom_data.content_ids, ["p1"]);
  assert.deepEqual(purchase.user_data.fn, [sha256("maria")]);
  assert.deepEqual(purchase.user_data.ln, [sha256("fernanda perez")]);
  assert.deepEqual(purchase.user_data.ph, [sha256("3001234567")]);
  assert.equal(purchase.user_data.fbp, "fb.1.123.456");
  const metaText = JSON.stringify(meta.body);
  for (const plain of ["María", "Pérez", "3001234567", PAYER]) assert.equal(metaText.includes(plain), false);
  assert.equal(state.get("meta-outbox/" + PURCHASE_ID).status, "sent");

  assert.equal(calls.whatsapp.length, 1);
  const wa = calls.whatsapp[0];
  assert.equal(wa.url.pathname, "/v24.0/100200300/messages");
  assert.equal(wa.headers.Authorization, "Bearer test-wa-token-not-real");
  assert.equal(wa.body.messaging_product, "whatsapp");
  assert.equal(wa.body.to, "573001234567");
  assert.equal(wa.body.template.name, "confirmacion_compra_marlon");
  const params = wa.body.template.components[0].parameters.map(p => p.text);
  assert.equal(params[1], "MF-TEST-1");
  assert.ok(params[10].includes("199.900"), "el importe confirmado va en la plantilla");
  assert.equal(state.get("whatsapp-outbox/MF-TEST-1").status, "sent");

  assert.equal(calls.form.length, 1);
  assert.match(calls.form[0].body, /form-name=pagos-confirmados/);
  assert.match(calls.form[0].body, /estado=aprobado/);
});

// ---------------------------------------------------------------- idempotencia
test("idempotencia: el mismo evento entregado dos veces no repite pedido, Meta ni WhatsApp", async () => {
  reset();
  put(ORDER_KEY, order());
  await deliver(event());
  const afterFirst = JSON.stringify(state.get(ORDER_KEY));
  await deliver(event());
  assert.equal(JSON.stringify(state.get(ORDER_KEY)), afterFirst);
  assert.deepEqual([calls.meta.length, calls.whatsapp.length, calls.form.length], [1, 1, 1]);
});

test("idempotencia: otra entrega del mismo pago con distinto id de evento no duplica Purchase ni WhatsApp", async () => {
  reset();
  put(ORDER_KEY, order());
  await deliver(event());
  await deliver(event({ id: "evt-test-2" }));
  assert.equal(state.get(ORDER_KEY).purchaseEventId, PURCHASE_ID);
  assert.equal(keysWith("meta-outbox/").length, 1);
  assert.equal(keysWith("whatsapp-outbox/").length, 1);
  assert.equal(calls.meta.length, 1);
  assert.equal(calls.whatsapp.length, 1);
  assert.equal(inbox("evt-test-2").status, "processed");
});

test("idempotencia: dos procesamientos concurrentes del mismo evento actualizan una sola vez", async () => {
  reset();
  put(ORDER_KEY, order());
  const e = event({ id: "evt-concurrent" });
  const results = await Promise.all([core.processBoldWebhook(e), core.processBoldWebhook(e)]);
  assert.equal(results.filter(r => r.outboxKey).length, 1);
  assert.equal(results.filter(r => r.duplicate || r.busy).length, 1);
  assert.equal(keysWith("meta-outbox/").length, 1);
});

test("rechazo posterior no degrada un pago aprobado ni dispara servicios; rechazo inicial no envía nada", async () => {
  reset();
  put(ORDER_KEY, order());
  await deliver(event());
  await deliver(event({ id: "evt-rej", type: "SALE_REJECTED" }));
  assert.equal(state.get(ORDER_KEY).paymentStatus, "aprobado");
  assert.deepEqual([calls.meta.length, calls.whatsapp.length], [1, 1]);

  reset();
  put(ORDER_KEY, order());
  await deliver(event({ id: "evt-rej-1", type: "SALE_REJECTED" }));
  assert.equal(state.get(ORDER_KEY).paymentStatus, "rechazado");
  assert.deepEqual([calls.meta.length, calls.whatsapp.length], [0, 0]);
});

// ---------------------------------------------------------------- Meta / WhatsApp con fallos
test("Meta falla: el pedido queda aprobado, WhatsApp se envía y el reintento reutiliza el mismo event_id", async () => {
  reset();
  put(ORDER_KEY, order());
  metaStatus = 500;
  await deliver(event());
  assert.equal(state.get(ORDER_KEY).paymentStatus, "aprobado");
  assert.equal(inbox("evt-test-1").status, "processed");
  assert.equal(calls.whatsapp.length, 1);
  const key = "meta-outbox/" + PURCHASE_ID;
  assert.equal(state.get(key).status, "error");
  assert.equal(state.get(key).attempts, 1);
  assert.ok(Date.parse(state.get(key).nextAttemptAt) > Date.now());

  state.get(key).nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  metaStatus = 200;
  const result = await metaOutbox.processOutboxKey(key);
  assert.equal(result.status, "sent");
  assert.equal(calls.meta.length, 2);
  assert.equal(calls.meta[0].body.data[0].event_id, calls.meta[1].body.data[0].event_id);
  assert.equal((await metaOutbox.processOutboxKey(key)).reason, "sent");
  assert.equal(calls.meta.length, 2);
});

test("WhatsApp falla: error transitorio se reintenta una sola vez con éxito; error 4xx es terminal", async () => {
  reset();
  put(ORDER_KEY, order());
  whatsappStatus = 503;
  await deliver(event());
  assert.equal(state.get(ORDER_KEY).paymentStatus, "aprobado");
  assert.equal(calls.meta.length, 1);
  const key = "whatsapp-outbox/MF-TEST-1";
  assert.equal(state.get(key).status, "error");
  assert.ok(Date.parse(state.get(key).nextAttemptAt) > Date.now());
  assert.equal(state.get(ORDER_KEY).whatsappConfirmationSentAt, undefined);

  state.get(key).nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  whatsappStatus = 200;
  assert.equal((await whatsapp.processWhatsAppOutboxKey(key)).status, "sent");
  assert.equal(calls.whatsapp.length, 2);
  assert.ok(state.get(ORDER_KEY).whatsappConfirmationSentAt);
  assert.equal((await whatsapp.processWhatsAppOutboxKey(key)).reason, "sent");
  assert.equal(calls.whatsapp.length, 2);

  reset();
  put(ORDER_KEY, order());
  whatsappStatus = 400;
  await deliver(event());
  const terminal = state.get("whatsapp-outbox/MF-TEST-1");
  assert.equal(terminal.status, "error");
  assert.equal(terminal.nextAttemptAt, "");
  assert.equal((await whatsapp.processWhatsAppOutboxKey("whatsapp-outbox/MF-TEST-1")).reason, "terminal_error");
  assert.equal(calls.whatsapp.length, 1);
});

// ---------------------------------------------------------------- reintentos y reproceso
test("el reintento programado no vuelve a ejecutar un desajuste de importe ya diagnosticado", async () => {
  reset();
  put(ORDER_KEY, order());
  await deliver(event({}, { currency: "COP", total: 1 }));
  // Simula el paso del tiempo: si el fallo estuviera programado para reintento, ya vencería.
  const stored = state.get("webhook-inbox/evt-test-1");
  if (stored.nextAttemptAt) stored.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  logs.length = 0;
  await retry.default();
  const item = inbox("evt-test-1");
  assert.equal(item.attempts, 1);
  assert.equal(logLine("bold_webhook_amount_rejected"), undefined);
  assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
});

test("pedido inexistente es recuperable: el reintento procesa el evento cuando el pedido aparece", async () => {
  reset();
  await deliver(event());
  let item = inbox("evt-test-1");
  assert.equal(item.lastErrorCode, "ORDER_NOT_FOUND");
  assert.equal(item.terminal, false);
  assert.ok(Date.parse(item.nextAttemptAt) > Date.now());

  put(ORDER_KEY, order());
  state.get("webhook-inbox/evt-test-1").nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  await retry.default();
  item = inbox("evt-test-1");
  assert.equal(item.status, "processed");
  assert.equal(state.get(ORDER_KEY).paymentStatus, "aprobado");
  assert.equal(state.get("meta-outbox/" + PURCHASE_ID).status, "pending");
});

test("reproceso manual: un importe distinto sigue rechazándose y se informa con código y detalle", async () => {
  reset();
  put(ORDER_KEY, order());
  await deliver(event({}, { currency: "COP", total: 1 }));

  const listing = await (await replay.default(new Request("https://example.test/x", { method: "GET" }))).json();
  const row = listing.events.find(e => e.id === "evt-test-1");
  assert.equal(row.lastErrorCode, "AMOUNT_MISMATCH");
  assert.equal(row.lastErrorDetail.boldTotal, 1);
  assert.equal(row.terminal, true);

  const response = await replay.default(new Request("https://example.test/x", {
    method: "POST", body: JSON.stringify({ eventId: "evt-test-1" })
  }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "AMOUNT_MISMATCH");
  assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
  assert.equal(inbox("evt-test-1").attempts, 2);
});

// ---------------------------------------------------------------- unidades puras
const failure = await import(fnUrl("_bold-failure.mjs"));

test("parseAmount: solo números finitos o texto numérico; null, vacío, booleanos y estructuras dan NaN", () => {
  for (const ok of [[199900, 199900], ["199900", 199900], ["199900.00", 199900], [" 5 ", 5], [0, 0]]) {
    assert.equal(core.parseAmount(ok[0]), ok[1], String(ok[0]));
  }
  for (const bad of [null, undefined, "", "  ", "abc", "1e5", "0x10", "-5", "1,5", true, false, [], [1], {}, NaN, Infinity]) {
    assert.ok(Number.isNaN(core.parseAmount(bad)), "debe ser NaN: " + JSON.stringify(bad));
  }
});

test("validateBoldAmount: devuelve el importe solo si moneda COP e importe coinciden exactamente", () => {
  assert.equal(core.validateBoldAmount({ total: 199900 }, event(), "MF-TEST-1"), 199900);
  const code = (o, e) => { try { core.validateBoldAmount(o, e, "MF-TEST-1"); return "OK"; } catch (err) { return err.code + ":" + err.retryable; } };
  assert.equal(code({ total: 199900 }, event({}, { currency: "COP", total: 199901 })), "AMOUNT_MISMATCH:false");
  assert.equal(code({ total: 199900 }, event({}, { currency: "COP", total: null })), "AMOUNT_INVALID:false");
  assert.equal(code({ total: 199900 }, event({}, { currency: "usd", total: 199900 })), "CURRENCY_INVALID:false");
  assert.equal(code({}, event()), "ORDER_TOTAL_INVALID:false");
});

test("buildInboxFailure: validación terminal sin reprogramar; error sin código reintenta con backoff y termina tras el máximo", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const terminal = failure.buildInboxFailure({ attempts: 0 }, new failure.BoldWebhookError("AMOUNT_MISMATCH", "x", { details: { a: 1 } }), now);
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.nextAttemptAt, "");
  assert.equal(terminal.lastErrorCode, "AMOUNT_MISMATCH");
  assert.deepEqual(terminal.lastErrorDetail, { a: 1 });

  const transient = failure.buildInboxFailure({ attempts: 1, lastErrorDetail: { stale: true } }, new Error("red caída"), now);
  assert.equal(transient.terminal, false);
  assert.equal(transient.lastErrorCode, "");
  assert.equal(transient.lastErrorDetail, undefined);
  assert.equal(transient.nextAttemptAt, new Date(now + 60 * 1000).toISOString());

  const exhausted = failure.buildInboxFailure({ attempts: failure.MAX_INBOX_ATTEMPTS - 1 }, new Error("red caída"), now);
  assert.equal(exhausted.terminal, true);
  assert.equal(exhausted.nextAttemptAt, "");

  const recoverable = failure.buildInboxFailure({}, new failure.BoldWebhookError("ORDER_NOT_FOUND", "x", { retryable: true }), now);
  assert.equal(recoverable.terminal, false);
  assert.ok(recoverable.nextAttemptAt);
});

test("un fallo transitorio (persistencia) sigue siendo recuperable y no se confunde con un rechazo de importe", async () => {
  reset();
  put(ORDER_KEY, order());
  const realSet = store.setJSON;
  store.setJSON = async (key, value, options) => {
    if (key === ORDER_KEY) throw new Error("persistencia caída");
    return realSet(key, value, options);
  };
  try { await deliver(event()); } finally { store.setJSON = realSet; }
  const item = inbox("evt-test-1");
  assert.equal(item.status, "error");
  assert.equal(item.lastErrorCode, "");
  assert.equal(item.terminal, false);
  assert.ok(Date.parse(item.nextAttemptAt) > Date.now());
  assert.equal(state.get(ORDER_KEY).paymentStatus, "pendiente");
});

console.log("bold-webhook-amount regression tests: PASS");
