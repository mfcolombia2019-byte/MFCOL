import test from "node:test";
import assert from "node:assert/strict";
import { sendMetaEvent } from "../netlify/functions/_meta.mjs";

const EVENT = {
  event_name: "Purchase",
  event_time: 1761063334,
  event_id: "evt-regression-test",
  action_source: "website",
  user_data: {},
  custom_data: { currency: "COP", value: 150000 }
};

async function withMetaEnv(callback) {
  const names = ["META_CAPI_ACCESS_TOKEN", "META_GRAPH_API_VERSION", "META_DATASET_ID", "META_TEST_EVENT_CODE", "CONTEXT"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.META_CAPI_ACCESS_TOKEN = "test-token-only";
  process.env.META_GRAPH_API_VERSION = "v25.0";
  delete process.env.META_DATASET_ID;
  delete process.env.META_TEST_EVENT_CODE;
  delete process.env.CONTEXT;
  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("Meta HTTP 200 sin events_received se considera fallo", async t => {
  await withMetaEnv(async () => {
    t.mock.method(globalThis, "fetch", async () => response({ fbtrace_id: "TRACE_MISSING" }));
    await assert.rejects(sendMetaEvent(EVENT), /sin confirmar events_received/);
  });
});

test("Meta HTTP 200 con events_received=0 se considera fallo", async t => {
  await withMetaEnv(async () => {
    t.mock.method(globalThis, "fetch", async () => response({ events_received: 0, fbtrace_id: "TRACE_ZERO" }));
    await assert.rejects(sendMetaEvent(EVENT), /sin confirmar events_received/);
  });
});

test("Meta HTTP 200 con events_received=1 se acepta", async t => {
  await withMetaEnv(async () => {
    t.mock.method(globalThis, "fetch", async () => response({ events_received: 1, fbtrace_id: "TRACE_OK" }));
    const result = await sendMetaEvent(EVENT);
    assert.equal(result.eventsReceived, 1);
  });
});
