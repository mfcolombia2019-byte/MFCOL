import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../netlify/functions/_admin.mjs", {
  exports: {
    requireAdmin: () => globalThis.__boldStatusAdminDenied
      ? Response.json({ error: "No autorizado" }, { status: 401 })
      : null,
    json: (data, status = 200, headers = {}) => Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store", ...headers }
    })
  }
});

process.env.BOLD_API_KEY = "test-key-not-a-real-secret";
const { default: boldStatus } = await import("../netlify/functions/bold-status.mjs");

function request(query = "reference=MFTEST123") {
  return boldStatus(new Request("https://example.test/.netlify/functions/bold-status?" + query));
}

test("reports upstream HTTP status without exposing provider response body", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ message: "private detail", code: "ACCESS_DENIED", customer_email: "private@example.test" }),
    { status: 403, headers: { "Content-Type": "application/json" } }
  ));
  try {
    const response = await request();
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.diagnostic.httpStatus, 403);
    assert.equal(body.diagnostic.providerCode, "ACCESS_DENIED");
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal(JSON.stringify(body).includes("private detail"), false);
  } finally {
    fetchMock.mock.restore();
  }
});

test("reports non-JSON response safely", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(
    "<html>internal gateway error</html>",
    { status: 502, headers: { "Content-Type": "text/html" } }
  ));
  try {
    const response = await request();
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.diagnostic.httpStatus, 502);
    assert.equal(body.diagnostic.contentType, "text/html");
    assert.equal(body.diagnostic.responseFormat, "non_json_or_empty");
    assert.equal(JSON.stringify(body).includes("internal gateway error"), false);
  } finally {
    fetchMock.mock.restore();
  }
});

test("reports connection failure without leaking exception details", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("secret-bearing internal exception");
  });
  try {
    const response = await request();
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.diagnostic.stage, "upstream_fetch_failed");
    assert.equal(JSON.stringify(body).includes("secret-bearing"), false);
  } finally {
    fetchMock.mock.restore();
  }
});

test("rejects invalid input before calling Bold", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not be called");
  });
  try {
    const response = await request("");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Falta payment_link o reference");
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

// --- Consulta por referencia (Botón de pagos): casos de estado, seguridad y fallos ---

const REF = "MFMV5WMN88EE0C232DA2";
const VOUCHER = "payments.api.bold.co/v2/payment-voucher/";
const NOTIFICATIONS = "integrations.api.bold.co/payments/webhook/notifications/";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Enruta por URL; devuelve las URL consultadas para verificar qué se llamó.
async function withBold(routes, fn) {
  const calls = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    const route = Object.entries(routes).find(([part]) => String(url).includes(part));
    if (!route) throw new Error("unexpected url " + url);
    const value = route[1];
    return typeof value === "function" ? value() : value;
  });
  try {
    return await fn(calls);
  } finally {
    fetchMock.mock.restore();
  }
}

const approvedVoucher = (over = {}) => ({
  payment_status: "APPROVED",
  reference_id: REF,
  transaction_id: "TX_123",
  total: 443800,
  payment_method: "CREDIT_CARD",
  payer_email: "private@example.test",
  ...over
});

test("approved payment is reported only for the exact reference and hides payer data", async () => {
  await withBold({ [VOUCHER]: () => jsonResponse(approvedVoucher()) }, async (calls) => {
    const response = await request("reference=" + REF);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.paymentStatus, "aprobado");
    assert.equal(body.verified, true);
    assert.equal(body.reference, REF);
    assert.equal(body.total, 443800);
    assert.equal(body.message, "Pago aprobado");
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes(VOUCHER + REF));
  });
});

test("pending and rejected payments get their own safe status", async () => {
  await withBold({ [VOUCHER]: () => jsonResponse(approvedVoucher({ payment_status: "PROCESSING", transaction_id: "" })) }, async () => {
    const body = await (await request("reference=" + REF)).json();
    assert.equal(body.paymentStatus, "pendiente");
  });
  await withBold({ [VOUCHER]: () => jsonResponse(approvedVoucher({ payment_status: "REJECTED" })) }, async () => {
    const body = await (await request("reference=" + REF)).json();
    assert.equal(body.paymentStatus, "rechazado");
  });
});

test("unknown reference returns 404 and invalid format never reaches Bold", async () => {
  await withBold({
    [VOUCHER]: () => jsonResponse({ code: "NOT_FOUND" }, 404),
    [NOTIFICATIONS]: () => jsonResponse({ notifications: [] })
  }, async () => {
    const response = await request("reference=" + REF);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "bold_not_found");
  });
  await withBold({}, async (calls) => {
    for (const bad of ["MF%2F..%2Fx", "a".repeat(81), "MF%20X"]) {
      const response = await request("reference=" + bad);
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, 0);
  });
});

test("approval whose reference_id differs from the queried reference is never accepted", async () => {
  await withBold({ [VOUCHER]: () => jsonResponse(approvedVoucher({ reference_id: "MFOTHERORDER" })) }, async () => {
    const response = await request("reference=" + REF);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, "bold_reference_mismatch");
    assert.equal(body.paymentStatus, undefined);
    assert.equal(body.verified, undefined);
  });
});

test("approval without reference_id or transaction_id is never accepted", async () => {
  for (const over of [{ reference_id: undefined }, { reference_id: "" }, { transaction_id: "" }]) {
    await withBold({ [VOUCHER]: () => jsonResponse(approvedVoucher(over)) }, async () => {
      const response = await request("reference=" + REF);
      const body = await response.json();
      assert.equal(response.status, 502);
      assert.equal(body.code, "bold_reference_mismatch");
      assert.equal(body.paymentStatus, undefined);
    });
  }
});

