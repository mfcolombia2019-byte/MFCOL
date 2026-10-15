import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Regresión: un pago de una vista previa nunca debe regresar a producción, y
// producción debe seguir usando su dominio canónico.

const state = new Map();
const etags = new Map();
let nextEtag = 0;

const store = {
  async get(key) {
    return state.has(key) ? structuredClone(state.get(key)) : null;
  },
  async getWithMetadata(key) {
    return state.has(key)
      ? { data: structuredClone(state.get(key)), etag: etags.get(key) }
      : { data: null, etag: undefined };
  },
  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && state.has(key)) return { modified: false };
    if (options.onlyIfMatch && etags.get(key) !== options.onlyIfMatch) return { modified: false };
    const etag = '"e' + (++nextEtag) + '"';
    state.set(key, structuredClone(value));
    etags.set(key, etag);
    return { modified: true, etag };
  }
};

mock.module(new URL("../netlify/functions/_admin.mjs", import.meta.url).href, {
  exports: {
    store,
    getJson: async key => state.has(key) ? structuredClone(state.get(key)) : null,
    json: (data, status = 200, headers = {}) =>
      Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } })
  }
});

const { canonicalOrigin, default: handler } = await import("../netlify/functions/crear-link-pago.mjs");

const PRODUCTION = "https://tienda.mfcol.com";
const PREVIEW = "https://deploy-preview-30--mfcol.netlify.app";
const read = vars => name => vars[name];

test("producción usa SITE_CANONICAL_ORIGIN y, si falta, URL", () => {
  assert.equal(
    canonicalOrigin(read({ CONTEXT: "production", SITE_CANONICAL_ORIGIN: PRODUCTION, URL: "https://otro.example" })),
    PRODUCTION
  );
  assert.equal(canonicalOrigin(read({ CONTEXT: "production", URL: PRODUCTION })), PRODUCTION);
  assert.equal(canonicalOrigin(read({ CONTEXT: "Production", SITE_CANONICAL_ORIGIN: PRODUCTION + "/" })), PRODUCTION);
});

test("producción ignora el origen de vista previa y rechaza orígenes no HTTPS", () => {
  assert.equal(
    canonicalOrigin(read({ CONTEXT: "production", SITE_CANONICAL_ORIGIN: PRODUCTION, DEPLOY_PRIME_URL: PREVIEW })),
    PRODUCTION
  );
  assert.equal(canonicalOrigin(read({ CONTEXT: "production", SITE_CANONICAL_ORIGIN: "http://tienda.mfcol.com" })), "");
  assert.equal(canonicalOrigin(read({ CONTEXT: "production" })), "");
});

test("una vista previa regresa a su propio dominio aunque SITE_CANONICAL_ORIGIN y URL sean de producción", () => {
  for (const context of ["deploy-preview", "branch-deploy"]) {
    assert.equal(
      canonicalOrigin(read({
        CONTEXT: context,
        SITE_CANONICAL_ORIGIN: PRODUCTION,
        URL: PRODUCTION,
        DEPLOY_PRIME_URL: PREVIEW
      })),
      PREVIEW
    );
  }
});

test("fuera de producción usa DEPLOY_URL si falta DEPLOY_PRIME_URL", () => {
  assert.equal(
    canonicalOrigin(read({
      CONTEXT: "deploy-preview",
      SITE_CANONICAL_ORIGIN: PRODUCTION,
      DEPLOY_URL: "https://6710abc--mfcol.netlify.app"
    })),
    "https://6710abc--mfcol.netlify.app"
  );
});

