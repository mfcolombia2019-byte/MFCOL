import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDeployContext } from "../netlify/functions/_deploy-context.mjs";

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
