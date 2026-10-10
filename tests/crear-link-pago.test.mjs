import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = new Map();
const etags = new Map();
let nextEtag = 0;
let boldFetchCalls = 0;
let failMappingWrites = false;
let failOrderWrites = false;

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
    if (key.startsWith("orders/") && failOrderWrites) {
      throw new Error("fallo al guardar el pedido simulado");
    }
    if (key.startsWith("bold-links/") && failMappingWrites) {
      throw new Error("fallo de persistencia simulado");
    }
    if (options.onlyIfNew && state.has(key)) {
      return { modified: false };
    }
    if (options.onlyIfMatch && etags.get(key) !== options.onlyIfMatch) {
      return { modified: false };
    }
    const etag = '"e' + (++nextEtag) + '"';
    state.set(key, structuredClone(value));
    etags.set(key, etag);
    return { modified: true, etag };
  }
};

const adminUrl = new URL("../netlify/functions/_admin.mjs", import.meta.url).href;

mock.module(adminUrl, {
  exports: {
    store,
    getJson: async key => state.has(key) ? structuredClone(state.get(key)) : null,
    json: (data, status = 200, headers = {}) =>
      Response.json(data, {
        status,
        headers: { "Cache-Control": "no-store", ...headers }
      })
  }
});

let concurrentFetchBarrier = null;

mock.method(globalThis, "fetch", async () => {
  boldFetchCalls++;

  if (concurrentFetchBarrier) {
    const call = boldFetchCalls;
    if (call === 2) concurrentFetchBarrier.markBothFetched();
    await concurrentFetchBarrier.release;

    const paymentLink = "LNK-CONCURRENT-" + call;
    return Response.json({
      payload: {
        url: "https://checkout.bold.co/" + paymentLink,
        payment_link: paymentLink
      }
    });
  }

  return Response.json({
    payload: {
      url: "https://checkout.bold.co/new-link",
      payment_link: "LNK-NEW-TEST"
    }
  });
});

process.env.CONTEXT = "branch-deploy";
process.env.SITE_CANONICAL_ORIGIN = "https://example.test";
process.env.BOLD_SECRET_KEY = "test-secret-only";
process.env.BOLD_API_KEY = "test-api-key-only";

const { default: handler } = await import("../netlify/functions/crear-link-pago.mjs");

function reset() {
  state.clear();
  etags.clear();
  nextEtag = 0;
  boldFetchCalls = 0;
  failMappingWrites = false;
  failOrderWrites = false;
}

function seedOrder(reference, extra = {}) {
  const order = {
    reference,
    total: 199900,
    paymentStatus: "pendiente",
    paymentMethod: "Link de pago (Bold)",
    items: [{ name: "Producto de prueba" }],
    boldPaymentLink: "LNK-EXISTING-TEST",
    paymentLink: "https://checkout.bold.co/LNK-EXISTING-TEST",
    ...extra
  };
  state.set("orders/" + reference, structuredClone(order));
  etags.set("orders/" + reference, '"seed-' + (++nextEtag) + '"');
}

function request(reference) {
  return handler(new Request(
    "https://example.test/.netlify/functions/crear-link-pago",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference })
    }
  ));
}

test("repara la asociación faltante reutilizando el enlace existente", async () => {
  reset();
  seedOrder("MF-REPAIR-1");

  const response = await request("MF-REPAIR-1");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.payment_link, "LNK-EXISTING-TEST");
  assert.equal(body.url, "https://checkout.bold.co/LNK-EXISTING-TEST");
  assert.equal(boldFetchCalls, 0, "no debe crear otro enlace en Bold");
  assert.equal(state.get("bold-links/LNK-EXISTING-TEST")?.reference, "MF-REPAIR-1");
});

