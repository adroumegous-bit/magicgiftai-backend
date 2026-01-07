"use strict";

const PROMPT_VERSION = "v4.7-2026-01-07";

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

// Banque structurée (160 entrées)
const IDEA_BANK = [
  { cat: "experience", tags: ["creatif","deco"], urgentOk: true, min: 25, max: 120, text: "Un atelier céramique/poterie (initiation 1 séance)" },
  { cat: "experience", tags: ["food"], urgentOk: true, min: 30, max: 180, text: "Un atelier cuisine (thème selon ses goûts)" },
  { cat: "experience", tags: ["sport"], urgentOk: true, min: 20, max: 120, text: "Une initiation escalade / bloc (1 séance découverte)" },
  { cat: "experience", tags: ["zen","sport"], urgentOk: true, min: 15, max: 80, text: "Une séance de yoga privé ou en petit groupe (1 cours)" },
  { cat: "experience", tags: ["sport","fun"], urgentOk: true, min: 15, max: 80, text: "Un cours de danse découverte (salsa, bachata, contemporain…)" },
  { cat: "experience", tags: ["food","creatif"], urgentOk: true, min: 35, max: 200, text: "Un atelier pâtisserie (macarons, entremets, pain…)" },
  { cat: "experience", tags: ["food","creatif"], urgentOk: true, min: 30, max: 150, text: "Un atelier chocolat (dégustation + création)" },
  { cat: "experience", tags: ["food","creatif"], urgentOk: true, min: 30, max: 150, text: "Un atelier barista (café : extraction + latte art)" },
  { cat: "experience", tags: ["food"], urgentOk: true, min: 20, max: 90, text: "Un atelier thés & infusions (dégustation + accords)" },
  { cat: "experience", tags: ["creatif","fun"], urgentOk: true, min: 45, max: 220, text: "Un atelier création de parfum (sur-mesure)" },
  { cat: "experience", tags: ["deco","creatif","zen"], urgentOk: true, min: 35, max: 160, text: "Un atelier composition florale moderne (pas ‘bouquet classique’)" },
  { cat: "experience", tags: ["creatif"], urgentOk: true, min: 20, max: 90, text: "Un atelier calligraphie/lettering (1 session)" },
  { cat: "experience", tags: ["creatif","culture"], urgentOk: true, min: 25, max: 120, text: "Un atelier photo urbaine (sortie + coaching)" },
  { cat: "experience", tags: ["creatif","zen"], urgentOk: true, min: 20, max: 90, text: "Un atelier peinture/aquarelle (débutant friendly)" },
  { cat: "experience", tags: ["creatif"], urgentOk: true, min: 25, max: 120, text: "Un atelier linogravure / tampon artisanal" },
  { cat: "experience", tags: ["creatif"], urgentOk: true, min: 25, max: 120, text: "Un atelier couture (accessoire simple à fabriquer)" },
  { cat: "experience", tags: ["creatif","deco"], urgentOk: true, min: 40, max: 200, text: "Un atelier bijou artisanal (argent/laiton, selon profil)" },
  { cat: "experience", tags: ["creatif"], urgentOk: true, min: 45, max: 220, text: "Un atelier cuir (porte-cartes / petit accessoire)" },
  { cat: "experience", tags: ["culture"], urgentOk: true, min: 15, max: 150, text: "Une sortie spectacle local (humour/théâtre/concert)" },
  { cat: "experience", tags: ["culture"], urgentOk: true, min: 12, max: 80, text: "Un billet pour une expo immersive / musée (selon ville)" },
  { cat: "experience", tags: ["sport","culture"], urgentOk: true, min: 25, max: 200, text: "Une place pour un match/événement sportif (si fan)" },
  { cat: "experience", tags: ["tech","fun"], urgentOk: true, min: 15, max: 90, text: "Une expérience réalité virtuelle (VR) en salle" },
  { cat: "experience", tags: ["fun"], urgentOk: true, min: 18, max: 120, text: "Un escape game / quiz room à faire à deux ou en groupe" },
  { cat: "experience", tags: ["zen"], urgentOk: true, min: 50, max: 250, text: "Une séance de massage ou spa (si ok pour la personne)" },
  { cat: "experience", tags: ["zen"], urgentOk: true, min: 60, max: 280, text: "Un soin visage / head spa (si profil bien-être)" },
  { cat: "experience", tags: ["zen"], urgentOk: true, min: 45, max: 200, text: "Une séance flottaison / relaxation (si ça lui parle)" },
  { cat: "experience", tags: ["food","culture"], urgentOk: true, min: 20, max: 120, text: "Une initiation dégustation (chocolat, café, fromage…)" },
  { cat: "experience", tags: ["food","culture"], urgentOk: true, min: 35, max: 200, text: "Un cours de cuisine du monde (italien, japonais, libanais…)" },
  { cat: "experience", tags: ["food","fun"], urgentOk: true, min: 25, max: 120, text: "Un atelier cocktails sans alcool (mocktails) + techniques" },
  { cat: "experience", tags: ["voyage","sport"], urgentOk: true, min: 10, max: 60, text: "Une micro-aventure : rando + pique-nique stylé organisé" },
  { cat: "experience", tags: ["culture","fun"], urgentOk: true, min: 10, max: 60, text: "Une balade guidée (street-art, histoire, gourmandise…)" },
  { cat: "experience", tags: ["sport","voyage"], urgentOk: true, min: 20, max: 120, text: "Une sortie paddle/kayak (si saison/lieu)" },
  { cat: "experience", tags: ["sport","voyage"], urgentOk: true, min: 25, max: 150, text: "Une initiation surf (si région et saison)" },
  { cat: "experience", tags: ["zen","sport"], urgentOk: true, min: 15, max: 90, text: "Un cours de pilates (1 séance découverte)" },
  { cat: "experience", tags: ["sport"], urgentOk: true, min: 15, max: 90, text: "Un cours de boxe/light boxing (découverte, safe)" },
  { cat: "experience", tags: ["sport"], urgentOk: true, min: 20, max: 120, text: "Un cours de self-défense (initiation)" },
  { cat: "experience", tags: ["food"], urgentOk: true, min: 25, max: 140, text: "Un atelier cuisine healthy / meal-prep" },
  { cat: "experience", tags: ["food"], urgentOk: true, min: 35, max: 180, text: "Un atelier pizza napolitaine / pain au levain" },
  { cat: "experience", tags: ["food","culture"], urgentOk: true, min: 30, max: 160, text: "Un atelier “fromage” (accords + fabrication simple)" },
  { cat: "experience", tags: ["creatif","zen"], urgentOk: true, min: 20, max: 90, text: "Un atelier collage/vision board (créatif)" },
  { cat: "experience", tags: ["deco","zen","bureau"], urgentOk: true, min: 25, max: 160, text: "Une séance coaching “organisation maison” (1h, si profil déco/zen)" },
  { cat: "experience", tags: ["culture","fun"], urgentOk: true, min: 12, max: 80, text: "Une soirée planétarium / astronomie (selon ville)" },
  { cat: "experience", tags: ["creatif"], urgentOk: true, min: 25, max: 120, text: "Un atelier bougies sculptées (créatif)" },
  { cat: "experience", tags: ["food","culture"], urgentOk: true, min: 30, max: 180, text: "Une initiation œnologie sans achat de bouteille (cours/atelier)" },
  { cat: "experience", tags: ["creatif","culture"], urgentOk: true, min: 35, max: 180, text: "Un atelier “initiation photo argentique” (si dispo)" },

  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Une boîte souvenirs prête en 1h (photos + 5 mots + 1 petit objet symbole)" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Une lettre ‘vraie’ + 3 souvenirs précis (format court, mais marquant)" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Une capsule temporelle (petits objets + date d’ouverture) à préparer aujourd’hui" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un mini-album photo imprimé en express (ou retiré en magasin si possible)" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Une carte ‘playlist’ (QR code) + message audio personnalisé" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un “bon pour” personnalisé (3 bons : utile / waouh / émotion) signé" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Une chasse au trésor maison (3 indices simples) menant au cadeau final" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un kit ‘soirée parfaite’ fait maison (film/jeu + snack + détail perso)" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un carnet ‘30 raisons’… mais en version cartes à tirer (plus fun qu’un carnet)" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un tableau/affiche ‘top 10 moments’ (texte + photos, style minimal)" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un ‘date’ planifié (itinéraire + réservation) avec une enveloppe à ouvrir" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un bocal de défis doux (petites actions à faire sur 30 jours)" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un message vidéo monté (1 min) avec photos/vidéos + musique" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un “pack réconfort” ciblé (3 petites choses qui lui ressemblent, pas génériques)" },
  { cat: "emotion", tags: ["couple","culture","fun"], urgentOk: true, min: 5, max: 60, text: "Un ‘rituel’ à deux (ex: brunch maison + balade) avec invitation imprimée" },

  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 140, text: "Une illustration/portrait (style minimaliste) à partir d’une photo" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 20, max: 120, text: "Une carte des étoiles (date/lieu important) en affiche" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 20, max: 140, text: "Une affiche carte de ville (lieu marquant) en poster" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 160, text: "Un poster ‘constellation’/skyline personnalisé (style sobre)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 30, max: 180, text: "Une photo encadrée avec passe-partout (format clean) + petit mot au dos" },
  { cat: "personnalise", tags: ["couple","emotion"], urgentOk: false, min: 20, max: 120, text: "Un puzzle photo personnalisé (image qui a du sens)" },
  { cat: "personnalise", tags: ["couple","emotion"], urgentOk: false, min: 25, max: 160, text: "Un album photo premium ‘mini-livre’ (mise en page simple)" },
  { cat: "personnalise", tags: ["food","creatif"], urgentOk: false, min: 15, max: 90, text: "Un mini-livre de recettes (thème/famille) imprimé et relié" },
  { cat: "personnalise", tags: ["bureau"], urgentOk: false, min: 15, max: 90, text: "Un agenda/planning personnalisé… mais version ‘planificateur mural’ minimaliste" },
  { cat: "personnalise", tags: ["bureau"], urgentOk: false, min: 25, max: 140, text: "Un porte-cartes / portefeuille gravé (initiales discrètes)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 140, text: "Une planche à découper gravée (message discret + date)" },
  { cat: "personnalise", tags: ["food","creatif"], urgentOk: false, min: 20, max: 120, text: "Un tablier brodé avec une blague interne (sobre, pas beauf)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 20, max: 120, text: "Un coussin brodé minimal (un mot/coordonnées)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 150, text: "Une bougie sculptée personnalisée (forme + étiquette sobre)" },
  { cat: "personnalise", tags: ["culture"], urgentOk: false, min: 15, max: 90, text: "Un ex-libris personnalisé (tampon ‘bibliothèque de …’)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 160, text: "Un calendrier photo ‘1 photo par mois’ (design minimal)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 160, text: "Une affiche ‘top 5 voyages’ (dates/lieux) en style typographique" },
  { cat: "personnalise", tags: ["voyage"], urgentOk: false, min: 20, max: 120, text: "Une étiquette bagage cuir gravée + porte-passeport assorti (initiales)" },
  { cat: "personnalise", tags: ["sport"], urgentOk: false, min: 20, max: 140, text: "Une serviette sport brodée (initiales + couleur sobre)" },
  { cat: "personnalise", tags: ["tech"], urgentOk: false, min: 25, max: 160, text: "Une coque/étui personnalisé discret (initiales, pas photo géante)" },
  { cat: "personnalise", tags: ["couple","emotion"], urgentOk: false, min: 25, max: 150, text: "Un ‘livre’ de promesses/bon pour, imprimé proprement (pas bricolé)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 30, max: 200, text: "Une impression photo sur support premium (alu/bois)" },
  { cat: "personnalise", tags: ["culture"], urgentOk: false, min: 20, max: 120, text: "Un poster personnalisé d’un film/album préféré (style minimal, sans marque)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 160, text: "Une carte ‘lignes de métro’ personnalisée (villes importantes)" },
  { cat: "personnalise", tags: ["couple","emotion"], urgentOk: false, min: 20, max: 120, text: "Un bracelet discret gravé (coordonnées/date) – minimal, pas bling" },
  { cat: "personnalise", tags: ["bureau"], urgentOk: false, min: 20, max: 120, text: "Un stylo gravé + petite carte (utile, sobre)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 160, text: "Une affiche ‘citation + date’ en typographie propre" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 140, text: "Une housse d’ordinateur brodée (initiales discrètes)" },
  { cat: "personnalise", tags: ["deco","zen"], urgentOk: false, min: 25, max: 140, text: "Un tote solide personnalisé (broderie minimaliste)" },
  { cat: "personnalise", tags: ["food","creatif"], urgentOk: false, min: 20, max: 140, text: "Un set ‘épices’ personnalisé (étiquettes + boîte) pour quelqu’un qui cuisine" },

  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 15, max: 90, text: "Un organiseur de voyage (passeport/cartes) + étiquettes bagages" },
  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 20, max: 120, text: "Un set de packing cubes (rangement valise propre)" },
  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 15, max: 80, text: "Une trousse câbles/chargeurs compacte (organisation)" },
  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 15, max: 80, text: "Une balance bagage compacte + housse/étui (pratique)" },
  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 20, max: 120, text: "Un oreiller de voyage vraiment confortable (pas gadget)" },
  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 15, max: 70, text: "Un masque sommeil + bouchons premium (kit sommeil clean)" },
  { cat: "utile", tags: ["tech"], urgentOk: true, min: 20, max: 140, text: "Une batterie externe fiable + câble court (qualité, pas gadget)" },
  { cat: "utile", tags: ["tech"], urgentOk: true, min: 15, max: 90, text: "Un chargeur multi-ports compact (pour voyager / bureau)" },
  { cat: "utile", tags: ["tech"], urgentOk: true, min: 20, max: 150, text: "Un support téléphone/ordi propre (setup minimaliste)" },
  { cat: "utile", tags: ["tech"], urgentOk: true, min: 25, max: 220, text: "Un tracker d’objets (clés/sac) compatible smartphone (sans citer de marque)" },
  { cat: "utile", tags: ["bureau"], urgentOk: true, min: 20, max: 150, text: "Un upgrade bureau (support laptop + rangement clean)" },
  { cat: "utile", tags: ["bureau"], urgentOk: true, min: 15, max: 90, text: "Un organiseur de tiroir/desk (style sobre, anti-bazar)" },
  { cat: "utile", tags: ["bureau"], urgentOk: true, min: 20, max: 120, text: "Une lampe de bureau orientable ‘lumière douce’ (design simple)" },
  { cat: "utile", tags: ["bureau"], urgentOk: true, min: 15, max: 80, text: "Un repose-poignets/desk mat confortable (setup clean)" },
  { cat: "utile", tags: ["sport"], urgentOk: true, min: 15, max: 120, text: "Un accessoire sport qualitatif lié à SON sport exact (pas gadget)" },
  { cat: "utile", tags: ["sport"], urgentOk: true, min: 15, max: 80, text: "Un rouleau de massage + balle (récup, simple et efficace)" },
  { cat: "utile", tags: ["sport"], urgentOk: true, min: 15, max: 80, text: "Des bandes/élastiques training + mini guide d’exos (qualité)" },
  { cat: "utile", tags: ["sport"], urgentOk: true, min: 20, max: 150, text: "Une ceinture/hydratation running ou brassard premium (si runner)" },
  { cat: "utile", tags: ["sport"], urgentOk: true, min: 15, max: 90, text: "Une gourde sport souple/rigide adaptée à sa pratique" },
  { cat: "utile", tags: ["zen","deco"], urgentOk: true, min: 20, max: 160, text: "Une lumière d’ambiance design pour vibe zen (lampe/veilleuse)" },
  { cat: "utile", tags: ["zen","deco"], urgentOk: true, min: 15, max: 90, text: "Un plaid ultra doux (qualité) pour ‘coin cosy’ (pas déco kitsch)" },
  { cat: "utile", tags: ["zen","deco"], urgentOk: true, min: 15, max: 80, text: "Un coussin lombaire/nuque ergonomique (si besoin)" },
  { cat: "utile", tags: ["food"], urgentOk: true, min: 20, max: 200, text: "Un outil cuisine premium ciblé (moulin, planche, couteau… selon profil)" },
  { cat: "utile", tags: ["food"], urgentOk: true, min: 20, max: 160, text: "Un moulin à poivre/sel manuel de qualité (sans marque)" },
  { cat: "utile", tags: ["food"], urgentOk: true, min: 20, max: 160, text: "Une belle planche + huile d’entretien (si cuisine)" },
  { cat: "utile", tags: ["food"], urgentOk: true, min: 20, max: 160, text: "Un couteau d’office qualitatif + affûteur simple" },
  { cat: "utile", tags: ["food"], urgentOk: true, min: 15, max: 90, text: "Un thermomètre cuisine précis (cuissons, pâtisserie)" },
  { cat: "utile", tags: ["food"], urgentOk: true, min: 20, max: 150, text: "Une cafetière ‘méthode douce’ + filtre réutilisable (si coffee nerd)" },
  { cat: "utile", tags: ["food"], urgentOk: true, min: 15, max: 90, text: "Un infuseur/théière simple mais premium (si thé)" },
  { cat: "utile", tags: ["culture","fun"], urgentOk: true, min: 15, max: 80, text: "Une liseuse de lecture ‘lumière clip’ + support livre (confort)" },
  { cat: "utile", tags: ["culture","fun"], urgentOk: true, min: 15, max: 80, text: "Un puzzle adulte beau (illustration) – choisi selon goûts" },
  { cat: "utile", tags: ["deco","zen"], urgentOk: true, min: 20, max: 160, text: "Un rangement discret pour entrée (vide-poches design, mais sobre)" },
  { cat: "utile", tags: ["deco","zen"], urgentOk: true, min: 20, max: 160, text: "Un cadre photo premium + impression (look galerie)" },
  { cat: "utile", tags: ["deco","zen"], urgentOk: true, min: 15, max: 120, text: "Un set d’accessoires ‘salle de bain clean’ (porte-savon, rangement, sobre)" },
  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 15, max: 80, text: "Un parapluie compact solide (anti-retournement) – utile toute l’année" },

  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 120, text: "Un kit DIY linogravure (outils + blocs) pour créer des tampons" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 90, text: "Un kit broderie moderne (motif minimal, pas ‘grand-mère’)" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 90, text: "Un kit aquarelle débutant (papier + pinceaux + palette simple)" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 80, text: "Un kit calligraphie/brush lettering (2 feutres + guide)" },
  { cat: "creatif", tags: ["creatif","deco"], urgentOk: true, min: 20, max: 140, text: "Un kit poterie auto-durcissante + outils (création maison)" },
  { cat: "creatif", tags: ["creatif","zen"], urgentOk: true, min: 15, max: 90, text: "Un kit terrarium simple (plantes + bocal) à monter" },
  { cat: "creatif", tags: ["creatif","food"], urgentOk: true, min: 15, max: 90, text: "Un kit cuisine ‘fait maison’ (ramen, pâtes, kimchi… selon goûts)" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 80, text: "Un kit bougie sculptée (moules + cire) version design" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 80, text: "Un kit cosmétique maison (baume, gommage) – si profil zen" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 80, text: "Un kit ‘carnet de voyage’… mais version collage + stickers (créatif)" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 100, text: "Un set ‘puzzle 3D / maquette’ (objet final déco)" },
  { cat: "creatif", tags: ["creatif","culture"], urgentOk: true, min: 20, max: 160, text: "Un set initiation photo (mini trépied + déclencheur + guide)" },
  { cat: "creatif", tags: ["creatif","zen"], urgentOk: true, min: 15, max: 90, text: "Un kit origami premium (papier + modèles) pour déconnecter" },
  { cat: "creatif", tags: ["creatif","deco"], urgentOk: true, min: 15, max: 120, text: "Un set peinture sur céramique (à faire à la maison)" },
  { cat: "creatif", tags: ["creatif","fun"], urgentOk: true, min: 20, max: 140, text: "Un set ‘initiation musique’ (kalimba/ukulélé simple) si ça lui parle" },

  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 220, text: "Un objet déco signature (affiche, mobile, vase) aligné avec son style" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 25, max: 220, text: "Un mini ‘coin zen’ cohérent (plaid + lumière douce + petit élément)" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 180, text: "Un set de cadres minimalistes (1–3 cadres) pour une mini galerie murale" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 180, text: "Un miroir design simple (format entrée / chambre)" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 180, text: "Un mobile décoratif (métal/bois) pour une vibe zen" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 200, text: "Un vase contemporain (forme simple) + une tige/branche stylée" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 180, text: "Un tapis/paillasson intérieur sobre (texture) pour ‘upgrade’ la pièce" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 200, text: "Un panier/rangement tressé chic (anti-bazar, mais joli)" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 180, text: "Une plante d’intérieur facile + cache-pot sobre (si elle aime le vert)" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 200, text: "Un set ‘table’ minimal (dessous de verre/petit plateau) style zen" },

  { cat: "tech", tags: ["tech","bureau"], urgentOk: true, min: 20, max: 120, text: "Un support de charge multi-appareils (setup clean, sans marque)" },
  { cat: "tech", tags: ["tech","bureau"], urgentOk: true, min: 25, max: 220, text: "Un casque/écouteurs confort (si elle écoute musique/podcasts)" },
  { cat: "tech", tags: ["tech","bureau"], urgentOk: true, min: 20, max: 160, text: "Une mini enceinte compacte (pour maison/voyage)" },
  { cat: "tech", tags: ["tech","bureau"], urgentOk: true, min: 15, max: 90, text: "Un hub USB/organisateur de câbles (bureau propre)" },
  { cat: "tech", tags: ["tech","bureau"], urgentOk: true, min: 20, max: 150, text: "Un clavier/souris ergonomiques (si beaucoup de bureau)" },

  { cat: "culture", tags: ["culture","fun"], urgentOk: true, min: 15, max: 80, text: "Un livre vraiment ciblé + un accessoire lecture (pince-livre / marque-page premium)" },
  { cat: "culture", tags: ["culture","fun"], urgentOk: true, min: 15, max: 90, text: "Un jeu narratif / enquête à faire à la maison (choisi selon style)" },
  { cat: "culture", tags: ["culture","fun"], urgentOk: true, min: 20, max: 160, text: "Un pass musée/expo (carte cadeau officielle) – version locale" },
  { cat: "culture", tags: ["culture","fun"], urgentOk: true, min: 15, max: 90, text: "Un puzzle illustré ‘beau’ (à exposer ou encadrer)" },
  { cat: "culture", tags: ["culture","fun"], urgentOk: true, min: 20, max: 160, text: "Un cours en ligne court (photo, cuisine, dessin) à suivre à son rythme" },
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
