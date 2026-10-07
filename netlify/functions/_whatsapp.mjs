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
      env("META_WHATSAPP_PHONE_NUMBER_ID") ||
      "1439222772604466",
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

export async function sendWhatsAppConfirmationForReference(reference) {
  const key = "orders/" + reference;
  const order = await store.get(key, { type: "json", consistency: "strong" });
  if (!order) throw new Error("Pedido no encontrado para WhatsApp");

  // Idempotencia: un reintento de Bold no debe enviar dos confirmaciones al cliente.
  if (order.whatsappConfirmationSentAt) {
    return { skipped: true, reason: "already_sent", sentAt: order.whatsappConfirmationSentAt };
  }

  const result = await sendWhatsAppConfirmation(order);
  const sentAt = new Date().toISOString();

  // Persistimos la marca solo después de que Meta acepte el mensaje.
  const latest = await store.get(key, { type: "json", consistency: "strong" });
  if (latest) {
    await store.setJSON(key, {
      ...latest,
      whatsappConfirmationSentAt: sentAt,
      updatedAt: latest.updatedAt || sentAt
    });
  }

  return { ...result, skipped: false, sentAt };
}
