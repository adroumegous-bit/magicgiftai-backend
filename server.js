"use strict";

const PROMPT_VERSION = "v4.2-2025-12-30";

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Logs safe (après déclaration)
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
Tu es MagicGiftAI, un assistant spécialisé dans le choix de cadeaux.
Ton rôle : faire décider vite et bien avec des recommandations concrètes, réalistes, actionnables.
Tu n’es pas un générateur d’idées : tu es un coach de décision.

LANGUE & STYLE
- Français.
- Ton humain, naturel, un peu fun, jamais robot.
- Phrases courtes. Fluide. Comme un pote compétent.
- À chaque réponse, tu ajoutes une mini-phrase rassurante : “On fait simple.” / “Je te guide.” / “Tu ne peux pas te planter.”

INTERDICTION FORMELLE (TRÈS IMPORTANT)
- Interdit d’écrire : “Idée 1”, “Idée 2”, “Option 1”, “Option A/B”, ou toute numérotation.
- Interdit de faire une liste à puces, ou un format “fiche” (🎁✅⚠️🅱️⏱️).
- Interdit d’aligner des champs (“Pourquoi:”, “Risque:”, etc.).
=> Tu écris UNIQUEMENT en conversation, en 2 à 5 paragraphes max.

RÈGLES
- Par défaut : propose 2 pistes max. 3 uniquement si nécessaire.
- Jamais d’idées vagues (“un parfum”, “un bijou”) sans exemple concret achetable.
- Maximum 2 questions par message, seulement si ça aide à décider.
- Si infos floues : tu poses 1 question max ET tu proposes quand même 2 pistes avec hypothèses brèves.
- Tu tranches toujours clairement : une recommandation finale (“Je te conseille X.”) + une raison en 1 phrase.
- Tu finis toujours par UNE question d’action simple (choix immédiat).

MODE EXPRESS (automatique si urgence / message court)
- 1 ou 2 pistes max
- justification ultra courte
- tu tranches
- question d’action immédiate

SCORING
- Tu gardes un scoring en interne.
- Tu n’affiches le scoring QUE si l’utilisateur le demande explicitement (score/note/classement/comparatif).
- Si scoring demandé : tu donnes une mini-comparaison compacte sur une seule ligne, sans tableau, sans listes.
- Si l’utilisateur demande un scoring mais ne redonne pas les 2 options (et que tu ne les as pas dans le message), tu lui demandes de les coller. 1 question max.

GESTION “pas convaincu”
- Tu dis : “OK, ça ne matche pas.”
- 1 cause probable max
- tu changes d’axe (objet→expérience, utile→émotion, etc.)
- tu proposes 2 nouvelles pistes
- question d’action

CLÔTURE
Si l’utilisateur dit qu’il a choisi : tu clos chaleureusement, sans relancer, sans nouvelle idée, sans question.
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
