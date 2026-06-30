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

// --- Config ---
const MODELE_CLASSIFICATION = "gpt-4o-mini";
const MODELE_SYNTHESE = "gpt-4o";
const MAX_BOI_TEXTE_COMPLET = 3;
const MAX_BOI_EXTRAITS = 5;
const MAX_BOI_CADRAGE = 6;
const TRONCATURE_BOI = 8000;
const TIMEOUT_OPENAI = 30000;

// --- Caches en mémoire avec TTL 24 h ---
const TTL = 24 * 60 * 60 * 1000;

const cacheBoi = new Map();       // boi_id → { data, expireAt }
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
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

app.post("/synthese", async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(500).json({ error: "Clé OPENAI_API_KEY non configurée" });
  }

  const { query, items } = req.body;
  if (!items || !items.length) {
    return res.status(400).json({ error: "Aucun résultat à synthétiser" });
  }

  const context = items.slice(0, 10).map((item, i) =>
    `[${i + 1}] ${item.boi_id} — ${item.titre}\n${item.extrait || ""}`
  ).join("\n\n");

  const prompt = `Tu es un assistant fiscal expert. L'utilisateur a recherché : "${query}".

Voici les extraits de ${items.length} documents BOFiP pertinents :

${context}

Rédige une synthèse fiscale claire et structurée en français, en quelques phrases concises, qui répond directement à la question de l'utilisateur. Cite explicitement les références BOI (ex. : BOI-TVA-BASE-10-10) utilisées. Ne répète pas les extraits mot pour mot.`;

  try {
    const openaiRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json({ error: data.error?.message || "Erreur OpenAI" });
    }

    const synthese = data.choices?.[0]?.message?.content || "";
    res.json({ synthese });
  } catch (err) {
    res.status(502).json({ error: "Échec de la requête OpenAI", detail: String(err) });
  }
});

const SYSTEM_SYNTHESE = `Tu es un assistant de recherche en doctrine fiscale française destiné à des experts-comptables, juristes et fiscalistes. Tu t'appuies EXCLUSIVEMENT sur les textes et extraits BOFiP fournis ci-dessous. Tu ne mobilises AUCUNE connaissance externe.

NATURE DE LA SOURCE
- Tu commentes la DOCTRINE ADMINISTRATIVE (BOFiP), opposable à l'administration mais qui ne se substitue ni à la loi (CGI) ni à la jurisprudence. Qualifie tes énoncés (« la doctrine administrative précise que… »). Ne présente jamais un commentaire BOFiP comme une règle légale absolue.

CITATION
- Cite SYSTÉMATIQUEMENT chaque affirmation. Quand le numéro de paragraphe est identifiable dans le texte fourni, cite [BOI-XXX-XXX-XX § N] ; sinon [BOI-XXX-XXX-XX]. Aucune affirmation sans source.
- Tu ne peux citer QUE les BOI listés comme disponibles dans le contexte. N'invente jamais d'identifiant ni de paragraphe.
- Quand la doctrine renvoie à un article du CGI, mentionne-le (« sur le fondement de l'article X du CGI ») en précisant que la base légale est à vérifier dans le texte légal, hors périmètre de cet outil.

VERSION ET ACTUALITÉ
- Tiens compte des notes de version fournies. Signale tout BOI rapporté, abrogé, ou disposant d'une version plus récente. Précise la date de la version analysée.

RIGUEUR PROFESSIONNELLE
- Structure la synthèse (conditions, régime, exceptions). Distingue conditions cumulatives et alternatives.
- Signale (a) les points où les BOI se complètent ou se CONTREDISENT ; (b) les angles pour lesquels AUCUN texte fourni n'apporte de réponse.
- Si une information n'est pas dans les textes fournis, écris-le. Aucune extrapolation.
- Reste strictement factuel et neutre : synthèse doctrinale, jamais de conseil personnalisé.`;

