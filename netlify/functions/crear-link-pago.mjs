// Creates a Bold Embedded Checkout configuration for a server-persisted pending order.
// The browser cannot choose amount, description, reference, or callback URL.

import crypto from "node:crypto";
import { store, json } from "./_admin.mjs";

const safeRef = /^[A-Za-z0-9_-]{1,60}$/;

function env(name) {
  // Netlify.env exposes configured runtime variables, but system variables
  // such as CONTEXT and DEPLOY_PRIME_URL may only be present in process.env.
  if (typeof Netlify !== "undefined" && Netlify.env) {
    try {
      const value = Netlify.env.get(name);
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    } catch {
      // Fall through to process.env when the runtime API cannot provide it.
    }
  }
  return process.env[name];
}

function httpsOrigin(candidate) {
  const raw = String(candidate || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

// Origen HTTPS al que Bold devuelve al cliente (redirectionUrl y originUrl).
// - Producción: dominio canónico (SITE_CANONICAL_ORIGIN) o, si falta, URL.
// - Cualquier otro despliegue (vista previa, rama, etc.): únicamente el origen
//   del propio despliegue que Netlify define (DEPLOY_PRIME_URL, luego
//   DEPLOY_URL), y nunca un origen de producción. En estos contextos URL es el
//   dominio principal del sitio y SITE_CANONICAL_ORIGIN suele ser el dominio
//   productivo, así que no se usan como respaldo: devolver "" es preferible a
//   enviar un pago de prueba a la tienda real.
// `read` se inyecta para poder probar la selección sin tocar el entorno.
export function canonicalOrigin(read = env, requestUrl = "") {
  const isProduction = String(read("CONTEXT") || "").trim().toLowerCase() === "production";

  if (isProduction) {
    return httpsOrigin(read("SITE_CANONICAL_ORIGIN")) || httpsOrigin(read("URL"));
  }

  const productionHosts = new Set(
    [read("SITE_CANONICAL_ORIGIN"), read("URL")]
      .map(httpsOrigin)
      .filter(Boolean)
      .map(origin => new URL(origin).hostname)
  );

  for (const candidate of [read("DEPLOY_PRIME_URL"), read("DEPLOY_URL")]) {
    const origin = httpsOrigin(candidate);
    if (origin && !productionHosts.has(new URL(origin).hostname)) return origin;
  }

  // En algunos branch deploys Netlify no expone DEPLOY_PRIME_URL/DEPLOY_URL
  // en runtime. Solo en no-producción se permite usar la URL de la petición,
  // validando HTTPS y el sufijo netlify.app; nunca se confía en cabeceras Host.
  const requestOrigin = httpsOrigin(requestUrl);
  if (requestOrigin) {
    const hostname = new URL(requestOrigin).hostname.toLowerCase();
    if (hostname.endsWith(".netlify.app") && !productionHosts.has(hostname)) return requestOrigin;
  }

  return "";
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

  // Embedded Checkout con monto definido necesita la llave secreta.
  // No se permite abrir el checkout si falta la clave de integridad.
  const boldSecretKey = String(env("BOLD_SECRET_KEY") || "").trim();
  if (!boldSecretKey) {
    console.error("Bold Embedded Checkout: falta BOLD_SECRET_KEY en el entorno.");
    return json({ error: "El pago en línea aún no está habilitado para esta tienda." }, 503);
  }

  const origin = canonicalOrigin(env, req.url);
  if (!origin) {
    const isProduction = String(env("CONTEXT") || "").trim().toLowerCase() === "production";
    console.error("Bold Embedded Checkout: no hay un origen HTTPS válido para el retorno del pago.");
    return json({
      error: isProduction
        ? "Falta configurar SITE_CANONICAL_ORIGIN con el dominio HTTPS canónico de la tienda antes de crear pagos."
        : "No se pudo determinar el dominio HTTPS de este despliegue para el retorno del pago."
    }, 503);
  }

  const boldApiKey = String(env("BOLD_API_KEY") || "").trim();
  if (!boldApiKey) {
    return json({ error: "Falta configurar BOLD_API_KEY en Netlify" }, 500);
  }
  const itemNames = Array.isArray(order.items) ? order.items.map(i => i.name).filter(Boolean) : [];
  const description = ("MF Colombia · " + itemNames.slice(0, 3).join(" · ")).slice(0, 100);
  const callbackUrl = origin + "/gracias.html?ref=" + encodeURIComponent(reference);

  const buildEmbedded = (description, totalValue) => ({
    orderId: reference,
    currency: "COP",
    amount: String(totalValue),
    apiKey: boldApiKey,
    integritySignature: crypto
      .createHash("sha256")
      .update(reference + String(totalValue) + "COP" + boldSecretKey)
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
  });

  // MFCOL usa Bold Embedded Checkout (Botón de pagos): el orderId es la referencia
  // del pedido. No crear un API Payment Link LNK_* en paralelo: es otra integración
  // y su webhook usa LNK_* como metadata.reference, lo que añade una ruta distinta
  // de conciliación para un enlace que el cliente nunca abre.
  const embedded = buildEmbedded(description.length >= 2 ? description : "Pedido MF Colombia", total);
  return json({ ok: true, reference, total, embedded });
};
