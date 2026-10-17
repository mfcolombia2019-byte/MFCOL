import test from "node:test";
import assert from "node:assert/strict";
import { sendMetaEvent } from "../netlify/functions/_meta.mjs";

const ENV_NAMES = [
  "META_CAPI_ACCESS_TOKEN",
  "META_GRAPH_API_VERSION",
  "META_DATASET_ID",
  "META_TEST_EVENT_CODE",
  "CONTEXT"
];

async function withEnv(values, callback) {
  const previous = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) {
    if (Object.hasOwn(values, name)) process.env[name] = values[name];
    else delete process.env[name];
  }
  try {
    return await callback();
  } finally {
    for (const name of ENV_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

const baseEnv = {
  META_CAPI_ACCESS_TOKEN: "test-token",
  META_GRAPH_API_VERSION: "v26.0"
};

function mockMeta(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ events_received: 1, fbtrace_id: "trace-1" }) };
  });
  return calls;
}

const purchase = { event_name: "Purchase", event_id: "evt-1" };

test("preview con META_TEST_EVENT_CODE: test_event_code va en el nivel superior y no dentro del evento", async t => {
  const calls = mockMeta(t);
  const result = await withEnv({ ...baseEnv, CONTEXT: "branch-deploy", META_TEST_EVENT_CODE: "TEST89021" },
    () => sendMetaEvent(purchase));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.test_event_code, "TEST89021");
  assert.equal(Object.hasOwn(calls[0].body.data[0], "test_event_code"), false);
  assert.equal(result.testMode, true);
});

test("el código de prueba se recorta antes de enviarse", async t => {
  const calls = mockMeta(t);
  await withEnv({ ...baseEnv, CONTEXT: "branch-deploy", META_TEST_EVENT_CODE: "  TEST89021\\n" },
    () => sendMetaEvent(purchase));
  assert.equal(calls[0].body.test_event_code, "TEST89021");
});

test("preview SIN META_TEST_EVENT_CODE: no llama a Meta y deja un error de configuración", async t => {
  const calls = mockMeta(t);
  await assert.rejects(
    withEnv({ ...baseEnv, CONTEXT: "branch-deploy" }, () => sendMetaEvent(purchase)),
    error => {
      assert.equal(error.errorClass, "config");
      assert.equal(error.retryable, false);
      assert.match(error.message, /META_TEST_EVENT_CODE/);
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test("deploy-preview con código en blanco se trata como ausente", async t => {
  const calls = mockMeta(t);
  await assert.rejects(
    withEnv({ ...baseEnv, CONTEXT: "deploy-preview", META_TEST_EVENT_CODE: "   " }, () => sendMetaEvent(purchase)),
    /META_TEST_EVENT_CODE/
  );
  assert.equal(calls.length, 0);
});

test("producción sin código: envía el evento real sin test_event_code", async t => {
  const calls = mockMeta(t);
  const result = await withEnv({ ...baseEnv, CONTEXT: "production" }, () => sendMetaEvent(purchase));
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].body, "test_event_code"), false);
  assert.equal(result.testMode, false);
});

test("sin CONTEXT (pruebas locales) se conserva el comportamiento anterior", async t => {
  const calls = mockMeta(t);
  const result = await withEnv({ ...baseEnv }, () => sendMetaEvent(purchase));
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].body, "test_event_code"), false);
  assert.equal(result.testMode, false);
});

test("un código de prueba con formato inválido se rechaza sin llamar a Meta ni repetir el valor", async t => {
  const calls = mockMeta(t);
  await assert.rejects(
    withEnv({ ...baseEnv, CONTEXT: "branch-deploy", META_TEST_EVENT_CODE: "TEST 89021 \\"x\\"" }, () => sendMetaEvent(purchase)),
    error => {
      assert.equal(error.errorClass, "config");
      assert.doesNotMatch(error.message, /89021/);
      return true;
    }
  );
  assert.equal(calls.length, 0);
});
