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

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("57") && digits.length >= 12) return digits;
  if (digits.length === 10 && digits.startsWith("3")) return "57" + digits;
  return digits;
}

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(amount);
}

function firstName(value) {
  return String(value || "").trim().split(/\s+/)[0] || "cliente";
}

function productData(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (items.length === 1) {
    const item = items[0] || {};
    return {
      product: String(item.name || "Tu producto").slice(0, 100),
      size: String(item.size || "—").slice(0, 40),
      color: String(item.color || "—").slice(0, 60)
    };
  }
  return {
    product: items.length ? "Varios productos" : "Tu compra",
    size: items.length ? "Varios" : "—",
    color: items.length ? "Varios" : "—"
  };
}

export function whatsappConfig() {
  return {
    accessToken:
      env("WHATSAPP_ACCESS_TOKEN") ||
      env("META_WHATSAPP_ACCESS_TOKEN") ||
      env("WHATSAPP_API_TOKEN"),
    phoneNumberId:
      env("WHATSAPP_PHONE_NUMBER_ID") ||
      env("META_WHATSAPP_PHONE_NUMBER_ID"),
    graphVersion: env("META_GRAPH_API_VERSION") || "v25.0",
    templateName: env("WHATSAPP_CONFIRMATION_TEMPLATE") || "confirmacion_compra_marlon",
    templateLanguage: env("WHATSAPP_TEMPLATE_LANGUAGE") || "es_CO"
  };
}

export function buildConfirmationTemplate(order) {
  const customerPhone = normalizePhone(order?.phone);
  if (!customerPhone) throw new Error("El pedido no tiene un teléfono/WhatsApp válido");

  const cfg = whatsappConfig();
  if (!cfg.accessToken) throw new Error("Falta WHATSAPP_ACCESS_TOKEN en Netlify");
  if (!cfg.phoneNumberId) throw new Error("Falta WHATSAPP_PHONE_NUMBER_ID en Netlify");

  const p = productData(order);

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: customerPhone,
    type: "template",
    template: {
      name: cfg.templateName,
      language: { code: cfg.templateLanguage },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: firstName(order.name) },
          { type: "text", text: String(order.reference || "") },
          { type: "text", text: p.product },
          { type: "text", text: p.size },
          { type: "text", text: p.color },
          { type: "text", text: String(order.name || "").slice(0, 120) },
          { type: "text", text: "No registrado" },
          { type: "text", text: String(order.phone || "").slice(0, 40) },
          { type: "text", text: String(order.address || "").slice(0, 240) },
          { type: "text", text: String(order.city || "").slice(0, 100) },
          { type: "text", text: formatMoney(order.confirmedAmount ?? order.total) },
          { type: "text", text: String(order.boldPaymentMethod || order.paymentMethod || "Pago en línea").slice(0, 80) }
        ]
      }]
    }
  };
}

export async function sendWhatsAppConfirmation(order) {
  if (order?.paymentStatus !== "aprobado" || order?.webhookType !== "SALE_APPROVED") {
    throw new Error("WhatsApp confirmation solo puede enviarse después de SALE_APPROVED");
  }

  const cfg = whatsappConfig();
  const payload = buildConfirmationTemplate(order);
  const endpoint =
    "https://graph.facebook.com/" +
    encodeURIComponent(cfg.graphVersion) +
    "/" +
    encodeURIComponent(cfg.phoneNumberId) +
    "/messages";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.accessToken
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      "WhatsApp Cloud API rechazó la confirmación (" + response.status + ")"
    );
    error.metaStatus = response.status;
    error.metaResponse = data;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }

  return { status: response.status, response: data };
}

function retryDelayMs(attempts) {
  return Math.min(
    60 * 60 * 1000,
    Math.max(30 * 1000, 2 ** Math.max(0, attempts - 1) * 30 * 1000)
  );
}

