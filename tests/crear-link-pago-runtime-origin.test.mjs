import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Regresión: en ejecución Netlify solo entrega URL, SITE_NAME y SITE_ID a las
// funciones; CONTEXT y DEPLOY_* existen solo durante el build. El origen de
// retorno de Bold debe resolverse entonces desde la petición, con validación
// estricta, sin construir URLs de dominios ajenos al sitio.

const state = new Map();
const etags = new Map();

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
    state.set(key, structuredClone(value));
    etags.set(key, '"e1"');
    return { modified: true, etag: '"e1"' };
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

const { canonicalOrigin, requestOrigin, resolveOrigin, default: handler } =
  await import("../netlify/functions/crear-link-pago.mjs");

const SITE = "comforting-liger-43ac3a";
const PRODUCTION = "https://tienda.mfcol.com";
const PREVIEW = "https://deploy-preview-30--" + SITE + ".netlify.app";
const BRANCH = "https://fix-bold-webhook-functions-logs--" + SITE + ".netlify.app";
const PERMALINK = "https://6acf3d632c5d40c6e7f44f5c--" + SITE + ".netlify.app";
const read = vars => name => vars[name];

// Variables que Netlify sí entrega a una función en ejecución.
const RUNTIME_VARS = { URL: PRODUCTION, SITE_NAME: SITE };

test("sin CONTEXT ni DEPLOY_*: el dominio de producción de la petición se acepta", () => {
  assert.equal(canonicalOrigin(read(RUNTIME_VARS), PRODUCTION + "/.netlify/functions/crear-link-pago"), PRODUCTION);
  assert.equal(resolveOrigin(read(RUNTIME_VARS), PRODUCTION + "/x").source, "request");
});

test("sin CONTEXT ni DEPLOY_*: Deploy Preview, Branch Deploy y permalink usan su propio dominio", () => {
  for (const origin of [PREVIEW, BRANCH, PERMALINK]) {
    assert.equal(canonicalOrigin(read(RUNTIME_VARS), origin + "/.netlify/functions/crear-link-pago"), origin);
  }
});

test("el origen de la petición se normaliza (sin ruta, consulta ni mayúsculas)", () => {
  assert.equal(
    requestOrigin("https://FIX-Bold--" + SITE + ".NETLIFY.app/a/b?x=1#h", read(RUNTIME_VARS)),
    "https://fix-bold--" + SITE + ".netlify.app"
  );
});

test("hosts ajenos al sitio se rechazan", () => {
  const rejected = [
    "https://evil.example/x",
    "https://" + SITE + ".netlify.app.evil.com/x",
    "https://evil.com/--" + SITE + ".netlify.app",
    "https://preview--otro-sitio-123.netlify.app/x",
    "https://" + SITE + ".netlify.app/x", // dominio por defecto: no es ni canónico ni host de despliegue
    "https://--" + SITE + ".netlify.app/x",
    "https://a.b--" + SITE + ".netlify.app/x",
    "https://tienda.mfcol.com.evil.com/x",
    "https://evil-tienda.mfcol.com/x"
  ];
  for (const url of rejected) {
    assert.equal(requestOrigin(url, read(RUNTIME_VARS)), "", url);
  }
});

test("esquema no HTTPS, puerto o credenciales se rechazan", () => {
  for (const url of [
    "http://tienda.mfcol.com/x",
    PRODUCTION + ":8443/x",
    "https://user:pass@tienda.mfcol.com/x",
    "https://user@" + "deploy-preview-30--" + SITE + ".netlify.app/x",
    "https://deploy-preview-30--" + SITE + ".netlify.app:444/x",
    "no es una url",
    "",
    undefined
  ]) {
    assert.equal(requestOrigin(url, read(RUNTIME_VARS)), "", String(url));
  }
});

test("sin SITE_NAME válido no se aceptan hosts de despliegue", () => {
  assert.equal(requestOrigin(PREVIEW + "/x", read({ URL: PRODUCTION })), "");
  assert.equal(requestOrigin(PREVIEW + "/x", read({ URL: PRODUCTION, SITE_NAME: "a.b" })), "");
  assert.equal(requestOrigin(PREVIEW + "/x", read({ URL: PRODUCTION, SITE_NAME: "" })), "");
});

test("sin ninguna variable solo falla cerrado", () => {
  assert.equal(canonicalOrigin(read({}), PRODUCTION + "/x"), "");
  assert.equal(canonicalOrigin(read({}), PREVIEW + "/x"), "");
});

test("sin petición no hay respaldo: el comportamiento previo se conserva", () => {
  assert.equal(canonicalOrigin(read(RUNTIME_VARS)), "");
  assert.equal(
    canonicalOrigin(read({ CONTEXT: "production", SITE_CANONICAL_ORIGIN: PRODUCTION })),
    PRODUCTION
  );
});

test("las variables presentes tienen prioridad sobre la petición", () => {
  assert.deepEqual(
    resolveOrigin(read({ CONTEXT: "deploy-preview", ...RUNTIME_VARS, DEPLOY_PRIME_URL: PREVIEW }), BRANCH + "/x"),
    { origin: PREVIEW, source: "env" }
  );
  assert.deepEqual(
    resolveOrigin(read({ CONTEXT: "production", SITE_CANONICAL_ORIGIN: PRODUCTION, ...RUNTIME_VARS }), PREVIEW + "/x"),
    { origin: PRODUCTION, source: "env" }
  );
});

// ---------- Nivel handler ----------

