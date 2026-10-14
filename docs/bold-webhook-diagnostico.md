# Diagnóstico del webhook de Bold (rama feature/admin-panel)

## Hallazgos verificados en el código

1. **El webhook desplegado verificaba la firma con la llave equivocada en producción.** `main` y esta rama usaban
   `BOLD_API_KEY` (llave de identidad, pública: se entrega al navegador). Bold firma con la llave secreta.
   Una notificación real de producción habría sido rechazada, y una firma forjada con la llave pública habría sido aceptada.
   Corregido con el cherry-pick de `dd391aa`: en producción se usa `BOLD_SECRET_KEY` y sin ella el endpoint falla cerrado (500).
2. **Los rechazos eran silenciosos.** Firma inválida, JSON inválido o evento no permitido respondían 400 sin ninguna línea de
   registro, así que en Netlify no quedaba rastro de que Bold sí había llamado. Ahora se registra la recepción y el motivo del
   rechazo (contexto, longitudes, tipo de evento), nunca el cuerpo, la firma ni secretos.
3. Existe `bold-webhook.mjs` (y copias de `crear-link-pago.mjs` y `comunidad.mjs`) en la **raíz** del repositorio. Netlify solo
   construye funciones desde `netlify/functions`, así que esos archivos no son endpoints; además, con `publish="."` quedan
   servidos como archivos estáticos. No se tocaron aquí; conviene eliminarlos en una limpieza aparte.
4. Fuera de producción (`CONTEXT` distinto de `production`, incluido el Branch Deploy) la clave de firma es `""`, como documenta
   Bold para sus notificaciones de prueba. Con eso el Branch Deploy usa el almacén `mfc-admin-nonprod`.

## Lo que el código no puede resolver (configuración externa de Bold)

Bold solo llama a la URL de webhook registrada en su panel (una por ambiente: pruebas y producción). Si apunta a producción o a un
Deploy Preview que ya no existe (los Deploy Previews fueron desactivados), el Branch Deploy nunca recibe llamadas y no habrá
registros por más que el código sea correcto. Dato exacto a revisar: en el panel de Bold, Integraciones → Webhooks, ambiente de
pruebas, la URL debe ser
`https://feature-admin-panel--comforting-liger-43ac3a.netlify.app/.netlify/functions/bold-webhook`.
El botón de Bold para enviar una notificación de prueba usa clave vacía y es la verificación oficial para esa URL.

## Niveles de verificación

- Pruebas automatizadas (simulado): firma, importe, moneda, referencia, duplicados, concurrencia, estado rechazado/anulado,
  rechazo con llave de identidad, fallo cerrado sin `BOLD_SECRET_KEY`, rastro en registros sin secretos.
- Mecanismo oficial de Bold (notificación de prueba) y notificación real: **no ejecutados desde aquí**.
