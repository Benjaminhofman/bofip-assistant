// Serveur Express : proxie GET /search vers l'API BOFiP en injectant la clé API.
// Transmet q, domaine, limit depuis la query string.

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

// --- Config ---
const MODELE_SYNTHESE        = "gpt-4o";
const MAX_BOI_TEXTE_COMPLET  = 3;
const MAX_RESULTATS_LISTE    = 8;   // résultats renvoyés par /chat (liste)
const TRONCATURE_BOI         = 8000;
const TIMEOUT_OPENAI         = 30000;

// --- Caches en mémoire avec TTL 24 h ---
const TTL = 24 * 60 * 60 * 1000;

const cacheBoi        = new Map(); // boi_id → { data, expireAt }
const cacheHistorique = new Map(); // boi_id → { data, expireAt }

const BOFIP_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

async function getBoiComplet(id) {
  const now = Date.now();
  const cached = cacheBoi.get(id);
  if (cached && cached.expireAt > now) return cached.data;

  const apiKey = process.env.BOFIP_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(`https://api.bofip.dev/v1/boi/${encodeURIComponent(id)}`, {
      headers: { ...BOFIP_HEADERS, "X-API-Key": apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    cacheBoi.set(id, { data, expireAt: now + TTL });
    return data;
  } catch {
    return null;
  }
}

async function getHistoriqueBoi(id) {
  const now = Date.now();
  const cached = cacheHistorique.get(id);
  if (cached && cached.expireAt > now) return cached.data;

  const apiKey = process.env.BOFIP_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(`https://api.bofip.dev/v1/boi/${encodeURIComponent(id)}/historique`, {
      headers: { ...BOFIP_HEADERS, "X-API-Key": apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    cacheHistorique.set(id, { data, expireAt: now + TTL });
    return data;
  } catch {
    return null;
  }
}

// CORS pour toutes les routes
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/search", async (req, res) => {
  const apiKey = process.env.BOFIP_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Clé API BOFIP_API_KEY non configurée" });
  }

  const upstreamUrl = new URL(UPSTREAM);
  for (const param of ["q", "domaine", "limit"]) {
    const value = req.query[param];
    if (value !== undefined && value !== null) upstreamUrl.searchParams.set(param, value);
  }

  try {
    console.log("Appel vers:", upstreamUrl.toString(), "avec clé:", apiKey.substring(0, 8));
    const upstreamRes = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    const body = await upstreamRes.text();
    res.status(upstreamRes.status)
       .type(upstreamRes.headers.get("Content-Type") || "application/json")
       .send(body);
  } catch (err) {
    res.status(502).json({ error: "Échec de la requête amont", detail: String(err) });
  }
});

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

async function openaiCall(openaiKey, body) {
  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_OPENAI),
    });
  } catch (err) {
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    throw new Error(
      isTimeout ? `Délai OpenAI dépassé (${TIMEOUT_OPENAI / 1000}s)` : `Réseau OpenAI : ${err.message}`
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
  return data;
}

const SYSTEM_SYNTHESE = `Tu es un assistant de recherche en doctrine fiscale française destiné à des experts-comptables, juristes et fiscalistes. Tu t'appuies EXCLUSIVEMENT sur le texte BOFiP fourni ci-dessous. Tu ne mobilises AUCUNE connaissance externe.

NATURE DE LA SOURCE
- Tu commentes la DOCTRINE ADMINISTRATIVE (BOFiP), opposable à l'administration mais qui ne se substitue ni à la loi (CGI) ni à la jurisprudence. Qualifie tes énoncés (« la doctrine administrative précise que… »). Ne présente jamais un commentaire BOFiP comme une règle légale absolue.

CITATION
- Cite SYSTÉMATIQUEMENT chaque affirmation. Quand le numéro de paragraphe est identifiable dans le texte fourni, cite [BOI-XXX-XXX-XX § N] ; sinon [BOI-XXX-XXX-XX]. Aucune affirmation sans source.
- Tu ne peux citer QUE le BOI listé comme disponible dans le contexte. N'invente jamais d'identifiant ni de paragraphe.
- Quand la doctrine renvoie à un article du CGI, mentionne-le (« sur le fondement de l'article X du CGI ») en précisant que la base légale est à vérifier dans le texte légal, hors périmètre de cet outil.

VERSION ET ACTUALITÉ
- Tiens compte de la note de version fournie. Signale si le BOI est rapporté, abrogé, ou dispose d'une version plus récente. Précise la date de la version analysée.

RIGUEUR PROFESSIONNELLE
- Structure la synthèse (conditions, régime, exceptions). Distingue conditions cumulatives et alternatives.
- Signale les angles pour lesquels le texte fourni n'apporte pas de réponse.
- Si une information n'est pas dans le texte fourni, écris-le. Aucune extrapolation.
- Reste strictement factuel et neutre : synthèse doctrinale, jamais de conseil personnalisé.`;

function postTraiterReponse(reponse, bois_synthese) {
  const index = new Map();
  for (const b of bois_synthese) {
    if (b.boi_id) index.set(b.boi_id, b);
  }

  const regexBoi = /\[BOI-[A-Z0-9][A-Z0-9-]*(?:\s+§\s*[\d.]+)?\]/g;
  const rawMatches = [...reponse.matchAll(regexBoi)].map((m) => {
    const inner = m[0].slice(1, -1);
    const paraMatch = inner.match(/^(BOI-[A-Z0-9-]+)\s+§\s*([\d.]+)$/);
    if (paraMatch) return { boi_id: paraMatch[1], paragraphe: `§ ${paraMatch[2]}` };
    return { boi_id: inner.trim(), paragraphe: null };
  });

  const seenCites   = new Map();
  const seenIgnores = new Set();
  const boi_ignores = [];

  for (const { boi_id, paragraphe } of rawMatches) {
    if (index.has(boi_id)) {
      if (!seenCites.has(boi_id)) {
        const item = index.get(boi_id);
        seenCites.set(boi_id, {
          boi_id,
          titre: item.titre || "",
          url_bofip: item.url_bofip || null,
          date_publication: item.date_publication || null,
          note_version: item.note_version || null,
          paragraphe,
        });
      }
    } else if (!seenIgnores.has(boi_id)) {
      seenIgnores.add(boi_id);
      boi_ignores.push({ boi_id, paragraphe });
    }
  }

  const regexCgi = /articles?\s+(\d[\w\s-]*?)\s+du\s+CGI/gi;
  const articles_cgi = [
    ...new Set([...reponse.matchAll(regexCgi)].map((m) => m[1].trim())),
  ];

  return { boi_cites: [...seenCites.values()], boi_ignores, articles_cgi };
}

function buildNoteVersion(boiId, datePublication, historique) {
  const versions = !historique
    ? []
    : Array.isArray(historique)
    ? historique
    : historique.versions || historique.historique || [];

  if (!versions.length) return `${boiId} : historique non disponible.`;

  const sorted = versions.slice().sort((a, b) => {
    const da = new Date(a.date_debut || a.date_publication || a.date || 0);
    const db = new Date(b.date_debut || b.date_publication || b.date || 0);
    return db - da;
  });

  const latest        = sorted[0];
  const latestDateRaw = latest.date_debut || latest.date_publication || latest.date || null;
  const latestDate    = latestDateRaw ? new Date(latestDateRaw) : null;
  const injectedDate  = datePublication ? new Date(datePublication) : null;

  const statut = latest.statut
    ? latest.statut
    : latest.date_fin
    ? "rapporté"
    : "en vigueur";

  const plusRecente = latestDate && injectedDate && latestDate > injectedDate;

  let note = `${boiId} : statut "${statut}"`;
  if (plusRecente) {
    note += `, version plus récente disponible (${latestDateRaw}) — la version injectée peut être antérieure`;
  } else {
    note += ", version courante injectée";
  }
  return note + ".";
}

async function searchBofip(q, domaine, limit) {
  const apiKey = process.env.BOFIP_API_KEY;
  if (!apiKey || !q) return [];
  try {
    const url = new URL(UPSTREAM);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(limit));
    if (domaine) url.searchParams.set("domaine", domaine);
    const res = await fetch(url, {
      headers: { ...BOFIP_HEADERS, "X-API-Key": apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data.results || data.hits || data.data || [];
  } catch {
    return [];
  }
}

// ── POST /chat — renvoie la liste des références sans synthèse ─────────
app.post("/chat", async (req, res) => {
  const { messages, filtre_domaine } = req.body;
  if (!messages || !messages.length) {
    return res.status(400).json({ error: "messages requis" });
  }

  // Requête de recherche : deux derniers messages utilisateur (contexte glissant)
  const userMsgs   = messages.filter((m) => m.role === "user");
  const searchQuery = userMsgs.slice(-2).map((m) => m.content).join(" ").slice(0, 400);

  const domaine = filtre_domaine || null;
  console.log(`[chat] requete:"${searchQuery.slice(0, 80)}" domaine:${domaine || "null"}`);

  const rawItems = await searchBofip(searchQuery, domaine, MAX_RESULTATS_LISTE + 5);

  rawItems.sort((a, b) => {
    const da = a.date_publication ? new Date(a.date_publication) : new Date(0);
    const db = b.date_publication ? new Date(b.date_publication) : new Date(0);
    return db - da;
  });

  const resultats = rawItems.slice(0, MAX_RESULTATS_LISTE).map((item) => ({
    boi_id:            item.boi_id,
    titre:             item.titre,
    extrait:           item.extrait,
    url_bofip:         item.url_bofip,
    date_publication:  item.date_publication,
    domaine:           item.domaine || null,
  }));

  console.log(`[chat] ${resultats.length} résultats`);
  return res.json({ resultats, requete_utilisee: searchQuery });
});

// ── POST /synthese-boi — synthèse d'un BOI unique à la demande ────────
app.post("/synthese-boi", async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(500).json({ error: "Clé OPENAI_API_KEY non configurée" });
  }

  const { boi_id, question_contexte } = req.body;
  if (!boi_id) {
    return res.status(400).json({ error: "boi_id requis" });
  }

  try {
    console.log(`[synthese-boi] ${boi_id}`);

    const [complet, historique] = await Promise.all([
      getBoiComplet(boi_id),
      getHistoriqueBoi(boi_id),
    ]);

    if (!complet) {
      return res.status(404).json({ error: `BOI ${boi_id} non trouvé ou inaccessible` });
    }

    const raw            = complet.texte || complet.contenu || complet.text || complet.body || null;
    const texte          = raw ? String(raw).slice(0, TRONCATURE_BOI) : null;
    const datePublication = complet.date_publication || null;
    const titre          = complet.titre || boi_id;
    const url_bofip      = complet.url_bofip || null;
    const note_version   = buildNoteVersion(boi_id, datePublication, historique);

    if (!texte) {
      return res.status(422).json({ error: `Texte de ${boi_id} non disponible` });
    }

    // Contexte limité à ce seul BOI
    let contexte  = `TEXTE BOFiP — [${boi_id}] — ${titre}\n`;
    if (datePublication) contexte += `Date de publication : ${datePublication}\n`;
    contexte += `Note de version : ${note_version}\n`;
    contexte += `\n---\n${texte}\n---\n\n`;
    contexte += `BOI DISPONIBLE DANS CE CONTEXTE (liste exhaustive — ne citer que celui-ci)\n`;
    contexte += `${boi_id}`;

    const userContent = question_contexte
      ? `${contexte}\n\n---\n\nDemande : ${question_contexte}\n\nCite uniquement [${boi_id}] ou [${boi_id} § N] (avec le numéro exact de paragraphe quand il est lisible dans le texte).`
      : `${contexte}\n\n---\n\nFais une synthèse structurée de ce document.`;

    const data = await openaiCall(openaiKey, {
      model: MODELE_SYNTHESE,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_SYNTHESE },
        { role: "user",   content: userContent },
      ],
    });

    const synthese = data.choices[0].message.content;

    const boiItem = {
      boi_id,
      titre,
      url_bofip,
      date_publication: datePublication,
      note_version,
      texte_complet: texte,
      extrait: null,
    };
    const { boi_cites, boi_ignores, articles_cgi } = postTraiterReponse(synthese, [boiItem]);

    console.log(`[synthese-boi] ${boi_id} — ${boi_cites.length} citations | ${boi_ignores.length} non valides`);

    return res.json({
      synthese,
      boi_id,
      titre,
      url_bofip,
      date_publication: datePublication,
      note_version,
      articles_cgi,
      boi_cites,
      boi_ignores,
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
});

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

app.post("/export", (req, res) => {
  const { messages = [], boi_cites_cumules = [] } = req.body;

  const now = new Date();
  const dateLocale = now.toLocaleDateString("fr-FR", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris",
  });
  const heureLocale = now.toLocaleTimeString("fr-FR", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris",
  });
  const horodatage = `${dateLocale} à ${heureLocale}`;

  const conversation = messages.map((m) => {
    const role = m.role === "user" ? "Vous" : "Assistant";
    const cls  = m.role === "user" ? "user" : "assistant";
    return `<div class="message ${cls}"><span class="role">${role}</span><div class="content">${escapeHtml(m.content).replace(/\n/g, "<br>")}</div></div>`;
  }).join("\n");

  const sources = boi_cites_cumules.length
    ? boi_cites_cumules.map((b) => {
        const href  = escapeHtml(b.url_bofip || "#");
        const id    = escapeHtml(b.boi_id || "");
        const titre = escapeHtml(b.titre || "");
        const date  = b.date_publication ? ` — ${escapeHtml(b.date_publication)}` : "";
        const para  = b.paragraphe ? ` <span class="para">${escapeHtml(b.paragraphe)}</span>` : "";
        const note  = b.note_version ? `<br><span class="note-version">${escapeHtml(b.note_version)}</span>` : "";
        return `<li><a href="${href}" target="_blank" rel="noopener noreferrer">${id}</a>${para} — ${titre}${date}${note}</li>`;
      }).join("\n")
    : "<li><em>Aucune source consultée.</em></li>";

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Consultation BOFiP — ${escapeHtml(dateLocale)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; margin-top: 36px; }
  .mention { color: #6b7280; font-size: 0.85rem; margin: 0 0 32px; }
  .message { margin-bottom: 20px; }
  .role { font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; display: block; margin-bottom: 4px; }
  .message.user .content { background: #f3f4f6; border-radius: 8px; padding: 12px 16px; }
  .message.assistant .content { border-left: 3px solid #1a3a2e; padding-left: 14px; }
  ul.sources { padding-left: 18px; }
  ul.sources li { margin-bottom: 10px; font-size: 0.9rem; }
  .para { font-family: monospace; color: #1a3a2e; }
  .note-version { color: #6b7280; font-size: 0.8rem; }
  footer { margin-top: 48px; border-top: 1px solid #e5e7eb; padding-top: 12px; color: #6b7280; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>BOFiP Assistant — Consultation du ${escapeHtml(horodatage)}</h1>
<p class="mention">Doctrine consultée le ${escapeHtml(dateLocale)} — BOFiP, Etalab 2.0</p>

<h2>Questions posées</h2>
${conversation || "<p><em>Aucun message.</em></p>"}

<h2>Sources consultées et synthétisées</h2>
<ul class="sources">
${sources}
</ul>

<footer>Doctrine consultée le ${escapeHtml(dateLocale)} — BOFiP, Etalab 2.0</footer>
</body>
</html>`;

  res.type("text/html; charset=utf-8").send(html);
});

app.listen(PORT, () => {
  console.log(`Serveur BOFiP à l'écoute sur le port ${PORT}`);
  console.log("BOFIP_API_KEY présente au démarrage:", !!process.env.BOFIP_API_KEY);
});
