// Piezas puras (sin almacén ni red) compartidas por el handler, el reintento y el
// reproceso manual. Viven aparte para que el handler pueda usarlas sin depender
// del módulo que accede al almacén de Blobs.

export const MAX_INBOX_ATTEMPTS = 8;

// Error de validación/estado del webhook con código estable. `retryable=false`
// marca un fallo determinista: repetir el mismo evento contra el mismo pedido
// dará el mismo resultado. `details` solo contiene datos no sensibles
// (referencia, ids de evento, importes, moneda), nunca datos del pagador.
export class BoldWebhookError extends Error {
  constructor(code, message, { retryable = false, details = {} } = {}) {
    super(message);
    this.name = "BoldWebhookError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

// Una línea JSON por evento, filtrable por `evt` en los logs de Netlify.
// No pasar secretos, firmas, cuerpos crudos ni datos del cliente en `fields`.
export function logBoldEvent(level, evt, fields = {}) {
  const line = JSON.stringify({ evt, ts: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function inboxRetryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, attempts - 1)));
}

// Estado del inbox tras un fallo. Los errores deterministas (retryable=false)
// quedan terminales: no se reprograman, pero siguen visibles y se pueden
// reprocesar manualmente con webhook-replay.
export function buildInboxFailure(data, error, nowMs = Date.now(), { maxErrorLength = 1000 } = {}) {
  const attempts = Number(data?.attempts || 0) + 1;
  const retryable = error?.retryable !== false && attempts < MAX_INBOX_ATTEMPTS;
  const failed = {
    ...data,
    status: "error",
    attempts,
    processingAt: "",
    updatedAt: new Date(nowMs).toISOString(),
    lastError: String(error?.message || error).slice(0, maxErrorLength),
    lastErrorCode: error instanceof BoldWebhookError ? error.code : "",
    terminal: !retryable,
    nextAttemptAt: retryable ? new Date(nowMs + inboxRetryDelayMs(attempts)).toISOString() : ""
  };
  if (error instanceof BoldWebhookError && error.details && Object.keys(error.details).length) {
    failed.lastErrorDetail = error.details;
  } else {
    delete failed.lastErrorDetail;
  }
  return failed;
}
