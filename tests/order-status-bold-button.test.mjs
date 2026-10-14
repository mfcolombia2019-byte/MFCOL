import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Regresión: el pago se hace con el Embedded Checkout / Botón de pagos de Bold
// (orderId = referencia del pedido MF). order-status debe confirmar la
// aprobación consultando a Bold por esa referencia, nunca por el ID LNK_* del
// enlace ni por parámetros que llegan desde el navegador.
// Estas pruebas usan la implementación real de _orders.mjs y simulan Bold, Meta
// y WhatsApp: no hay llamadas de red ni mensajes reales.

const REFERENCE = "MFMV4XOYOS9A736E1F58";
const TOTAL = 207000;
const API_KEY = "test-key-not-a-real-secret";

const records = new Map();
let nextEtag = 1;
let failOrderWrites = false;
let metaEnqueues = [];
let whatsappEnqueues = [];
let whatsappProcesses = 0;

const blobStore = {
  async get(key) {
    return records.has(key) ? structuredClone(records.get(key).data) : null;
  },
  async getWithMetadata(key) {
    const record = records.get(key);
    return record
      ? { data: structuredClone(record.data), etag: record.etag }
      : { data: null, etag: null };
  },
  async setJSON(key, value, options = {}) {
    if (failOrderWrites && key.startsWith("orders/")) {
      throw new Error("fallo de persistencia simulado");
    }
    const current = records.get(key);
    if (options.onlyIfNew && current) return { modified: false, etag: current.etag };
    if (options.onlyIfMatch && (!current || current.etag !== options.onlyIfMatch)) {
      return { modified: false, etag: current?.etag || null };
    }
    const etag = String(nextEtag++);
    records.set(key, { data: structuredClone(value), etag });
    return { modified: true, etag };
  }
};

mock.module("@netlify/blobs", {
  exports: { getStore: () => blobStore }
});
mock.module("../netlify/functions/_meta-outbox.mjs", {
  exports: {
    async enqueuePurchase(order) {
      metaEnqueues.push(order);
      return { key: "meta-test" };
    },
    async processOutboxKey() { return { ok: true }; }
  }
});
mock.module("../netlify/functions/_whatsapp.mjs", {
  exports: {
    async enqueueWhatsAppConfirmation(order) {
      whatsappEnqueues.push(order);
      return { key: "wa-test" };
    },
    async processWhatsAppOutboxKey() {
      whatsappProcesses++;
      return { ok: true };
    }
  }
});

process.env.BOLD_API_KEY = API_KEY;
const { default: orderStatus } = await import("../netlify/functions/order-status.mjs");
const { purchaseEventId, outboxKeyForPurchase } = await import("../netlify/functions/_orders.mjs");

function seedOrder(overrides = {}) {
  records.clear();
  nextEtag = 1;
  failOrderWrites = false;
  metaEnqueues = [];
  whatsappEnqueues = [];
  whatsappProcesses = 0;
  records.set("orders/" + REFERENCE, {
    etag: String(nextEtag++),
    data: {
      reference: REFERENCE,
      total: TOTAL,
      paymentStatus: "pendiente",
      status: "nuevo",
      paymentMethod: "Link de pago (Bold)",
      paymentLink: "https://checkout.bold.co/LNK_SPCLIDP2A3",
      boldPaymentLink: "LNK_SPCLIDP2A3",
      phone: "+573001112233",
      ...overrides
    }
  });
}

