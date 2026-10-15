// SIMULATED harness: every dependency of netlify/functions/bold-webhook.mjs that
// touches the network or Netlify Blobs is replaced by an in-memory fake. Tests
// built on it prove the handler's logic, not Netlify or Bold behaviour.
import crypto from "node:crypto";
import { mock } from "node:test";

export const FAKE_SECRET_KEY = "test-secret-key-not-real";
export const FAKE_IDENTITY_KEY = "test-identity-key-not-real";

const fn = (name) => new URL("../../netlify/functions/" + name, import.meta.url).href;

export function sign(body, key = "") {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return crypto.createHmac("sha256", key).update(bytes.toString("base64")).digest("hex");
}

export function boldEvent(overrides = {}) {
  return {
    id: "evt-regress-1",
    type: "SALE_APPROVED",
    subject: "PAY-TEST-1",
    data: {
      payment_id: "PAY-TEST-1",
      amount: { currency: "COP", total: 199900 },
      metadata: { reference: "MF-TEST-1" },
      payment_method: "CARD_WEB"
    },
    ...overrides
  };
}

export function makeRequest(body, signature, method = "POST") {
  return new Request("https://example.test/.netlify/functions/bold-webhook", {
    method,
    headers: signature ? { "x-bold-signature": signature, "content-type": "application/json" } : {},
    body: method === "POST" ? body : undefined
  });
}

export async function createHarness({ storeName }) {
  const state = new Map();
  const ops = [];
  const logs = [];
  const flags = {
    failEnsureInbox: false,
    failSetJSON: false,
    processError: null,
    processResult: { ok: true, duplicate: false, reference: "MF-TEST-1" }
  };

  const store = {
    async get(key) {
      ops.push(["get", key]);
      return state.has(key) ? structuredClone(state.get(key)) : null;
    },
    async setJSON(key, value) {
      ops.push(["setJSON", key]);
      if (flags.failSetJSON) throw new Error("persistencia caída");
      state.set(key, structuredClone(value));
      return { modified: true, etag: '"e1"' };
    }
  };

  mock.module(fn("_admin.mjs"), {
    exports: { store, getJson: async () => null, APP_STORE_NAME: storeName }
  });
  mock.module(fn("_bold-webhook.mjs"), {
    exports: {
      safeEventId: (id) => String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100),
      webhookInboxKey: (id) => "webhook-inbox/" + id,
      async ensureInbox(event) {
        ops.push(["ensureInbox", event.id]);
        if (flags.failEnsureInbox) throw new Error("persistencia caída");
        return null;
      },
      async processBoldWebhook(event) {
        ops.push(["processBoldWebhook", event.id]);
        if (flags.processError) throw flags.processError;
        return flags.processResult;
      }
    }
  });
  mock.module(fn("_meta-outbox.mjs"), { exports: { processOutboxKey: async () => ({ ok: true }) } });
  mock.module(fn("_whatsapp.mjs"), { exports: { sendWhatsAppConfirmationForReference: async () => ({ ok: true }) } });

  for (const level of ["log", "warn", "error"]) {
    mock.method(console, level, (...args) => { logs.push({ level, line: args.map(String).join(" ") }); });
  }
  mock.method(globalThis, "fetch", async () => new Response("OK", { status: 200 }));

  process.env.BOLD_SECRET_KEY = FAKE_SECRET_KEY;
  process.env.BOLD_API_KEY = FAKE_IDENTITY_KEY;
  delete process.env.CONTEXT;

  const webhook = await import(fn("bold-webhook.mjs"));

  function reset() {
    state.clear();
    ops.length = 0;
    logs.length = 0;
    flags.failEnsureInbox = false;
    flags.failSetJSON = false;
    flags.processError = null;
    flags.processResult = { ok: true, duplicate: false, reference: "MF-TEST-1" };
    delete process.env.CONTEXT;
    process.env.BOLD_SECRET_KEY = FAKE_SECRET_KEY;
    process.env.BOLD_API_KEY = FAKE_IDENTITY_KEY;
  }

  // Run the handler, wait for the background work, return the response.
  async function invoke(request, context = {}) {
    let background;
    const response = await webhook.default(request, { waitUntil(p) { background = p; }, ...context });
    if (background) await background;
    return response;
  }

  function loggedEvents() {
    return logs.flatMap(({ line }) => { try { return [JSON.parse(line)]; } catch { return []; } });
  }

  return { webhook, state, ops, logs, flags, reset, invoke, loggedEvents };
}
