# Panel administrativo — fase 3 (productos, inventario por variante, indicadores)

Rama: `feature/admin-panel`. No se tocó checkout, Bold, webhooks, `gracias.html`, pedidos existentes,
WhatsApp, Meta CAPI, `_catalog.mjs`, `orders.mjs`, `store-config.mjs`, `index.html`, secretos ni variables.
Nada se publicó ni se desplegó.

## Qué es real y qué no

| Función | Estado |
| --- | --- |
| Crear / consultar / editar / activar / desactivar / archivar productos del panel | Implementado y probado (pruebas unitarias con almacén simulado y navegador con servidor local) |
| Los productos creados **se guardan** de forma persistente (`catalog/<id>` en el almacén administrativo) | Implementado. No probado contra Netlify Blobs reales |
| Los productos creados **aparecen en la tienda pública** y el **checkout los acepta** | **NO implementado en esta rama (bloqueado a propósito)**. Ver «Sincronización» |
| Precio de productos del catálogo base | Solo lectura. Lo cobra `_catalog.mjs` |
| Inventario por producto/color/talla con ajuste manual, motivo, confirmación e historial | Implementado. **No se descuenta al vender** y la tienda no lo lee |
| Alertas de existencias bajas (≤ 2) y agotadas | Implementado (Inicio e Inventario) |
| Utilidad | Solo si todos los productos vendidos tienen costo registrado; si no, el panel dice que no se puede calcular. Las ventas aprobadas nunca se presentan como utilidad |

## Modelo de datos (almacén `mfc-admin` / `mfc-admin-nonprod`)

- `catalog/<id>`: `id, source ("panel"|"estatico"), status (activo|inactivo|archivado), name, description, sku, cost, price, category, collection, colors[], sizes[], imgs[{path,alt}], order, isNew, createdAt, updatedAt, photosCheckedAt, history[≤60]`.
  Los productos base (`productos.js`) solo guardan `sku`, `cost` y `status`; sus datos públicos no se editan aquí.
- `catalog-sku/<SKU>`: reserva atómica (`onlyIfNew`) para que un SKU no se repita.
- `inventory/<id>`: `stock {"color|talla" o "talla": n}`, `history[≤300] {at,key,before,after,delta,reason}`.
- Creación idempotente (`onlyIfNew`), ediciones con etag (`onlyIfMatch`, 409 si cambió). Archivar no borra nada y es reversible.
- Fotos: solo rutas existentes `assets/…(jpg|jpeg|png|webp|avif)`; el servidor verifica con HEAD al propio sitio que existan y sean imagen. **No se suben fotos nuevas desde el panel.**
- El costo y las notas son internos: `toPublicProduct()` nunca los expone.

## Cómo crear un producto (paso a paso)

1. Entrar a `/admin` → **Productos** → **+ Nuevo producto**.
2. Nombre (el identificador se genera solo), precio entero en COP (1.000 a 20.000.000), categoría, colección, descripción.
3. Costo interno (opcional, necesario para calcular utilidad) y SKU (opcional, único).
4. Colores separados por coma (vacío si no aplica) y tallas 34–40.
5. Fotos: elegir una existente de la lista o escribir su ruta `assets/…` y pulsar **Verificar**.
6. Guardar. Nace **inactivo** (borrador) salvo que marques «Crear como activo».
7. Registrar existencias en **Inventario** (motivo obligatorio).

Dónde queda: `catalog/<id>` del almacén administrativo. **Hoy no llega al catálogo público**: la tienda lee
`productos.js` y el checkout valida con `_catalog.mjs`.

## Sincronización catálogo ↔ precio ↔ checkout

Bloqueo concreto: el checkout (`orders.mjs` → `validateCart` → `_catalog.mjs`) solo conoce los ids de `productos.js`
y `index.html` renderiza `PRODUCTS` estático. Para que un producto del panel se muestre y se pueda comprar hay que
modificar checkout, creación de pedidos y la portada, lo cual está prohibido sin autorización independiente.

Alternativa segura preparada y **no aplicada**: `docs/proposals/catalog-sync-checkout.patch`
(se aplica con `git apply`; se verificó con `git apply --check`).

- `validateCart(items, extraProducts)`: los ids estáticos ganan siempre; el precio sale solo del servidor y la talla debe estar entre las del producto.
- `orders.mjs`: lee los productos activos del panel y los pasa a `validateCart` (el precio del navegador nunca se usa).
- `store-config.mjs`: expone `catalog` (solo activos, sin costo/notas/historial).
- `index.html`: agrega esos productos a `PRODUCTS` al cargar la configuración y vuelve a pintar.
- Pruebas incluidas: `tests/catalog-sync.test.mjs` (6). Con el parche aplicado, la suite da 85 pruebas: 81 pasan; fallan las 3 de
  siempre (falta `@netlify/blobs` en este entorno) y **1 guarda intencional** de `tests/admin-catalog.test.mjs`
  («orders.mjs sigue validando con el catálogo base»), que existe justamente para detectar este cambio y que quien
  apruebe el parche debe reemplazar conscientemente.
- Limitaciones aún abiertas con el parche: `coleccion.html` no listaría los productos nuevos; no hay snapshot de versión de
  precio en el pedido; no hay prueba contra Netlify Blobs ni Bold reales. Requiere revisión y despliegue en entorno de prueba.

## Verificación realizada

- Pruebas unitarias: ver informe final (cifras exactas). Las 3 suites que fallan (`order-status-bold-button`,
  `order-status`, `orders-meta`) fallan igual en `main` por no poder instalar `@netlify/blobs` (proxy 403); no se modificaron.
- Navegador (Chromium, servidor local con almacén en memoria y Bold simulado): 56 comprobaciones, incluido 390 px sin
  scroll horizontal en todas las vistas y sin errores de consola.
- **No probado**: Netlify Blobs reales, login real de producción, Bold real, pedidos reales.

## Pendiente

- Aplicar y probar el parche de sincronización (requiere autorización).
- Subida de fotos nuevas, descuento automático de existencias, «agotado» en la tienda, seguimiento de transportadoras.
- Productos base: nombre/fotos/precio siguen en `productos.js` + `_catalog.mjs`.