export function whatsappOutboxKey(reference) {
  return "whatsapp-outbox/" + String(reference || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}

export async function enqueueWhatsAppConfirmation(order) {
  if (order?.paymentStatus !== "aprobado" || order?.webhookType !== "SALE_APPROVED") {
    throw new Error("WhatsApp outbox solo acepta SALE_APPROVED");
  }

  if (order.whatsappConfirmationSentAt) {
    return { key: whatsappOutboxKey(order.reference), status: "sent", skipped: true };
  }

  const key = whatsappOutboxKey(order.reference);
  const existing = await store.get(key, { type: "json", consistency: "strong" });
  if (existing?.status === "sent") return { key, status: "sent", skipped: true };
  if (existing) return { key, status: existing.status || "pending", skipped: false };

  const now = new Date().toISOString();
  const record = {
    key,
    kind: "WhatsAppPurchaseConfirmation",
    orderReference: String(order.reference || ""),
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    processingAt: "",
    lastError: "",
    metaStatus: 0,
    metaMessageId: "",
    metaResponse: null
  };

  const created = await store.setJSON(key, record, { onlyIfNew: true });
  if (created?.modified && !created?.etag) {
    throw new Error("No se pudo confirmar la creación del outbox de WhatsApp");
  }
  if (created?.modified) return { key, status: "pending", skipped: false };

  const winner = await store.get(key, { type: "json", consistency: "strong" });
  return { key, status: winner?.status || "pending", skipped: false };
}

export async function processWhatsAppOutboxKey(key) {
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!current?.data) return { ok: false, skipped: true, reason: "not_found" };
  if (current.data.status === "sent") return { ok: true, skipped: true, reason: "sent", key };

  const now = Date.now();
  if (current.data.nextAttemptAt && new Date(current.data.nextAttemptAt).getTime() > now) {
    return { ok: false, skipped: true, reason: "not_due", key };
  }

  if (current.data.status === "processing") {
    const processingAt = Date.parse(String(current.data.processingAt || ""));
    if (Number.isFinite(processingAt) && Date.now() - processingAt < 10 * 60 * 1000) {
      return { ok: false, skipped: true, reason: "busy", key };
    }
  }

  const orderReference = String(current.data.orderReference || "");
  const order = await store.get("orders/" + orderReference, { type: "json", consistency: "strong" });
  if (!order) throw new Error("Pedido no encontrado para outbox de WhatsApp");
  if (order.whatsappConfirmationSentAt) {
    const latest = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (latest?.data) {
      await store.setJSON(key, {
        ...latest.data,
        status: "sent",
        updatedAt: new Date().toISOString(),
        nextAttemptAt: "",
        processingAt: ""
      }, { onlyIfMatch: latest.etag });
    }
    return { ok: true, skipped: true, reason: "already_sent", key };
  }

  const attempts = Number(current.data.attempts || 0) + 1;
  const processing = {
    ...current.data,
    status: "processing",
    attempts,
    processingAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const claimed = await store.setJSON(key, processing, { onlyIfMatch: current.etag });
  if (claimed?.modified && !claimed?.etag) throw new Error("No se pudo confirmar el bloqueo de WhatsApp");
  if (!claimed?.modified) return { ok: false, skipped: true, reason: "lost_race", key };

  try {
    const result = await sendWhatsAppConfirmation(order);
    const latest = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!latest?.data || latest.data.status !== "processing") {
      return { ok: false, skipped: true, reason: "state_changed", key };
    }

    const messageId = String(
      result?.response?.messages?.[0]?.id ||
      result?.response?.messages?.[0]?.message_id ||
      ""
    );

    const sentAt = new Date().toISOString();
    const sent = {
      ...latest.data,
      status: "sent",
      updatedAt: sentAt,
      sentAt,
      nextAttemptAt: "",
      processingAt: "",
      lastError: "",
      metaStatus: Number(result.status) || 0,
      metaMessageId: messageId,
      metaResponse: result.response
    };
    const written = await store.setJSON(key, sent, { onlyIfMatch: latest.etag });
    if (written?.modified && !written?.etag) throw new Error("No se pudo confirmar WhatsApp enviado");
    if (!written?.modified) return { ok: false, skipped: true, reason: "lost_race", key };

    const latestOrder = await store.get("orders/" + orderReference, { type: "json", consistency: "strong" });
    if (latestOrder && !latestOrder.whatsappConfirmationSentAt) {
      await store.setJSON("orders/" + orderReference, {
        ...latestOrder,
        whatsappConfirmationSentAt: sentAt
      });
    }

    return { ok: true, key, status: "sent", attempts, messageId };
  } catch (error) {
    const latest = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!latest?.data || latest.data.status !== "processing") throw error;

    const status = Number(error?.metaStatus);
    const retryable = error?.retryable !== false && (status === 429 || status >= 500 || !status);
    const maxAttempts = 8;
    const failed = {
      ...latest.data,
      status: "error",
      updatedAt: new Date().toISOString(),
      processingAt: "",
      lastError: String(error?.message || error).slice(0, 1000),
      metaStatus: Number.isFinite(status) ? status : 0,
      nextAttemptAt: retryable && attempts < maxAttempts
        ? new Date(Date.now() + retryDelayMs(attempts)).toISOString()
        : ""
    };

    const written = await store.setJSON(key, failed, { onlyIfMatch: latest.etag });
    if (written?.modified && !written?.etag) throw new Error("No se pudo confirmar el error del outbox de WhatsApp");
    if (!written?.modified) return { ok: false, skipped: true, reason: "lost_race", key };

    if (retryable && attempts < maxAttempts) throw error;
    return { ok: false, key, status: "error", attempts, retryable: false };
  }
}

export async function sendWhatsAppConfirmationForReference(reference) {
  const key = "orders/" + reference;
  const order = await store.get(key, { type: "json", consistency: "strong" });
  if (!order) throw new Error("Pedido no encontrado para WhatsApp");

  const queued = await enqueueWhatsAppConfirmation(order);
  if (queued.status === "sent") {
    return { skipped: true, reason: "already_sent" };
  }

  return processWhatsAppOutboxKey(queued.key);
}
