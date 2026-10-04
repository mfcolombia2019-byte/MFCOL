# Seguridad de pedidos, Bold y Meta CAPI

Esta rama prepara la protección del flujo de pedidos sin tocar producción, dominio, variables reales ni despliegues.

## Estado de pago

- El POST /.netlify/functions/orders acepta los datos comerciales del pedido, pero fuerza nuevos pedidos a status="nuevo" y paymentStatus="pendiente".
- Si ya existe el pedido, conserva los estados guardados por el servidor.
- El navegador no puede establecer paymentStatus=aprobado.
- El PATCH /.netlify/functions/orders es administrativo y ya no permite modificar paymentStatus; la confirmación de pago queda reservada al webhook validado de Bold.
- WhatsApp no crea ningún evento Purchase.

## Bold webhook

bold-webhook.mjs:

1. valida x-bold-signature usando el cuerpo crudo, Base64 y HMAC-SHA256;
2. persiste primero el evento validado en webhook-inbox/<event-id>;
3. responde 200 OK inmediatamente después de persistir el evento;
4. procesa el pedido y el outbox mediante context.waitUntil() cuando está disponible;
5. escribe el marcador processedAt solo después de guardar el pedido y, para SALE_APPROVED, crear el registro del outbox.

Esto evita el fallo anterior donde el marcador de idempotencia podía quedar escrito antes de completar la actualización del pedido.

Bold documenta que el endpoint debe responder 200 en un máximo de 2 segundos y que puede reenviar notificaciones, por lo que el inbox y la idempotencia son deliberados.

## Netlify Blobs y concurrencia

El proyecto declara @netlify/blobs: ^8.1.0.

La versión 8.1.0 actualmente declarada no expone onlyIfNew ni onlyIfMatch en set/setJSON. Por ello no se ha inventado un CAS ni un lock falso.

Se usa consistency: "strong" en las lecturas críticas y claves deterministas para que los reintentos reutilicen el mismo registro, pero esto no garantiza exclusión mutua entre dos invocaciones concurrentes.

Por tanto:

- Blobs es suficiente para el almacenamiento actual, inbox y outbox como objetos recuperables.
- Blobs por sí solo no garantiza una transacción de lectura-modificación-escritura para estados de pedido.
- Si se exige garantía fuerte frente a dos webhooks simultáneos que actualicen el mismo pedido, hace falta una base de datos transaccional o un mecanismo de concurrencia externo.
- No se migró nada ni se añadió una base de datos en esta etapa.

## Outbox Meta

Cada SALE_APPROVED crea un registro meta-outbox/<event-id-estable> con:

- pending
- processing
- sent
- error
- attempts
- nextAttemptAt
- lastError
- payload completo de Purchase

El event_id se deriva de la referencia y del payment_id de Bold, por lo que los reintentos del mismo pago reutilizan el mismo identificador.

El envío a Meta ocurre después de la aprobación validada. Si Meta falla, el evento permanece recuperable en el outbox y no se marca como enviado.

## Meta CAPI preparada

Dataset:

1092821839891082

El código prepara:

- event_name=Purchase
- action_source=website
- currency=confirmedCurrency (por defecto COP)
- value=confirmedAmount proveniente de Bold
- event_id estable
- event_time de la notificación de Bold
- fbp y fbc conservados desde el navegador
- nombre y teléfono normalizados y hasheados cuando existen
- client_user_agent
- event_source_url

Purchase no se genera al abrir gracias.html, al crear un pedido ni al enviar WhatsApp.

### Variables que deberán configurarse posteriormente

No se han creado ni modificado variables reales.

- META_CAPI_ACCESS_TOKEN
- META_GRAPH_API_VERSION (por ejemplo, v24.0; debe corresponder a una versión Graph vigente)
- opcional: META_DATASET_ID (si no se define se usa 1092821839891082)
- opcional: META_TEST_EVENT_CODE

## Async Workloads

No se instaló @netlify/async-workloads ni se afirmó que esté activo.

La implementación de esta rama usa el outbox persistente y context.waitUntil() para no bloquear la respuesta del webhook. Esto deja el evento recuperable incluso si Meta no responde.

Si posteriormente se necesita una cola durable administrada con reintentos independientes del ciclo de vida de la Function, Async Workloads es una evolución posible, pero requiere instalar/configurar su extensión y paquete y no se hace automáticamente en esta rama.