function storedOrder() {
  return records.get("orders/" + REFERENCE).data;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function voucher(overrides = {}) {
  return {
    link_id: "BTN_TEST",
    transaction_id: "CNPVI70CQC0EY",
    total: TOTAL,
    subtotal: TOTAL,
    description: "MF Colombia · Pedido de prueba",
    reference_id: REFERENCE,
    payment_method: "CREDIT_CARD",
    payer_email: "cliente.privado@example.test",
    transaction_date: "2026-10-12 03:00:00-05:00",
    payment_status: "APPROVED",
    ...overrides
  };
}

function notification(overrides = {}) {
  const { data: dataOverrides, ...rest } = overrides;
  return {
    id: "notification-1",
    type: "SALE_APPROVED",
    subject: "CNPVI70CQC0EY",
    source: "/payments",
    time: 1761063334000000000,
    data: {
      payment_id: "CNPVI70CQC0EY",
      created_at: "2026-10-12T03:00:00-05:00",
      amount: { currency: "COP", total: TOTAL },
      metadata: { reference: REFERENCE },
      ...dataOverrides
    },
    ...rest
  };
}

// Ejecuta fn con fetch y console.error simulados y devuelve lo registrado.
async function withBold(handler, fn) {
  const urls = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
    urls.push({ url: String(url), authorization: options?.headers?.Authorization });
    return handler(String(url), urls.length);
  });
  const errorMock = mock.method(console, "error", () => {});
  try {
    await fn();
  } finally {
    const logged = JSON.stringify(errorMock.mock.calls.map(call => call.arguments.map(String)));
    fetchMock.mock.restore();
    errorMock.mock.restore();
    // Ningún log puede exponer la clave ni datos del pagador.
    assert.ok(!logged.includes(API_KEY), "los logs no deben incluir BOLD_API_KEY");
    assert.ok(!logged.includes("cliente.privado@example.test"), "los logs no deben incluir el correo del pagador");
  }
  return { urls, errors: errorMock.mock.calls.length };
}

async function requestStatus(query = "ref=" + REFERENCE) {
  const response = await orderStatus(
    new Request("https://preview.example.netlify.app/.netlify/functions/order-status?" + query)
  );
  return { status: response.status, body: await response.json() };
}

function assertNoSideEffects() {
  assert.equal(metaEnqueues.length, 0);
  assert.equal(whatsappEnqueues.length, 0);
  assert.equal(whatsappProcesses, 0);
}

test("una aprobación verificada del Botón de pagos aprueba el pedido y dispara Meta y WhatsApp una sola vez", async () => {
  seedOrder();
  const { urls } = await withBold(() => jsonResponse(voucher()), async () => {
    const { status, body } = await requestStatus();
    assert.equal(status, 200);
    assert.equal(body.paymentStatus, "aprobado");
    assert.equal(body.verification, "checked");
  });

  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, "https://payments.api.bold.co/v2/payment-voucher/" + REFERENCE);
  assert.equal(urls[0].authorization, "x-api-key " + API_KEY);

  const order = storedOrder();
  assert.equal(order.paymentStatus, "aprobado");
  assert.equal(order.paymentId, "CNPVI70CQC0EY");
  assert.equal(order.webhookType, "SALE_APPROVED");
  assert.equal(order.confirmedAmount, TOTAL);
  assert.equal(order.confirmedCurrency, "COP");
  assert.equal(order.purchaseEventId, "purchase_" + REFERENCE + "_CNPVI70CQC0EY");
  assert.equal(metaEnqueues.length, 1);
  assert.equal(whatsappEnqueues.length, 1);
  assert.equal(whatsappProcesses, 1);
});

test("los parámetros de retorno del navegador no aprueban el pedido sin verificación de Bold", async () => {
  seedOrder();
  await withBold(() => jsonResponse(voucher({ payment_status: "NO_TRANSACTION_FOUND", transaction_id: undefined })), async () => {
    const { body } = await requestStatus(
      "ref=" + REFERENCE + "&bold-order-id=" + REFERENCE + "&bold-tx-status=approved"
    );
    assert.equal(body.paymentStatus, "pendiente");
    assert.equal(body.verification, "checked");
  });
  assert.equal(storedOrder().paymentStatus, "pendiente");
  assertNoSideEffects();
});

for (const paymentStatus of ["PROCESSING", "PENDING", "REJECTED", "FAILED", "VOIDED"]) {
  test("estado " + paymentStatus + " de Bold no aprueba ni modifica el pedido", async () => {
    seedOrder();
    const { urls } = await withBold(() => jsonResponse(voucher({ payment_status: paymentStatus })), async () => {
      const { body } = await requestStatus();
      assert.equal(body.paymentStatus, "pendiente");
    });
    assert.equal(urls.length, 1);
    assert.equal(storedOrder().paymentStatus, "pendiente");
    assertNoSideEffects();
  });
}

