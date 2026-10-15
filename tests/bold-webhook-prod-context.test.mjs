// SIMULATED: in-memory fakes (see tests/helpers/bold-webhook-harness.mjs).
// The store bound by _admin.mjs is fixed at module load, so this file models a
// production deploy (mfc-admin); bold-webhook-nonprod-context.test.mjs models the rest.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAKE_IDENTITY_KEY, FAKE_SECRET_KEY, boldEvent, createHarness, makeRequest, sign
} from "./helpers/bold-webhook-harness.mjs";

const h = await createHarness({ storeName: "mfc-admin" });
const PROD = { deploy: { context: "production" } };

test("producción: firma calculada con la llave secreta se acepta y se procesa", async () => {
  h.reset();
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, sign(body, FAKE_SECRET_KEY)), PROD);
  assert.equal(response.status, 200);
  assert.deepEqual(h.ops.map(o => o[0]), ["ensureInbox", "processBoldWebhook"]);
  const received = h.loggedEvents().find(e => e.evt === "bold_webhook_received");
  assert.equal(received.context, "production");
  assert.equal(received.store, "mfc-admin");
  assert.equal(received.eventId, "evt-regress-1");
});

test("regresión: la llave de identidad (pública) NO puede firmar webhooks de producción", async () => {
  h.reset();
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, sign(body, FAKE_IDENTITY_KEY)), PROD);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Firma inválida");
  assert.equal(h.ops.length, 0, "una firma inválida no debe tocar el almacén");
});

test("producción rechaza la firma de clave vacía del modo de pruebas de Bold", async () => {
  h.reset();
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, sign(body, "")), PROD);
  assert.equal(response.status, 400);
  assert.equal(h.ops.length, 0);
});

test("contexto de producción solo en el handler (CONTEXT ausente en runtime) usa la llave secreta", async () => {
  h.reset();
  assert.equal(process.env.CONTEXT, undefined);
  const body = JSON.stringify(boldEvent({ id: "evt-runtime-ctx" }));
  const response = await h.invoke(makeRequest(body, sign(body, FAKE_SECRET_KEY)), PROD);
  assert.equal(response.status, 200);
  assert.ok(h.ops.some(o => o[0] === "processBoldWebhook"));
});

test("producción sin BOLD_SECRET_KEY configurada falla cerrado con 500 aunque exista la llave de identidad", async () => {
  h.reset();
  delete process.env.BOLD_SECRET_KEY;
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, sign(body, FAKE_IDENTITY_KEY)), PROD);
  assert.equal(response.status, 500);
  assert.equal(h.ops.length, 0);
  const evt = h.loggedEvents().find(e => e.evt === "bold_webhook_secret_missing");
  assert.ok(evt, "debe registrar la configuración faltante");
  assert.equal(evt.keySource, "BOLD_SECRET_KEY");
});

test("encabezado de firma ausente: 400 con motivo registrado", async () => {
  h.reset();
  const body = JSON.stringify(boldEvent());
  const response = await h.invoke(makeRequest(body, ""), PROD);
  assert.equal(response.status, 400);
  const evt = h.loggedEvents().find(e => e.evt === "bold_webhook_invalid_signature");
  assert.equal(evt.reason, "missing_header");
  assert.equal(h.ops.length, 0);
});

test("la firma se calcula sobre los bytes crudos, no sobre el texto decodificado", async () => {
  h.reset();
  // Un byte 0xFF (no UTF-8 válido) dentro de un string JSON: decodificar a texto lo cambia por U+FFFD.
  const bytes = Buffer.concat([
    Buffer.from('{"id":"evt-bytes","type":"SALE_APPROVED","subject":"PAY-1","data":{"payment_id":"PAY-1",' +
      '"metadata":{"reference":"MF-TEST-1"},"amount":{"currency":"COP","total":199900},"payment_method":"TARJETA ñ 🙂 ', "utf8"),
    Buffer.from([0xff]),
    Buffer.from('"}}', "utf8")
  ]);
  // Premisa: el viaje bytes -> texto -> bytes NO reproduce el cuerpo original.
  const viaText = Buffer.from(await new Response(bytes).text(), "utf8");
  assert.notEqual(Buffer.compare(viaText, bytes), 0);
  const response = await h.invoke(makeRequest(bytes, sign(bytes, FAKE_SECRET_KEY)), PROD);
  assert.equal(response.status, 200);
  assert.ok(h.ops.some(o => o[0] === "processBoldWebhook" && o[1] === "evt-bytes"));
  // Y una firma calculada sobre el texto re-codificado ya no es válida.
  const wrong = await h.invoke(makeRequest(bytes, sign(viaText, FAKE_SECRET_KEY)), PROD);
  assert.equal(wrong.status, 400);
});

test("los registros nunca incluyen llaves, firma ni cuerpo", async () => {
  h.reset();
  const body = JSON.stringify(boldEvent());
  const good = sign(body, FAKE_SECRET_KEY);
  const bad = sign(body, FAKE_IDENTITY_KEY);
  await h.invoke(makeRequest(body, good), PROD);
  await h.invoke(makeRequest(body, bad), PROD);
  const all = h.logs.map(l => l.line).join("\n");
  for (const forbidden of [FAKE_SECRET_KEY, FAKE_IDENTITY_KEY, good, bad, '"amount"', "CARD_WEB"]) {
    assert.ok(!all.includes(forbidden), "el registro no debe contener: " + forbidden);
  }
});
