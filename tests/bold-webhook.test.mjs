import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mock, test } from "node:test";

const state = new Map();
const etags = new Map();
let nextEtag = 0;
let orderUpdates = 0;
let outboxEnqueues = 0;
let outboxProcessCalls = 0;
let metaShouldFail = false;
let persistShouldFail = false;

const store = {
  async get(key) {
    if (persistShouldFail) throw new Error("persistencia caída");
    return state.has(key) ? structuredClone(state.get(key)) : null;
  },
  async getWithMetadata(key) {
    if (persistShouldFail) throw new Error("persistencia caída");
    return state.has(key)
      ? { data: structuredClone(state.get(key)), etag: etags.get(key) }
      : { data: null, etag: undefined };
  },
  async setJSON(key, value, options = {}) {
    if (persistShouldFail) throw new Error("persistencia caída");
    if (options.onlyIfNew && state.has(key)) return { modified: false };
    if (options.onlyIfMatch && etags.get(key) !== options.onlyIfMatch) return { modified: false };
    const etag = '"e' + (++nextEtag) + '"';
    state.set(key, structuredClone(value));
    etags.set(key, etag);
    return { modified: true, etag };
  }
};

const adminUrl = new URL("../netlify/functions/_admin.mjs", import.meta.url).href;
const ordersUrl = new URL("../netlify/functions/_orders.mjs", import.meta.url).href;
const outboxUrl = new URL("../netlify/functions/_meta-outbox.mjs", import.meta.url).href;
const coreUrl = new URL("../netlify/functions/_bold-webhook.mjs", import.meta.url).href;
const webhookUrl = new URL("../netlify/functions/bold-webhook.mjs", import.meta.url).href;

mock.module(adminUrl, {
  exports: {
    store,
    getJson: async (key) => state.has(key) ? structuredClone(state.get(key)) : null
  }
});

mock.module(ordersUrl, {
  exports: {
    safeReference(value) {
      const ref = String(value ?? "").trim();
      return /^[A-Za-z0-9_-]{1,80}$/.test(ref) ? ref : "";
    },
    applyBoldPaymentEvent(existing, event) {
      orderUpdates++;
      const type = String(event.type);
      const paymentStatus =
        type === "SALE_APPROVED" ? "aprobado" :
        type === "SALE_REJECTED" ? "rechazado" :
        type === "VOID_APPROVED" ? "anulado" :
        "rechazado";
      return {
        ...existing,
        paymentStatus,
        paymentId: event.data?.payment_id || event.subject || "",
        webhookType: type,
        webhookEventId: event.id,
        confirmedAmount: Number(event.data?.amount?.total),
        confirmedCurrency: String(event.data?.amount?.currency || "")
      };
    }
  }
});

mock.module(outboxUrl, {
  exports: {
    async enqueuePurchase() {
      outboxEnqueues++;
      return { key: "meta-outbox/purchase_test", created: true };
    },
    async processOutboxKey() {
      outboxProcessCalls++;
      if (metaShouldFail) throw new Error("Meta caída");
      return { ok: true, status: "sent" };
    }
  }
});

const core = await import(coreUrl);
const webhook = await import(webhookUrl);

function put(key, value) {
  state.set(key, structuredClone(value));
  etags.set(key, '"seed-' + (++nextEtag) + '"');
}

function reset() {
  state.clear();
  etags.clear();
  nextEtag = 0;
  orderUpdates = 0;
  outboxEnqueues = 0;
  outboxProcessCalls = 0;
  metaShouldFail = false;
  persistShouldFail = false;
}

function event(overrides = {}) {
  return {
    id: "evt-test-1",
    type: "SALE_APPROVED",
    subject: "PAY-TEST-1",
    time: 1761063334000000000,
    data: {
      payment_id: "PAY-TEST-1",
      amount: { currency: "COP", total: 199900 },
      metadata: { reference: "MF-TEST-1" },
      payment_method: "CARD_WEB"
    },
    ...overrides
  };
}