test("importe distinto al del pedido no aprueba", async () => {
  seedOrder();
  const { errors } = await withBold(() => jsonResponse(voucher({ total: 9900 })), async () => {
    const { body } = await requestStatus();
    assert.equal(body.paymentStatus, "pendiente");
  });
  assert.ok(errors >= 1, "debe registrar el desajuste");
  assert.equal(storedOrder().paymentStatus, "pendiente");
  assertNoSideEffects();
});

test("referencia distinta a la del pedido no aprueba", async () => {
  seedOrder();
  await withBold(() => jsonResponse(voucher({ reference_id: "MFOTROPEDIDO" })), async () => {
    const { body } = await requestStatus();
    assert.equal(body.paymentStatus, "pendiente");
  });
  assert.equal(storedOrder().paymentStatus, "pendiente");
  assertNoSideEffects();
});

test("una aprobación sin transaction_id no se acepta", async () => {
  seedOrder();
  await withBold(() => jsonResponse(voucher({ transaction_id: undefined })), async () => {
    const { body } = await requestStatus();
    assert.equal(body.paymentStatus, "pendiente");
  });
  assertNoSideEffects();
});

test("si el voucher responde HTTP 401, consulta las notificaciones por referencia externa y aprueba solo con datos válidos", async () => {
  seedOrder();
  const { urls } = await withBold(
    url => url.includes("/payment-voucher/")
      ? jsonResponse({ message: "Unauthorized" }, 401)
      : jsonResponse({ notifications: [notification()] }),
    async () => {
      const { body } = await requestStatus();
      assert.equal(body.paymentStatus, "aprobado");
    }
  );
  assert.equal(urls.length, 2);
  assert.equal(
    urls[1].url,
    "https://integrations.api.bold.co/payments/webhook/notifications/" + REFERENCE + "?is_external_reference=true"
  );
  assert.equal(storedOrder().paymentStatus, "aprobado");
  assert.equal(metaEnqueues.length, 1);
  assert.equal(whatsappEnqueues.length, 1);
});

test("consulta de notificaciones sin resultados deja el pedido pendiente", async () => {
  seedOrder();
  await withBold(
    url => url.includes("/payment-voucher/")
      ? jsonResponse({ message: "Not found" }, 404)
      : jsonResponse({ notifications: [] }),
    async () => {
      const { body } = await requestStatus();
      assert.equal(body.paymentStatus, "pendiente");
      assert.equal(body.verification, "checked");
    }
  );
  assertNoSideEffects();
});

test("notificaciones con otra referencia, otro tipo, otra moneda o importe distinto no aprueban", async () => {
  const invalid = [
    notification({ data: { metadata: { reference: "LNK_SPCLIDP2A3" } } }),
    notification({ data: { metadata: { reference: "MFOTROPEDIDO" } } }),
    notification({ type: "SALE_REJECTED" }),
    notification({ data: { amount: { currency: "USD", total: TOTAL } } }),
    notification({ data: { amount: { currency: "COP", total: 1000 } } })
  ];
  for (const item of invalid) {
    seedOrder();
    await withBold(
      url => url.includes("/payment-voucher/")
        ? jsonResponse({}, 404)
        : jsonResponse({ notifications: [item] }),
      async () => {
        const { body } = await requestStatus();
        assert.equal(body.paymentStatus, "pendiente");
      }
    );
    assert.equal(storedOrder().paymentStatus, "pendiente");
    assertNoSideEffects();
  }
});

test("error HTTP de Bold en ambas fuentes: sigue pendiente, informa 'unavailable' y no filtra secretos", async () => {
  seedOrder();
  const { urls, errors } = await withBold(
    url => url.includes("/payment-voucher/")
      ? jsonResponse({ message: "boom" }, 500)
      : jsonResponse({ message: "unavailable" }, 503),
    async () => {
      const { status, body } = await requestStatus();
      assert.equal(status, 200);
      assert.equal(body.paymentStatus, "pendiente");
      assert.equal(body.verification, "unavailable");
    }
  );
  assert.equal(urls.length, 2);
  assert.ok(errors >= 2, "debe registrar ambos fallos");
  assert.equal(storedOrder().paymentStatus, "pendiente");
  assertNoSideEffects();
});

