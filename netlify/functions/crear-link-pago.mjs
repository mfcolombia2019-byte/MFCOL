// Creates a Bold payment link only for a server-persisted, pending order.
// The browser cannot choose amount, description, reference, or callback URL.

import crypto from "node:crypto";
import { store, getJson, json } from "./_admin.mjs";

const safeRef = /^[A-Za-z0-9_-]{1,60}$/;

function env(name) {
  return typeof Netlify !== "undefined" && Netlify.env
    ? Netlify.env.get(name)
    : process.env[name];
}

function canonicalOrigin() {
  const isProduction = String(env("CONTEXT") || "").toLowerCase() === "production";

  const candidates = isProduction
    ? [env("SITE_CANONICAL_ORIGIN"), env("URL")]
    : [env("DEPLOY_PRIME_URL"), env("URL")];

  for (const candidate of candidates) {
    const raw = String(candidate || "").trim().replace(/\/+$/, "");
    if (!raw) continue;

    try {
      const u = new URL(raw);
      if (u.protocol !== "https:") continue;
      return u.origin;
    } catch {
      continue;
    }
  }

  return "";
}

async function associateBoldLink(reference, paymentLink) {
  const key = "orders/" + reference;
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!current?.data) throw new Error("Pedido no encontrado");
  if (current.data.boldPaymentLink && current.data.paymentLink) {
    return current.data;
  }

  const next = {
    ...current.data,
    paymentLink: "https://checkout.bold.co/" + paymentLink,
    boldPaymentLink: paymentLink,
    updatedAt: new Date().toISOString()
  };
  const result = await store.setJSON(key, next, { onlyIfMatch: current.etag });
  if (result?.modified && !result?.etag) throw new Error("No se pudo confirmar la asociación del link");
  if (!result?.modified) {
    const latest = await store.get(key, { type: "json", consistency: "strong" });
    if (latest?.boldPaymentLink === paymentLink) return latest;
    throw new Error("El pedido cambió mientras se asociaba el link");
  }
  return next;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "JSON inválido" }, 400); }

  const reference = String(body?.reference || "").trim();
  if (!safeRef.test(reference)) return json({ error: "Referencia inválida" }, 400);

  const order = await store.get("orders/" + reference, { type: "json", consistency: "strong" });
  if (!order) return json({ error: "Pedido no encontrado" }, 404);
  if (order.paymentStatus !== "pendiente") return json({ error: "Este pedido ya no está pendiente de pago" }, 409);
  if (order.paymentMethod !== "Link de pago (Bold)") return json({ error: "El pedido no está configurado para pagar con Bold" }, 409);

  const total = Math.round(Number(order.total));
  if (!Number.isFinite(total) || total < 1000 || total > 20000000) {
    return json({ error: "El importe del pedido no es válido" }, 409);
  }

  if (order.boldPaymentLink && order.paymentLink) {
    return json({ ok: true, url: order.paymentLink, payment_link: order.boldPaymentLink, reference, total });
  }

  const origin = canonicalOrigin();
  if (!origin) {
    return json({ error: "Falta configurar SITE_CANONICAL_ORIGIN con el dominio HTTPS canónico de la tienda antes de crear pagos." }, 503);
  }

  const boldApiKey = String(env("BOLD_API_KEY") || "").trim();
  if (!boldApiKey) {
    return json({ error: "Falta configurar BOLD_API_KEY en Netlify" }, 500);
  }
  // Embedded Checkout con monto definido exige la llave secreta para generar
  // la firma SHA-256. Nunca creamos un Link de pago si no podemos abrir el
  // checkout embebido: así evitamos pedidos "pagables" pero sin checkout.
  const boldSecretKey = String(env("BOLD_SECRET_KEY") || "").trim();
  if (!boldSecretKey) {
    console.error("Bold Embedded Checkout: falta BOLD_SECRET_KEY en el entorno.");
    return json({ error: "El pago en línea aún no está habilitado para esta tienda." }, 503);
  }

  const itemNames = Array.isArray(order.items) ? order.items.map(i => i.name).filter(Boolean) : [];
  const description = ("MF Colombia · " + itemNames.slice(0, 3).join(" · ")).slice(0, 100);
  const callbackUrl = origin + "/gracias.html?ref=" + encodeURIComponent(reference);

  const payload = {
    amount_type: "CLOSE",
    amount: { currency: "COP", total_amount: total, tip_amount: 0 },
    reference,
    description: description.length >= 2 ? description : "Pedido MF Colombia",
    callback_url: callbackUrl,
    expiration_date: (Date.now() * 1e6) + (24 * 60 * 60 * 1e9)
  };

  const res = await fetch("https://integrations.api.bold.co/online/link/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "x-api-key " + boldApiKey
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payload?.url || !data.payload?.payment_link) {
    console.error("Bold create link:", res.status, JSON.stringify(data));
    return json({ error: "No se pudo crear el link de pago", detail: data.errors || undefined }, 502);
  }

  const paymentLink = String(data.payload.payment_link);
  const saved = await associateBoldLink(reference, paymentLink);

  // Bold's API Link webhook documentation identifies metadata.reference as the
  // generated LNK_* payment link. Keep an explicit mapping so the webhook can
  // resolve the original order without trusting browser data.
  await store.setJSON("bold-links/" + paymentLink, {
    reference,
    createdAt: new Date().toISOString()
  });

  const embedded = {
    orderId: reference,
    currency: "COP",
    amount: String(total),
    apiKey: boldApiKey,
    integritySignature: crypto
      .createHash("sha256")
      .update(reference + String(total) + "COP" + boldSecretKey)
      .digest("hex"),
    description,
    originUrl: origin + "/checkout?bold=cancel&ref=" + encodeURIComponent(reference),
    redirectionUrl: callbackUrl,
    renderMode: "embedded",
    customerData: JSON.stringify({
      fullName: String(order.name || ""),
      phone: String(order.phone || ""),
      dialCode: "+57"
    }),
    billingAddress: JSON.stringify({
      address: String(order.address || ""),
      city: String(order.city || ""),
      country: "CO"
    })
  };

  return json({
    ok: true,
    url: data.payload.url,
    payment_link: paymentLink,
    reference,
    total: saved.total,
    embedded
  });
};
