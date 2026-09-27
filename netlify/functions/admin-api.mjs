import { store, getJson, listJson, json, requireAdmin, safeId } from "./_admin.mjs";

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const url = new URL(req.url);
    const section = url.searchParams.get("section") || "dashboard";

    if (section === "dashboard") {
      const orders = await listJson("orders/");
      const reviews = await listJson("reviews/");
      const products = await listJson("products/");
      const paid = orders.filter(o => o.paymentStatus === "aprobado");
      const revenue = paid.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
      return json({
        stats: {
          orders: orders.length,
          pending: orders.filter(o => o.status === "nuevo" || o.paymentStatus === "pendiente").length,
          paid: paid.length,
          revenue
        },
        recentOrders: orders.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8),
        reviewCount: reviews.length,
        productOverrides: products.length
      });
    }

    if (section === "products") return json({ products: await listJson("products/") });
    if (section === "reviews") return json({ reviews: await listJson("reviews/") });
    if (section === "settings") return json({ settings: await getJson("settings", {}) });

    return json({ error: "Sección no encontrada" }, 404);
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "JSON inválido" }, 400); }

  const action = String(body?.action || "");

  if (action === "save-product") {
    const id = safeId(body.id);
    if (!id) return json({ error: "ID de producto inválido" }, 400);
    const product = {
      id,
      name: String(body.name || "").trim().slice(0, 120),
      price: body.price === "" || body.price == null ? null : Math.round(Number(body.price)),
      active: body.active !== false,
      category: String(body.category || "").slice(0, 80),
      stock: body.stock === "" || body.stock == null ? null : Math.max(0, Math.round(Number(body.stock))),
      updatedAt: new Date().toISOString()
    };
    if (product.price != null && (!Number.isFinite(product.price) || product.price < 0)) return json({ error: "Precio inválido" }, 400);
    await store.setJSON("products/" + id, product);
    return json({ ok: true, product });
  }

  if (action === "save-review") {
    const id = safeId(body.id || ("review-" + Date.now()));
    if (!id) return json({ error: "ID inválido" }, 400);
    const review = {
      id,
      name: String(body.name || "").trim().slice(0, 100),
      text: String(body.text || "").trim().slice(0, 1200),
      rating: Math.max(1, Math.min(5, Math.round(Number(body.rating || 5)))),
      active: body.active !== false,
      updatedAt: new Date().toISOString()
    };
    if (!review.name || !review.text) return json({ error: "Nombre y reseña son obligatorios" }, 400);
    await store.setJSON("reviews/" + id, review);
    return json({ ok: true, review });
  }

  if (action === "delete-review") {
    const id = safeId(body.id);
    if (!id) return json({ error: "ID inválido" }, 400);
    await store.delete("reviews/" + id);
    return json({ ok: true });
  }

  if (action === "save-settings") {
    const current = await getJson("settings", {});
    const settings = {
      ...current,
      brandMessage: String(body.brandMessage ?? current.brandMessage ?? "").slice(0, 300),
      whatsapp: String(body.whatsapp ?? current.whatsapp ?? "").replace(/\D/g, "").slice(0, 20),
      instagram: String(body.instagram ?? current.instagram ?? "").slice(0, 80),
      email: String(body.email ?? current.email ?? "").slice(0, 160),
      updatedAt: new Date().toISOString()
    };
    await store.setJSON("settings", settings);
    return json({ ok: true, settings });
  }

  return json({ error: "Acción no reconocida" }, 400);
};
