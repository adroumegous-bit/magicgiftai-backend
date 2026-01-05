"use strict";

const PROMPT_VERSION = "v4.2-2025-12-30";

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Logs safe
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
      ?.map((c) => c?.text)
      ?.filter((t) => typeof t === "string" && t.trim().length > 0) || [];

  return chunks.join("\n").trim();
}

// ✅ Prompt maître (SYSTEM)
const systemPrompt = `
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

// 1) Healthcheck
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "MagicGiftAI backend",
    time: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    portEnv: process.env.PORT || null,
  });
});

// 2) Home
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "MagicGiftAI backend running",
    promptVersion: PROMPT_VERSION,
  });
});

// 3) Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const userMessage = (req.body?.message || "").trim();
    if (!userMessage) {
      return res.status(400).json({ ok: false, error: "Missing 'message' in body", promptVersion: PROMPT_VERSION });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not set in env", promptVersion: PROMPT_VERSION });
    }

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: userMessage }] },
        ],
        max_output_tokens: 650,
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
    return res.json({ ok: true, answer: clean, promptVersion: PROMPT_VERSION });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      promptVersion: PROMPT_VERSION,
    });
  }
});

// 4) Listen (important for Railway)
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
