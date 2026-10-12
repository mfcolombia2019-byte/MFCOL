import assert from "node:assert/strict";
import { mock, test } from "node:test";

const records = new Map();
let nextEtag = 1;
let metaEnqueues = 0;
let whatsappEnqueues = 0;
let whatsappProcesses = 0;
let fetchHandler = async () => new Response(JSON.stringify({ notifications: [] }), {
  status: 200,
  headers: { "Content-Type": "application/json" }
});

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
mock.module("../netlify/functions/_orders.mjs", {
  exports: {
    applyBoldPaymentEvent(order, event, now) {
      return {
        ...order,
        paymentStatus: event.type === "SALE_APPROVED" ? "aprobado" :
          event.type === "SALE_REJECTED" ? "rechazado" :
          event.type === "VOID_APPROVED" ? "anulado" : "rechazado",
        webhookType: event.type,
        paymentId: event.data.payment_id,
        webhookEventId: event.id,
        updatedAt: now
      };
    }
  }
});
mock.module("../netlify/functions/_meta-outbox.mjs", {
  exports: {
    async enqueuePurchase() {
      metaEnqueues++;
      return { key: "meta-test" };
    },
    async processOutboxKey() { return { ok: true }; }
  }
});
mock.module("../netlify/functions/_whatsapp.mjs", {
  exports: {
    async enqueueWhatsAppConfirmation() {
      whatsappEnqueues++;
      return { key: "wa-test" };
    },
    async processWhatsAppOutboxKey() {
      whatsappProcesses++;
      return { ok: true };
    }
  }
});

process.env.BOLD_API_KEY = "test-key-not-a-real-secret";
const { default: orderStatus } = await import("../netlify/functions/order-status.mjs");

function seedOrder(reference = "MFORDER123") {
  records.clear();
  nextEtag = 1;
  metaEnqueues = 0;
  whatsappEnqueues = 0;
  whatsappProcesses = 0;
  records.set("orders/" + reference, {
    etag: String(nextEtag++),
    data: {
      reference,
      total: 5000,
      paymentStatus: "pendiente",
      status: "nuevo",
      paymentMethod: "Link de pago (Bold)",
      paymentLink: "https://checkout.bold.co/LNK_TEST123",
      boldPaymentLink: "LNK_TEST123",
      phone: "+573001112233"
    }
  });
}

function notification(reference, type = "SALE_APPROVED", total = 5000) {
  return {
    id: "notification-1",
    type,
    subject: "PAYMENT123",
    source: "/payments/links",
    time: 1761063334000000000,
    data: {
      payment_id: "PAYMENT123",
      created_at: "2026-10-10T12:00:00-05:00",
      amount: { currency: "COP", total },
      metadata: { reference }
    }
  };
}

async function requestStatus(reference = "MFORDER123") {
  return orderStatus(new Request("https://tienda.example/.netlify/functions/order-status?ref=" + encodeURIComponent(reference)));
}

test("consulta Bold por ID LNK del enlace y reconcilia aprobación", async () => {
  seedOrder();
  const fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(String(url), /\/payments\/webhook\/notifications\/LNK_TEST123$/);
    assert.equal(options.headers.Authorization, "x-api-key test-key-not-a-real-secret");
    return new Response(JSON.stringify({ notifications: [notification("LNK_TEST123")] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
  try {
    const response = await requestStatus();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.paymentStatus, "aprobado");
    assert.equal(records.get("orders/MFORDER123").data.paymentStatus, "aprobado");
    assert.equal(metaEnqueues, 1);
    assert.equal(whatsappEnqueues, 1);
    assert.equal(whatsappProcesses, 1);
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("no aprueba un pago cuyo importe o moneda no coinciden", async () => {
  seedOrder();
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    notifications: [notification("MFORDER123", "SALE_APPROVED", 9900)]
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  try {
    const response = await requestStatus();
    const body = await response.json();
    assert.equal(body.paymentStatus, "pendiente");
    assert.equal(records.get("orders/MFORDER123").data.paymentStatus, "pendiente");
    assert.equal(metaEnqueues, 0);
    assert.equal(whatsappEnqueues, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test("ignora una notificación de otra referencia externa", async () => {
  seedOrder();
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    notifications: [notification("LNK_OTHER123")]
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  try {
    const response = await requestStatus();
    const body = await response.json();
    assert.equal(body.paymentStatus, "pendiente");
    assert.equal(records.get("orders/MFORDER123").data.paymentStatus, "pendiente");
    assert.equal(metaEnqueues, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test("limita las consultas repetidas de respaldo durante 15 segundos", async () => {
  seedOrder();
  let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ notifications: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
  try {
    await requestStatus();
    await requestStatus();
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test("rechaza métodos distintos de GET y referencias inválidas", async () => {
  seedOrder();
  const methodResponse = await orderStatus(new Request("https://tienda.example/.netlify/functions/order-status?ref=MFORDER123", { method: "POST" }));
  assert.equal(methodResponse.status, 405);
  const refResponse = await requestStatus("../invalid");
  assert.equal(refResponse.status, 400);
});