function signature(body, secret = "") {
  const encoded = Buffer.from(body, "utf8").toString("base64");
  return crypto.createHmac("sha256", secret).update(encoded).digest("hex");
}

function req(body, sig, method = "POST") {
  return new Request("https://example.test/.netlify/functions/bold-webhook", {
    method,
    headers: sig ? { "x-bold-signature": sig, "content-type": "application/json" } : {},
    body: method === "POST" ? body : undefined
  });
}

test("firma válida con clave vacía en pruebas y firma inválida", () => {
  const body = JSON.stringify(event());
  assert.equal(webhook.validSignature(body, signature(body, ""), ""), true);
  assert.equal(webhook.validSignature(body, signature(body, "test-secret"), ""), false);
  assert.equal(webhook.validSignature(body, "not-a-hmac", "test-secret"), false);
});

test("selección de secreto: vacío solo fuera de producción", () => {
  assert.equal(webhook.getBoldWebhookSecret({ CONTEXT: "branch-deploy", BOLD_SECRET_KEY: "prod-secret" }), "");
  assert.equal(webhook.getBoldWebhookSecret({ CONTEXT: "deploy-preview", BOLD_SECRET_KEY: "prod-secret" }), "");
  assert.equal(webhook.getBoldWebhookSecret({ CONTEXT: "production", BOLD_SECRET_KEY: "prod-secret" }), "prod-secret");
  assert.equal(webhook.getBoldWebhookSecret({ CONTEXT: "production" }), "");
});

test("JSON malformado y método HTTP", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  const malformed = "{not-json";
  const response = await webhook.default(req(malformed, signature(malformed)));
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "JSON inválido");

  const getResponse = await webhook.default(req("", "", "GET"));
  assert.equal(getResponse.status, 405);
});

test("evento sin ID o tipo no permitido", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  for (const bad of [
    event({ id: "" }),
    event({ type: "PROCESSING" })
  ]) {
    const body = JSON.stringify(bad);
    const response = await webhook.default(req(body, signature(body)));
    assert.equal(response.status, 400);
  }
});

test("persistencia inicial falla y no responde 200", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  persistShouldFail = true;
  const body = JSON.stringify(event());
  const response = await webhook.default(req(body, signature(body)));
  assert.equal(response.status, 500);
});

test("venta aprobada valida importe/moneda, actualiza pedido y crea outbox", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  put("orders/MF-TEST-1", {
    reference: "MF-TEST-1",
    total: 199900,
    paymentStatus: "pendiente"
  });
  const body = JSON.stringify(event());
  let background;
  const response = await webhook.default(req(body, signature(body)), { waitUntil(p) { background = p; } });
  assert.equal(response.status, 200);
  assert.ok(background, "waitUntil debe recibir el trabajo");
  await background;
  const order = state.get("orders/MF-TEST-1");
  const inbox = state.get("webhook-inbox/evt-test-1");
  assert.equal(order.paymentStatus, "aprobado");
  assert.equal(order.confirmedAmount, 199900);
  assert.equal(order.confirmedCurrency, "COP");
  assert.equal(inbox.status, "processed");
  assert.equal(outboxEnqueues, 1);
  assert.equal(outboxProcessCalls, 1);
});

test("referencia inexistente termina en error recuperable del inbox", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  const body = JSON.stringify(event({ id: "evt-missing" }));
  let background;
  const response = await webhook.default(req(body, signature(body)), { waitUntil(p) { background = p; } });
  assert.equal(response.status, 200);
  await background;
  const inbox = state.get("webhook-inbox/evt-missing");
  assert.equal(inbox.status, "error");
  assert.match(inbox.lastError, /Pedido no encontrado/);
});