const NAMES = ["CONTEXT", "SITE_CANONICAL_ORIGIN", "URL", "DEPLOY_PRIME_URL", "DEPLOY_URL", "SITE_NAME", "BOLD_SECRET_KEY", "BOLD_API_KEY"];
const SECRET_VALUE = "valor-secreto-que-nunca-debe-aparecer-en-logs";

async function callHandler(vars, requestOrigin, handlerContext) {
  const saved = {};
  for (const name of NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  Object.assign(process.env, { BOLD_SECRET_KEY: SECRET_VALUE, BOLD_API_KEY: SECRET_VALUE + "-api", ...vars });

  const logs = [];
  const original = { error: console.error, info: console.info };
  console.error = (...args) => logs.push(args.join(" "));
  console.info = (...args) => logs.push(args.join(" "));
  const originalFetch = globalThis.fetch;
  let boldCalls = 0;
  globalThis.fetch = async (...args) => { boldCalls++; return originalFetch(...args); };

  try {
    state.clear();
    etags.clear();
    state.set("orders/MFRUNTIME1", {
      reference: "MFRUNTIME1",
      total: 199900,
      paymentStatus: "pendiente",
      paymentMethod: "Link de pago (Bold)",
      items: [{ name: "Producto de prueba" }],
      boldPaymentLink: "LNK_EXISTING",
      paymentLink: "https://checkout.bold.co/LNK_EXISTING"
    });
    const response = await handler(
      new Request(requestOrigin + "/.netlify/functions/crear-link-pago", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: "MFRUNTIME1" })
      }),
      handlerContext
    );
    return { status: response.status, body: await response.json(), logs: logs.join("\n"), boldCalls };
  } finally {
    console.error = original.error;
    console.info = original.info;
    globalThis.fetch = originalFetch;
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("handler en Deploy Preview sin CONTEXT/DEPLOY_*: retorna a la vista previa, nunca a producción", async () => {
  const { status, body, boldCalls } = await callHandler(RUNTIME_VARS, PREVIEW, { deploy: { context: "deploy-preview" } });
  assert.equal(status, 200);
  assert.equal(body.embedded.redirectionUrl, PREVIEW + "/gracias.html?ref=MFRUNTIME1");
  assert.ok(body.embedded.originUrl.startsWith(PREVIEW + "/"));
  assert.ok(!JSON.stringify(body.embedded).includes("tienda.mfcol.com"));
  assert.equal(boldCalls, 0, "con un enlace ya existente no se llama a Bold");
});

test("handler en Branch Deploy sin CONTEXT/DEPLOY_*: retorna al dominio de la rama", async () => {
  const { status, body } = await callHandler(RUNTIME_VARS, BRANCH, { deploy: { context: "branch-deploy" } });
  assert.equal(status, 200);
  assert.equal(body.embedded.redirectionUrl, BRANCH + "/gracias.html?ref=MFRUNTIME1");
});

test("handler en el dominio de producción sin CONTEXT/DEPLOY_* (incluso publicado como branch deploy)", async () => {
  for (const handlerContext of [undefined, { deploy: { context: "production" } }, { deploy: { context: "branch-deploy" } }]) {
    const { status, body } = await callHandler(RUNTIME_VARS, PRODUCTION, handlerContext);
    assert.equal(status, 200);
    assert.equal(body.embedded.redirectionUrl, PRODUCTION + "/gracias.html?ref=MFRUNTIME1");
    assert.ok(body.embedded.originUrl.startsWith(PRODUCTION + "/"));
  }
});

test("handler con host ajeno: 503, sin embedded, sin llamar a Bold y sin filtrar valores", async () => {
  const { status, body, logs, boldCalls } = await callHandler(
    { ...RUNTIME_VARS, CONTEXT: "" },
    "https://evil.example",
    { deploy: { context: "deploy-preview" } }
  );
  assert.equal(status, 503);
  assert.equal(body.embedded, undefined);
  assert.equal(boldCalls, 0);
  assert.ok(!JSON.stringify(body).includes("tienda.mfcol.com"));

  assert.match(logs, /no hay un origen HTTPS válido/);
  const diagnostic = JSON.parse(logs.slice(logs.indexOf("{"), logs.lastIndexOf("}") + 1));
  assert.deepEqual(diagnostic.envPresent, {
    CONTEXT: false,
    SITE_CANONICAL_ORIGIN: false,
    URL: true,
    DEPLOY_PRIME_URL: false,
    DEPLOY_URL: false,
    SITE_NAME: true
  });
  assert.equal(diagnostic.handlerContext, "deploy-preview");
  for (const forbidden of [SECRET_VALUE, "tienda.mfcol.com", SITE]) {
    assert.ok(!logs.includes(forbidden), "los registros no deben contener valores de variables: " + forbidden);
  }
});

test("el registro de éxito indica de dónde salió el origen sin exponer valores", async () => {
  const { logs } = await callHandler(RUNTIME_VARS, PREVIEW, { deploy: { context: "deploy-preview" } });
  assert.match(logs, /"originSource":"request"/);
  assert.match(logs, /"handlerContext":"deploy-preview"/);
  assert.ok(!logs.includes(SECRET_VALUE));
  assert.ok(!logs.includes("netlify.app"));
});

test("con variables de despliegue presentes el comportamiento anterior no cambia", async () => {
  const { status, body, logs } = await callHandler(
    { CONTEXT: "deploy-preview", ...RUNTIME_VARS, DEPLOY_PRIME_URL: PREVIEW },
    PREVIEW,
    undefined
  );
  assert.equal(status, 200);
  assert.equal(body.embedded.redirectionUrl, PREVIEW + "/gracias.html?ref=MFRUNTIME1");
  assert.match(logs, /"originSource":"env"/);
});
