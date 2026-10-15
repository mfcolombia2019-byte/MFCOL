// SIMULATED: in-memory fakes (see tests/helpers/bold-webhook-harness.mjs).
// Models a deploy bound to the isolated non-production store (mfc-admin-nonprod).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAKE_IDENTITY_KEY, FAKE_SECRET_KEY, boldEvent, createHarness, makeRequest, sign
} from "./helpers/bold-webhook-harness.mjs";

const h = await createHarness({ storeName: "mfc-admin-nonprod" });
const PREVIEW = { deploy: { context: "deploy-preview" } };

function seedInbox(id, extra = {}) {
  h.state.set("webhook-inbox/" + id, {
    id, type: "SALE_APPROVED", status: "processing", processedAt: "", processingAt: new Date().toISOString(), event: boldEvent({ id }), ...extra
  });
}

test("preview/branch deploy: firma de clave vacía (modo pruebas) se acepta", async () => {
  for (const ctx of ["deploy-preview", "branch-deploy"]) {
    h.reset();
    const body = JSON.stringify(boldEvent({ id: "evt-" + ctx }));
    const response = await h.invoke(makeRequest(body, sign(body, "")), { deploy: { context: ctx } });
    assert.equal(response.status, 200, ctx);
    assert.ok(h.ops.some(o => o[0] === "processBoldWebhook"), ctx);
  }
});

test("preview no acepta firmas hechas con la llave secreta ni con la de identidad", async () => {
  h.reset();
  const body = JSON.stringify(boldEvent());
  for (const key of [FAKE_SECRET_KEY, FAKE_IDENTITY_KEY]) {
    const response = await h.invoke(makeRequest(body, sign(body, key)), PREVIEW);
    assert.equal(response.status, 400);
  }
  assert.equal(h.ops.length, 0);
});

test("contexto de producción con el almacén no-producción: falla cerrado antes de tocar datos", async () => {
  h.reset();
  const body = JSON.stringify(boldEvent());
  // Ni siquiera una firma válida debe permitir escribir un pedido en el almacén equivocado.
  const response = await h.invoke(makeRequest(body, sign(body, FAKE_SECRET_KEY)), { deploy: { context: "production" } });
  assert.equal(response.status, 500);
  assert.equal(h.ops.length, 0, "no debe haber ninguna operación de almacén");
  const evt = h.loggedEvents().find(e => e.evt === "bold_webhook_store_mismatch");
  assert.equal(evt.context, "production");
  assert.equal(evt.store, "mfc-admin-nonprod");
  assert.equal(evt.expectedStore, "mfc-admin");
});

test("producción solo vía process.env.CONTEXT (sin contexto de handler) con almacén no-producción también falla cerrado", async () => {
  h.reset();
  process.env.CONTEXT = "production";
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, sign(body, FAKE_SECRET_KEY)));
  assert.equal(response.status, 500);
  assert.equal(h.ops.length, 0);
});

test("fallo al persistir el inbox: 500, sin procesar y con registro", async () => {
  h.reset();
  h.flags.failEnsureInbox = true;
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, sign(body, "")), PREVIEW);
  assert.equal(response.status, 500);
  assert.ok(!h.ops.some(o => o[0] === "processBoldWebhook"));
  const evt = h.loggedEvents().find(e => e.evt === "bold_webhook_inbox_persist_failed");
  assert.equal(evt.eventId, "evt-regress-1");
  assert.match(evt.error, /persistencia caída/);
});

test("JSON inválido, evento sin ID o tipo no permitido: 400 y sin persistencia", async () => {
  h.reset();
  const bad = [
    "{not-json",
    JSON.stringify(boldEvent({ id: "" })),
    JSON.stringify(boldEvent({ type: "PROCESSING" }))
  ];
  for (const body of bad) {
    const response = await h.invoke(makeRequest(body, sign(body, "")), PREVIEW);
    assert.equal(response.status, 400, body);
  }
  assert.equal(h.ops.length, 0);
  const names = h.loggedEvents().map(e => e.evt);
  assert.ok(names.includes("bold_webhook_invalid_json"));
  assert.equal(names.filter(n => n === "bold_webhook_invalid_event").length, 2);
});

test("error de procesamiento: se registra en el inbox con reintento y se responde 200", async () => {
  h.reset();
  seedInbox("evt-regress-1");
  h.flags.processError = new Error("Pedido no encontrado para el webhook " + "x".repeat(900));
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, sign(body, "")), PREVIEW);
  assert.equal(response.status, 200);
  const inbox = h.state.get("webhook-inbox/evt-regress-1");
  assert.equal(inbox.status, "error");
  assert.equal(inbox.attempts, 1);
  assert.equal(inbox.lastError.length, 500, "el error persistido se trunca a 500 caracteres");
  assert.ok(Date.parse(inbox.nextAttemptAt) > Date.now(), "debe quedar programado un reintento");
  assert.equal(inbox.processingAt, "");
  const names = h.loggedEvents().map(e => e.evt);
  assert.ok(names.includes("bold_webhook_processing_error"));
  assert.ok(names.includes("bold_webhook_error_recorded"));
});

test("octavo intento fallido deja el evento sin reintento automático", async () => {
  h.reset();
  seedInbox("evt-regress-1", { attempts: 7, status: "error" });
  h.flags.processError = new Error("sigue fallando");
  const body = JSON.stringify(boldEvent());
  await h.invoke(makeRequest(body, sign(body, "")), PREVIEW);
  const inbox = h.state.get("webhook-inbox/evt-regress-1");
  assert.equal(inbox.attempts, 8);
  assert.equal(inbox.nextAttemptAt, "");
  const recorded = h.loggedEvents().find(e => e.evt === "bold_webhook_error_recorded");
  assert.equal(recorded.retryable, false);
});

test("si no se puede guardar el error, no hay excepción sin manejar y queda el registro del fallo", async () => {
  h.reset();
  seedInbox("evt-regress-1");
  h.flags.processError = new Error("fallo de negocio");
  h.flags.failSetJSON = true;
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, sign(body, "")), PREVIEW);
  assert.equal(response.status, 200);
  const names = h.loggedEvents().map(e => e.evt);
  assert.ok(names.includes("bold_webhook_processing_error"));
  assert.ok(names.includes("bold_webhook_error_persist_failed"));
  assert.ok(!names.includes("bold_webhook_error_recorded"));
});

test("idempotencia: un evento duplicado o en proceso no dispara efectos secundarios y se registra", async () => {
  h.reset();
  const body = JSON.stringify(boldEvent());
  let formPosts = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { formPosts++; return realFetch(...args); };
  try {
    h.flags.processResult = { ok: true, duplicate: true, reference: "MF-TEST-1" };
    assert.equal((await h.invoke(makeRequest(body, sign(body, "")), PREVIEW)).status, 200);
    h.flags.processResult = { ok: true, busy: true, reference: "MF-TEST-1" };
    assert.equal((await h.invoke(makeRequest(body, sign(body, "")), PREVIEW)).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(formPosts, 0);
  const skipped = h.loggedEvents().filter(e => e.evt === "bold_webhook_skipped");
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].duplicate, true);
  assert.equal(skipped[1].busy, true);
});

test("método distinto de POST: 405 sin tocar nada", async () => {
  h.reset();
  const response = await h.invoke(makeRequest("", "", "GET"), PREVIEW);
  assert.equal(response.status, 405);
  assert.equal(h.ops.length, 0);
});