test("branch deploy usa origen HTTPS de la petición si faltan las URLs de despliegue", () => {
  assert.equal(canonicalOrigin(read({ CONTEXT: "branch-deploy", SITE_CANONICAL_ORIGIN: PRODUCTION, URL: PRODUCTION }), "https://fix-checkout-page-redirect--comforting-liger-43ac3a.netlify.app/.netlify/functions/crear-link-pago"), "https://fix-checkout-page-redirect--comforting-liger-43ac3a.netlify.app");
  assert.equal(canonicalOrigin(read({ CONTEXT: "branch-deploy", SITE_CANONICAL_ORIGIN: PRODUCTION }), "https://tienda.mfcol.com/.netlify/functions/crear-link-pago"), "");
  assert.equal(canonicalOrigin(read({ CONTEXT: "branch-deploy", SITE_CANONICAL_ORIGIN: PRODUCTION }), "http://fix-checkout-page-redirect--comforting-liger-43ac3a.netlify.app/.netlify/functions/crear-link-pago"), "");
});

test("fuera de producción nunca recurre a URL ni a SITE_CANONICAL_ORIGIN", () => {
  assert.equal(canonicalOrigin(read({ CONTEXT: "deploy-preview", SITE_CANONICAL_ORIGIN: PRODUCTION, URL: PRODUCTION })), "");
  assert.equal(canonicalOrigin(read({ SITE_CANONICAL_ORIGIN: PRODUCTION, URL: PRODUCTION })), "", "sin CONTEXT se trata como no producción");
});

test("fuera de producción rechaza un origen de despliegue que coincide con producción o no es HTTPS", () => {
  assert.equal(
    canonicalOrigin(read({
      CONTEXT: "branch-deploy",
      SITE_CANONICAL_ORIGIN: PRODUCTION,
      DEPLOY_PRIME_URL: PRODUCTION + "/",
      DEPLOY_URL: PREVIEW
    })),
    PREVIEW,
    "si DEPLOY_PRIME_URL apunta a producción se descarta y se usa el siguiente origen válido"
  );
  assert.equal(
    canonicalOrigin(read({ CONTEXT: "dev", SITE_CANONICAL_ORIGIN: PRODUCTION, DEPLOY_PRIME_URL: "http://localhost:8888" })),
    "",
    "el desarrollo local (http) no se envía a Bold ni cae a producción"
  );
  assert.equal(canonicalOrigin(read({ CONTEXT: "deploy-preview", DEPLOY_PRIME_URL: "no es una url" })), "");
});

async function createCheckout(vars) {
  const saved = {};
  const names = ["CONTEXT", "SITE_CANONICAL_ORIGIN", "URL", "DEPLOY_PRIME_URL", "DEPLOY_URL", "BOLD_SECRET_KEY", "BOLD_API_KEY", "REQUEST_ORIGIN"];
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  Object.assign(process.env, { BOLD_SECRET_KEY: "test-secret-only", BOLD_API_KEY: "test-api-key-only", ...vars });
  try {
    state.clear();
    etags.clear();
    state.set("orders/MFORIGIN1", {
      reference: "MFORIGIN1",
      total: 199900,
      paymentStatus: "pendiente",
      paymentMethod: "Link de pago (Bold)",
      items: [{ name: "Producto de prueba" }],
      boldPaymentLink: "LNK_EXISTING",
      paymentLink: "https://checkout.bold.co/LNK_EXISTING"
    });
    etags.set("orders/MFORIGIN1", '"seed"');
    const requestOrigin = vars.REQUEST_ORIGIN || "https://irrelevante.example";
    const response = await handler(new Request(requestOrigin + "/.netlify/functions/crear-link-pago", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: "MFORIGIN1" })
    }));
    return { status: response.status, body: await response.json() };
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("el checkout de branch deploy detecta su propio origen HTTPS por la petición", async () => {
  const { status, body } = await createCheckout({ CONTEXT: "branch-deploy", SITE_CANONICAL_ORIGIN: PRODUCTION, URL: PRODUCTION, REQUEST_ORIGIN: "https://fix-checkout-page-redirect--comforting-liger-43ac3a.netlify.app" });
  assert.equal(status, 200);
  assert.equal(body.embedded.redirectionUrl, "https://fix-checkout-page-redirect--comforting-liger-43ac3a.netlify.app/gracias.html?ref=MFORIGIN1");
  assert.ok(body.embedded.originUrl.startsWith("https://fix-checkout-page-redirect--comforting-liger-43ac3a.netlify.app/"));
  assert.ok(!JSON.stringify(body.embedded).includes("tienda.mfcol.com"));
});