const SYSTEM_CADRAGE = `Tu es un assistant de recherche en doctrine fiscale française pour un professionnel du chiffre et du droit. L'utilisateur ouvre un nouveau sujet. On te fournit ci-dessous des EXTRAITS de la doctrine BOFiP réellement trouvée sur ce sujet.
- Appuie-toi sur ces extraits pour identifier les VRAIES distinctions doctrinales qui font varier la réponse (régimes, conditions cumulatives ou alternatives, seuils, cas particuliers, options) telles qu'elles apparaissent dans la doctrine actuelle.
- Pose exactement TROIS questions de clarification numérotées (ou QUATRE si le sujet est d'un niveau expert le justifiant), ancrées dans ces distinctions réelles. Rien d'autre : pas d'ébauche de réponse, pas de synthèse, pas encore de citation.
- Formule des questions de niveau professionnel, précises.
- Si les extraits fournis sont vides ou hors sujet, pose des questions de cadrage fondées sur les familles de distinctions usuelles (nature et régime du contribuable, conditions, cas particulier, dispositif visé) et indique que la doctrine sera recherchée une fois la demande précisée.
- Termine en invitant l'utilisateur à répondre.`;

const SYSTEM_CLASSIFICATION = `Tu es un routeur pour un assistant de doctrine fiscale destiné à des professionnels (experts-comptables, juristes, fiscalistes). À partir de l'historique, réponds UNIQUEMENT en JSON valide.
- phase='cadrage' si l'utilisateur ouvre un NOUVEAU sujet fiscal pas encore clarifié (ou premier message).
- phase='synthese' s'il répond aux questions de clarification OU pose un suivi sur un sujet déjà traité.
- niveau_expert=true si le sujet est techniquement pointu (démembrement, intégration fiscale, prix de transfert, régimes optionnels, dispositifs de faveur) justifiant une précision supplémentaire.
- requete_recherche : mots-clés doctrinaux pertinents dans TOUS les cas (en cadrage, déduis-les du sujet brut ; en synthèse, du sujet + précisions). Jamais null si un sujet fiscal est identifiable.
- domaine : code domaine fiscal (IS, IR, TVA, BIC, BNC, RPPM, ENR, PAT) si clairement identifiable, sinon null.`;

function postTraiterReponse(reponse, bois_synthese) {
  // Index boi_id → item complet pour lookup rapide
  const index = new Map();
  for (const b of bois_synthese) {
    if (b.boi_id) index.set(b.boi_id, b);
  }

  // Extrait toutes les citations [BOI-...] avec paragraphe optionnel [BOI-... § N]
  const regexBoi = /\[BOI-[A-Z0-9][A-Z0-9-]*(?:\s+§\s*[\d.]+)?\]/g;
  const rawMatches = [...reponse.matchAll(regexBoi)].map((m) => {
    const inner = m[0].slice(1, -1); // retire [ ]
    const paraMatch = inner.match(/^(BOI-[A-Z0-9-]+)\s+§\s*([\d.]+)$/);
    if (paraMatch) return { boi_id: paraMatch[1], paragraphe: `§ ${paraMatch[2]}` };
    return { boi_id: inner.trim(), paragraphe: null };
  });

  // Sépare cités-présents (dédupliqués) et cités-absents
  const seenCites = new Map(); // boi_id → entrée boi_cites
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

  // Articles CGI : "article 39 du CGI", "article 238 bis du CGI", etc.
  const regexCgi = /articles?\s+(\d[\w\s-]*?)\s+du\s+CGI/gi;
  const articles_cgi = [
    ...new Set([...reponse.matchAll(regexCgi)].map((m) => m[1].trim())),
  ];

  return { boi_cites: [...seenCites.values()], boi_ignores, articles_cgi };
}

function buildContextSynthese(bois, notesVersion) {
  const avecTexte = bois.filter((b) => b.texte_complet);
  const enExtrait = bois.filter((b) => !b.texte_complet && b.extrait);
  const allIds = bois.map((b) => b.boi_id).filter(Boolean);

  let ctx = "TEXTES BOFiP DISPONIBLES DANS LE CONTEXTE\n";
  ctx += "==========================================\n\n";

  if (avecTexte.length) {
    ctx += "── Textes complets ──\n\n";
    for (const b of avecTexte) {
      ctx += `[${b.boi_id}] — ${b.titre}${b.date_publication ? ` (${b.date_publication})` : ""}\n`;
      ctx += `---\n${b.texte_complet}\n---\n\n`;
    }
  }

  if (enExtrait.length) {
    ctx += "── Extraits ──\n\n";
    for (const b of enExtrait) {
      ctx += `[${b.boi_id}] — ${b.titre}${b.date_publication ? ` (${b.date_publication})` : ""}\n`;
      ctx += `${b.extrait}\n\n`;
    }
  }

  if (notesVersion) {
    ctx += "NOTES DE VERSION\n";
    ctx += "================\n";
    ctx += notesVersion + "\n\n";
  }

  ctx += "BOI DISPONIBLES DANS CE CONTEXTE (liste exhaustive — ne citer que ceux-ci)\n";
  ctx += "===========================================================================\n";
  ctx += allIds.join(", ");

  return ctx;
}

