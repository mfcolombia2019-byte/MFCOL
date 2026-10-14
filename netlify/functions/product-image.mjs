import { store } from "./_admin.mjs";

// Sirve las fotos de productos subidas desde el panel admin.
// La clave es un UUID único por foto, por eso se puede cachear sin riesgo.
export default async (req) => {
  if (req.method !== "GET") return new Response("Método no permitido", { status: 405 });
  const k = new URL(req.url).searchParams.get("k") || "";
  if (!/^[a-f0-9-]{36}$/.test(k)) return new Response("No encontrada", { status: 404 });

  const data = await store.get("product-images/" + k, { type: "arrayBuffer" });
  if (!data) return new Response("No encontrada", { status: 404 });

  return new Response(data, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable"
    }
  });
};
