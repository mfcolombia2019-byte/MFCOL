import { store } from "./_admin.mjs";

function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify?.env?.get) {
      const value = Netlify.env.get(name);
      if (value) return String(value).trim();
    }
  } catch {}
  return String(process.env[name] || "").trim();
}

function authorized(req, expected) {
  const supplied = String(req.headers.get("x-mf-diagnostic-key") || "");
  if (!expected || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}

function summarizeInbox(item) {
  return {
    eventId: String(item.id || "").slice(0, 100),
    type: String(item.type || ""),
    status: String(item.status || "unknown"),
    reference: String(item.reference || ""),
    attempts: Number(item.attempts || 0),
    receivedAt: item.receivedAt || "",
    updatedAt: item.updatedAt || "",
    processedAt: item.processedAt || "",
    nextAttemptAt: item.nextAttemptAt || "",
    lastError: String(item.lastError || "").slice(0, 240)
  };
}

function summarizeOutbox(item) {
  return {
    kind: String(item.kind || ""),
    status: String(item.status || "unknown"),
    attempts: Number(item.attempts || 0),
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
    sentAt: item.sentAt || "",
    nextAttemptAt: item.nextAttemptAt || "",
    lastError: String(item.lastError || "").slice(0, 240)
  };
}

export default async (req) => {
  const headers = { "Cache-Control": "no-store" };
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "Método no permitido" }, { status: 405, headers: { ...headers, Allow: "POST" } });
  }

  const contextName = env("CONTEXT").toLowerCase();
  if (contextName === "production") {
    return Response.json({ ok: false, error: "Diagnóstico deshabilitado en producción" }, { status: 404, headers });
  }

  if (!authorized(req, env("WHATSAPP_DIAGNOSTIC_KEY"))) {
    return Response.json({ ok: false, error: "No autorizado" }, { status: 401, headers });
  }

  let body;
  try { body = await req.json(); }
  catch { return Response.json({ ok: false, error: "JSON inválido" }, { status: 400, headers }); }

  const reference = String(body?.reference || "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(reference)) {
    return Response.json({ ok: false, error: "Referencia inválida" }, { status: 400, headers });
  }

  try {
    const order = await store.get("orders/" + reference, { type: "json", consistency: "strong" });
    const inboxRows = [];
    const { blobs = [] } = await store.list({ prefix: "webhook-inbox/" });
    for (const blob of blobs.slice(0, 500)) {
      const item = await store.get(blob.key, { type: "json", consistency: "strong" });
      if (item && (String(item.reference || "") === reference ||
          String(item.event?.data?.metadata?.reference || "") === reference)) {
        inboxRows.push(summarizeInbox(item));
      }
    }

    const whatsapp = await store.get("whatsapp-outbox/" + reference, { type: "json", consistency: "strong" });
    const metaRows = [];
    const { blobs: metaBlobs = [] } = await store.list({ prefix: "meta-outbox/" });
    for (const blob of metaBlobs.slice(0, 500)) {
      const item = await store.get(blob.key, { type: "json", consistency: "strong" });
      if (item && String(item.orderReference || "") === reference) metaRows.push(summarizeOutbox(item));
    }

    return Response.json({
      ok: true,
      context: contextName || "unknown",
      reference,
      order: order ? {
        found: true,
        paymentStatus: String(order.paymentStatus || ""),
        status: String(order.status || ""),
        total: Number(order.total || 0),
        paymentIdPresent: Boolean(order.paymentId),
        webhookEventIdPresent: Boolean(order.webhookEventId),
        createdAt: order.createdAt || "",
        updatedAt: order.updatedAt || ""
      } : { found: false },
      boldInbox: inboxRows,
      whatsappOutbox: whatsapp ? summarizeOutbox(whatsapp) : { found: false },
      metaOutbox: metaRows
    }, { headers });
  } catch (error) {
    console.error("Error en diagnóstico de pedido:", error);
    return Response.json({ ok: false, error: "No se pudieron leer los registros de diagnóstico" }, { status: 500, headers });
  }
};
