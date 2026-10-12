import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../netlify/functions/_admin.mjs", {
  exports: {
    requireAdmin: () => null,
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