test("fallo de red al consultar a Bold deja el pedido pendiente", async () => {
  seedOrder();
  await withBold(() => { throw new TypeError("fetch failed"); }, async () => {
    const { body } = await requestStatus();
    assert.equal(body.paymentStatus, "pendiente");
    assert.equal(body.verification, "unavailable");
  });
  assertNoSideEffects();
});

test("si falla la persistencia de la aprobación, el pedido sigue pendiente y no se envían efectos", async () => {
  seedOrder();
  // El cooldown se escribe en otra clave; solo fallan las escrituras del pedido.
  failOrderWrites = true;
  await withBold(() => jsonResponse(voucher()), async () => {
    const { status, body } = await requestStatus();
    assert.equal(status, 200);
    assert.equal(body.paymentStatus, "pendiente");
    assert.equal(body.verification, "unavailable");
  });
  assert.equal(storedOrder().paymentStatus, "pendiente");
  assertNoSideEffects();
});

test("solicitudes simultáneas y repetidas consultan a Bold una vez y no duplican Meta ni WhatsApp", async () => {
  seedOrder();
  const { urls } = await withBold(() => jsonResponse(voucher()), async () => {
    const results = await Promise.all([requestStatus(), requestStatus(), requestStatus()]);
    assert.ok(results.some(result => result.body.paymentStatus === "aprobado"));
    const after = await requestStatus();
    assert.equal(after.body.paymentStatus, "aprobado");
    assert.equal(after.body.verification, "not_applicable");
  });
  assert.equal(urls.length, 1, "una sola consulta a Bold");
  assert.equal(metaEnqueues.length, 1);
  assert.equal(whatsappEnqueues.length, 1);
  assert.equal(whatsappProcesses, 1);
});

test("un pedido ya aprobado no vuelve a consultar a Bold", async () => {
  seedOrder({ paymentStatus: "aprobado", paymentId: "CNPVI70CQC0EY" });
  const { urls } = await withBold(() => jsonResponse(voucher({ payment_status: "REJECTED" })), async () => {
    const { body } = await requestStatus();
    assert.equal(body.paymentStatus, "aprobado");
  });
  assert.equal(urls.length, 0);
  assertNoSideEffects();
});

test("un pedido que no es de Bold no consulta a Bold", async () => {
  seedOrder({ paymentMethod: "WhatsApp", paymentLink: "", boldPaymentLink: "" });
  const { urls } = await withBold(() => jsonResponse(voucher()), async () => {
    const { body } = await requestStatus();
    assert.equal(body.paymentStatus, "pendiente");
    assert.equal(body.verification, "not_applicable");
  });
  assert.equal(urls.length, 0);
});

test("sin BOLD_API_KEY no se consulta y se informa 'unavailable'", async () => {
  seedOrder();
  delete process.env.BOLD_API_KEY;
  try {
    const { urls } = await withBold(() => jsonResponse(voucher()), async () => {
      const { body } = await requestStatus();
      assert.equal(body.paymentStatus, "pendiente");
      assert.equal(body.verification, "unavailable");
    });
    assert.equal(urls.length, 0);
  } finally {
    process.env.BOLD_API_KEY = API_KEY;
  }
});

test("el sondeo y el webhook del mismo pago comparten clave de Purchase (sin duplicado en Meta)", () => {
  const pollEvent = "poll_" + REFERENCE + "_SALE_APPROVED_CNPVI70CQC0EY";
  const webhookEvent = "191850cb-00f8-4f64-aa5f-4975848e9428";
  assert.equal(
    purchaseEventId(REFERENCE, "CNPVI70CQC0EY", pollEvent),
    purchaseEventId(REFERENCE, "CNPVI70CQC0EY", webhookEvent)
  );
  assert.equal(
    outboxKeyForPurchase(REFERENCE, "CNPVI70CQC0EY", pollEvent),
    outboxKeyForPurchase(REFERENCE, "CNPVI70CQC0EY", webhookEvent)
  );
});
