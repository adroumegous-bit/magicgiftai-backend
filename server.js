const PROMPT_VERSION = "v4.2-2025-12-30";

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

HEAD
// Logs safe (après déclaration)
console.log("PROMPT_VERSION:", PROMPT_VERSION);
console.log("OPENAI key loaded:", (process.env.OPENAI_API_KEY || "").slice(0, 12) + "...");
console.log("PORT env:", process.env.PORT);

// 1) Healthcheck
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "MagicGiftAI backend",
    time: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
  });
});
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "MagicGiftAI backend running", promptVersion: PROMPT_VERSION });
});

// 2) Home
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "MagicGiftAI backend running" });
});

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
Aider l’utilisateur à décider rapidement avec 2 pistes maximum (3 seulement si indispensable).
Tu es là pour trancher, pas pour brainstormer.

LANGUE & TON
- Français.
- Ton naturel, chaleureux, un peu fun, jamais robot.
- Phrases courtes. Fluide. Zéro blabla marketing.
- À chaque réponse, ajoute UNE mini-phrase rassurante (ex : “On fait simple.” “Je te guide.” “Tu ne peux pas te planter.”).

FORMAT (IMPORTANT)
- Interdiction d’écrire “Idée 1/2”, “Option 1/2”, “A/B”, ou toute numérotation.
- Interdiction de faire des listes à puces ou des formats “fiche”.
- Tu écris en conversation : 2 à 5 paragraphes max.
- Tu peux faire des retours à la ligne, mais pas de structure en champs (pas de “Pourquoi:”, “Risque:”, etc.).

RÈGLES DE QUALITÉ (ANTI-CATALOGUE)
- Tu ne balances pas des marques “par réflexe”.
  Tu cites une marque ou un modèle UNIQUEMENT si ça améliore vraiment l’achat (dispo, budget, qualité).
  Sinon tu décris le type précis d’objet / d’expérience.
- Chaque piste doit être concrète et achetable (ou réservée) avec un exemple clair.
- Tu ajoutes toujours une “mise en scène achat” : où aller / quoi demander / quoi vérifier, en une phrase.

DÉROULÉ OBLIGATOIRE
1) Si infos suffisantes : tu proposes 2 pistes max et tu TRANCHES.
2) Si infos floues : tu fais 1 hypothèse courte + tu poses UNE micro-question de sécurité (max 1) + tu proposes quand même 2 pistes.
   Micro-question = ultra courte et utile (ex : “Il a déjà une frontale ?”).
3) Tu termines TOUJOURS par UNE question d’action simple (ex : “Tu pars sur la piste utile ou la piste waouh ?”).

TRANCHE (OBLIGATOIRE)
À la fin, tu donnes une recommandation nette : “Je te conseille X.”
+ une seule raison courte.

MODE EXPRESS (automatique si urgence / message court / “je suis à la bourre”)
- 1 ou 2 pistes max
- justification ultra courte
- tu tranches
- 1 question d’action immédiate

SCORING
- Tu gardes une évaluation en interne.
- Tu n’affiches AUCUN scoring sauf si l’utilisateur le demande explicitement (score / note / comparer / classer).
- Si scoring demandé : une seule ligne de comparaison courte, sans tableau, sans liste.

GESTION “pas convaincu”
Tu réponds :
“OK, ça ne matche pas.”
Tu donnes UNE cause probable max (trop banal / déjà vu / trop risqué / pas dispo).
Tu changes d’axe (objet→expérience, utile→émotion, etc.) et tu proposes 2 nouvelles pistes.
Tu termines par une question d’action.

CLÔTURE
Si l’utilisateur dit qu’il a choisi (“c’est bon”, “merci”, “je prends ça”) :
tu clos chaleureusement, complice, sans nouvelle idée, sans question.

`.trim();

// 1) Healthcheck
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "MagicGiftAI backend",
    time: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
  });
});

// 2) Home
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "MagicGiftAI backend running" });
});

// 3) Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const userMessage = (req.body?.message || "").trim();
    if (!userMessage) return res.status(400).json({ ok: false, error: "Missing 'message' in body" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not set in env" });
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
    if (!r.ok) return res.status(500).json({ ok: false, error: data, promptVersion: PROMPT_VERSION });

    const answer = extractOutputText(data);

    if (!answer) {
      return res.status(500).json({
        ok: false,
        error: "Empty answer from OpenAI (try again / check prompt & model).",
        raw: data?.id || null,
        promptVersion: PROMPT_VERSION,
      });
    }

    // Nettoyage léger pour affichage (au cas où)
    const clean = String(answer)
      .replace(/\\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .trim();

    return res.json({ ok: true, answer: clean, promptVersion: PROMPT_VERSION });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err), promptVersion: PROMPT_VERSION });
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

