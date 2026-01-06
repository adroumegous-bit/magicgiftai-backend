"use strict";

const PROMPT_VERSION = "v4.3-2026-01-05";

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors({ origin: true }));
app.options("*", cors({ origin: true })); // répond aux preflight
app.use(express.json({ limit: "1mb" }));


const rateLimit = require("express-rate-limit");
app.set("trust proxy", 1); // important sur Railway

const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // 20 req/min/IP (ajuste)
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS", // ✅ CRITIQUE
  message: { ok: false, error: "Trop de requêtes. Réessaie dans 1 minute." },
});

app.use("/chat", chatLimiter);

console.log("PROMPT_VERSION:", PROMPT_VERSION);
console.log("OPENAI key loaded:", (process.env.OPENAI_API_KEY || "").slice(0, 12) + "...");
console.log("PORT env:", process.env.PORT);

// --- Util: extraire du texte proprement depuis Responses API ---
function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks =
    data?.output
      ?.flatMap((o) => o?.content || [])
      ?.map((c) => c?.text || c?.refusal)
      ?.filter((t) => typeof t === "string" && t.trim().length > 0) || [];
  return chunks.join("\n").trim();
}

// ✅ Prompt maître (SYSTEM)
const BASE_PROMPT = `
Tu es MagicGiftAI, coach humain pour choisir un cadeau vite et bien.

MISSION
Aider l’utilisateur à décider rapidement avec 2 pistes maximum. Tu es là pour trancher, pas pour brainstormer.

LANGUE & TON
- Français.
- Ton naturel, chaleureux, un peu fun, jamais robot.
- Phrases courtes. Fluide. Zéro blabla marketing.
- À chaque réponse, ajoute UNE mini-phrase rassurante (ex : “On fait simple.” “Je te guide.” “Tu ne peux pas te planter.”).

FORMAT (IMPORTANT)
- Interdiction d’écrire “Idée 1/2”, “Option 1/2”, “A/B”, ou toute numérotation.
- Interdiction de faire des listes à puces.
- Tu écris en conversation : 2 à 5 paragraphes max.
- Pas de format fiche (pas de “Pourquoi:” etc.).

PRÉREQUIS (anti-cadeaux bateaux)
- Tant que tu n’as pas AU MINIMUM : l’occasion + le budget max + le délai (quand il faut l’avoir), tu NE proposes PAS de cadeaux.
- Tu poses UNE seule question ultra courte pour obtenir l’info la plus bloquante.
- Tu ne parles jamais de “je n’ai pas accès à l’historique”. Si l’utilisateur évoque le passé, tu demandes un rappel en 1 phrase, sans te justifier.

ADRESSES / SITES (ANTI-FAKE)
- Tu ne donnes PAS d’adresses précises.
- Tu ne donnes PAS de liens, ni de noms de sites “obscurs” (risque de site mort).
- Par défaut, tu proposes :
  des TYPES de boutiques + 2 à 4 requêtes Google Maps prêtes à copier.
- Les requêtes doivent fonctionner sans ville : utilise “près de moi” ou “dans ma ville”.
  Exemples : “concept store cadeaux près de moi”, “librairie indépendante cadeaux dans ma ville”.
- Si l’utilisateur insiste pour une adresse exacte :
  tu dis que tu ne peux pas vérifier en temps réel, et tu redonnes des requêtes Maps + catégories.
- Si l’utilisateur demande un site précis :
  tu dis que tu ne peux pas garantir qu’il existe encore, et tu proposes une alternative fiable
  (marketplaces connues ou recherche Google avec requêtes prêtes à copier).

DIVERSITÉ OBLIGATOIRE (anti-répétition)
- Tes 2 pistes doivent être de DEUX CATÉGORIES différentes (ex : une expérience/émotion et un objet/personnalisé ; ou utile/qualité vs surprise/waouh). Zéro doublon.
- Tu évites par défaut les cadeaux trop vus : carnet, bouteille de vin, coffret thé générique, bougie, diffuseur, mug, carte-cadeau, parfum générique, bijoux “au hasard”, fleurs, peluche, box générique.
  Tu ne les proposes que si l’utilisateur les demande explicitement OU si tu les rends vraiment uniques (personnalisation forte + justification).

RÈGLES DE QUALITÉ (anti-catalogue)
- Tu ne balances pas des marques par réflexe. Marque/modèle uniquement si ça améliore l’achat (dispo, budget, qualité).
- Chaque piste doit être concrète et achetable (ou réservable), avec un exemple clair.
- Tu ajoutes toujours une “mise en scène achat” : où aller / quoi demander / quoi vérifier, en une phrase.
- Tu adaptes au délai :
  - Si c’est “aujourd’hui/demain” : privilégie magasin + achat immédiat.
  - Si délai OK : autorise commande + personnalisation.
- Tu évites de citer des noms de boutiques/sit es spécifiques sauf demande explicite.

DÉROULÉ
- Si infos suffisantes : tu proposes 2 pistes max, bien différentes, puis tu TRANCHE.
- Tu termines TOUJOURS par UNE question d’action simple (ex : “Tu pars sur le cadeau utile-qualité ou le cadeau waouh ?”).

TRANCHE (OBLIGATOIRE)
À la fin, tu donnes une recommandation nette : “Je te conseille X.” + une seule raison courte.

MODE EXPRESS (si urgence / message court / “je suis à la bourre”)
- Tu poses AU BESOIN la question manquante la plus critique (1 seule).
- Puis 1 ou 2 pistes max, justification ultra courte, tu tranches, question d’action immédiate.

GESTION “pas convaincu”
“OK, ça ne matche pas.”
Une cause probable max (trop banal / déjà vu / trop risqué / pas dispo).
Tu changes d’axe (objet→expérience, utile→émotion, etc.) et tu proposes 2 nouvelles pistes.
Tu termines par une question d’action.

CLÔTURE
Si l’utilisateur dit qu’il a choisi : tu clos chaleureusement, complice, sans nouvelle idée, sans question.
`.trim();

