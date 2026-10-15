import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mock, test } from "node:test";

const fn = name => new URL("../netlify/functions/" + name, import.meta.url).href;

mock.module(fn("_admin.mjs"), { exports: { store: {} } });
mock.module(fn("_bold-webhook.mjs"), {
  exports: {
    async processBoldWebhook() { return { ok: true }; },
    safeEventId: id => String(id || "").replace(/[^A-Za-z0-9_-]/g, ""),
    webhookInboxKey: id => "webhook-inbox/" + id,
    async ensureInbox() { return {}; }
  }
});
mock.module(fn("_meta-outbox.mjs"), { exports: { async processOutboxKey() { return { ok: true }; } } });
mock.module(fn("_whatsapp.mjs"), { exports: { async sendWhatsAppConfirmationForReference() { return {}; } } });

mock.method(globalThis, "fetch", async () => new Response("OK", { status: 200 }));
const webhook = await import(fn("bold-webhook.mjs"));

const event = {
  id: "evt-keys-1",
  type: "SALE_APPROVED",
  subject: "PAY-KEYS-1",
  data: { payment_id: "PAY-KEYS-1", amount: { currency: "COP", total: 1000 }, metadata: { reference: "MF-KEYS-1" } }
};
const sign = (body, key) =>
  crypto.createHmac("sha256", key).update(Buffer.from(body, "utf8").toString("base64")).digest("hex");

async function post(body, signature) {
  let background;
  const response = await webhook.default(
    new Request("https://example.test/.netlify/functions/bold-webhook", {
      method: "POST",
      headers: { "x-bold-signature": signature, "content-type": "application/json" },
      body
    }),
    { waitUntil(p) { background = p; } }
  );
  if (background) await background;
  return response.status;
}

function withEnv(vars, fnc) {
  const names = ["CONTEXT", "BOLD_API_KEY", "BOLD_SECRET_KEY"];
  const prev = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, vars);
  return Promise.resolve(fnc()).finally(() => {
    for (const n of names) { if (prev[n] === undefined) delete process.env[n]; else process.env[n] = prev[n]; }
  });
}

test("getBoldWebhookSecrets: producción devuelve las llaves configuradas; fuera de producción, la vacía", () => {
  assert.deepEqual(webhook.getBoldWebhookSecrets({ CONTEXT: "production", BOLD_API_KEY: "a", BOLD_SECRET_KEY: "b" }), ["a", "b"]);
  assert.deepEqual(webhook.getBoldWebhookSecrets({ CONTEXT: "production", BOLD_SECRET_KEY: "b" }), ["b"]);
  assert.deepEqual(webhook.getBoldWebhookSecrets({ CONTEXT: "production" }), []);
  assert.deepEqual(webhook.getBoldWebhookSecrets({ CONTEXT: "deploy-preview", BOLD_API_KEY: "a" }), [""]);
});

test("producción acepta la firma hecha con la llave de identidad", async () => {
  await withEnv({ CONTEXT: "production", BOLD_API_KEY: "identity-key", BOLD_SECRET_KEY: "secret-key" }, async () => {
    const body = JSON.stringify(event);
    assert.equal(await post(body, sign(body, "identity-key")), 200);
  });
});

test("producción acepta la firma hecha con la llave secreta", async () => {
  await withEnv({ CONTEXT: "production", BOLD_API_KEY: "identity-key", BOLD_SECRET_KEY: "secret-key" }, async () => {
    const body = JSON.stringify(event);
    assert.equal(await post(body, sign(body, "secret-key")), 200);
  });
});

test("producción rechaza la clave vacía, otra clave y la ausencia de firma", async () => {
  await withEnv({ CONTEXT: "production", BOLD_API_KEY: "identity-key", BOLD_SECRET_KEY: "secret-key" }, async () => {
    const body = JSON.stringify(event);
    assert.equal(await post(body, sign(body, "")), 400);
    assert.equal(await post(body, sign(body, "otra")), 400);
    assert.equal(await post(body, ""), 400);
  });
});

test("producción sin llaves configuradas responde 500", async () => {
  await withEnv({ CONTEXT: "production" }, async () => {
    const body = JSON.stringify(event);
    assert.equal(await post(body, sign(body, "")), 500);
  });
});

test("fuera de producción solo vale la clave vacía de pruebas", async () => {
  await withEnv({ CONTEXT: "deploy-preview", BOLD_API_KEY: "identity-key" }, async () => {
    const body = JSON.stringify(event);
    assert.equal(await post(body, sign(body, "")), 200);
    assert.equal(await post(body, sign(body, "identity-key")), 400);
  });
});