test("el checkout de una vista previa devuelve redirectionUrl y originUrl de la vista previa", async () => {
  const { status, body } = await createCheckout({
    CONTEXT: "deploy-preview",
    SITE_CANONICAL_ORIGIN: PRODUCTION,
    URL: PRODUCTION,
    DEPLOY_PRIME_URL: PREVIEW
  });
  assert.equal(status, 200);
  assert.equal(body.embedded.redirectionUrl, PREVIEW + "/gracias.html?ref=MFORIGIN1");
  assert.ok(body.embedded.originUrl.startsWith(PREVIEW + "/"));
  assert.ok(!JSON.stringify(body.embedded).includes("tienda.mfcol.com"), "ningún campo debe apuntar a producción");
});

test("el checkout de producción conserva el dominio canónico", async () => {
  const { status, body } = await createCheckout({
    CONTEXT: "production",
    SITE_CANONICAL_ORIGIN: PRODUCTION,
    URL: PRODUCTION,
    DEPLOY_PRIME_URL: PRODUCTION
  });
  assert.equal(status, 200);
  assert.equal(body.embedded.redirectionUrl, PRODUCTION + "/gracias.html?ref=MFORIGIN1");
  assert.ok(body.embedded.originUrl.startsWith(PRODUCTION + "/"));
});

test("usa únicamente Embedded Checkout: no crea ni asocia un API Payment Link LNK_*", async () => {
  const saved = {};
  const names = ["CONTEXT", "SITE_CANONICAL_ORIGIN", "URL", "DEPLOY_PRIME_URL", "DEPLOY_URL", "BOLD_SECRET_KEY", "BOLD_API_KEY"];
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  let upstreamCalls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    upstreamCalls++;
    throw new Error("No debe llamar al endpoint de API Payment Links");
  });
  try {
    Object.assign(process.env, {
      CONTEXT: "branch-deploy",
      BOLD_SECRET_KEY: "test-secret-only",
      BOLD_API_KEY: "test-api-key-only",
      DEPLOY_PRIME_URL: PREVIEW
    });
    state.clear();
    etags.clear();
    state.set("orders/MFSINGLE1", {
      reference: "MFSINGLE1",
      total: 199900,
      paymentStatus: "pendiente",
      paymentMethod: "Link de pago (Bold)",
      items: [{ name: "Producto de prueba" }]
    });
    etags.set("orders/MFSINGLE1", '"seed-single"');
    const response = await handler(new Request(PREVIEW + "/.netlify/functions/crear-link-pago", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: "MFSINGLE1" })
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.reference, "MFSINGLE1");
    assert.equal(body.embedded.orderId, "MFSINGLE1");
    assert.equal(body.embedded.redirectionUrl, PREVIEW + "/gracias.html?ref=MFSINGLE1");
    assert.equal(body.payment_link, undefined);
    assert.equal(state.has("bold-links/LNK_TEST"), false);
    assert.equal(upstreamCalls, 0);
  } finally {
    fetchMock.mock.restore();
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("una vista previa sin origen propio válido no crea el pago en lugar de volver a producción", async () => {
  const { status, body } = await createCheckout({
    CONTEXT: "deploy-preview",
    SITE_CANONICAL_ORIGIN: PRODUCTION,
    URL: PRODUCTION
  });
  assert.equal(status, 503);
  assert.equal(body.embedded, undefined);
  assert.ok(!JSON.stringify(body).includes("tienda.mfcol.com"));
});
