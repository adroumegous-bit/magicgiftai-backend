"use strict";

const PROMPT_VERSION = "v4.5-2026-01-06";

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

// CORS + preflight
app.use(cors({ origin: true }));
app.options("*", cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// Rate limit (Railway)
app.set("trust proxy", 1);

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  message: { ok: false, error: "Trop de requêtes. Réessaie dans 1 minute." },
});

app.use("/chat", chatLimiter);

// Logs safe
console.log("PROMPT_VERSION:", PROMPT_VERSION);
console.log("OPENAI key loaded:", (process.env.OPENAI_API_KEY || "").slice(0, 12) + "...");
console.log("PORT env:", process.env.PORT);

// --- Util: extraire du texte depuis Responses API ---
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
- Tu évites de citer des noms de boutiques/sites spécifiques sauf demande explicite.

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

/* ==========================
   DIVERSITÉ: AXES IMPOSÉS
   ========================== */

// Banque structurée (tu peux l’agrandir facilement)
const IDEA_BANK = [
  // EXPERIENCE / EMOTION
  { cat: "experience", tags: ["creatif","deco"], urgentOk: true,  min: 25, max: 150, text: "Un atelier céramique/poterie (1 séance découverte)" },
  { cat: "experience", tags: ["food"],          urgentOk: true,  min: 30, max: 180, text: "Un atelier cuisine (thème selon ses goûts)" },
  { cat: "experience", tags: ["sport"],         urgentOk: true,  min: 20, max: 150, text: "Une initiation/coaching (yoga, escalade, running… 1 séance)" },
  { cat: "experience", tags: ["culture"],       urgentOk: true,  min: 15, max: 150, text: "Une sortie spectacle local (humour/théâtre/concert)" },
  { cat: "experience", tags: ["zen"],           urgentOk: true,  min: 40, max: 250, text: "Un massage/spa (si c’est OK pour la personne)" },
  { cat: "experience", tags: ["fun"],           urgentOk: true,  min: 15, max: 100, text: "Un escape game / quiz room à faire à deux ou en groupe" },

  { cat: "emotion",    tags: ["emotion"],       urgentOk: true,  min: 10, max: 90,  text: "Une boîte souvenirs (photos + 5 mots + 1 petit objet symbole)" },
  { cat: "emotion",    tags: ["emotion"],       urgentOk: true,  min: 10, max: 90,  text: "Une lettre + capsule temporelle (à ouvrir dans 6 mois / 1 an)" },
  { cat: "emotion",    tags: ["couple"],        urgentOk: true,  min: 15, max: 90,  text: "Un ‘bon pour’ personnalisé (3 bons utiles/waouh selon la personne)" },

  // PERSONNALISE (souvent pas urgent)
  { cat: "personnalise", tags: ["deco","emotion"], urgentOk: false, min: 25, max: 140, text: "Une illustration/portrait (style minimaliste) à partir d’une photo" },
  { cat: "personnalise", tags: ["deco","emotion"], urgentOk: false, min: 20, max: 120, text: "Une carte des étoiles (date/lieu important) en affiche" },
  { cat: "personnalise", tags: ["deco","emotion"], urgentOk: false, min: 20, max: 140, text: "Une affiche carte de ville (lieu marquant) en poster" },
  { cat: "personnalise", tags: ["food","emotion"], urgentOk: false, min: 15, max: 90,  text: "Un mini-livre de recettes (thème/famille) imprimé et relié" },

  // UTILE / OBJET
  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 15, max: 100, text: "Un organiseur de voyage (passeport/cartes) + étiquettes bagages" },
  { cat: "utile", tags: ["sport"],  urgentOk: true, min: 15, max: 140, text: "Un accessoire sport qualitatif lié à SON sport exact (pas gadget)" },
  { cat: "utile", tags: ["bureau"], urgentOk: true, min: 20, max: 150, text: "Un upgrade bureau (support laptop + rangement clean + petit accessoire)" },
  { cat: "utile", tags: ["zen","deco"], urgentOk: true, min: 20, max: 160, text: "Une lumière d’ambiance design pour une vibe zen (lampe/veilleuse)" },
  { cat: "utile", tags: ["food"],   urgentOk: true, min: 20, max: 200, text: "Un outil cuisine premium ciblé (moulin, planche, couteau… selon profil)" },

  // CREATIF/DIY / DECO
  { cat: "creatif", tags: ["creatif","deco"], urgentOk: true, min: 15, max: 120, text: "Un kit DIY vraiment cool (linogravure, broderie, bougie sculptée…)" },
  { cat: "creatif", tags: ["zen"],            urgentOk: true, min: 15, max: 90,  text: "Un kit activité zen (peinture numéros / aquarelle débutant)" },
  { cat: "creatif", tags: ["deco","nature"],  urgentOk: true, min: 15, max: 120, text: "Un kit jardinage intérieur (aromates, champignons, terrarium simple)" },

  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 220, text: "Un objet déco signature (affiche, mobile, vase) aligné avec son style" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 25, max: 220, text: "Un mini ‘coin zen’ cohérent (plaid + lumière douce + petit élément)" },

  // TECH / CULTURE
  { cat: "tech", tags: ["tech"], urgentOk: true, min: 15, max: 220, text: "Un objet tech utile et sobre (chargeur, tracker, support) mais qualitatif" },
  { cat: "culture", tags: ["culture","fun"], urgentOk: true, min: 15, max: 90, text: "Un jeu de société ciblé (coop/duel/party) selon personnalité" },
];

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function extractBudgetMax(text) {
  const t = String(text || "").replace(",", ".");
  const range = t.match(/(\d+(?:\.\d+)?)\s*[-à]\s*(\d+(?:\.\d+)?)(?:\s*€|\s*eur|\s*euro)?/i);
  if (range) return Number(range[2]);
  const one = t.match(/(\d+(?:\.\d+)?)(?:\s*€|\s*eur|\s*euro)/i);
  return one ? Number(one[1]) : null;
}

