import crypto from "node:crypto";
import { store, listJson, json, requireAdmin } from "./_admin.mjs";
import { validateExpenseInput, validateExpenseId, summarizeFinance, isValidMonth, EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS } from "./_admin-data.mjs";

// Gastos del negocio. Prefijo independiente "expenses/" en el almacén administrativo
// (producción y no producción ya están separados por _admin.mjs). No toca pedidos.
// Los gastos no se borran: se anulan, y cada cambio queda en el historial.

const KEY = (id) => "expenses/" + id;
const MAX_HISTORY = 30;

async function readExpense(id) {
  return await store.getWithMetadata(KEY(id), { type: "json", consistency: "strong" });
}

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const url = new URL(req.url);
    const month = url.searchParams.get("month") || "";
    if (month && !isValidMonth(month)) return json({ error: "Mes no válido (AAAA-MM)" }, 400);
    const [expenses, orders] = await Promise.all([listJson("expenses/"), listJson("orders/")]);
    expenses.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const visible = month ? expenses.filter(e => String(e.date).startsWith(month)) : expenses;
    return json({
      expenses: visible,
      summary: summarizeFinance(orders, expenses, month),
      options: { categories: EXPENSE_CATEGORIES, paymentMethods: EXPENSE_PAYMENT_METHODS }
    });
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const action = String(body?.action || "");
  const now = new Date().toISOString();

  if (action === "create") {
    const checked = validateExpenseInput(body);
    if (checked.errors) return json({ error: checked.errors[0], errors: checked.errors }, 400);
    // El id lo genera el navegador una vez por formulario: reenviar la misma solicitud
    // (doble toque, reintento de red) no crea un gasto duplicado.
    const id = body?.id ? validateExpenseId(body.id) : "gx_" + crypto.randomUUID().replace(/-/g, "");
    if (!id) return json({ error: "Identificador no válido" }, 400);
    const expense = { id, ...checked.value, voided: false, createdAt: now, updatedAt: now, history: [] };
    const result = await store.setJSON(KEY(id), expense, { onlyIfNew: true });
    if (result?.modified === false) {
      const existing = await readExpense(id);
      return json({ ok: true, duplicate: true, expense: existing?.data ?? null });
    }
    return json({ ok: true, expense }, 201);
  }

  const id = validateExpenseId(body?.id);
  if (!id) return json({ error: "Identificador no válido" }, 400);
  const current = await readExpense(id);
  if (!current?.data) return json({ error: "Gasto no encontrado" }, 404);
  const before = current.data;

  if (action === "void") {
    if (before.voided) return json({ ok: true, expense: before });
    const next = {
      ...before, voided: true, voidedAt: now, updatedAt: now,
      voidReason: String(body?.reason || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200),
      history: [...(before.history || []), { at: now, action: "void" }].slice(-MAX_HISTORY)
    };
    const result = await store.setJSON(KEY(id), next, { onlyIfMatch: current.etag });
    if (result?.modified === false) return json({ error: "El gasto cambió mientras lo anulabas. Recarga e inténtalo de nuevo." }, 409);
    return json({ ok: true, expense: next });
  }

  if (action === "update") {
    if (before.voided) return json({ error: "Un gasto anulado no se puede editar." }, 409);
    const checked = validateExpenseInput(body);
    if (checked.errors) return json({ error: checked.errors[0], errors: checked.errors }, 400);
    const next = {
      ...before, ...checked.value, updatedAt: now,
      history: [...(before.history || []), {
        at: now, action: "update",
        previous: { description: before.description, category: before.category, amount: before.amount, date: before.date, paymentMethod: before.paymentMethod, reference: before.reference, recurrence: before.recurrence }
      }].slice(-MAX_HISTORY)
    };
    const result = await store.setJSON(KEY(id), next, { onlyIfMatch: current.etag });
    if (result?.modified === false) return json({ error: "El gasto cambió mientras lo editabas. Recarga e inténtalo de nuevo." }, 409);
    return json({ ok: true, expense: next });
  }

  return json({ error: "Acción no reconocida" }, 400);
};
