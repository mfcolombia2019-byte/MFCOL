# Webhook Bold: diagnóstico de importe, reintentos y reproceso

## Problema

`_bold-webhook.mjs` lanzaba "El importe de Bold no coincide con el pedido" para
cuatro situaciones distintas, sin guardar los valores comparados:

1. El evento trae un importe distinto al total del pedido (desajuste real).
2. El evento trae `amount.total` nulo o vacío: `Number(null)` y `Number("")`
   valen 0 y se leían como un importe de 0.
3. El pedido guardado no tiene un `total` numérico (`Number(undefined)` es NaN).
4. El total del pedido está guardado como texto con formato (por ejemplo "199.900").

Al ser un fallo determinista, `bold-webhook.mjs` y `bold-webhook-retry.mjs` lo
reintentaban hasta 8 veces sin posibilidad de éxito.

## Qué cambia

- `_bold-failure.mjs` (nuevo, sin acceso a almacén ni red): `BoldWebhookError`
  con código y `retryable`, `logBoldEvent` (una línea JSON por evento) y
  `buildInboxFailure` (estado del inbox tras un fallo).
- Códigos en el inbox (`lastErrorCode`): `AMOUNT_MISMATCH`, `AMOUNT_INVALID`,
  `CURRENCY_INVALID`, `ORDER_TOTAL_INVALID` (terminales) y `ORDER_NOT_FOUND`
  (recuperable). Errores sin código (red, persistencia) siguen reintentándose.
- Detalle seguro (`lastErrorDetail`) y log `bold_webhook_amount_rejected` con
  referencia, id y tipo de evento, moneda, importe recibido y esperado, tipos,
  diferencia y estado de pago. Nunca datos del pagador, firmas ni llaves.
- Los errores terminales (`terminal: true`, `nextAttemptAt: ""`) no se
  reprograman. Siguen visibles y se pueden reprocesar con `webhook-replay`.
- `webhook-replay`: el GET incluye `lastErrorCode`, `lastErrorDetail`,
  `attempts`, `terminal` y `nextAttemptAt`; el POST devuelve 409 (terminal) o
  500 (transitorio) con código y detalle si el reproceso vuelve a fallar.
- La validación NO se relaja: el importe debe coincidir exactamente, la moneda
  debe ser COP, la firma se verifica igual que antes y la idempotencia no cambia.

## Clave de firma del webhook

`x-bold-signature` es HMAC-SHA256 (hexadecimal) del cuerpo en Base64, firmado con
la **llave secreta** (`BOLD_SECRET_KEY`) del producto que genera el pago. La tienda
usa Embedded Checkout y el API de Link de pagos (Pagos en línea / Botón de pagos),
y ya depende de `BOLD_SECRET_KEY` para el hash de integridad del checkout
(`crear-link-pago`). En producción el webhook verifica con `BOLD_SECRET_KEY`; si
falta responde 500 y no procesa nada. No hay respaldo a `BOLD_API_KEY`: esa es la
llave de identidad pública y solo se usa en las consultas a la API. Fuera de
producción la clave de firma es vacía, como documenta Bold para pruebas.

Limitación: si algún día se reciben pagos de API Integrations (datáfono), Bold
los firma con la llave API Datáfono y este webhook los rechazaría con 400.

## Cómo diagnosticar en producción

- Logs de la función: filtrar por `evt`: `bold_webhook_amount_rejected`,
  `bold_webhook_processing_error` y `bold_webhook_retry_failed`.
- `GET webhook-replay` (admin) lista cada evento con su código y detalle; con eso
  se distingue entre los casos 1 a 4 de arriba.
