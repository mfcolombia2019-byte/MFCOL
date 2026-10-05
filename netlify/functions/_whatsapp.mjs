import { store } from "./_admin.mjs";

function env(name) {
  return String(process.env?.[name] || "").trim();
}

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function money(value) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function orderMessage(order) {
  const lines = [
    "🛍️ NUEVO PEDIDO — MARLON FOOTWEAR",
    "",
    "✅ Pago aprobado",
    "📦 Pedido: #" + clean(order.reference, 80),
    "👤 Cliente: " + clean(order.name, 120),
    "📱 WhatsApp: " + clean(order.phone, 40),
    order.payerEmail ? "📧 Correo: " + clean(order.payerEmail, 160) : "",
    "",
    "👠 PRODUCTOS",
    clean(order.pedido, 5000),
    "",
    "💰 TOTAL: " + money(order.total),
    "💳 Pago: " + clean(order.boldPaymentMethod || order.paymentMethod, 80),
    "",
    "📍 ENTREGA",
    clean(order.address, 240),
    clean(order.city, 100),
    "",
    "🕐 Fecha: " + clean(order.updatedAt || order.createdAt, 80),
    "",
    "🔗 Panel: " + clean(env("SITE_CANONICAL_ORIGIN") || "https://tienda.mfcol.com", 200) + "/admin.html"
  ];

  return lines.filter(Boolean).join("\n").slice(0, 4096);
}

function notificationKey(order) {
  const eventId = clean(order.purchaseEventId || order.webhookEventId || "", 200)
    .replace(/[^A-Za-z0-9_-]/g, "");
  return eventId ? "whatsapp-outbox/" + eventId : "";
}

export function isWhatsAppConfigured() {
  return Boolean(
    env("WHATSAPP_ACCESS_TOKEN") &&
    env("WHATSAPP_PHONE_NUMBER_ID") &&
    env("WHATSAPP_NOTIFY_TO") &&
    env("WHATSAPP_TEMPLATE_NAME")
  );
}

export async function sendWhatsAppOrderNotification(order) {
  if (!isWhatsAppConfigured()) {
    return { ok: false, skipped: true, reason: "WhatsApp no está configurado" };
  }

  const key = notificationKey(order);
  if (!key) throw new Error("No hay identificador estable para la notificación WhatsApp");

  const now = new Date().toISOString();
  const existing = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (existing?.data?.status === "sent") {
    return { ok: true, skipped: true, duplicate: true };
  }

  if (existing?.data?.status === "sending") {
    return { ok: false, skipped: true, duplicate: true, reason: "Notificación en curso" };
  }

  const claim = await store.setJSON(key, {
    status: "sending",
    reference: clean(order.reference, 80),
    purchaseEventId: clean(order.purchaseEventId || "", 200),
    createdAt: existing?.data?.createdAt || now,
    updatedAt: now
  }, existing?.etag ? { onlyIfMatch: existing.etag } : { onlyIfNew: true });

  if (!claim?.modified) {
    return { ok: false, skipped: true, duplicate: true, reason: "Otra ejecución tomó la notificación" };
  }
  if (!claim?.etag) throw new Error("No se pudo confirmar el bloqueo de WhatsApp");

  const version = env("WHATSAPP_GRAPH_API_VERSION") || "v23.0";
  const language = env("WHATSAPP_TEMPLATE_LANGUAGE") || "es_CO";
  const endpoint =
    "https://graph.facebook.com/" +
    encodeURIComponent(version) +
    "/" +
    encodeURIComponent(env("WHATSAPP_PHONE_NUMBER_ID")) +
    "/messages";

  const payload = {
    messaging_product: "whatsapp",
    to: env("WHATSAPP_NOTIFY_TO"),
    type: "template",
    template: {
      name: env("WHATSAPP_TEMPLATE_NAME"),
      language: { code: language },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: orderMessage(order) }
          ]
        }
      ]
    }
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env("WHATSAPP_ACCESS_TOKEN"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error("WhatsApp rechazó la notificación (" + response.status + ")");
      error.whatsappStatus = response.status;
      error.whatsappResponse = data;
      throw error;
    }

    await store.setJSON(key, {
      status: "sent",
      reference: clean(order.reference, 80),
      purchaseEventId: clean(order.purchaseEventId || "", 200),
      createdAt: existing?.data?.createdAt || now,
      updatedAt: new Date().toISOString(),
      whatsappMessageId: clean(data?.messages?.[0]?.id || "", 200)
    });

    return { ok: true, response: data };
  } catch (error) {
    await store.setJSON(key, {
      status: "error",
      reference: clean(order.reference, 80),
      purchaseEventId: clean(order.purchaseEventId || "", 200),
      createdAt: existing?.data?.createdAt || now,
      updatedAt: new Date().toISOString(),
      lastError: clean(error?.message || error, 500)
    });
    throw error;
  }
}