function buildNoteVersion(boiId, datePublication, historique) {
  const versions = !historique
    ? []
    : Array.isArray(historique)
    ? historique
    : historique.versions || historique.historique || [];

  if (!versions.length) return `${boiId} : historique non disponible.`;

  // Tri du plus récent au plus ancien
  const sorted = versions.slice().sort((a, b) => {
    const da = new Date(a.date_debut || a.date_publication || a.date || 0);
    const db = new Date(b.date_debut || b.date_publication || b.date || 0);
    return db - da;
  });

  const latest = sorted[0];
  const latestDateRaw = latest.date_debut || latest.date_publication || latest.date || null;
  const latestDate = latestDateRaw ? new Date(latestDateRaw) : null;
  const injectedDate = datePublication ? new Date(datePublication) : null;

  const statut = latest.statut
    ? latest.statut
    : latest.date_fin
    ? "rapporté"
    : "en vigueur";

  const plusRecente =
    latestDate && injectedDate && latestDate > injectedDate;

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

async function classifier(messages, openaiKey) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELE_CLASSIFICATION,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_CLASSIFICATION },
        ...messages,
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_OPENAI),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI ${res.status}`);
  return JSON.parse(data.choices[0].message.content);
}

app.post("/chat", async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(500).json({ error: "Clé OPENAI_API_KEY non configurée" });
  }

  const { messages, paniers_boi, filtre_domaine } = req.body;
  if (!messages || !messages.length) {
    return res.status(400).json({ error: "messages requis" });
  }

  try {
    const classification = await classifier(messages, openaiKey);
    console.log("Classification:", JSON.stringify(classification));

    if (classification.phase === "cadrage") {
      // Recherche BOFiP avec les mots-clés déduits
      const rawItems = await searchBofip(
        classification.requete_recherche,
        classification.domaine || filtre_domaine || null,
        MAX_BOI_CADRAGE + 5
      );

      // Tri par date_publication décroissante
      const sorted = rawItems.slice().sort((a, b) => {
        const da = a.date_publication ? new Date(a.date_publication) : new Date(0);
        const db = b.date_publication ? new Date(b.date_publication) : new Date(0);
        return db - da;
      });

      // Garde MAX_BOI_CADRAGE premiers, extraits seulement
      const boi_pistes = sorted.slice(0, MAX_BOI_CADRAGE).map((item) => ({
        boi_id: item.boi_id,
        titre: item.titre,
        extrait: item.extrait,
        url_bofip: item.url_bofip,
        date_publication: item.date_publication,
      }));

      // Contexte injecté avant la question de l'utilisateur
      const contextCadrage = boi_pistes.length
        ? boi_pistes
            .map((item, i) => `[${i + 1}] ${item.boi_id} — ${item.titre}\n${item.extrait || ""}`)
            .join("\n\n")
        : "";

      const lastMsg = messages[messages.length - 1];
      const augmentedMessages = [
        { role: "system", content: SYSTEM_CADRAGE },
        ...messages.slice(0, -1),
        {
          role: lastMsg.role,
          content: boi_pistes.length
            ? `EXTRAITS BOFiP pertinents :\n\n${contextCadrage}\n\n---\n\nDemande : ${lastMsg.content}`
            : lastMsg.content,
        },
      ];

      const openaiRes = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODELE_SYNTHESE,
          temperature: 0,
          messages: augmentedMessages,
        }),
        signal: AbortSignal.timeout(TIMEOUT_OPENAI),
      });

      const data = await openaiRes.json();
      if (!openaiRes.ok) throw new Error(data.error?.message || `OpenAI ${openaiRes.status}`);

      return res.json({
        reponse: data.choices[0].message.content,
        phase: "cadrage",
        boi_pistes,
      });
    }

    if (classification.phase === "synthese") {
      const domaine = classification.domaine || filtre_domaine || null;

      // 1. Recherche BOFiP
      const rawItems = await searchBofip(
        classification.requete_recherche,
        domaine,
        MAX_BOI_EXTRAITS + 10
      );

      // 2. Tri par date décroissante
      rawItems.sort((a, b) => {
        const da = a.date_publication ? new Date(a.date_publication) : new Date(0);
        const db = b.date_publication ? new Date(b.date_publication) : new Date(0);
        return db - da;
      });

      // 3. MAX_BOI_EXTRAITS premiers + tout boi_id des paniers non déjà présent
      const selection = rawItems.slice(0, MAX_BOI_EXTRAITS);
      const selectionIds = new Set(selection.map((i) => i.boi_id));

      for (const entry of paniers_boi || []) {
        const boiId = typeof entry === "string" ? entry : entry?.boi_id;
        if (boiId && !selectionIds.has(boiId)) {
          const found = rawItems.find((i) => i.boi_id === boiId);
          selection.push(
            found || { boi_id: boiId, titre: "", extrait: "", url_bofip: null, date_publication: null }
          );
          selectionIds.add(boiId);
        }
      }

      // 4. Texte complet + historique pour les MAX_BOI_TEXTE_COMPLET premiers, extrait court pour les autres
      const bois_synthese = await Promise.all(
        selection.map(async (item, i) => {
          if (i < MAX_BOI_TEXTE_COMPLET) {
            const [complet, historique] = await Promise.all([
              getBoiComplet(item.boi_id),
              getHistoriqueBoi(item.boi_id),
            ]);
            const raw = complet &&
              (complet.texte || complet.contenu || complet.text || complet.body || null);
            const datePublication = item.date_publication || complet?.date_publication || null;
            return {
              boi_id: item.boi_id,
              titre: item.titre || complet?.titre || "",
              url_bofip: item.url_bofip || complet?.url_bofip || null,
              date_publication: datePublication,
              texte_complet: raw ? String(raw).slice(0, TRONCATURE_BOI) : null,
              extrait: item.extrait || null,
              note_version: buildNoteVersion(item.boi_id, datePublication, historique),
            };
          }
          return {
            boi_id: item.boi_id,
            titre: item.titre,
            extrait: item.extrait,
            url_bofip: item.url_bofip,
            date_publication: item.date_publication,
            texte_complet: null,
            note_version: null,
          };
        })
      );

      // Rassemble les notes de version des BOI avec texte complet pour le prompt
      const notes_version = bois_synthese
        .filter((b) => b.note_version)
        .map((b) => b.note_version)
        .join("\n");

      // Appel OpenAI synthèse
      const contextSynthese = buildContextSynthese(bois_synthese, notes_version);
      const lastMsg = messages[messages.length - 1];
      const augmentedMessages = [
        { role: "system", content: SYSTEM_SYNTHESE },
        ...messages.slice(0, -1),
        {
          role: lastMsg.role,
          content: `${contextSynthese}\n\n---\n\nDemande : ${lastMsg.content}`,
        },
      ];

      const openaiRes = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODELE_SYNTHESE,
          temperature: 0,
          messages: augmentedMessages,
        }),
        signal: AbortSignal.timeout(TIMEOUT_OPENAI),
      });

      const data = await openaiRes.json();
      if (!openaiRes.ok) throw new Error(data.error?.message || `OpenAI ${openaiRes.status}`);

      const reponse = data.choices[0].message.content;
      const { boi_cites, boi_ignores, articles_cgi } = postTraiterReponse(reponse, bois_synthese);

      return res.json({
        reponse,
        phase: "synthese",
        boi_cites,
        boi_ignores,
        articles_cgi,
      });
    }

    res.json({ classification });
  } catch (err) {
    res.status(502).json({ error: "Erreur classification", detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur BOFiP à l'écoute sur le port ${PORT}`);
  console.log("BOFIP_API_KEY présente au démarrage:", !!process.env.BOFIP_API_KEY);
});
