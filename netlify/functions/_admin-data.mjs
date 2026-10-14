// Lógica pura (sin Blobs ni red) del panel administrativo: validación de gastos,
// despachos e inventario por talla, y resumen financiero. Se mantiene aparte de las
// funciones para poder probarla sin dependencias y para no tocar flujos de pago.

export const EXPENSE_CATEGORIES = ["publicidad", "envios", "empaques", "inventario", "servicios", "impuestos", "otros"];
export const EXPENSE_PAYMENT_METHODS = ["efectivo", "transferencia", "tarjeta", "bold", "otro"];
export const RECURRENCES = ["", "mensual"];
export const SHIPPING_STATUSES = ["pendiente", "preparando", "despachado", "en_transito", "entregado", "novedad", "devuelto"];
const NEEDS_GUIDE = new Set(["despachado", "en_transito", "entregado"]);

const MAX_AMOUNT = 1_000_000_000;
const MAX_STOCK = 99_999;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,80}$/;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export function isValidDate(value) {
  if (!DATE_RE.test(String(value || ""))) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidMonth(value) {
  return MONTH_RE.test(String(value || ""));
}

// Colombia no usa horario de verano: UTC-5 fijo. Evita que un pedido de las 8 p. m.
// del último día del mes se cuente en el mes siguiente.
export function bogotaDate(input) {
  const t = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(t)) return "";
  return new Date(t - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseAmount(value) {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return NaN;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

export function validateExpenseInput(body, { today = bogotaDate(Date.now()) } = {}) {
  const errors = [];
  const description = clean(body?.description, 160);
  if (description.length < 2) errors.push("La descripción es obligatoria (mínimo 2 caracteres).");

  const category = clean(body?.category, 40).toLowerCase();
  if (!EXPENSE_CATEGORIES.includes(category)) errors.push("Categoría no válida.");

  const amount = parseAmount(body?.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > MAX_AMOUNT) errors.push("El importe debe ser un número entero de pesos mayor que 0.");

  const date = clean(body?.date, 10);
  if (!isValidDate(date)) errors.push("La fecha no es válida (AAAA-MM-DD).");
  else if (date > new Date(Date.parse(today + "T12:00:00Z") + 31 * 86400000).toISOString().slice(0, 10)) errors.push("La fecha está demasiado lejos en el futuro.");

  const paymentMethod = clean(body?.paymentMethod, 30).toLowerCase();
  if (!EXPENSE_PAYMENT_METHODS.includes(paymentMethod)) errors.push("Método de pago no válido.");

  const reference = clean(body?.reference, 80);
  if (reference && !REF_RE.test(reference)) errors.push("La referencia solo admite letras, números, guion y guion bajo.");

  const recurrence = clean(body?.recurrence, 20).toLowerCase();
  if (!RECURRENCES.includes(recurrence)) errors.push("Recurrencia no válida.");

  if (errors.length) return { errors };
  return { value: { description, category, amount, date, paymentMethod, reference, recurrence } };
}

export function validateExpenseId(value) {
  const id = String(value || "").trim();
  return ID_RE.test(id) ? id : "";
}

export function validateShippingInput(body) {
  const errors = [];
  const reference = clean(body?.reference, 80);
  if (!REF_RE.test(reference)) errors.push("Referencia de pedido no válida.");

  const status = clean(body?.status, 20).toLowerCase();
  if (!SHIPPING_STATUSES.includes(status)) errors.push("Estado de despacho no válido.");

  const carrier = clean(body?.carrier, 60);
  const guide = clean(body?.guide, 60);
  if (guide && !/^[A-Za-z0-9._-]{3,60}$/.test(guide)) errors.push("La guía solo admite letras, números, punto, guion y guion bajo (3 a 60).");
  if (NEEDS_GUIDE.has(status) && (!carrier || !guide)) errors.push("Para este estado debes indicar la transportadora y el número de guía.");

  const shippedAt = clean(body?.shippedAt, 10);
  const deliveredAt = clean(body?.deliveredAt, 10);
  if (shippedAt && !isValidDate(shippedAt)) errors.push("La fecha de despacho no es válida.");
  if (deliveredAt && !isValidDate(deliveredAt)) errors.push("La fecha de entrega no es válida.");
  if (shippedAt && deliveredAt && deliveredAt < shippedAt) errors.push("La entrega no puede ser anterior al despacho.");
  if (status === "entregado" && !deliveredAt) errors.push("Indica la fecha de entrega.");

  const notes = clean(body?.notes, 500);
  if (errors.length) return { errors };
  return { value: { reference, status, carrier, guide, shippedAt, deliveredAt, notes } };
}

export const PRODUCT_STATUSES = ["activo", "inactivo", "archivado"];
export const SIZES = ["34", "35", "36", "37", "38", "39", "40"]; // mismas tallas que valida el checkout
export const COLLECTIONS = ["tacones", "plataformas"]; // valores reales de "group" en productos.js
export const LOW_STOCK = 2;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
const PHOTO_RE = /^assets\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,150}\.(?:jpe?g|png|webp|avif)$/i;
const MAX_PRICE = 20_000_000; // tope del checkout

export function isValidProductId(value) {
  const id = String(value || "");
  return id.length >= 3 && id.length <= 80 && SLUG_RE.test(id);
}

// Solo rutas relativas a este mismo sitio dentro de assets/. Nada de URLs externas: así la
// verificación del servidor nunca puede apuntar a otro host.
export function normalizePhotoPath(value) {
  const path = String(value ?? "").trim().replace(/^\/+/, "");
  if (!PHOTO_RE.test(path) || path.includes("..") || path.includes("//")) return "";
  return path;
}

const cleanList = (value, max, each) => {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const v of value) {
    const t = clean(v, each);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.length <= max ? out : null;
};

// Valida los campos de un producto del panel. Solo se aceptan los campos de la lista
// blanca (sin asignación masiva). En "update" solo se validan los campos enviados.
export function validateProductInput(body, { mode = "create" } = {}) {
  const errors = [];
  const v = {};
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);
  const need = (k) => mode === "create" || has(k);

  if (need("name")) {
    const name = clean(body?.name, 120);
    if (name.length < 3) errors.push("El nombre es obligatorio (mínimo 3 caracteres)."); else v.name = name;
  }
  if (has("description")) v.description = clean(body.description, 1200);
  if (need("price")) {
    const price = parseAmount(body?.price);
    if (!Number.isFinite(price) || price < 1000 || price > MAX_PRICE) errors.push("El precio debe ser un número entero de pesos entre 1.000 y 20.000.000."); else v.price = price;
  }
  if (has("cost")) {
    if (body.cost === null || body.cost === "") v.cost = null;
    else {
      const cost = parseAmount(body.cost);
      if (!Number.isFinite(cost) || cost < 0 || cost > MAX_PRICE) errors.push("El costo debe ser un entero de pesos (0 o más)."); else v.cost = cost;
    }
  }
  if (has("sku")) {
    const sku = clean(body.sku, 40);
    if (sku && !SKU_RE.test(sku)) errors.push("El SKU solo admite letras, números, punto, guion y guion bajo (2 a 40)."); else v.sku = sku;
  }
  if (has("category")) v.category = clean(body.category, 80);
  if (has("collection")) {
    const c = clean(body.collection, 30);
    if (c && !COLLECTIONS.includes(c)) errors.push("Colección no válida."); else v.collection = c;
  }
  if (need("imgs")) {
    if (!Array.isArray(body?.imgs) || body.imgs.length < 1 || body.imgs.length > 8) errors.push("Agrega entre 1 y 8 fotografías.");
    else {
      const imgs = [], seen = new Set();
      for (const raw of body.imgs) {
        const path = normalizePhotoPath(raw?.path);
        if (!path) { errors.push("Ruta de foto no válida: " + clean(raw?.path, 80) + ". Usa una ruta existente dentro de assets/ (jpg, png, webp o avif)."); continue; }
        if (seen.has(path)) continue;
        seen.add(path);
        imgs.push({ path, alt: clean(raw?.alt, 160) });
      }
      v.imgs = imgs;
    }
  }
  if (has("colors")) {
    const colors = cleanList(body.colors, 12, 30);
    if (!colors) errors.push("Colores no válidos (máximo 12)."); else v.colors = colors;
  }
  if (need("sizes")) {
    const sizes = cleanList(body?.sizes, 7, 3);
    if (!sizes || !sizes.length || sizes.some(t => !SIZES.includes(t))) errors.push("Elige al menos una talla entre 34 y 40.");
    else v.sizes = SIZES.filter(t => sizes.includes(t));
  }
  if (has("order")) {
    const order = parseAmount(body.order);
    if (!Number.isFinite(order) || order < 0 || order > 9999) errors.push("El orden debe ser un entero entre 0 y 9999."); else v.order = order;
  }
  if (has("isNew")) v.isNew = body.isNew === true;
  if (errors.length) return { errors };
  return { value: v };
}

// Claves de inventario de un producto: "color|talla" si tiene colores; "talla" si no.
export function variantKeys(product) {
  const sizes = (product?.sizes || []).map(String);
  const colors = (product?.colors || []).map(String);
  return colors.length ? colors.flatMap(c => sizes.map(t => c + "|" + t)) : sizes;
}

export function validateInventoryInput(body, product) {
  const errors = [];
  const productId = String(body?.productId || "").trim();
  if (!ID_RE.test(productId)) errors.push("Producto no válido.");
  const reason = clean(body?.reason, 200);
  if (reason.length < 3) errors.push("Indica el motivo del ajuste (mínimo 3 caracteres).");
  const allowed = new Set(variantKeys(product));
  const changes = {};
  const raw = body?.changes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) errors.push("Indica las existencias a ajustar.");
  else {
    const entries = Object.entries(raw);
    if (!entries.length || entries.length > 120) errors.push("Cantidad de variantes no válida.");
    for (const [key, qty] of entries) {
      if (!allowed.has(key)) { errors.push("La variante «" + clean(key, 40) + "» no existe para este producto."); continue; }
      const n = parseAmount(qty);
      if (!Number.isFinite(n) || n < 0 || n > MAX_STOCK) { errors.push("Existencias no válidas en «" + key + "» (entero entre 0 y " + MAX_STOCK + ")."); continue; }
      changes[key] = n;
    }
  }
  if (errors.length) return { errors };
  return { value: { productId, reason, changes } };
}

