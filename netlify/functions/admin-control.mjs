import crypto from "node:crypto";
import { store, getJson, listJson, json, requireAdmin, safeId } from "./_admin.mjs";

const SHIP_STATES = new Set(["pendiente","preparando","despachado","en_transito","entregado","incidencia"]);

function makeId(prefix = "row") {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}
function safeMoney(value, { allowZero = true } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1) || amount > 1000000000) return null;
  return amount;
}
function str(value, max = 180) { return String(value ?? "").trim().slice(0, max); }

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const url = new URL(req.url);
    const section = url.searchParams.get("section") || "";
    if (section === "finance") {
      const [orders, expenses, costs] = await Promise.all([
        listJson("orders/"), listJson("finance-expenses/"), listJson("finance-costs/")
      ]);
      const paid = orders.filter(o => o.paymentStatus === "aprobado");
      const revenue = paid.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
      const costMap = new Map(costs.map(c => [c.productId, Number(c.unitCost) || 0]));
      const costOfGoods = paid.reduce((sum, o) => sum + (Array.isArray(o.items) ? o.items.reduce((part, item) => part + (costMap.get(item.id) || 0) * (Number(item.qty) || 0), 0) : 0), 0);
      const expenseTotal = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
      expenses.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
      costs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return json({ summary: { revenue, costOfGoods, expenses: expenseTotal, profit: revenue - costOfGoods - expenseTotal }, costs, expenses });
    }
    if (section === "inventory") {
      const variants = await listJson("inventory-variants/");
      variants.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.color).localeCompare(String(b.color)) || Number(a.size) - Number(b.size));
      return json({ variants });
    }
    if (section === "dispatches") {
      const [orders, dispatches] = await Promise.all([listJson("orders/"), listJson("dispatches/")]);
      const byReference = new Map(dispatches.map(d => [d.reference, d]));
      orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json({ orders: orders.map(o => ({ ...o, dispatch: byReference.get(o.reference) || { reference: o.reference, status: "pendiente", trackingNumber: "" } })) });
    }
    return json({ error: "Sección no encontrada" }, 404);
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const action = str(body?.action, 40);

  if (action === "save-cost") {
    const productId = safeId(body.productId);
    const name = str(body.name, 120);
    const unitCost = safeMoney(body.unitCost);
    if (!productId || !name || unitCost == null) return json({ error: "Completa ID, nombre y costo válido del producto." }, 400);
    const cost = { productId, name, unitCost, updatedAt: new Date().toISOString() };
    await store.setJSON("finance-costs/" + productId, cost);
    return json({ ok: true, cost });
  }

  if (action === "save-expense") {
    const description = str(body.description, 180);
    const category = str(body.category, 60);
    const amount = safeMoney(body.amount, { allowZero: false });
    const date = str(body.date, 10);
    if (!description || !category || amount == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Revisa el concepto, categoría, valor y fecha del gasto." }, 400);
    const expense = { id: makeId("expense"), description, category, amount, date, createdAt: new Date().toISOString() };
    await store.setJSON("finance-expenses/" + expense.id, expense);
    return json({ ok: true, expense });
  }

  if (action === "save-inventory") {
    const productId = safeId(body.productId);
    const name = str(body.name, 120);
    const color = str(body.color, 50);
    const size = Number(body.size);
    const stock = safeMoney(body.stock);
    if (!productId || !name || !color || !Number.isInteger(size) || size < 34 || size > 40 || stock == null) return json({ error: "Completa producto, color, talla 34–40 y existencias válidas." }, 400);
    const key = crypto.createHash("sha256").update(productId + "|" + color.toLowerCase() + "|" + size).digest("hex");
    const variant = { productId, name, color, size, stock, updatedAt: new Date().toISOString() };
    await store.setJSON("inventory-variants/" + key, variant);
    return json({ ok: true, variant });
  }

  if (action === "save-dispatch") {
    const reference = safeId(body.reference);
    const status = str(body.status, 30);
    const trackingNumber = str(body.trackingNumber, 120);
    if (!reference || !SHIP_STATES.has(status)) return json({ error: "Referencia o estado de despacho inválido." }, 400);
    const order = await getJson("orders/" + reference);
    if (!order) return json({ error: "No se encontró el pedido para asociar el despacho." }, 404);
    const current = await getJson("dispatches/" + reference, { reference });
    const dispatch = { ...(current || {}), reference, status, trackingNumber, updatedAt: new Date().toISOString() };
    await store.setJSON("dispatches/" + reference, dispatch);
    return json({ ok: true, dispatch });
  }

  return json({ error: "Acción no reconocida" }, 400);
};
