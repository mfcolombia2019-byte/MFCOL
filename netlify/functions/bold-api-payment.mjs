import { store, json } from "./_admin.mjs";

const BOLD_BASE = "https://api.online.payments.bold.co";

function getApiKey() {
  return String(
    process.env.BOLD_ONLINE_API_KEY ||
    process.env.BOLD_API_PAYMENTS_KEY ||
    process.env.BOLD_API_KEY ||
    ""
  ).trim();
}

function validReference(value) {
  return /^[A-Za-z0-9_-]{1,60}$/.test(String(value || "").trim());
}

function deviceFingerprint(input) {
  const d = input && typeof input === "object" ? input : {};
  return {
    device_type: String(d.device_type || "").slice(0, 30),
    os: String(d.os || "").slice(0, 80),
    browser: String(d.browser || "").slice(0, 120),
    java_enabled: Boolean(d.java_enabled),
    language: String(d.language || "es-CO").slice(0, 20),
    color_depth: Number(d.color_depth) || 24,
    screen_height: Number(d.screen_height) || 0,
    screen_width: Number(d.screen_width) || 0,
    time_zone_offset: Number(d.time_zone_offset) || 0,
    model: String(d.model || "").slice(0, 80),
    platform: String(d.platform || "").slice(0, 80)
  };
}

async function boldFetch(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    const error = new Error("Falta la llave de API de Pagos en Línea de Bold.");
    error.status = 503;
    throw error;
  }

  const response = await fetch(BOLD_BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "x-api-key " + apiKey,
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data?.errors?.[0]?.message ||
      data?.payload?.errors?.[0]?.message ||
      data?.message ||
      "Bold no pudo procesar la solicitud.";
    const error = new Error(String(message));
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    error.bold = data;
    throw error;
  }
  return data;
}

function payerFrom(order, body) {
  const payer = body?.payer || {};
  return {
    person_type: "NATURAL_PERSON",
    name: String(payer.name || order.name || "").trim(),
    phone: String(payer.phone || order.phone || "").replace(/\D/g, "").slice(-10),
    email: String(payer.email || "").trim(),
    document_type: String(payer.document_type || "CEDULA"),
    document_number: String(payer.document_number || "").replace(/\D/g, "").slice(0, 20),
    billing_address: {
      street1: String(order.address || "").trim(),
      city: String(order.city || "").trim(),
      country: "CO",
      phone: String(order.phone || "").replace(/\D/g, "").slice(-10)
    }
  };
}

function paymentMethodFrom(body) {
  const method = String(body?.method || "CREDIT_CARD");
  if (method === "CREDIT_CARD") {
    const card = body?.card || {};
    return {
      name: "CREDIT_CARD",
      card_number: String(card.card_number || "").replace(/\D/g, ""),
      cardholder_name: String(card.cardholder_name || "").trim(),
      expiration_month: Number(card.expiration_month),
      expiration_year: Number(card.expiration_year),
      installments: Number(card.installments) || 1,
      cvc: String(card.cvc || "").replace(/\D/g, "")
    };
  }
  if (method === "PSE") {
    return {
      name: "PSE",
      bank_code: Number(body?.bank_code),
      bank_name: String(body?.bank_name || "").trim()
    };
  }
  if (method === "NEQUI") return { name: "NEQUI" };
  if (method === "BOTON_BANCOLOMBIA") return { name: "BOTON_BANCOLOMBIA" };
  throw new Error("Método de pago no disponible.");
}

async function ensurePaymentIntent(reference, order, payer) {
  const existing = await fetch(BOLD_BASE + "/v1/payment-intent/" + encodeURIComponent(reference), {
    headers: { "Authorization": "x-api-key " + getApiKey() }
  });

  if (existing.ok) return existing.json();

  if (existing.status !== 404) {
    const data = await existing.json().catch(() => ({}));
    const error = new Error(data?.errors?.[0]?.message || "No se pudo consultar la intención de pago.");
    error.status = 502;
    throw error;
  }

  const origin = new URL("https://tienda.mfcol.com");
  const payload = {
    reference_id: reference,
    amount: {
      currency: "COP",
      total_amount: Number(order.total)
    },
    description: "Compra Marlon Footwear " + reference,
    callback_url: origin.origin + "/gracias.html?ref=" + encodeURIComponent(reference),
    customer: {
      name: payer.name,
      phone: payer.phone,
      email: payer.email,
      billing_address: {
        street1: String(order.address || ""),
        city: String(order.city || ""),
        province: String(order.city || ""),
        country_code: "CO",
        phone: payer.phone
      },
      shipping_address: {
        street1: String(order.address || ""),
        city: String(order.city || ""),
        province: String(order.city || ""),
        country_code: "CO",
        phone: payer.phone
      }
    }
  };

  return boldFetch("/v1/payment-intent", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export default async (req) => {
  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      const reference = String(url.searchParams.get("reference") || "").trim();
      const banks = url.searchParams.get("banks") === "1";

      if (banks) {
        const data = await boldFetch("/v1/payment/pse/banks", { method: "GET" });
        return json(data);
      }

      if (!validReference(reference)) return json({ error: "Referencia inválida" }, 400);
      const data = await boldFetch("/v1/payment/" + encodeURIComponent(reference), { method: "GET" });
      return json(data);
    }

    if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

    const body = await req.json();
    const reference = String(body?.reference || "").trim();
    if (!validReference(reference)) return json({ error: "Referencia inválida" }, 400);

    const order = await store.get("orders/" + reference, { type: "json", consistency: "strong" });
    if (!order) return json({ error: "Pedido no encontrado" }, 404);
    if (order.paymentMethod !== "Link de pago (Bold)") {
      return json({ error: "Este pedido no está configurado para pago en línea" }, 400);
    }
    if (String(order.paymentStatus || "") !== "pendiente") {
      return json({ error: "Este pedido ya no está pendiente de pago" }, 409);
    }

    const payer = payerFrom(order, body);
    if (!payer.name || payer.phone.length < 10) {
      return json({ error: "Faltan datos del comprador para procesar el pago." }, 400);
    }

    const paymentMethod = paymentMethodFrom(body);
    if (paymentMethod.name === "CREDIT_CARD") {
      if (paymentMethod.card_number.length < 13 || paymentMethod.card_number.length > 19) {
        return json({ error: "Revisa el número de tarjeta." }, 400);
      }
      if (!paymentMethod.cardholder_name || !paymentMethod.expiration_month || !paymentMethod.expiration_year || paymentMethod.cvc.length < 3) {
        return json({ error: "Completa los datos de tu tarjeta." }, 400);
      }
    }

    await ensurePaymentIntent(reference, order, payer);

    const attempt = await boldFetch("/v1/payment", {
      method: "POST",
      body: JSON.stringify({
        reference_id: reference,
        payer,
        payment_method: paymentMethod,
        device_fingerprint: deviceFingerprint(body?.device_fingerprint)
      })
    });

    const payload = attempt?.payload || attempt;
    const nextActions = payload?.next_actions || null;

    return json({
      ok: true,
      reference,
      transaction_id: payload?.transaction_id || "",
      status: String(payload?.status || "").toUpperCase(),
      next_actions: nextActions
    });
  } catch (error) {
    console.error("bold-api-payment:", error);
    return json({
      error: error?.message || "No pudimos procesar el pago."
    }, Number(error?.status) || 400);
  }
};
