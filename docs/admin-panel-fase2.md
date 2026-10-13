# Panel administrativo — fase 2

Rama: `feature/admin-panel` (parte de `main` en `839c593`). Esta fase no toca checkout, Bold,
webhooks, `gracias.html`, WhatsApp, cálculo de envíos, `_catalog.mjs` ni la autenticación.

## Fuentes reales de cada módulo

| Módulo | Lee de | Escribe en | Función |
| --- | --- | --- | --- |
| Inicio | pedidos, resumen de gastos, despachos, inventario | nada | `orders`, `admin-expenses`, `admin-shipping`, `admin-inventory` |
| Pedidos | `orders/` | `orders/<ref>` solo `status` y notas (PATCH existente) | `orders` |
| Consulta de pago | Bold (voucher, solo lectura) | nada | `bold-status` (sin cambios) |
| Finanzas | `orders/` + `expenses/` | `expenses/<id>` | `admin-expenses` |
| Despachos | `orders/` + `shipping/` | `shipping/<ref>` | `admin-shipping` |
| Inventario | `productos.js` (catálogo) + `inventory/` + `products/` | `inventory/<id>`; visibilidad vía `products/<id>` | `admin-inventory`, `admin-api` |
| Marca | `settings` | `settings` | `admin-api` |

Todos los datos están en el almacén administrativo (`mfc-admin` en producción,
`mfc-admin-nonprod` fuera de ella). Toda ruta usa `requireAdmin` en el servidor.

## Modelo de datos nuevo (prefijos independientes)

- `expenses/<id>`: `description, category, amount (COP entero), date (AAAA-MM-DD), paymentMethod, reference, recurrence, voided, voidedAt, voidReason, createdAt, updatedAt, history[]`.
  Los gastos no se borran: se anulan. El id lo genera el navegador una vez por formulario y la
  creación usa `onlyIfNew`, así un doble toque o un reintento no duplica. Las ediciones usan
  `onlyIfMatch` (etag): si el registro cambió, responde 409 y no pisa.
- `shipping/<referencia>`: `status, carrier, guide, shippedAt, deliveredAt, notes, history[]`.
  Nunca escribe en `orders/`. Despachado/en tránsito/entregado exigen transportadora y guía
  escritas por el administrador; no se inventan guías ni entregas. No hay seguimiento
  automático: no existe integración con ninguna transportadora.
- `inventory/<productId>`: `sizes { "36": n, … }`. Registro manual validado contra las tallas del
  catálogo del servidor. **No se descuenta al vender** y la tienda no lo lee.

## Qué significa cada cifra de Finanzas

- **Aprobado**: pedidos con `paymentStatus = aprobado` (solo lo fija el webhook validado de
  Bold). Importe = `confirmedAmount` si Bold lo confirmó, si no el total del pedido. Se asigna al
  mes del evento de pago (`paymentEventTime`), en hora de Bogotá (UTC−5).
- **Pendiente**: pedidos con pago pendiente y no cancelados. **No es dinero recibido.**
- **Rechazado/anulado**: aparte.
- **Gastos**: registros no anulados, por la fecha del gasto.
- **Neto** = aprobado − gastos. No incluye costos de producto ni márgenes: no hay datos de costos.
- No hay ingresos manuales: la única fuente de ingresos es el pago aprobado de cada pedido, por
  eso un pedido no se cuenta dos veces.
- Limitación: un pedido cobrado fuera de Bold (efectivo, transferencia) queda «pendiente» y no
  suma como ingreso, porque el panel no puede marcar pagos manualmente (prohibido por diseño).

## Precios: solo lectura (y por qué)

La tienda muestra el precio de `productos.js` (más los cambios de `store-config`), pero el
servidor cobra y valida contra `netlify/functions/_catalog.mjs`. Si el panel cambiara un precio,
la tienda mostraría uno y el checkout validaría otro. Por eso:

- El panel no tiene campo de precio y `admin-api` (`save-product`) responde 403 si recibe `price`.
- `save-product` ahora fusiona con el registro existente y no escribe `price: null`. Antes, un
  guardado sin precio creaba `price: null` y `store-config` lo aplicaba en la tienda
  (`o.price !== undefined`), anulando el precio mostrado.
- Los registros `products/<id>` que ya existan con precio no se tocan ni migran.

### Arquitectura necesaria para sincronizar precios (fase posterior, no implementada)

1. Una sola fuente de verdad en el servidor (por ejemplo `catalog/<id>` en Blobs, con
   `price`, `version` y `updatedAt`), inicializada desde `_catalog.mjs`/`productos.js` con un
   script de migración verificable.
2. `validateCart` y `store-config` leen esa misma fuente; `_catalog.mjs` queda como respaldo.
3. El pedido guarda un snapshot del precio y de la versión usados, y la creación del pedido
   rechaza con 409 si la versión del carrito está desfasada, para que el cliente refresque.
4. La escritura del precio es atómica (`onlyIfMatch`) y deja historial de quién y cuándo.
5. Pruebas: el precio mostrado = el validado = el cobrado, cambios concurrentes, y regresión de
   Bold/gracias. Despliegue gradual tras revisión, con el checkout bajo prueba controlada.
6. Requiere autorización expresa porque modifica checkout y creación de pedidos.

## Consulta de pago Bold dentro del panel

Se conserva «Consultar pago» (por referencia o por link LNK) y «Crear link de pago». El panel
muestra el mensaje del servidor y el detalle, y si el servidor responde sin detalle muestra
«Error HTTP <código>» en lugar de un «Error» genérico. Esas dos mejoras equivalen a las ediciones
de `admin.html` del PR #35 (`fix/bold-reference-id-required`).

**Al fusionar ambas ramas habrá un conflicto en `admin.html`** (este archivo se reescribió
completo). Resolver tomando la versión de `feature/admin-panel`, que ya incluye ambos
comportamientos. `bold-status.mjs` no se toca aquí.

## Pendiente / no implementado

- Alta y edición de productos nuevos (nombre, descripción, fotos, tallas, costo): el catálogo vive
  en un archivo estático versionado (`productos.js`) y en `_catalog.mjs`; crear productos desde el
  panel exigiría la arquitectura de precios de arriba. No se creó un catálogo paralelo.
- Descuento automático de existencias al vender y «agotado» en la tienda.
- Costos y márgenes (no hay datos).
- Seguimiento automático de transportadoras.
- Fotos: solo se muestran las existentes del catálogo (si el archivo falta se ve «Sin foto»).
- Verificar en un entorno real con la sesión de administrador (login real, Blobs reales).