function isUrgent(text) {
  const t = String(text || "").toLowerCase();
  if (/(aujourd|ce soir|demain|urgent|tout de suite)/.test(t)) return true;
  const m = t.match(/dans\s*(\d+)\s*(jour|jours|j)\b/);
  if (m && Number(m[1]) <= 2) return true;
  return false;
}

function extractTags(text) {
  const t = String(text || "").toLowerCase();
  const tags = new Set();
  if (/(déco|deco|décoration|maison|intérieur|interieur|zen|minimal|hygge)/.test(t)) { tags.add("deco"); tags.add("zen"); }
  if (/(sport|running|fitness|muscu|yoga|vélo|velo|rando|randonnée|escalade)/.test(t)) tags.add("sport");
  if (/(voyage|week-end|valise|road ?trip|avion)/.test(t)) tags.add("voyage");
  if (/(cuisine|pâtisserie|patiss|bbq|barbecue|thé|the|café|cafe)/.test(t)) tags.add("food");
  if (/(livre|lecture|roman|bd|manga|théâtre|theatre|concert|spectacle)/.test(t)) tags.add("culture");
  if (/(jeu|jeux|escape|quiz)/.test(t)) tags.add("fun");
  if (/(diy|créatif|creatif|peinture|broderie|céramique|ceramique|poterie)/.test(t)) tags.add("creatif");
  if (/(tech|gadget|geek|informatique|phone|iphone|android)/.test(t)) tags.add("tech");
  if (/(bureau|travail|ordinateur|setup)/.test(t)) tags.add("bureau");
  if (/(couple|à deux|a deux)/.test(t)) tags.add("couple");
  return [...tags];
}

// anti-répétition par session (mémoire en RAM)
const SESSION_RECENT = new Map(); // sessionId -> { lastSeen:number, recent:string[] }
function touchSession(sessionId) {
  const now = Date.now();
  const cur = SESSION_RECENT.get(sessionId);
  if (cur) cur.lastSeen = now;
  else SESSION_RECENT.set(sessionId, { lastSeen: now, recent: [] });

  // purge simple si ça grossit trop
  if (SESSION_RECENT.size > 5000) {
    const cutoff = now - 24 * 3600 * 1000; // 24h
    for (const [k, v] of SESSION_RECENT.entries()) {
      if (!v || !v.lastSeen || v.lastSeen < cutoff) SESSION_RECENT.delete(k);
    }
    if (SESSION_RECENT.size > 5000) SESSION_RECENT.clear();
  }
}