test("no sobrescribe un enlace ya asociado a otro pedido", async () => {
  reset();
  seedOrder("MF-REPAIR-2");
  state.set("bold-links/LNK-EXISTING-TEST", {
    reference: "MF-OTHER-ORDER",
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  const response = await request("MF-REPAIR-2");
  assert.equal(response.status, 503);
  assert.equal(
    state.get("bold-links/LNK-EXISTING-TEST")?.reference,
    "MF-OTHER-ORDER"
  );
  assert.equal(boldFetchCalls, 0);
});

test("un fallo al persistir la asociación nunca devuelve éxito", async () => {
  reset();
  seedOrder("MF-REPAIR-3");
  failMappingWrites = true;

  const response = await request("MF-REPAIR-3");
  assert.equal(response.status, 503);
  assert.equal(state.has("bold-links/LNK-EXISTING-TEST"), false);
  assert.equal(boldFetchCalls, 0);
}); 
test("crea y guarda un enlace nuevo de Bold cuando el pedido a�n no tiene enlace", async () => {
  reset();
  seedOrder("MF-NEW-LINK-1", {
    boldPaymentLink: "",
    paymentLink: ""
  });

  const response = await request("MF-NEW-LINK-1");
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.payment_link, "LNK-NEW-TEST");
  assert.equal(boldFetchCalls, 1);

  const order = state.get("orders/MF-NEW-LINK-1");
  assert.equal(order.boldPaymentLink, "LNK-NEW-TEST");
  assert.equal(
    order.paymentLink,
    "https://checkout.bold.co/LNK-NEW-TEST"
  );
  assert.equal(
    state.get("bold-links/LNK-NEW-TEST")?.reference,
    "MF-NEW-LINK-1"
  );
});

test("si falla guardar la asociaci�n del enlace nuevo, no devuelve �xito", async () => {
  reset();
  seedOrder("MF-NEW-LINK-2", {
    boldPaymentLink: "",
    paymentLink: ""
  });
  failMappingWrites = true;

  const response = await request("MF-NEW-LINK-2");
  assert.equal(response.status, 503);
  assert.equal(boldFetchCalls, 1);
  assert.equal(state.has("bold-links/LNK-NEW-TEST"), false);

  const order = state.get("orders/MF-NEW-LINK-2");
  assert.equal(order.boldPaymentLink, "LNK-NEW-TEST");
  assert.equal(
    order.paymentLink,
    "https://checkout.bold.co/LNK-NEW-TEST"
  );
});

test("si falla guardar el pedido después de crear el enlace, devuelve 503", async () => {
  reset();
  const reference = "MF-NEW-LINK-3";
  seedOrder(reference, {
    boldPaymentLink: "",
    paymentLink: ""
  });
  failOrderWrites = true;

  const response = await request(reference);
  assert.equal(response.status, 503);
  assert.equal(boldFetchCalls, 1);
  assert.equal(state.get("orders/" + reference).boldPaymentLink, "");
  assert.equal(state.has("bold-links/LNK-NEW-TEST"), false);
});

test("dos solicitudes concurrentes no sobrescriben el enlace ganador", async () => {
  reset();
  seedOrder("MF-CONCURRENT-1", {
    boldPaymentLink: "",
    paymentLink: ""
  });

  let markBothFetched;
  let releaseFetches;

  const bothFetched = new Promise(resolve => {
    markBothFetched = resolve;
  });
  const release = new Promise(resolve => {
    releaseFetches = resolve;
  });

  concurrentFetchBarrier = { bothFetched, release, markBothFetched };

  const firstRequest = request("MF-CONCURRENT-1");
  const secondRequest = request("MF-CONCURRENT-1");

  await bothFetched;
  releaseFetches();

  const responses = await Promise.all([firstRequest, secondRequest]);
  const statuses = responses.map(response => response.status).sort();

  assert.deepEqual(statuses, [200, 409]);
  assert.equal(boldFetchCalls, 2);

  const order = state.get("orders/MF-CONCURRENT-1");
  assert.ok(
    ["LNK-CONCURRENT-1", "LNK-CONCURRENT-2"].includes(order.boldPaymentLink)
  );
  assert.equal(
    order.paymentLink,
    "https://checkout.bold.co/" + order.boldPaymentLink
  );
  assert.equal(
    state.get("bold-links/" + order.boldPaymentLink)?.reference,
    "MF-CONCURRENT-1"
  );

  const losingLink = order.boldPaymentLink === "LNK-CONCURRENT-1"
    ? "LNK-CONCURRENT-2"
    : "LNK-CONCURRENT-1";
  assert.equal(state.has("bold-links/" + losingLink), false);

  concurrentFetchBarrier = null;
});