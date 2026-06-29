// Proxy GET vers l'API BOFiP (endpoint: /.netlify/functions/bofip)
// Transmet q, domaine, limit depuis la query string et injecte la clé API.

const fetch = require("node-fetch");

const UPSTREAM = "https://api.bofip.dev/v1/search";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async function (event) {

  // Préflight CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Méthode non autorisée" }),
    };
  }

  const apiKey = process.env.BOFIP_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Clé API BOFIP_API_KEY non configurée" }),
    };
  }

  // Construction de l'URL amont en ne transmettant que les paramètres attendus
  const params = event.queryStringParameters || {};
  const upstreamUrl = new URL(UPSTREAM);
  for (const param of ["q", "domaine", "limit"]) {
    const value = params[param];
    if (value !== undefined && value !== null) {
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
    return {
      statusCode: upstreamRes.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":
          upstreamRes.headers.get("Content-Type") || "application/json",
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Échec de la requête amont",
        detail: String(err),
      }),
    };
  }
};
