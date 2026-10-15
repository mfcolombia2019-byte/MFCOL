// SIMULATED: @netlify/blobs is replaced by a fake that counts getStore() calls.
// It proves how _admin.mjs obtains handles; it does not exercise real Netlify Blobs tokens.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls = [];
mock.module("@netlify/blobs", {
  exports: {
    getStore(name) {
      calls.push(name);
      const id = calls.length;
      return {
        handleId: id,
        async get(key) { return { key, handleId: this.handleId }; },
        async list() { return { blobs: [], handleId: this.handleId }; }
      };
    }
  }
});

const adminUrl = new URL("../netlify/functions/_admin.mjs", import.meta.url).href;

async function loadAdmin(context) {
  calls.length = 0;
  if (context === undefined) delete process.env.CONTEXT; else process.env.CONTEXT = context;
  return import(adminUrl + "?ctx=" + encodeURIComponent(String(context)) + "-" + Math.random());
}

test("el nombre del almacén sigue al contexto de despliegue", async () => {
  assert.equal((await loadAdmin("production")).APP_STORE_NAME, "mfc-admin");
  assert.equal((await loadAdmin("deploy-preview")).APP_STORE_NAME, "mfc-admin-nonprod");
  assert.equal((await loadAdmin(undefined)).APP_STORE_NAME, "mfc-admin-nonprod");
});

test("cada operación abre un handle nuevo del almacén correcto (sin token capturado al cargar)", async () => {
  const { store } = await loadAdmin("production");
  assert.equal(calls.length, 0, "importar el módulo no debe abrir ningún handle");
  const a = await store.get("orders/A");
  const b = await store.get("orders/B");
  const c = await store.list({ prefix: "webhook-inbox/" });
  assert.deepEqual(calls, ["mfc-admin", "mfc-admin", "mfc-admin"]);
  assert.notEqual(a.handleId, b.handleId);
  assert.notEqual(b.handleId, c.handleId);
  assert.equal(a.key, "orders/A", "los métodos conservan su this");
});

test("esperar o devolver el almacén desde una función async no abre handles", async () => {
  const { store } = await loadAdmin("deploy-preview");
  const same = await Promise.resolve(store);
  assert.equal(same, store);
  assert.equal(calls.length, 0);
});