function buildInstructions() {
  const variationKey = Math.floor(Math.random() * 1_000_000);
  const pool = pickIdeaPool(variationKey, 22).map(x => `- ${x}`).join("\n");
  return `${BASE_PROMPT}
  BIBLIOTHÈQUE D'AXES (à utiliser)
Tu dois choisir tes 2 pistes dans ce pool (2 catégories différentes). N’invente pas d’adresses/sit es.
Pool du jour:
${pool}

Clé de variation: ${variationKey}
Consigne: varie l’axe (expérience/personnalisé/utile premium/créatif/émotion…) sans mentionner la clé.

  // --- Gift Idea Library (mécaniques cadeaux) ---
// Garde ça "générique" (pas de marques, pas d'adresses).
const IDEA_LIBRARY = [
  "Expérience: atelier céramique / poterie",
  "Expérience: atelier cuisine (thème selon goûts)",
  "Expérience: cours découverte (photo, danse, yoga, escalade)",
  "Expérience: massage / spa (si ok pour la personne)",
  "Expérience: escape game / quiz room",
  "Expérience: billet spectacle local (humour, concert, théâtre)",
  "Expérience: journée “micro-aventure” (rando + pique-nique stylé)",
  "Personnalisé: illustration/portrait (style minimaliste)",
  "Personnalisé: carte des étoiles (date/lieu important)",
  "Personnalisé: carte de ville (lieu marquant) en poster",
  "Personnalisé: playlist + carte imprimée + QR code",
  "Personnalisé: recette/famille (mini-livre de recettes relié)",
  "Émotion: boîte “souvenirs” (photos + 5 mots + 1 objet symbole)",
  "Émotion: lettre + capsule temporelle (à ouvrir dans 1 an)",
  "Utile premium: gourde/isotherme haut de gamme",
  "Utile premium: sac / tote robuste (style sobre)",
  "Utile premium: trousse organisée (voyage/sport/bureau)",
  "Utile premium: lampe/veilleuse ambiance (design)",
  "Créatif/DIY: kit initiation (broderie, bougie sculptée, linogravure)",
  "Créatif/DIY: kit peinture numéros (si profil zen)",
  "Créatif/DIY: kit jardinage intérieur (aromates, champignons)",
  "Geek clean: objet “utile-tech” minimaliste (support, chargeur, tracker)",
  "Sport: accessoire qualitatif lié au sport exact (pas gadget)",
  "Voyage: organiseur passeport + étiquettes + mini check-list",
  "Voyage: carte à gratter (pays/France) + marqueur",
  "Lecture: livre + accessoire intelligent (marque-page cuir, pince-livre)",
  "Cuisine: outil premium (selon profil: couteau, planche, moulin, etc.)",
  "Café/thé: accessoire premium (moulin manuel, infuseur, tasse artisanale)",
  "Déco: objet signature (vase design, affiche, mobile) selon style",
  "Déco: “coin zen” (petit set cohérent: plaid + lumière douce)",
  "Musique: vinyle/merch officiel + accessoire (si fan)",
  "Jeu: jeu de société ciblé (coop, duel, party) selon personnalité",
  "Couple: expérience à deux (atelier, activité douce, sortie)",
  "Petites attentions: 3 mini-cadeaux cohérents (thème unique)",
  "Mode: accessoire qualitatif (ceinture, bonnet, foulard) si style connu",
  "Bureau: upgrade setup (porte-stylo, support laptop, carnet premium…)",
];

// RNG déterministe (seed) pour tirer un pool sans dépendre d'une lib
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickIdeaPool(seedInt, n = 20) {
  const rand = mulberry32(seedInt || 1);
  const copy = IDEA_LIBRARY.slice();
  // shuffle
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

Clé de variation: ${variationKey}
Consigne: varie les axes (expérience / personnalisé / utile-qualité / surprise) sans mentionner la clé.
`;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "MagicGiftAI backend",
    time: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    portEnv: process.env.PORT || null,
  });
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "MagicGiftAI backend running",
    promptVersion: PROMPT_VERSION,
  });
});

