import crypto from "node:crypto";
import { store } from "./_admin.mjs";
import {
  processBoldWebhook,
  safeEventId,
  webhookInboxKey,
  ensureInbox,
} from "./_bold-webhook.mjs";
import { processOutboxKey } from "./_meta-outbox.mjs";

function encodeForm(data) {
  return Object.keys(data)
    .map(
      (k) =>
        encodeURIComponent(k) +
        "=" +
        encodeURIComponent(data[k] ?? "")
    )
    .join("&");
}

function validSignature(rawBody, signature, secret) {
  if (!signature) return false;

  const encoded = Buffer.from(rawBody, "utf8").toString("base64");

  const hashed = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("hex");

  const a = Buffer.from(hashed);
  const b = Buffer.from(signature);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Método no permitido", { status: 405 });
  }

  const rawBody = await req.text();
  const signature =
    req.headers.get("x-bold-signature") || "";

  /*
   * Bold:
   * - Ambiente de pruebas: la llave secreta es ""
   * - Producción: usar BOLD_SECRET_KEY
   *
   * Netlify define CONTEXT=production únicamente
   * para el contexto de producción.
   */
  const isProduction =
    String(process.env.CONTEXT || "").toLowerCase() ===
    "production";

  const secret = isProduction
    ? process.env.BOLD_SECRET_KEY || ""
    : "";

  if (!validSignature(rawBody, signature, secret)) {
    console.error("Firma de webhook inválida");
    return new Response("Firma inválida", { status: 400 });
  }

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }

  const eventId = safeEventId(event?.id);

  const allowedTypes = new Set([
    "SALE_APPROVED",
    "SALE_REJECTED",
    "VOID_APPROVED",
    "VOID_REJECTED",
  ]);

  if (
    !eventId ||
    !allowedTypes.has(String(event?.type || ""))
  ) {
    return new Response("Evento Bold inválido", {
      status: 400,
    });
  }

  const inboxKey = webhookInboxKey(eventId);

  try {
    await ensureInbox(event);
  } catch (error) {
    console.error(
      "No se pudo persistir el inbox de Bold:",
      error
    );

    return new Response("Error interno", {
      status: 500,
    });
  }

  const work = processBoldWebhook(event)
    .then(async (result) => {
      if (result?.duplicate || result?.busy) {
        return;
      }

      if (result?.outboxKey) {
        try {
          await processOutboxKey(result.outboxKey);
        } catch (error) {
          console.error(
            "No se pudo enviar Purchase a Meta:",
            error
          );
        }
      }

      /*
       * Registro adicional en Netlify Forms.
       * Esto no sustituye el procesamiento principal
       * del pedido ni el outbox de Meta.
       */
      try {
        const d = event.data || {};

        const reference = String(
          result?.reference || ""
        ).trim();

        const paymentId = String(
          d.payment_id ||
            event.subject ||
            ""
        ).trim();

        const paymentStatus =
          event.type === "SALE_APPROVED"
            ? "aprobado"
            : event.type === "SALE_REJECTED"
            ? "rechazado"
            : event.type === "VOID_APPROVED"
            ? "anulado"
            : event.type === "VOID_REJECTED"
            ? "rechazado"
            : "pendiente";

        await fetch(
          new URL(req.url).origin + "/",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded",
            },
            body: encodeForm({
              "form-name": "pagos-confirmados",
              reference,
              payment_id: paymentId,
              valor:
                d.amount?.total != null
                  ? String(d.amount.total)
                  : "",
              medio_pago:
                d.payment_method || "",
              estado: paymentStatus,
            }),
          }
        );
      } catch (error) {
        console.error(
          "No se pudo registrar el formulario de pago:",
          error
        );
      }
    })
    .catch(async (error) => {
      console.error(
        "No se pudo procesar webhook Bold:",
        error
      );

      try {
        const current = await store.get(
          inboxKey,
          {
            type: "json",
            consistency: "strong",
          }
        );

        if (current && !current.processedAt) {
          current.status = "error";
          current.lastError = String(
            error?.message || error
          ).slice(0, 1000);

          current.updatedAt =
            new Date().toISOString();

          await store.setJSON(
            inboxKey,
            current
          );
        }
      } catch (persistError) {
        console.error(
          "No se pudo actualizar el estado de error del inbox:",
          persistError
        );
      }
    });

  if (
    typeof context?.waitUntil ===
    "function"
  ) {
    context.waitUntil(work);
  } else {
    await work;
  }

  return new Response("OK", {
    status: 200,
  });
};
