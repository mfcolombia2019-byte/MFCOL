import { getStore } from "@netlify/blobs";

const store = getStore("mfc-admin");

export default async (req) => {
  if (req.method !== "GET") return Response.json({ error: "Método no permitido" }, { status: 405 });

  const { blobs: productBlobs } = await store.list({ prefix: "products/" });
  const { blobs: reviewBlobs } = await store.list({ prefix: "reviews/" });
  const products = [];
  const reviews = [];

  for (const b of productBlobs) {
    const p = await store.get(b.key, { type: "json" });
    if (p) products.push(p);
  }
  for (const b of reviewBlobs) {
    const r = await store.get(b.key, { type: "json" });
    if (r && r.active !== false) reviews.push(r);
  }

  const settings = await store.get("settings", { type: "json" });
  return Response.json(
    { products, reviews, settings: settings || {} },
    { headers: { "Cache-Control": "no-store" } }
  );
};
