import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Un intento rechazado seguido de un reintento aprobado dentro del checkout de
// Bold deja el pedido en "rechazado". order-status debe poder confirmarlo.

const REFERENCE = "MFRECHAZADO1";
const TOTAL = 207000;
const API_KEY = "test-key-not-a-real-secret";

const records = new Map();
let nextEtag = 1;
let metaEnqueues = 0;
let whatsappEnqueues = 0;

const blobStore = {
  async get(key) { return records.has(key) ? structuredClone(records.get(key).data) : null; },
  async getWithMetadata(key) {
    const r = records.get(key);
    return r ? { data: structuredClone(r.data), etag: r.etag } : { data: null, etag: null };
  },
  async setJSON(key, value, options = {}) {
    const current = records.get(key);
    if (options.onlyIfNew && current) return { modified: false, etag: current.etag };
    if (options.onlyIfMatch && (!current || current.etag !== options.onlyIfMatch)) return { modified: false, etag: current?.etag || null };
    const etag = String(nextEtag++);
    records.set(key, { data: structuredClone(value), etag });
    return { modified: true, etag };
  }
};

mock.module("@netlify/blobs", { exports: { getStore: () => blobStore } });
mock.module("../netlify/functions/_meta-outbox.mjs", {
  exports: {
    async enqueuePurchase() { metaEnqueues++; return { key: "meta-test" }; },
    async processOutboxKey() { return { ok: true }; }
  }
});
mock.module("../netlify/functions/_whatsapp.mjs", {
  exports: {
    async enqueueWhatsAppConfirmation() { whatsappEnqueues++; return { key: "wa-test" }; },
    async processWhatsAppOutboxKey() { return { ok: true }; }
  }
});

process.env.BOLD_API_KEY = API_KEY;
const { default: orderStatus } = await import("../netlify/functions/order-status.mjs");

function seed(paymentStatus) {
  records.clear();
  nextEtag = 1;
  metaEnqueues = 0;
  whatsappEnqueues = 0;
  records.set("orders/" + REFERENCE, {
    etag: String(nextEtag++),
    data: {
      reference: REFERENCE,
      total: TOTAL,
      paymentStatus,
      status: "nuevo",
      paymentMethod: "Link de pago (Bold)",
      paymentLink: "https://checkout.bold.co/LNK_X",
      boldPaymentLink: "LNK_X",
      phone: "+573001112233"
    }
  });
}

const voucher = (overrides = {}) => new Response(JSON.stringify({
  transaction_id: "TX-RECH-1",
  total: TOTAL,
  reference_id: REFERENCE,
  payment_method: "CREDIT_CARD",
  transaction_date: "2026-10-12 03:00:00-05:00",
  payment_status: "APPROVED",
  ...overrides
}), { status: 200, headers: { "Content-Type": "application/json" } });

async function status() {
  const res = await orderStatus(new Request("https://preview.example.netlify.app/.netlify/functions/order-status?ref=" + REFERENCE));
  return res.json();
}

test("pedido rechazado que Bold confirma como aprobado pasa a aprobado y dispara Meta y WhatsApp una vez", async () => {
  seed("rechazado");
  const f = mock.method(globalThis, "fetch", async () => voucher());
  try {
    const body = await status();
    assert.equal(body.paymentStatus, "aprobado");
    assert.equal(body.verification, "checked");
    assert.equal(records.get("orders/" + REFERENCE).data.paymentStatus, "aprobado");
    assert.equal(metaEnqueues, 1);
    assert.equal(whatsappEnqueues, 1);
  } finally { f.mock.restore(); }
});

test("pedido rechazado que Bold sigue informando rechazado se queda rechazado sin efectos", async () => {
  seed("rechazado");
  const f = mock.method(globalThis, "fetch", async () => voucher({ payment_status: "REJECTED" }));
  try {
    const body = await status();
    assert.equal(body.paymentStatus, "rechazado");
    assert.equal(body.verification, "checked");
    assert.equal(metaEnqueues, 0);
    assert.equal(whatsappEnqueues, 0);
  } finally { f.mock.restore(); }
});

test("un pedido anulado no se reabre", async () => {
  seed("anulado");
  let calls = 0;
  const f = mock.method(globalThis, "fetch", async () => { calls++; return voucher(); });
  try {
    const body = await status();
    assert.equal(body.paymentStatus, "anulado");
    assert.equal(calls, 0);
  } finally { f.mock.restore(); }
});