// Registro público de un producto del panel: solo lo que la tienda debe ver. Nunca incluye
// costo, notas, historial ni estado interno. Solo los productos "activo" son publicables.
export function toPublicProduct(record) {
  if (!record || record.source === "estatico" || record.status !== "activo") return null;
  return {
    id: record.id,
    name: record.name,
    cat: record.category || "",
    group: record.collection || "",
    price: record.price,
    isNew: record.isNew === true,
    cardBg: "#ececec",
    imgs: (record.imgs || []).map(i => [i.path, i.alt || record.name]),
    colors: record.colors || [],
    facts: [...(record.colors || []), ...(record.sizes || [])],
    desc: record.description || "",
    order: Number.isInteger(record.order) ? record.order : 0
  };
}

// Costo de mercancía de los pedidos aprobados del periodo, solo con costos registrados.
// Si falta el costo de algún producto vendido, no se calcula utilidad (no se inventa).
export function computeCogs(orders = [], costs = {}, month = "") {
  const out = { total: 0, units: 0, unknownUnits: 0, unknownProducts: [] };
  const unknown = new Set();
  for (const o of Array.isArray(orders) ? orders : []) {
    if (o?.paymentStatus !== "aprobado") continue;
    const paid = Number(o?.paymentEventTime) > 0 ? bogotaDate(Number(o.paymentEventTime) * 1000) : bogotaDate(o?.createdAt);
    if (month && String(paid).slice(0, 7) !== month) continue;
    for (const it of Array.isArray(o?.items) ? o.items : []) {
      const qty = Number(it?.qty) || 0;
      if (qty < 1) continue;
      const cost = costs[it?.id];
      out.units += qty;
      if (Number.isFinite(cost) && cost >= 0) out.total += cost * qty;
      else { out.unknownUnits += qty; unknown.add(it?.id || "desconocido"); }
    }
  }
  out.unknownProducts = [...unknown];
  return out;
}