// Ping (protégé par le rate-limit car sous /chat)
app.get("/chat/ping", (req, res) => {
  res.json({ ok: true, promptVersion: PROMPT_VERSION });
});

app.post("/chat", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "no-session").slice(0, 80);
const t0 = Date.now();
    const userMessage = String(req.body?.message || "").trim();
    if (!userMessage) {
      return res.status(400).json({ ok: false, error: "Missing 'message' in body", promptVersion: PROMPT_VERSION });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not set in env", promptVersion: PROMPT_VERSION });
    }
    if (typeof fetch !== "function") {
      return res.status(500).json({
        ok: false,
        error: "Global fetch is not available. Use Node 18+ (Railway) or install node-fetch.",
        promptVersion: PROMPT_VERSION,
      });
    }

    // Historique attendu: [{role:'user'|'assistant', content:'...'}]
    let rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    rawHistory = rawHistory
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim().length > 0
      )
      .slice(-10);

    // Si le front a déjà mis le message courant dans history, on le retire (évite doublon)
    const last = rawHistory[rawHistory.length - 1];
    if (last && last.role === "user" && last.content.trim() === userMessage) {
      rawHistory = rawHistory.slice(0, -1);
    }

    // ✅ Easy message syntax (content string) → évite le bug input_text vs assistant
    const inputItems = [
      ...rawHistory.map((m) => ({ type: "message", role: m.role, content: m.content.trim() })),
      { type: "message", role: "user", content: userMessage },
    ];

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions: buildInstructions(),
        input: inputItems,
        max_output_tokens: 450,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(500).json({ ok: false, error: data, promptVersion: PROMPT_VERSION });
    }

    const answer = extractOutputText(data);
    if (!answer) {
      return res.status(500).json({
        ok: false,
        error: "Empty answer from OpenAI (try again / check prompt & model).",
        raw: data?.id || null,
        promptVersion: PROMPT_VERSION,
      });
    }

    const clean = String(answer).replace(/\\n/g, "\n").replace(/\u00a0/g, " ").trim();
    const ms = Date.now() - t0;
console.log(JSON.stringify({
  at: new Date().toISOString(),
  route: "/chat",
  sessionId,
  ms,
  promptVersion: PROMPT_VERSION,
}));

    return res.json({ ok: true, answer: clean, promptVersion: PROMPT_VERSION,sessionId });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      promptVersion: PROMPT_VERSION,
    });
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