## Recuperación administrativa

- webhook-replay.mjs: permite consultar y reprocesar eventos de Bold que quedaron en error.
- meta-outbox.mjs: permite consultar y reprocesar entradas del outbox.

Ambas rutas requieren la autenticación administrativa existente.

## Pruebas

tests/orders-meta.test.mjs usa únicamente datos ficticios y comprueba:

- rechazo de paymentStatus enviado por cliente;
- conservación de estados confirmados;
- conservación de fbp/fbc;
- creación de SALE_APPROVED;
- importe confirmado desde Bold;
- Purchase solo después de SALE_APPROVED;
- Purchase no generado para un pedido de WhatsApp;
- estabilidad de event_id;
- no degradación de un pago aprobado por una notificación posterior rechazada.


## Implementación actual (2026-10-01)

### Checkout
- El navegador envía carrito estructurado; el servidor valida producto, talla, color, cantidad y precio.
- El total usado para el pedido y para Bold proviene del servidor.
- La referencia del pedido la genera el servidor.
- El cliente no puede fijar paymentStatus, status, callback_url, descripción ni importe para crear el link Bold.
- Un producto cuyo precio del catálogo es null se rechaza; no se inventa precio.
- Se usa una clave de idempotencia para evitar crear dos referencias ante doble envío.

### Bold
- crear-link-pago recibe únicamente la referencia de un pedido persistido y pendiente.
- El total, descripción y callback se derivan del pedido/configuración servidor.
- SITE_CANONICAL_ORIGIN es la configuración central prevista para el callback HTTPS canónico. No se eligió automáticamente entre los dominios existentes.
- El API Link de Bold usa el endpoint/payload existente del repositorio.

### Webhook / outbox
- Inbox y outbox mantienen sus estados existentes.
- El inbox y el outbox usan escrituras condicionales para reclamar procesamiento.
- El pedido se actualiza con CAS y se valida amount/COP contra el total persistido.
- API Link de Bold puede entregar metadata.reference como LNK_*; se añadió bold-links/LNK_* para resolverlo al pedido.
- Purchase solo se crea después de SALE_APPROVED.
- No se instaló scheduler, Background Functions ni Async Workloads; el retry fuera del ciclo del webhook sigue requiriendo recuperación administrativa.
- @netlify/blobs se fijó en 10.7.12 para disponer de onlyIfNew/onlyIfMatch. Se trata modified=true + etag vacío como fallo por un problema documentado de esa versión.

### Comunidad
- issue-token requiere sesión administrativa, pedido existente, referencia coincidente y paymentStatus aprobado.
- El producto del token debe pertenecer a los items del pedido aprobado.
- moderar.html reutiliza la cookie de sesión firmada; ya no usa x-admin-key ni sessionStorage.
- El consumo del token usa claim processing con CAS y solo pasa a done después del guardado exitoso.

### Gracias / pagar / navegación
- gracias.html consulta el estado del pedido en servidor y no presume aprobación por el simple regreso desde Bold.
- pagar.html usa únicamente ?ref=<referencia del pedido>.
- Comunidad enlaza a /?producto=<id>.
- No se reescribió el sistema de history existente.

### Feed Meta pendiente
El producto Sandalia de cuña trenzada en negro y rosado mantiene price="" en meta-feed/meta-product-feed.csv y price:null en index.html. No existe un precio inequívoco en el repositorio, por lo que no se modificó.

### Dominios
No se modificaron dominios. Se encontraron:
- mfcol-links.html → https://mfcol.com
- meta-feed/meta-product-feed.csv → https://tienda.mfcol.com
No hay evidencia suficiente para seleccionar uno como dominio canónico de checkout. marlonfootwearcol.netlify.app no fue seleccionado.

### netlify.toml
Se mantienen publish="." y functions="netlify/functions". Netlify recomienda mantener Functions fuera del directorio publicado; cambiarlo exigiría una reestructuración que no corresponde a esta fase.

### Pruebas
tests/orders-meta.test.mjs fue actualizado para probar autoridad server-side del total, validación de carrito, precio no configurado, talla inválida, SALE_APPROVED, importe confirmado, Purchase posterior a aprobación, fbp/fbc, event_id estable y no degradación de aprobado.

Las pruebas reales de Netlify/Blobs, Bold y Meta no se ejecutaron en esta sesión. No hubo eventos reales a Meta.
