import assert from "node:assert/strict";
import { mock, test } from "node:test";

const records = new Map();
const writes = [];
const store = {
  async getWithMetadata(key) {
    const data = records.get(key);
    return data ? { data: structuredClone(data), etag: "etag-1" } : null;
  },
  async get(key) {
    return records.has(key) ? structuredClone(records.get(key)) : null;
  },
  async setJSON(...args) {
    writes.push(args);
    return { modified: true, etag: "etag-2" };
  }
};

const adminUrl = new URL("../netlify/functions/_admin.mjs", import.meta.url).href;
const whatsappUrl = new URL("../netlify/functions/_whatsapp.mjs", import.meta.url).href;

mock.module(adminUrl, { exports: { store } });

const { processWhatsAppOutboxKey } = await import(whatsappUrl);

test("direct processing skips exhausted WhatsApp errors without mutating the record", async () => {
  const key = "whatsapp-outbox/exhausted";
  const record = {
    key,
    orderReference: "MFORDER123",
    status: "error",
    attempts: 8,
    nextAttemptAt: "",
    processingAt: "",
    lastError: "Permanent failure"
  };
  records.clear();
  writes.length = 0;
  records.set(key, record);

  const result = await processWhatsAppOutboxKey(key);

  assert.deepEqual(result, {
    ok: false,
    skipped: true,
    reason: "terminal_error",
    key
  });
  assert.deepEqual(records.get(key), record);
  assert.equal(writes.length, 0);
});

test("direct processing skips non-retryable WhatsApp errors without a retry time", async () => {
  const key = "whatsapp-outbox/non-retryable";
  const record = {
    key,
    orderReference: "MFORDER456",
    status: "error",
    attempts: 1,
    nextAttemptAt: "",
    processingAt: "",
    lastError: "Invalid recipient"
  };
  records.clear();
  writes.length = 0;
  records.set(key, record);

  const result = await processWhatsAppOutboxKey(key);

  assert.deepEqual(result, {
    ok: false,
    skipped: true,
    reason: "terminal_error",
    key
  });
  assert.deepEqual(records.get(key), record);
  assert.equal(writes.length, 0);
});