test("importe o moneda incorrectos no permiten aprobar", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  put("orders/MF-TEST-1", { reference: "MF-TEST-1", total: 199900, paymentStatus: "pendiente" });
  const wrongAmount = event({
    id: "evt-wrong-amount",
    data: { ...event().data, amount: { currency: "COP", total: 1 } }
  });
  let background;
  const response = await webhook.default(req(JSON.stringify(wrongAmount), signature(JSON.stringify(wrongAmount))), { waitUntil(p) { background = p; } });
  assert.equal(response.status, 200);
  await background;
  assert.equal(state.get("orders/MF-TEST-1").paymentStatus, "pendiente");
  assert.equal(state.get("webhook-inbox/evt-wrong-amount").status, "error");
});

test("rechazada y anulada actualizan el estado correspondiente", async () => {
  for (const [id, type, expected] of [
    ["evt-rejected", "SALE_REJECTED", "rechazado"],
    ["evt-void", "VOID_APPROVED", "anulado"],
    ["evt-void-rejected", "VOID_REJECTED", "rechazado"]
  ]) {
    reset();
    process.env.CONTEXT = "branch-deploy";
    put("orders/MF-TEST-1", { reference: "MF-TEST-1", total: 199900, paymentStatus: "pendiente" });
    const e = event({ id, type });
    const body = JSON.stringify(e);
    let background;
    const response = await webhook.default(req(body, signature(body)), { waitUntil(p) { background = p; } });
    assert.equal(response.status, 200);
    await background;
    assert.equal(state.get("orders/MF-TEST-1").paymentStatus, expected);
  }
});

test("referencia LNK_ inexistente no se resuelve y no actualiza pedidos", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  put("orders/MF-TEST-1", { reference: "MF-TEST-1", total: 199900, paymentStatus: "pendiente" });
  const e = event({
    id: "evt-unresolved-link",
    data: { ...event().data, metadata: { reference: "LNK_MISSING_TEST" } }
  });
  const resultPromise = core.processBoldWebhook(e);
  await assert.rejects(resultPromise, /referencia resoluble/);
  assert.equal(state.get("orders/MF-TEST-1").paymentStatus, "pendiente");
  assert.equal(state.get("webhook-inbox/evt-unresolved-link").status, "processing");
});


test("duplicados y concurrencia procesan una sola vez", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  state.set("orders/MF-TEST-1", { reference: "MF-TEST-1", total: 199900, paymentStatus: "pendiente" });
  const e = event({ id: "evt-concurrent" });
  const [a, b] = await Promise.all([core.processBoldWebhook(e), core.processBoldWebhook(e)]);
  assert.equal(Number(a.duplicate) + Number(b.duplicate) + Number(a.busy) + Number(b.busy), 1);
  assert.equal(orderUpdates, 1);
  assert.equal(outboxEnqueues, 1);
});

test("Meta CAPI fallido no deshace la aprobación ni marca el inbox como error", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  metaShouldFail = true;
  state.set("orders/MF-TEST-1", { reference: "MF-TEST-1", total: 199900, paymentStatus: "pendiente" });
  const e = event({ id: "evt-meta-fail" });
  const body = JSON.stringify(e);
  let background;
  const response = await webhook.default(req(body, signature(body)), { waitUntil(p) { background = p; } });
  assert.equal(response.status, 200);
  await background;
  assert.equal(state.get("orders/MF-TEST-1").paymentStatus, "aprobado");
  assert.equal(state.get("webhook-inbox/evt-meta-fail").status, "processed");
  assert.equal(outboxProcessCalls, 1);
});

test("evento duplicado ya procesado no vuelve a llamar el procesamiento", async () => {
  reset();
  process.env.CONTEXT = "branch-deploy";
  state.set("webhook-inbox/evt-processed", {
    id: "evt-processed",
    type: "SALE_APPROVED",
    status: "processed",
    processedAt: new Date().toISOString(),
    reference: "MF-TEST-1",
    event: event({ id: "evt-processed" })
  });
  const result = await core.processBoldWebhook(event({ id: "evt-processed" }));
  assert.equal(result.duplicate, true);
  assert.equal(orderUpdates, 0);
});

console.log("bold-webhook targeted tests: PASS");
