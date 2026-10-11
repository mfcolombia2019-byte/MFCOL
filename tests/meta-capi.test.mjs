import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildMetaPurchase, sendMetaEvent, META_DATASET_ID } from "../netlify/functions/_meta.mjs";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
  assert.equal(event.user_data.ln[0], hash("josé gomez"));
  assert.equal(event.user_data.ph[0], hash("573115551234"));
  assert.equal(event.custom_data.value, 125000);
  assert.equal(event.custom_data.currency, "COP");
});

test("sendMetaEvent acepta versión válida y dataset numérico sin llamar servicios reales", async () => {
  const oldEnv = {
    token: process.env.META_CAPI_ACCESS_TOKEN,
    version: process.env.META_GRAPH_API_VERSION,
    dataset: process.env.META_DATASET_ID,
    fetch: globalThis.fetch
  };
  let requestUrl;
  let requestOptions;
  try {
    process.env.META_CAPI_ACCESS_TOKEN = "test-token";
    process.env.META_GRAPH_API_VERSION = "v25.0";
    process.env.META_DATASET_ID = META_DATASET_ID;
    globalThis.fetch = async (url, options) => {
      requestUrl = String(url);
      requestOptions = options;
      return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
    };

    const result = await sendMetaEvent({ event_name: "Purchase", event_id: "test-event" });
    assert.equal(result.status, 200);
    assert.match(requestUrl, /graph\.facebook\.com\/v25\.0\/1092821839891082\/events/);
    assert.equal(requestOptions.method, "POST");
    assert.equal(JSON.parse(requestOptions.body).data[0].event_id, "test-event");
  } finally {
    if (oldEnv.token === undefined) delete process.env.META_CAPI_ACCESS_TOKEN;
    else process.env.META_CAPI_ACCESS_TOKEN = oldEnv.token;
    if (oldEnv.version === undefined) delete process.env.META_GRAPH_API_VERSION;
    else process.env.META_GRAPH_API_VERSION = oldEnv.version;
    if (oldEnv.dataset === undefined) delete process.env.META_DATASET_ID;
    else process.env.META_DATASET_ID = oldEnv.dataset;
    globalThis.fetch = oldEnv.fetch;
  }
});

test("sendMetaEvent rechaza una versión inválida antes de llamar a fetch", async () => {
  const oldEnv = {
    token: process.env.META_CAPI_ACCESS_TOKEN,
    version: process.env.META_GRAPH_API_VERSION,
    fetch: globalThis.fetch
  };
  let fetchCalled = false;
  try {
    process.env.META_CAPI_ACCESS_TOKEN = "test-token";
    process.env.META_GRAPH_API_VERSION = "vXX";
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("fetch no debería ejecutarse");
    };

    await assert.rejects(sendMetaEvent({ event_name: "Purchase" }), error => {
      assert.match(error.message, /META_GRAPH_API_VERSION inválida/);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(fetchCalled, false);
  } finally {
    if (oldEnv.token === undefined) delete process.env.META_CAPI_ACCESS_TOKEN;
    else process.env.META_CAPI_ACCESS_TOKEN = oldEnv.token;
    if (oldEnv.version === undefined) delete process.env.META_GRAPH_API_VERSION;
    else process.env.META_GRAPH_API_VERSION = oldEnv.version;
    globalThis.fetch = oldEnv.fetch;
  }
});