const monthOf = (isoDate) => String(isoDate || "").slice(0, 7);

/**
 * Resumen financiero. Definiciones (también documentadas en el panel):
 * - ordersCreated: pedidos creados en el mes (por fecha de creación, hora de Bogotá).
 * - approved: dinero con pago APROBADO por Bold validado (importe confirmado por Bold si
 *   existe; si no, el total del pedido). Se asigna al mes del evento de pago.
 * - pending: pedidos con pago pendiente que no están cancelados. No es dinero recibido.
 * - rejected: pagos rechazados o anulados.
 * - expenses: gastos registrados no anulados, por fecha del gasto.
 * - net: aprobado − gastos. No incluye costos de producto ni márgenes (no hay datos).
 * Los pedidos nunca se cuentan como ingresos manuales: la única fuente de ingresos es
 * el pago aprobado de cada pedido, por lo que no hay doble conteo.
 */
export function summarizeFinance(orders = [], expenses = [], month = "") {
  const inMonth = (m) => !month || m === month;
  const out = {
    month: month || "todos",
    ordersCreated: { count: 0, total: 0 },
    approved: { count: 0, total: 0 },
    pending: { count: 0, total: 0 },
    rejected: { count: 0, total: 0 },
    expenses: { count: 0, total: 0, byCategory: {}, recurring: 0 },
    net: 0,
    byMonth: {}
  };
  const bucket = (m) => (out.byMonth[m] ||= { approved: 0, expenses: 0, net: 0 });

  for (const o of Array.isArray(orders) ? orders : []) {
    const total = Number(o?.total) || 0;
    const createdMonth = monthOf(bogotaDate(o?.createdAt));
    if (inMonth(createdMonth)) {
      out.ordersCreated.count += 1;
      out.ordersCreated.total += total;
      if (o?.paymentStatus === "pendiente" && o?.status !== "cancelado") { out.pending.count += 1; out.pending.total += total; }
      if (o?.paymentStatus === "rechazado" || o?.paymentStatus === "anulado") { out.rejected.count += 1; out.rejected.total += total; }
    }
    if (o?.paymentStatus === "aprobado") {
      const confirmed = Number(o?.confirmedAmount);
      const amount = Number.isFinite(confirmed) && confirmed > 0 ? confirmed : total;
      const paidMonth = monthOf(Number.isFinite(Number(o?.paymentEventTime)) && Number(o.paymentEventTime) > 0
        ? bogotaDate(Number(o.paymentEventTime) * 1000)
        : bogotaDate(o?.createdAt));
      if (inMonth(paidMonth)) { out.approved.count += 1; out.approved.total += amount; }
      if (paidMonth) bucket(paidMonth).approved += amount;
    }
  }

  for (const e of Array.isArray(expenses) ? expenses : []) {
    if (!e || e.voided) continue;
    const amount = Number(e.amount) || 0;
    const m = monthOf(e.date);
    if (m) bucket(m).expenses += amount;
    if (!inMonth(m)) continue;
    out.expenses.count += 1;
    out.expenses.total += amount;
    out.expenses.byCategory[e.category] = (out.expenses.byCategory[e.category] || 0) + amount;
    if (e.recurrence) out.expenses.recurring += 1;
  }

  out.net = out.approved.total - out.expenses.total;
  for (const m of Object.keys(out.byMonth)) out.byMonth[m].net = out.byMonth[m].approved - out.byMonth[m].expenses;
  return out;
}
