import assert from "node:assert/strict";
import { mock, test } from "node:test";

const records = new Map();
const processCalls = [];

const store = {
  async list({ prefix }) {
    return {
      blobs: [...records.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => ({ key }))
    };
  },
  async get(key) {
    return records.has(key) ? structuredClone(records.get(key)) : null;
  }
};

const adminUrl = new URL("../netlify/functions/_admin.mjs", import.meta.url).href;
const whatsappUrl = new URL("../netlify/functions/_whatsapp.mjs", import.meta.url).href;
const retryUrl = new URL("../netlify/functions/whatsapp-outbox.mjs", import.meta.url).href;

mock.module(adminUrl, {
  exports: { store }
});

mock.module(whatsappUrl, {
  exports: {
    async processWhatsAppOutboxKey(key) {
      processCalls.push(key);
      return { ok: true };
    }
  }
});

const retry = await import(retryUrl);

test("WhatsApp retry worker skips exhausted errors and recent processing, but handles due work", async () => {
  records.clear();
  processCalls.length = 0;

  const now = Date.now();
  records.set("whatsapp-outbox/error-exhausted", {
    status: "error",
    attempts: 8,
    nextAttemptAt: ""
  });
  records.set("whatsapp-outbox/error-due", {
    status: "error",
    attempts: 3,
    nextAttemptAt: new Date(now - 1_000).toISOString()
  });
  records.set("whatsapp-outbox/error-future", {
    status: "error",
    attempts: 3,
    nextAttemptAt: new Date(now + 60_000).toISOString()
  });
  records.set("whatsapp-outbox/pending", {
    status: "pending",
    attempts: 0,
    nextAttemptAt: new Date(now - 1_000).toISOString()
  });
  records.set("whatsapp-outbox/processing-recent", {
    status: "processing",
    attempts: 2,
    processingAt: new Date(now - 60_000).toISOString(),
    nextAttemptAt: ""
  });
  records.set("whatsapp-outbox/processing-stale", {
    status: "processing",
    attempts: 2,
    processingAt: new Date(now - 11 * 60_000).toISOString(),
    nextAttemptAt: ""
  });
  records.set("whatsapp-outbox/sent", {
    status: "sent",
    nextAttemptAt: ""
  });

  await retry.default();

  assert.deepEqual(processCalls.sort(), [
    "whatsapp-outbox/error-due",
    "whatsapp-outbox/pending",
    "whatsapp-outbox/processing-stale"
  ]);
});
