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

export function validateInventoryInput(body, knownSizes = null) {
  const errors = [];
  const productId = String(body?.productId || "").trim();
  if (!ID_RE.test(productId)) errors.push("Producto no válido.");

  const sizes = {};
  const raw = body?.sizes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) errors.push("Indica las existencias por talla.");
  else {
    const entries = Object.entries(raw);
    if (!entries.length || entries.length > 30) errors.push("Cantidad de tallas no válida.");
    for (const [size, qty] of entries) {
      if (!/^\d{2}$/.test(size) || Number(size) < 30 || Number(size) > 46) { errors.push("Talla no válida: " + clean(size, 6)); continue; }
      if (knownSizes && !knownSizes.includes(size)) { errors.push("La talla " + size + " no existe para este producto."); continue; }
      const n = parseAmount(qty);
      if (!Number.isFinite(n) || n < 0 || n > MAX_STOCK) { errors.push("Existencias no válidas en la talla " + size + " (entero entre 0 y " + MAX_STOCK + ")."); continue; }
      sizes[size] = n;
    }
  }
  if (errors.length) return { errors };
  return { value: { productId, sizes } };
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
