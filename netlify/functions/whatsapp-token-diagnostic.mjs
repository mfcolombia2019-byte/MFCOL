function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify?.env?.get) {
      const value = Netlify.env.get(name);
      if (value) return String(value).trim();
    }
  } catch {}
  return String(process.env[name] || "").trim();
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "Método no permitido" }, {
      status: 405,
      headers: { Allow: "POST", "Cache-Control": "no-store" }
    });
  }

  const diagnosticKey = env("WHATSAPP_DIAGNOSTIC_KEY");
  if (!diagnosticKey) {
    return Response.json({ ok: false, error: "Diagnóstico no habilitado en este contexto" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const suppliedKey = String(req.headers.get("x-mf-diagnostic-key") || "");
  if (!suppliedKey || suppliedKey.length !== diagnosticKey.length) {
    return Response.json({ ok: false, error: "No autorizado" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" }
    });
  }

  let matches = 0;
  for (let i = 0; i < diagnosticKey.length; i++) {
    matches |= diagnosticKey.charCodeAt(i) ^ suppliedKey.charCodeAt(i);
  }
  if (matches !== 0) {
    return Response.json({ ok: false, error: "No autorizado" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const accessToken = env("WHATSAPP_ACCESS_TOKEN") ||
    env("META_WHATSAPP_ACCESS_TOKEN") ||
    env("WHATSAPP_API_TOKEN");
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID") ||
    env("META_WHATSAPP_PHONE_NUMBER_ID");
  const graphVersion = env("META_GRAPH_API_VERSION") || "v26.0";

  if (!accessToken || !phoneNumberId) {
    return Response.json({
      ok: false,
      authenticated: false,
      error: !accessToken ? "Falta WHATSAPP_ACCESS_TOKEN" : "Falta WHATSAPP_PHONE_NUMBER_ID"
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const endpoint = "https://graph.facebook.com/" +
    encodeURIComponent(graphVersion) + "/" +
    encodeURIComponent(phoneNumberId) +
    "?fields=id,display_phone_number,verified_name,quality_rating";

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken },
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return Response.json({
        ok: false,
        authenticated: false,
        httpStatus: response.status,
        metaError: {
          type: String(data?.error?.type || "OAuthException").slice(0, 80),
          code: Number(data?.error?.code) || 0,
          subcode: Number(data?.error?.error_subcode) || 0
        }
      }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }

    return Response.json({
      ok: true,
      authenticated: true,
      httpStatus: response.status,
      phoneNumberIdSuffix: String(data.id || phoneNumberId).slice(-4),
      displayPhoneNumberSuffix: String(data.display_phone_number || "").replace(/\\D/g, "").slice(-4),
      verifiedNamePresent: Boolean(data.verified_name),
      qualityRating: String(data.quality_rating || "unavailable")
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      ok: false,
      authenticated: false,
      error: error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "Tiempo de espera agotado al consultar Meta"
        : "No se pudo conectar con Meta"
    }, { status: 504, headers: { "Cache-Control": "no-store" } });
  }
};