function pickTwoAxes(contextText, sessionId, seedInt) {
  touchSession(sessionId);
  const sess = SESSION_RECENT.get(sessionId) || { recent: [] };
  const recentSet = new Set(sess.recent || []);

  const rand = mulberry32(seedInt || 1);
  const tags = extractTags(contextText);
  const urgent = isUrgent(contextText);
  const budgetMax = extractBudgetMax(contextText);

  let candidates = IDEA_BANK.slice();

  if (urgent) candidates = candidates.filter(x => x.urgentOk);
  if (budgetMax != null) candidates = candidates.filter(x => x.min <= budgetMax);

  if (tags.length) {
    const tagged = candidates.filter(x => x.tags.some(t => tags.includes(t)));
    if (tagged.length >= 8) candidates = tagged;
  }

  // évite de resservir les mêmes axes dans la session
  const filtered = candidates.filter(x => !recentSet.has(x.text));
  if (filtered.length >= 8) candidates = filtered;

  // impose 2 catégories différentes
  const groupA = candidates.filter(x => x.cat === "experience" || x.cat === "emotion");
  const groupB = candidates.filter(x => x.cat !== "experience" && x.cat !== "emotion");

  const A = groupA.length ? groupA : IDEA_BANK.filter(x => x.cat === "experience" || x.cat === "emotion");
  const B = groupB.length ? groupB : IDEA_BANK.filter(x => x.cat !== "experience" && x.cat !== "emotion");

  const axis1 = A[Math.floor(rand() * A.length)];
  let axis2 = B[Math.floor(rand() * B.length)];
  let safety = 0;
  while (axis2 && axis1 && axis2.text === axis1.text && safety++ < 10) {
    axis2 = B[Math.floor(rand() * B.length)];
  }

  const nextRecent = [...(sess.recent || []), axis1.text, axis2.text].slice(-10);
  SESSION_RECENT.set(sessionId, { lastSeen: Date.now(), recent: nextRecent });

  return { axis1: axis1.text, axis2: axis2.text, variationKey: seedInt };
}

function buildInstructions(contextText, sessionId) {
  const variationKey = Math.floor(Math.random() * 1_000_000);
  const { axis1, axis2 } = pickTwoAxes(contextText, sessionId, variationKey);

  return `${BASE_PROMPT}

CONTRAINTE VARIÉTÉ (importante)
- Si les prérequis (occasion + budget + délai) ne sont PAS présents : pose UNE seule question ultra courte. Ne propose pas encore de cadeaux.
- Si les prérequis sont présents : propose EXACTEMENT 2 pistes basées sur les 2 axes ci-dessous (2 catégories différentes). Ne propose pas d'autres axes.

AXE 1 (obligatoire) : ${axis1}
AXE 2 (obligatoire) : ${axis2}

Clé de variation: ${variationKey}
Consigne: même si la demande est identique, tu varies en respectant ces axes. Ne mentionne jamais la clé ni le fait que les axes sont imposés.
`;
}

/* ==========================
   ROUTES
   ========================== */

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

app.get("/chat/ping", (req, res) => {
  res.json({ ok: true, promptVersion: PROMPT_VERSION });
});

app.post("/chat", async (req, res) => {
  const t0 = Date.now();
  const sessionId = String(req.body?.sessionId || "no-session").slice(0, 80);

  try {
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

    // Si le front a déjà mis le message courant dans history, on le retire
    const last = rawHistory[rawHistory.length - 1];
    if (last && last.role === "user" && last.content.trim() === userMessage) {
      rawHistory = rawHistory.slice(0, -1);
    }

    // Contexte pour l’extraction (budget/délai/tags) = history + message
    const contextText = [...rawHistory.map(m => m.content), userMessage].join(" ");

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
        instructions: buildInstructions(contextText, sessionId),
        input: inputItems,
        max_output_tokens: 450,
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("OpenAI error:", r.status, JSON.stringify(data));
      return res.status(502).json({ ok: false, error: "Upstream error", promptVersion: PROMPT_VERSION });
    }

    const answer = extractOutputText(data);
    if (!answer) {
      return res.status(502).json({
        ok: false,
        error: "Empty answer from OpenAI",
        raw: data?.id || null,
        promptVersion: PROMPT_VERSION,
      });
    }

    const clean = String(answer).replace(/\\n/g, "\n").replace(/\u00a0/g, " ").trim();

    const ms = Date.now() - t0;
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        route: "/chat",
        sessionId,
        ms,
        promptVersion: PROMPT_VERSION,
      })
    );

    return res.json({ ok: true, answer: clean, promptVersion: PROMPT_VERSION, sessionId });
  } catch (err) {
    console.error("[/chat] ERROR", err);
    return res.status(500).json({
      ok: false,
      error: "Backend error",
      promptVersion: PROMPT_VERSION,
    });
  }
});

// Listen (Railway)
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
