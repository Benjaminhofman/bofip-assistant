// Proxy GET vers l'API BOFiP (endpoint: /.netlify/functions/bofip)
// Transmet q, domaine, limit depuis la query string et injecte la clé API.

const UPSTREAM = "https://api.bofip.dev/v1/search";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (request, context) => {
  // Préflight CORS
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Méthode non autorisée" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.BOFIP_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Clé API BOFIP_API_KEY non configurée" }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // Construction de l'URL amont en ne transmettant que les paramètres attendus
  const incoming = new URL(request.url);
  const upstreamUrl = new URL(UPSTREAM);
  for (const param of ["q", "domaine", "limit"]) {
    const value = incoming.searchParams.get(param);
    if (value !== null) {
      upstreamUrl.searchParams.set(param, value);
    }
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    });

    const body = await upstreamRes.text();
    return new Response(body, {
      status: upstreamRes.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":
          upstreamRes.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Échec de la requête amont", detail: String(err) }),
      {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
};
