import crypto from "node:crypto";
import { store, json } from "./_admin.mjs";

function getEnv(name) {
  try {
    const value = typeof process !== "undefined" ? process.env?.[name] : "";
    if (value) return String(value);
  } catch (e) {}
  try {
    if (typeof Netlify !== "undefined" && Netlify?.env?.get) {
      return String(Netlify.env.get(name) || "");
    }
  } catch (e) {}
  return "";
}

function validReference(value) {
  return /^[A-Za-z0-9_-]{1,60}$/.test(String(value || "").trim());
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
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

    const amount = Number(order.total);
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 20000000) {
      return json({ error: "El importe del pedido no es válido para el pago" }, 400);
    }

    const apiKey = getEnv("BOLD_API_KEY");
    const secretKey = getEnv("BOLD_SECRET_KEY");
    if (!apiKey || !secretKey) {
      console.error("Faltan BOLD_API_KEY o BOLD_SECRET_KEY para Embedded Checkout");
      return json({ error: "Configuración de pago incompleta" }, 500);
    }

    const currency = "COP";
    const integritySignature = crypto
      .createHash("sha256")
      .update(reference + String(amount) + currency + secretKey)
      .digest("hex");

    const origin = new URL(req.url).origin;
    const redirectionUrl = origin + "/gracias.html?ref=" + encodeURIComponent(reference);
    const originUrl = origin + "/?pago=cancelado&ref=" + encodeURIComponent(reference);

    return json({
      ok: true,
      orderId: reference,
      currency,
      amount: String(amount),
      apiKey,
      integritySignature,
      description: "Pedido MF " + reference,
      redirectionUrl,
      originUrl,
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
    });
  } catch (e) {
    console.error("preparar-checkout-bold:", e);
    return json({ error: e?.message || "No se pudo preparar el pago" }, 400);
  }
};
