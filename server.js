// Serveur Express : proxie GET /search vers l'API BOFiP en injectant la clé API.
// Transmet q, domaine, limit depuis la query string.

// Charge .env s'il existe ; ne plante pas s'il est absent (dotenv ne lève pas,
// mais on garde un try/catch par sécurité).
try {
  require("dotenv").config();
} catch (err) {
  console.warn("Impossible de charger .env :", err.message);
}

const path = require("path");
const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;
const UPSTREAM = "https://api.bofip.dev/v1/search";

// CORS pour toutes les routes
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Sert les fichiers statiques du dossier racine
app.use(express.static(__dirname));

// Page d'accueil
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/search", async (req, res) => {
  const apiKey = process.env.BOFIP_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "Clé API BOFIP_API_KEY non configurée" });
  }

  // On ne transmet que les paramètres attendus
  const upstreamUrl = new URL(UPSTREAM);
  for (const param of ["q", "domaine", "limit"]) {
    const value = req.query[param];
    if (value !== undefined && value !== null) {
      upstreamUrl.searchParams.set(param, value);
    }
  }

  try {
    console.log("Appel vers:", upstreamUrl.toString(), "avec clé:", apiKey.substring(0, 8));
    const upstreamRes = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    });

    const body = await upstreamRes.text();
    res
      .status(upstreamRes.status)
      .type(upstreamRes.headers.get("Content-Type") || "application/json")
      .send(body);
  } catch (err) {
    res.status(502).json({
      error: "Échec de la requête amont",
      detail: String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur BOFiP à l'écoute sur le port ${PORT}`);
  console.log("BOFIP_API_KEY présente au démarrage:", !!process.env.BOFIP_API_KEY);
});
