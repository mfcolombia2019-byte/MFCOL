import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildMetaPurchase, sendMetaEvent, META_DATASET_ID } from "../netlify/functions/_meta.mjs";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function withMetaEnv(values, callback) {
  const names = ["META_CAPI_ACCESS_TOKEN", "META_GRAPH_API_VERSION", "META_DATASET_ID", "META_TEST_EVENT_CODE"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) {
    if (Object.hasOwn(values, name)) process.env[name] = values[name];
    else delete process.env[name];
  }

  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("buildMetaPurchase normaliza nombre, apellidos y teléfono antes de hashear", () => {
  const event = buildMetaPurchase({
    confirmedAmount: 125000,
    confirmedCurrency: "COP",
    paymentStatus: "aprobado",
    webhookType: "SALE_APPROVED",
    purchaseEventId: "purchase-123",
    name: "  María José Gómez  ",
    phone: "+57 (311) 555-1234",
    reference: "MFC-123"
  });

  assert.equal(event.event_name, "Purchase");
  assert.equal(event.event_id, "purchase-123");
  assert.equal(event.user_data.fn[0], hash("maria"));
  assert.equal(event.user_data.ln[0], hash("jose gomez"));
  assert.equal(event.user_data.ph[0], hash("573115551234"));
  assert.equal(event.custom_data.value, 125000);
  assert.equal(event.custom_data.currency, "COP");
});

test("sendMetaEvent acepta versión válida y dataset numérico sin llamar servicios reales", async t => {
  let requestUrl;
  let requestOptions;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
  });

  const result = await withMetaEnv({
    META_CAPI_ACCESS_TOKEN: "test-token",
    META_GRAPH_API_VERSION: "v25.0",
    META_DATASET_ID: META_DATASET_ID
  }, () => sendMetaEvent({ event_name: "Purchase", event_id: "test-event" }));
  assert.equal(result.status, 200);
  assert.match(requestUrl, /graph\.facebook\.com\/v25\.0\/1092821839891082\/events/);
  assert.equal(requestOptions.method, "POST");
  assert.equal(JSON.parse(requestOptions.body).data[0].event_id, "test-event");
});

test("sendMetaEvent acepta versión sin prefijo v y la normaliza en el endpoint", async t => {
  let requestUrl;
  t.mock.method(globalThis, "fetch", async url => {
    requestUrl = String(url);
    return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
  });

  await withMetaEnv({
    META_CAPI_ACCESS_TOKEN: "test-token",
    META_GRAPH_API_VERSION: "25.0",
    META_DATASET_ID: "123"
  }, () => sendMetaEvent({ event_name: "Purchase" }));

  assert.match(requestUrl, /graph\.facebook\.com\/v25\.0\/123\/events/);
});

test("sendMetaEvent rechaza configuración ausente o inválida antes de llamar fetch", async t => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const invalidConfigurations = [
    [{ META_GRAPH_API_VERSION: "v25.0", META_DATASET_ID: "123" }, /META_CAPI_ACCESS_TOKEN/],
    [{ META_CAPI_ACCESS_TOKEN: "test-token", META_GRAPH_API_VERSION: "vXX", META_DATASET_ID: "123" }, /META_GRAPH_API_VERSION inválida/],
    [{ META_CAPI_ACCESS_TOKEN: "test-token", META_GRAPH_API_VERSION: "v25.0", META_DATASET_ID: "12x" }, /META_DATASET_ID inválido/]
  ];

  for (const [configuration, expectedError] of invalidConfigurations) {
    await assert.rejects(
      withMetaEnv(configuration, () => sendMetaEvent({ event_name: "Purchase" })),
      expectedError
    );
  }

  assert.equal(fetchCalls, 0);
});