test("notification fallback only trusts events carrying the exact order reference", async () => {
  const event = (reference, type = "SALE_APPROVED") => ({
    type,
    subject: "TX_9",
    data: { payment_id: "TX_9", created_at: "2026-10-12T10:00:00Z", amount: { currency: "COP", total: 443800 }, metadata: { reference } }
  });
  await withBold({
    [VOUCHER]: () => new Response("upstream error", { status: 500 }),
    [NOTIFICATIONS]: () => jsonResponse({ notifications: [event("MFOTHERORDER")] })
  }, async () => {
    const response = await request("reference=" + REF);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.paymentStatus, "sin_confirmacion");
    assert.equal(body.verified, false);
  });
  await withBold({
    [VOUCHER]: () => new Response("upstream error", { status: 500 }),
    [NOTIFICATIONS]: () => jsonResponse({ notifications: [event("MFOTHERORDER"), event(REF)] })
  }, async () => {
    const body = await (await request("reference=" + REF)).json();
    assert.equal(body.paymentStatus, "aprobado");
    assert.equal(body.reference, REF);
  });
});

test("authentication errors, Bold outages and non-JSON bodies map to distinct safe errors", async () => {
  const cases = [
    [401, "bold_auth"],
    [403, "bold_auth"],
    [429, "bold_unavailable"],
    [503, "bold_unavailable"],
    [400, "bold_rejected"]
  ];
  for (const [status, code] of cases) {
    await withBold({
      [VOUCHER]: () => jsonResponse({ message: "secret-detail", api_key: "test-key-not-a-real-secret" }, status),
      [NOTIFICATIONS]: () => jsonResponse({ message: "secret-detail" }, status)
    }, async () => {
      const response = await request("reference=" + REF);
      const body = await response.json();
      assert.equal(response.status, 502);
      assert.equal(body.code, code);
      assert.equal(body.diagnostic.httpStatus, status);
      assert.equal(JSON.stringify(body).includes("secret-detail"), false);
      assert.equal(JSON.stringify(body).includes("test-key-not-a-real-secret"), false);
    });
  }
  await withBold({
    [VOUCHER]: () => new Response("<html>ok</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    [NOTIFICATIONS]: () => new Response("<html>ok</html>", { status: 200, headers: { "Content-Type": "text/html" } })
  }, async () => {
    const response = await request("reference=" + REF);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "bold_bad_response");
  });
});

test("network timeout is reported as such and does not expose exception details", async () => {
  const timeout = () => { throw Object.assign(new Error("secret-bearing timeout detail"), { name: "TimeoutError" }); };
  await withBold({ [VOUCHER]: timeout, [NOTIFICATIONS]: timeout }, async () => {
    const response = await request("reference=" + REF);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.diagnostic.stage, "upstream_timeout");
    assert.equal(body.code, "bold_unavailable");
    assert.equal(JSON.stringify(body).includes("secret-bearing"), false);
  });
});

test("unauthenticated admin requests are rejected before Bold is called", async () => {
  globalThis.__boldStatusAdminDenied = true;
  try {
    await withBold({}, async (calls) => {
      const response = await request("reference=" + REF);
      assert.equal(response.status, 401);
      assert.equal(calls.length, 0);
    });
  } finally {
    globalThis.__boldStatusAdminDenied = false;
  }
});

test("voucher without payment_status falls back to notifications instead of failing", async () => {
  const approvedEvent = {
    type: "SALE_APPROVED",
    subject: "TX_9",
    data: { payment_id: "TX_9", created_at: "2026-10-12T10:00:00Z", amount: { currency: "COP", total: 443800 }, metadata: { reference: REF } }
  };
  await withBold({
    [VOUCHER]: () => jsonResponse({ reference_id: REF }),
    [NOTIFICATIONS]: () => jsonResponse({ notifications: [approvedEvent] })
  }, async (calls) => {
    const body = await (await request("reference=" + REF)).json();
    assert.equal(body.paymentStatus, "aprobado");
    assert.equal(body.source, "notifications");
    assert.equal(calls.length, 2);
  });
  await withBold({
    [VOUCHER]: () => jsonResponse({ reference_id: REF }),
    [NOTIFICATIONS]: () => jsonResponse({ notifications: [] })
  }, async () => {
    const response = await request("reference=" + REF);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.paymentStatus, "sin_confirmacion");
    assert.equal(body.verified, false);
  });
});

test("voided voucher is reported as anulado, not rejected", async () => {
  await withBold({ [VOUCHER]: () => jsonResponse(approvedVoucher({ payment_status: "VOIDED" })) }, async () => {
    const body = await (await request("reference=" + REF)).json();
    assert.equal(body.paymentStatus, "anulado");
    assert.equal(body.message, "Pago anulado");
  });
});

test("timeout while reading the response body is reported as a timeout", async () => {
  const stalled = () => new Response(new ReadableStream({
    start(controller) {
      controller.error(Object.assign(new Error("secret-bearing body timeout"), { name: "TimeoutError" }));
    }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  await withBold({ [VOUCHER]: stalled, [NOTIFICATIONS]: stalled }, async () => {
    const response = await request("reference=" + REF);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.diagnostic.stage, "upstream_timeout");
    assert.equal(JSON.stringify(body).includes("secret-bearing"), false);
  });
});

test("querying is read-only: the function never imports the order store", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../netlify/functions/bold-status.mjs", import.meta.url), "utf8");
  assert.equal(/import[^;]*\b(store|_orders|_meta|_whatsapp)\b/.test(source), false);
  assert.equal(/setJSON|\.set\(|enqueue/.test(source), false);
});
