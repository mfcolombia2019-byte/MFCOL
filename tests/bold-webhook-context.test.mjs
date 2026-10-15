import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NONPROD_STORE_NAME, PRODUCTION_STORE_NAME, resolveDeployContext, storeMatchesContext, storeNameForContext
} from "../netlify/functions/_deploy-context.mjs";

test("uses the runtime handler context when available", () => {
  assert.equal(resolveDeployContext({ deploy: { context: "production" } }, { CONTEXT: "deploy-preview" }), "production");
});

test("normalizes runtime context", () => {
  assert.equal(resolveDeployContext({ deploy: { context: "  PRODUCTION  " } }, {}), "production");
});

test("falls back to CONTEXT when runtime context is absent", () => {
  assert.equal(resolveDeployContext({}, { CONTEXT: "deploy-preview" }), "deploy-preview");
});

test("falls back to CONTEXT when deploy metadata is absent", () => {
  assert.equal(resolveDeployContext(undefined, { CONTEXT: "branch-deploy" }), "branch-deploy");
});

test("returns empty context when no source is available", () => {
  assert.equal(resolveDeployContext({}, {}), "");
});

test("ignores whitespace-only runtime context and uses environment fallback", () => {
  assert.equal(resolveDeployContext({ deploy: { context: "  " } }, { CONTEXT: "production" }), "production");
});

test("does not infer production from unrelated handler metadata", () => {
  assert.equal(resolveDeployContext({ deploy: { id: "123" } }, {}), "");
});

test("solo el contexto production usa el almacén de producción", () => {
  assert.equal(PRODUCTION_STORE_NAME, "mfc-admin");
  assert.equal(NONPROD_STORE_NAME, "mfc-admin-nonprod");
  assert.equal(storeNameForContext("production"), "mfc-admin");
  assert.equal(storeNameForContext("  PRODUCTION "), "mfc-admin");
  for (const ctx of ["deploy-preview", "branch-deploy", "dev", "", undefined, null, "prod", "productionx"]) {
    assert.equal(storeNameForContext(ctx), "mfc-admin-nonprod", String(ctx));
  }
});

test("coherencia contexto/almacén: nunca producción con almacén de pruebas ni a la inversa", () => {
  assert.equal(storeMatchesContext("production", "mfc-admin"), true);
  assert.equal(storeMatchesContext("deploy-preview", "mfc-admin-nonprod"), true);
  assert.equal(storeMatchesContext("", "mfc-admin-nonprod"), true);
  assert.equal(storeMatchesContext("production", "mfc-admin-nonprod"), false);
  assert.equal(storeMatchesContext("deploy-preview", "mfc-admin"), false);
  assert.equal(storeMatchesContext("branch-deploy", "mfc-admin"), false);
  assert.equal(storeMatchesContext("", "mfc-admin"), false);
  // Sin almacén conocido (módulo sustituido) no se puede comparar.
  assert.equal(storeMatchesContext("production", undefined), true);
});
