
"use strict";

const PROMPT_VERSION = "v5.3-2026-01-30";

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

async function upsertAccessFromLicenseKey(payload) {
  const pool = getPool();
  if (!pool) return;

  const a = payload?.data?.attributes || {};
  const productId = String(a.product_id || "");
  const licenseKey = String(a.key || "").trim();
  const email = String(a.user_email || "").toLowerCase().trim();

  if (!licenseKey) return;

  // expires_at est parfois null → on force 48h si c’est le produit 48h
  let expiresAt = a.expires_at ? String(a.expires_at) : null;
  if (!expiresAt && MG_PRODUCT_48H_ID && productId === MG_PRODUCT_48H_ID) {
    expiresAt = addHours(a.created_at, 48);
  }

  const meta = {
    product_id: a.product_id,
    order_id: a.order_id,
    customer_id: a.customer_id,
    created_at: a.created_at,
    lemon_status: a.status,
  };

  await pool.query(
    `
    INSERT INTO mg_access (email, customer_id, order_id, subscription_id, license_key, product_sku, status, starts_at, expires_at, meta)
    VALUES ($1,$2,$3,NULL,$4,NULL,'active',$5,$6,$7::jsonb)
    ON CONFLICT (license_key)
    DO UPDATE SET
      email = EXCLUDED.email,
      customer_id = EXCLUDED.customer_id,
      order_id = EXCLUDED.order_id,
      status = EXCLUDED.status,
      starts_at = EXCLUDED.starts_at,
      expires_at = EXCLUDED.expires_at,
      meta = mg_access.meta || EXCLUDED.meta,
      updated_at = now()
    `,
    [
      email || null,
      a.customer_id ? String(a.customer_id) : null,
      a.order_id ? String(a.order_id) : null,
      licenseKey,
      a.created_at ? String(a.created_at) : new Date().toISOString(),
      expiresAt,
      JSON.stringify(meta),
    ]
  );
}

async function updateAccessFromSubscription(payload) {
  const pool = getPool();
  if (!pool) return;

  const subId = String(payload?.data?.id || "");
  const a = payload?.data?.attributes || {};
  const orderId = a.order_id ? String(a.order_id) : null;

  // statuts Lemon -> notre status
  const lemonStatus = String(a.status || "").toLowerCase();
  const cancelled = Boolean(a.cancelled);

  let status = "active";
  let expiresAt = null;

  // si cancel → on coupe à la fin de période (renews_at/ends_at si dispo)
  if (cancelled) {
    status = "cancelled";
    expiresAt = a.ends_at ? String(a.ends_at) : (a.renews_at ? String(a.renews_at) : null);
  }

  // si expired/unpaid/etc → coupé tout de suite
  if (["expired", "unpaid", "paused"].includes(lemonStatus)) {
    status = lemonStatus;
    expiresAt = a.ends_at ? String(a.ends_at) : new Date().toISOString();
  }

  const meta = {
    subscription_id: subId,
    lemon_status: lemonStatus,
    cancelled,
    renews_at: a.renews_at || null,
    ends_at: a.ends_at || null,
  };

  // on rattache via order_id (tu l’as dans tes payloads)
  await pool.query(
    `
    UPDATE mg_access
    SET subscription_id = $1,
        status = $2,
        expires_at = COALESCE($3, expires_at),
        meta = mg_access.meta || $4::jsonb,
        updated_at = now()
    WHERE ($5 IS NOT NULL AND order_id = $5)
       OR (subscription_id IS NOT NULL AND subscription_id = $1)
    `,
    [subId, status, expiresAt, JSON.stringify(meta), orderId]
  );
}

async function checkAccessKey(licenseKey) {
  await initDb();
  const pool = getPool();
  if (!pool) return { ok: false, reason: "no_db" };

  const k = String(licenseKey || "").trim();
  if (!k) return { ok: false, reason: "missing_key" };

  const r = await pool.query(
    `
    SELECT status, expires_at
    FROM mg_access
    WHERE license_key = $1
    LIMIT 1
    `,
    [k]
  );

  if (!r.rowCount) return { ok: false, reason: "unknown_key" };

  const row = r.rows[0];
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : null;
  const now = Date.now();

  if (row.status !== "active" && row.status !== "cancelled") {
    return { ok: false, reason: "not_active" };
  }

  // cancelled = ok tant que pas expiré (fin de période)
  if (exp && now > exp) return { ok: false, reason: "expired" };

  return { ok: true };
}


const LEMON_SIGNING_SECRET = process.env.LEMON_SIGNING_SECRET || "";

// mapping par product_id (OK dans ton cas: 1 produit = 1 plan)
const MG_PRODUCT_48H_ID = String(process.env.MG_PRODUCT_48H_ID || "");
const MG_PRODUCT_MONTHLY_ID = String(process.env.MG_PRODUCT_MONTHLY_ID || "");
const MG_PRODUCT_ANNUAL_ID = String(process.env.MG_PRODUCT_ANNUAL_ID || "");

// header attendu côté front
const ACCESS_HEADER = "x-mg-key";

function verifyLemonSignature(req) {
  // Lemon: HMAC SHA256 hex digest envoyé dans X-Signature
  // https://docs.lemonsqueezy.com/help/webhooks/signing-requests :contentReference[oaicite:0]{index=0}
  if (!LEMON_SIGNING_SECRET) return false;

  const signature = Buffer.from(req.get("X-Signature") || "", "utf8");
  const hmac = crypto.createHmac("sha256", LEMON_SIGNING_SECRET);
  const digest = Buffer.from(hmac.update(req.rawBody || Buffer.from("")).digest("hex"), "utf8");

  if (signature.length !== digest.length) return false;
  return crypto.timingSafeEqual(digest, signature);
}

function addHours(dateStr, hours) {
  const d = new Date(dateStr);
  return new Date(d.getTime() + hours * 3600 * 1000).toISOString();
}

// ====== LEMON LICENSE GATE (48h / abonnements) ======
const ALLOWED_PRODUCT_IDS = (process.env.ALLOWED_PRODUCT_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean); // ex: "795614,123456"

const BYPASS_LICENSE = process.env.BYPASS_LICENSE === "1";

// Appel Lemon: POST /v1/licenses/validate
async function lemonValidateLicense(licenseKey, instanceId = null) {
  const body = new URLSearchParams();
  body.set("license_key", licenseKey);
  if (instanceId) body.set("instance_id", instanceId);

  const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

// Middleware : bloque /chat si licence invalide/expirée
async function requireValidLicense(req, res, next) {
  try {
    if (BYPASS_LICENSE) return next();

    const licenseKey =
      (req.get("x-license-key") || "").trim() ||
      String(req.body?.licenseKey || "").trim() ||
      String(req.query?.licenseKey || "").trim();

    if (!licenseKey) {
      return res.status(401).json({ ok: false, error: "Missing license key" });
    }

    const { ok, data } = await lemonValidateLicense(licenseKey);

    // spec: { valid: boolean, error, license_key: {status, expires_at...}, meta: { product_id... } }
    if (!ok || !data || data.valid !== true) {
      return res.status(403).json({ ok: false, error: "Invalid license key" });
    }

    const status = String(data?.license_key?.status || "").toLowerCase();
    if (status === "expired" || status === "disabled") {
      return res.status(403).json({ ok: false, error: `License ${status}` });
    }

    const productId = String(data?.meta?.product_id || "");
    if (ALLOWED_PRODUCT_IDS.length && !ALLOWED_PRODUCT_IDS.includes(productId)) {
      return res.status(403).json({ ok: false, error: "License not allowed for this product" });
    }

    // optionnel: expose au handler
    req.lemonLicense = data;
    next();
  } catch (e) {
    console.error("requireValidLicense error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "License check failed" });
  }
}

// CORS + preflight
app.use(cors({ origin: true }));
app.options("*", cors({ origin: true }));
// JSON + RAW BODY (obligatoire pour vérifier la signature Lemon)
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
    if (buf && buf.length) req.rawBody = buf; // 👈 garde le body brut pour la signature
    },
  })
);


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

// limiter événements (vote/feedback)
const eventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  message: { ok: false, error: "Trop de feedback. Réessaie dans 1 minute." },
});
app.use("/event", eventLimiter);
app.use("/feedback", eventLimiter);

// Logs safe
console.log("PROMPT_VERSION:", PROMPT_VERSION);
console.log("OPENAI key loaded:", (process.env.OPENAI_API_KEY || "").slice(0, 12) + "...");
console.log("PORT env:", process.env.PORT);

/* ==========================
   DB / METRICS (PostgreSQL)
   ========================== */

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.DATABASE_PRIVATE_URL ||
  process.env.POSTGRES_URL ||
  "";

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const SESSION_SALT = process.env.SESSION_SALT || "fallback-salt";
/* ==========================
   LEMON / ACCESS CONTROL
   ========================== */

const LEMON_WEBHOOK_SECRET = process.env.LEMON_WEBHOOK_SECRET || "";
const ACCESS_REQUIRED = String(process.env.ACCESS_REQUIRED || "true").toLowerCase() !== "false";
const MG_48H_HOURS = Number(process.env.MG_48H_HOURS || "48");

// clés produit/variant/sku attendues (liste séparée par virgules)
const MG_PLAN_48H_KEYS = String(process.env.MG_PLAN_48H_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MG_PLAN_MONTHLY_KEYS = String(process.env.MG_PLAN_MONTHLY_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MG_PLAN_ANNUAL_KEYS = String(process.env.MG_PLAN_ANNUAL_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function pickFirst(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function getDeep(obj, path) {
  try {
    return path.reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
  } catch {
    return undefined;
  }
}

function extractLemonBasics(req, payload) {
  const eventName = pickFirst(
    req.get("X-Event-Name"),
    req.get("x-event-name"),
    getDeep(payload, ["meta", "event_name"]),
    getDeep(payload, ["meta", "eventName"]),
    payload?.event_name
  );

  const eventId = pickFirst(
    req.get("X-Event-Id"),
    req.get("x-event-id"),
    getDeep(payload, ["meta", "event_id"]),
    getDeep(payload, ["meta", "eventId"]),
    getDeep(payload, ["data", "id"]),
    payload?.id
  ) || crypto.randomUUID();

  return { eventName: eventName || "unknown", eventId };
}

// essaye de récupérer une “clé produit” utilisable pour mapper tes plans
function extractProductKey(payload) {
  // patterns fréquents Lemon (selon le type d’événement)
  const direct = pickFirst(
    getDeep(payload, ["data", "attributes", "variant_id"]),
    getDeep(payload, ["data", "attributes", "product_id"]),
    getDeep(payload, ["data", "attributes", "product_sku"]),
    getDeep(payload, ["data", "attributes", "variant_sku"])
  );
  if (direct) return direct;

  // order_items (si présent)
  const item0 = getDeep(payload, ["data", "attributes", "first_order_item"]);
  const items = getDeep(payload, ["data", "attributes", "order_items"]);
  const tryItem = item0 || (Array.isArray(items) ? items[0] : null) || null;

  return pickFirst(
    tryItem?.variant_id,
    tryItem?.product_id,
    tryItem?.product_sku,
    tryItem?.variant_sku
  );
}

function detectPlan(productKey) {
  const key = String(productKey || "").trim();
  if (!key) return { plan: "unknown", durationHours: null };

  if (MG_PLAN_48H_KEYS.includes(key)) return { plan: "48h", durationHours: MG_48H_HOURS };
  if (MG_PLAN_MONTHLY_KEYS.includes(key)) return { plan: "monthly", durationHours: null };
  if (MG_PLAN_ANNUAL_KEYS.includes(key)) return { plan: "annual", durationHours: null };

  return { plan: "unknown", durationHours: null };
}

function computeHmacHex(buf, secret) {
  return crypto.createHmac("sha256", secret).update(buf).digest("hex");
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""), "utf8");
  const B = Buffer.from(String(b || ""), "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function verifyLemonSignature(req) {
  if (!LEMON_WEBHOOK_SECRET) return { ok: false, reason: "LEMON_WEBHOOK_SECRET missing" };

  let sig = pickFirst(req.get("X-Signature"), req.get("x-signature"), req.get("Signature"), req.get("signature"));
  sig = String(sig || "").trim().replace(/^sha256=/i, "");

  if (!sig) return { ok: false, reason: "signature header missing" };

  const raw = req.rawBody && Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}), "utf8");

  const hex = computeHmacHex(raw, LEMON_WEBHOOK_SECRET);

  // certains systèmes envoient hex, d’autres base64. On accepte les 2.
  const b64 = Buffer.from(hex, "hex").toString("base64");

  const ok = safeEqual(sig, hex) || safeEqual(sig, b64);
  return ok ? { ok: true } : { ok: false, reason: "invalid signature" };
}

async function ensureAccessTables() {
  const pool = getPool();
  if (!pool) return;

  // extensions utiles
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS citext;`);

  // events webhook (log)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_webhook_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      processed_at TIMESTAMPTZ,
      status TEXT,
      error TEXT
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mg_webhook_events_event_id_ux
    ON mg_webhook_events (event_id);
  `);

  // table accès
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_access (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email CITEXT,
      customer_id TEXT,
      order_id TEXT,
      subscription_id TEXT,
      license_key TEXT,
      product_sku TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      meta JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mg_access_license_key_ux
    ON mg_access (license_key)
    WHERE license_key IS NOT NULL AND license_key <> '';
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS mg_access_email_idx ON mg_access (email);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mg_access_status_idx ON mg_access (status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mg_access_expires_at_idx ON mg_access (expires_at);`);
}

function asDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function upsertAccess(pool, row) {
  const metaJson = JSON.stringify(row.meta || {});

  if (row.license_key) {
    await pool.query(
      `
      INSERT INTO mg_access
        (email, customer_id, order_id, subscription_id, license_key, product_sku, status, starts_at, expires_at, meta, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())
      ON CONFLICT (license_key)
      DO UPDATE SET
        email = COALESCE(EXCLUDED.email, mg_access.email),
        customer_id = COALESCE(EXCLUDED.customer_id, mg_access.customer_id),
        order_id = COALESCE(EXCLUDED.order_id, mg_access.order_id),
        subscription_id = COALESCE(EXCLUDED.subscription_id, mg_access.subscription_id),
        product_sku = COALESCE(EXCLUDED.product_sku, mg_access.product_sku),
        status = COALESCE(EXCLUDED.status, mg_access.status),
        starts_at = COALESCE(EXCLUDED.starts_at, mg_access.starts_at),
        expires_at = COALESCE(EXCLUDED.expires_at, mg_access.expires_at),
        meta = mg_access.meta || EXCLUDED.meta,
        updated_at = now()
      `,
      [
        row.email || null,
        row.customer_id || null,
        row.order_id || null,
        row.subscription_id || null,
        row.license_key,
        row.product_sku || null,
        row.status || null,
        row.starts_at || null,
        row.expires_at || null,
        metaJson,
      ]
    );
    return;
  }

  // fallback si pas de licence : on insère juste (moins robuste)
  await pool.query(
    `
    INSERT INTO mg_access (email, customer_id, order_id, subscription_id, license_key, product_sku, status, starts_at, expires_at, meta, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())
    `,
    [
      row.email || null,
      row.customer_id || null,
      row.order_id || null,
      row.subscription_id || null,
      null,
      row.product_sku || null,
      row.status || "pending",
      row.starts_at || null,
      row.expires_at || null,
      metaJson,
    ]
  );
}

async function findActiveAccess({ licenseKey, email }) {
  const pool = getPool();
  if (!pool) return { active: false, reason: "db_disabled" };

  const lk = String(licenseKey || "").trim();
  const em = String(email || "").trim();

  let row = null;

  if (lk) {
    const r = await pool.query(
      `SELECT * FROM mg_access WHERE license_key = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [lk]
    );
    row = r.rows[0] || null;
  } else if (em) {
    const r = await pool.query(
      `SELECT * FROM mg_access WHERE email = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [em]
    );
    row = r.rows[0] || null;
  }

  if (!row) return { active: false, reason: "not_found" };

  const now = new Date();
  const exp = row.expires_at ? new Date(row.expires_at) : null;

  // si expires_at est défini et passé => non
  if (exp && exp <= now) return { active: false, reason: "expired", row };

  // statuts bloquants
  const st = String(row.status || "").toLowerCase();
  if (["revoked", "refunded", "expired"].includes(st)) return { active: false, reason: "status_blocked", row };

  return { active: true, row };
}

let pgPool = null;
let dbInitPromise = null;

function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key") || req.query.key || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  next();
}

function getPool() {
  if (!DATABASE_URL) return null;
  if (pgPool) return pgPool;

  const isInternal = DATABASE_URL.includes("railway.internal");
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isInternal ? false : { rejectUnauthorized: false },
  });

  return pgPool;
}

// hash 24 chars stable
function h24(label, value) {
  return crypto
    .createHmac("sha256", SESSION_SALT)
    .update(`${label}:${String(value || "")}`)
    .digest("hex")
    .slice(0, 24);
}

// 3 niveaux : session / conversation / search
function computeHashes({ sessionId, conversationId, searchId }) {
  const sid = String(sessionId || "no-session").slice(0, 200);
  const cid = String(conversationId || sid).slice(0, 200);     // stable pour le fil
  const qid = String(searchId || "search-0").slice(0, 200);    // change à chaque "nouvelle recherche"

  return {
    session_hash: h24("s", sid),
    conversation_hash: h24("c", cid),
    search_hash: h24("q", `${cid}:${qid}`),
  };
}

async function initDb() {
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    const pool = getPool();
    if (!pool) throw new Error("DB disabled (DATABASE_URL missing)");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS mg_events (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        session_hash TEXT NOT NULL,
        conversation_hash TEXT,
        search_hash TEXT,
        event_type TEXT NOT NULL,
        prompt_version TEXT,
        ms INT,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    // si table existait déjà
    await pool.query(`ALTER TABLE mg_events ADD COLUMN IF NOT EXISTS conversation_hash TEXT;`);
    await pool.query(`ALTER TABLE mg_events ADD COLUMN IF NOT EXISTS search_hash TEXT;`);
    await pool.query(`ALTER TABLE mg_events ADD COLUMN IF NOT EXISTS prompt_version TEXT;`);
    await pool.query(`ALTER TABLE mg_events ADD COLUMN IF NOT EXISTS ms INT;`);
    await pool.query(`ALTER TABLE mg_events ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;`);

    // Index perf
    await pool.query(`CREATE INDEX IF NOT EXISTS mg_events_created_at_idx ON mg_events (created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS mg_events_event_type_idx ON mg_events (event_type);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS mg_events_session_hash_idx ON mg_events (session_hash);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS mg_events_conversation_hash_idx ON mg_events (conversation_hash);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS mg_events_search_hash_idx ON mg_events (search_hash);`);

    // IMPORTANT: 1 vote par SEARCH (pas par conversation)
    // (si l’index existe déjà en DB, ça ne bouge pas)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mg_one_vote_per_search
      ON mg_events (search_hash)
      WHERE search_hash IS NOT NULL
        AND event_type IN ('conv_validated','conv_invalidated');
    `);
    // ✅ tables accès + webhooks Lemon
    await ensureAccessTables();

    console.log("DB ready ✅ (unique vote per search)");
  })();

  return dbInitPromise;
}

// Log générique
async function logEvent({ sessionId, conversationId, searchId, eventType, ms = null, meta = {} }) {
  try {
    await initDb();
    const pool = getPool();
    if (!pool) return { stored: false, reason: "no_db" };

    const H = computeHashes({ sessionId, conversationId, searchId });
    const isVote = eventType === "conv_validated" || eventType === "conv_invalidated";

    const sql = `
      INSERT INTO mg_events (session_hash, conversation_hash, search_hash, event_type, prompt_version, ms, meta)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ${isVote ? "ON CONFLICT DO NOTHING" : ""}
    `;

    const r = await pool.query(sql, [
      H.session_hash,
      H.conversation_hash,
      H.search_hash,
      String(eventType || "unknown").slice(0, 80),
      PROMPT_VERSION,
      ms === null ? null : Number(ms),
      JSON.stringify(meta || {}),
    ]);

    return { stored: r.rowCount === 1 };
  } catch (e) {
    console.error("logEvent failed:", e?.message || String(e));
    return { stored: false, reason: "error" };
  }
}

// Init DB silencieux
initDb()
  .then(() => console.log("DB init done ✅"))
  .catch((e) => console.log("DB disabled or init error ⚠️", e?.message || e));


/* ==========================
   Util: extraire texte Responses API
   ========================== */
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

// Banque structurée (ta liste actuelle)
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
  { cat: "utile", tags: ["deco","zen"], urgentOk: true, min: 20, max: 160, text: "Un rangement discret pour entrée (vide-poches design, mais sobre)" },
  { cat: "utile", tags: ["deco","zen"], urgentOk: true, min: 20, max: 160, text: "Un cadre photo premium + impression (look galerie)" },
  { cat: "utile", tags: ["voyage"], urgentOk: true, min: 15, max: 80, text: "Un parapluie compact solide (anti-retournement) – utile toute l’année" },

  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 120, text: "Un kit DIY linogravure (outils + blocs) pour créer des tampons" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 90, text: "Un kit broderie moderne (motif minimal, pas ‘grand-mère’)" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 90, text: "Un kit aquarelle débutant (papier + pinceaux + palette simple)" },
  { cat: "creatif", tags: ["creatif"], urgentOk: true, min: 15, max: 80, text: "Un kit calligraphie/brush lettering (2 feutres + guide)" },
  { cat: "creatif", tags: ["creatif","deco"], urgentOk: true, min: 20, max: 140, text: "Un kit poterie auto-durcissante + outils (création maison)" },
  { cat: "creatif", tags: ["creatif","zen"], urgentOk: true, min: 15, max: 90, text: "Un kit terrarium simple (plantes + bocal) à monter" },

  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 20, max: 220, text: "Un objet déco signature (affiche, mobile, vase) aligné avec son style" },
  { cat: "deco", tags: ["deco","zen"], urgentOk: true, min: 25, max: 220, text: "Un mini ‘coin zen’ cohérent (plaid + lumière douce + petit élément)" },

  { cat: "tech", tags: ["tech","bureau"], urgentOk: true, min: 20, max: 120, text: "Un support de charge multi-appareils (setup clean, sans marque)" },
  { cat: "tech", tags: ["tech","bureau"], urgentOk: true, min: 15, max: 90, text: "Un hub USB/organisateur de câbles (bureau propre)" },

  { cat: "culture", tags: ["culture","fun"], urgentOk: true, min: 15, max: 80, text: "Un livre vraiment ciblé + un accessoire lecture (pince-livre / marque-page premium)" },
  { cat: "culture", tags: ["culture","fun"], urgentOk: true, min: 15, max: 90, text: "Un jeu narratif / enquête à faire à la maison (choisi selon style)" },
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

  if (urgent) candidates = candidates.filter((x) => x.urgentOk);
  if (budgetMax != null) candidates = candidates.filter((x) => x.min <= budgetMax);

  if (tags.length) {
    const tagged = candidates.filter((x) => x.tags.some((t) => tags.includes(t)));
    if (tagged.length >= 8) candidates = tagged;
  }

  // évite de resservir les mêmes axes dans la session
  const filtered = candidates.filter((x) => !recentSet.has(x.text));
  if (filtered.length >= 8) candidates = filtered;

  // impose 2 catégories différentes
  const groupA = candidates.filter((x) => x.cat === "experience" || x.cat === "emotion");
  const groupB = candidates.filter((x) => x.cat !== "experience" && x.cat !== "emotion");

  const A = groupA.length ? groupA : IDEA_BANK.filter((x) => x.cat === "experience" || x.cat === "emotion");
  const B = groupB.length ? groupB : IDEA_BANK.filter((x) => x.cat !== "experience" && x.cat !== "emotion");

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

   /* ==========================
   LEMON WEBHOOK (signature + log DB)
   ========================== */

   app.post("/webhooks/lemon", async (req, res) => {
  try {
    if (!verifyLemonSignature(req)) return res.status(401).send("Invalid signature");

    const payload = req.body;
    const eventName = payload?.meta?.event_name || "unknown";
    const eventId = String(payload?.data?.id || "");

    // log brut (optionnel mais utile)
    try {
      await initDb();
      const pool = getPool();
      if (pool) {
        await pool.query(
          `
          INSERT INTO mg_webhook_events (event_id, event_name, payload, status)
          VALUES ($1,$2,$3::jsonb,'received')
          ON CONFLICT DO NOTHING
          `,
          [eventId, eventName, JSON.stringify(payload)]
        );
      }
    } catch (e) {
      console.log("webhook log insert skipped:", e?.message || e);
    }

    // traitement accès
    if (eventName === "license_key_created") {
      await upsertAccessFromLicenseKey(payload);
    }
    if (eventName.startsWith("subscription_")) {
      await updateAccessFromSubscription(payload);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[/webhooks/lemon] ERROR", e?.message || e);
    return res.status(500).json({ ok: false });
  }
});

function verifyLemonSignature(req) {
  const secret = LEMON_WEBHOOK_SECRET;
  const sig = req.get("x-signature") || ""; // Lemon envoie "X-Signature"
  if (!secret || !sig || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");

  try {
    return (
      digest.length === sig.length &&
      crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(sig, "utf8"))
    );
  } catch {
    return false;
  }
}

app.post("/webhooks/lemon", async (req, res) => {
  const receivedAt = new Date();

  try {
    // 1) vérif signature
    if (!verifyLemonSignature(req)) {
      return res.status(401).send("Bad signature");
    }

    // 2) payload
    const event = req.body || {};

    // IDs (varie selon event)
    const eventId =
      event?.meta?.event_id ||
      event?.meta?.id ||
      event?.data?.id ||
      event?.id ||
      null;

    const eventName =
      event?.meta?.event_name ||
      event?.meta?.name ||
      event?.event_name ||
      event?.name ||
      event?.type ||
      null;

    // 3) log DB (table déjà créée chez toi)
    await initDb(); // garde ta logique DB
    const pool = getPool();
    if (!pool) return res.status(500).send("DB disabled");

    await pool.query(
      `
      INSERT INTO mg_webhook_events (event_id, event_name, received_at, payload, status)
      VALUES ($1, $2, $3, $4::jsonb, 'received')
      ON CONFLICT (event_id) DO NOTHING
      `,
      [eventId, eventName, receivedAt.toISOString(), JSON.stringify(event)]
    );

    return res.sendStatus(200);
  } catch (e) {
    console.error("LEMON WEBHOOK ERROR:", e?.message || e);
    return res.sendStatus(500);
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "MagicGiftAI backend",
    time: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    portEnv: process.env.PORT || null,
    dbEnabled: Boolean(DATABASE_URL),
  });
});
// Lemon webhook
app.post("/webhooks/lemon", async (req, res) => {
  try {
    const payload = req.body || {};

    // 1) signature check
    const v = verifyLemonSignature(req);
    if (!v.ok) {
      console.warn("[LEMON] invalid signature:", v.reason);
      return res.status(401).json({ ok: false });
    }

    // 2) basics
    const { eventName, eventId } = extractLemonBasics(req, payload);

    // 3) store raw event (idempotent)
    await initDb();
    const pool = getPool();
    if (!pool) return res.status(500).json({ ok: false });

    const ins = await pool.query(
      `
      INSERT INTO mg_webhook_events (event_id, event_name, payload, status)
      VALUES ($1,$2,$3::jsonb,'received')
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id
      `,
      [eventId, eventName, JSON.stringify(payload)]
    );

    if (ins.rowCount === 0) {
      // duplicate => on répond 200 (Lemon retente sinon)
      return res.json({ ok: true, duplicate: true });
    }

    // 4) extract useful fields
    const attrs = getDeep(payload, ["data", "attributes"]) || {};
    const productKey = extractProductKey(payload);
    const { plan, durationHours } = detectPlan(productKey);

    const email = pickFirst(
      attrs.user_email,
      attrs.customer_email,
      attrs.email,
      getDeep(payload, ["meta", "customer_email"])
    );

    const customerId = pickFirst(
      attrs.customer_id,
      getDeep(payload, ["data", "relationships", "customer", "data", "id"])
    );

    const orderId = pickFirst(
      attrs.order_id,
      (payload?.data?.type === "orders" ? payload?.data?.id : ""),
      getDeep(payload, ["data", "relationships", "order", "data", "id"])
    );

    const subscriptionId = pickFirst(
      attrs.subscription_id,
      (payload?.data?.type === "subscriptions" ? payload?.data?.id : ""),
      getDeep(payload, ["data", "relationships", "subscription", "data", "id"])
    );

    const licenseKey = pickFirst(
      attrs.license_key,
      attrs.key,
      attrs.license_key_key,
      getDeep(payload, ["data", "attributes", "key"])
    );

    // 5) decide status + expiry
    const now = new Date();
    let status = "pending";
    let startsAt = asDate(attrs.created_at) || now;
    let expiresAt = null;

    const ev = String(eventName || "").toLowerCase();

    if (ev === "order_created" || ev === "order_paid" || ev === "license_key_created") {
      status = "active";
      if (plan === "48h" && durationHours) {
        expiresAt = new Date(now.getTime() + durationHours * 3600 * 1000);
      }
    }

    if (ev === "subscription_created" || ev === "subscription_payment_success" || ev === "subscription_resumed") {
      status = "active";
    }

    if (ev === "subscription_cancelled") {
      // idéalement: actif jusqu'à la fin de période (si Lemon donne une date)
      status = "cancelled";
      expiresAt = asDate(attrs.ends_at) || asDate(attrs.renews_at) || null;
    }

    if (ev === "subscription_expired") {
      status = "expired";
      expiresAt = now;
    }

    if (ev === "subscription_paused") {
      status = "paused";
    }

    if (ev === "order_refunded" || ev === "order_refund" || ev === "order_refinanced") {
      status = "revoked";
      expiresAt = now;
    }

    // 6) upsert mg_access
    await upsertAccess(pool, {
      email,
      customer_id: customerId,
      order_id: orderId,
      subscription_id: subscriptionId,
      license_key: licenseKey,
      product_sku: productKey,
      status,
      starts_at: startsAt,
      expires_at: expiresAt,
      meta: {
        plan,
        eventName,
        productKey,
      },
    });

    // 7) mark processed
    await pool.query(
      `UPDATE mg_webhook_events SET processed_at = now(), status='processed' WHERE event_id=$1`,
      [eventId]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("[/webhooks/lemon] ERROR:", e?.message || e);
    try {
      const payload = req.body || {};
      const { eventId } = extractLemonBasics(req, payload);
      const pool = getPool();
      if (pool) {
        await pool.query(
          `UPDATE mg_webhook_events SET processed_at=now(), status='error', error=$2 WHERE event_id=$1`,
          [eventId, String(e?.message || e)]
        );
      }
    } catch {}
    return res.status(200).json({ ok: true }); // 200 pour éviter les retries infinis
  }
});

// Check access (utile pour ton front)
app.post("/access/check", async (req, res) => {
  try {
    const licenseKey = String(req.body?.licenseKey || req.get("x-license-key") || "").trim();
    const email = String(req.body?.email || req.get("x-buyer-email") || "").trim();

    if (!licenseKey && !email) {
      return res.status(400).json({ ok: false, error: "Missing licenseKey/email" });
    }

    const r = await findActiveAccess({ licenseKey, email });
    return res.json({
      ok: true,
      active: !!r.active,
      reason: r.active ? null : r.reason,
      expiresAt: r?.row?.expires_at || null,
      plan: r?.row?.meta?.plan || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Backend error" });
  }
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

// Admin: test DB
app.get("/admin/db-ping", requireAdmin, async (req, res) => {
  try {
    await initDb();
    const pool = getPool();
    if (!pool) return res.status(500).json({ ok: false, error: "DB disabled (DATABASE_URL missing)" });
    const r = await pool.query("SELECT now() AS now");
    res.json({ ok: true, now: r.rows[0].now, promptVersion: PROMPT_VERSION });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Vote conversion
 * body: { sessionId, conversationId, searchId, type }
 * type: conv_validated | conv_invalidated
 */
app.post("/event", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "no-session").slice(0, 80);
    const conversationId = String(req.body?.conversationId || "").slice(0, 120);
    const searchId = String(req.body?.searchId || "").slice(0, 120);
    const type = String(req.body?.type || "").trim();

    if (!conversationId || !searchId) {
      return res.status(400).json({ ok: false, error: "Missing conversationId/searchId" });
    }

    const allowed = new Set(["conv_validated", "conv_invalidated"]);
    if (!allowed.has(type)) return res.status(400).json({ ok: false, error: "Invalid event type" });

    const r = await logEvent({ sessionId, conversationId, searchId, eventType: type });
    return res.json({ ok: true, stored: !!r?.stored });
  } catch (e) {
    console.error("[/event] ERROR", e?.message || e);
    return res.status(500).json({ ok: false, error: "Backend error" });
  }
});

// Alias compatible : verdict valid/invalid => conv_validated/conv_invalidated
app.post("/feedback", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "no-session").slice(0, 80);
    const conversationId = String(req.body?.conversationId || "").slice(0, 120);
    const searchId = String(req.body?.searchId || "").slice(0, 120);
    const verdict = String(req.body?.verdict || "").toLowerCase().trim();

    if (!conversationId || !searchId) {
      return res.status(400).json({ ok: false, error: "Missing conversationId/searchId" });
    }

    if (!["valid", "invalid"].includes(verdict)) {
      return res.status(400).json({ ok: false, error: "verdict must be 'valid' or 'invalid'" });
    }

    const type = verdict === "valid" ? "conv_validated" : "conv_invalidated";
    const r = await logEvent({ sessionId, conversationId, searchId, eventType: type });
    return res.json({ ok: true, stored: !!r?.stored });
  } catch (e) {
    console.error("[/feedback] ERROR", e?.message || e);
    return res.status(500).json({ ok: false, error: "Backend error" });
  }
});

async function requireAccess(req, res, next) {
  try {
    const key = req.get(ACCESS_HEADER) || req.query.key || "";
    const ok = await checkAccessKey(key);
    if (!ok.ok) return res.status(403).json({ ok: false, error: "Access denied", reason: ok.reason });
    next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Access check failed" });
  }
}

app.post("/chat", requireValidLicense, async (req, res) => {
  const t0 = Date.now();
  const sessionId = String(req.body?.sessionId || "no-session").slice(0, 80);
  const conversationId = String(req.body?.conversationId || "").slice(0, 120);
  const searchId = String(req.body?.searchId || "search-0").slice(0, 120);

  try {
    const userMessage = String(req.body?.message || "").trim();
        // ✅ BLOQUAGE ACCÈS (payant)
    if (ACCESS_REQUIRED) {
      const licenseKey = String(req.body?.licenseKey || req.get("x-license-key") || "").trim();
      const email = String(req.body?.email || req.get("x-buyer-email") || "").trim();

      const access = await findActiveAccess({ licenseKey, email });
      if (!access.active) {
        return res.status(403).json({
          ok: false,
          error: "Accès non actif. Entre ta licence (ou ton email d’achat).",
          code: "ACCESS_DENIED",
          promptVersion: PROMPT_VERSION,
        });
      }
    }

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

    // log request (non bloquant)
    void logEvent({ sessionId, conversationId,searchId, eventType: "chat_request", meta: { len: userMessage.length } });

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
    const contextText = [...rawHistory.map((m) => m.content), userMessage].join(" ");

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
      const msErr = Date.now() - t0;
      console.error("OpenAI error:", r.status, JSON.stringify(data));
      void logEvent({ sessionId, conversationId, eventType: "chat_upstream_error", ms: msErr, meta: { status: r.status } });
      return res.status(502).json({ ok: false, error: "Upstream error", promptVersion: PROMPT_VERSION });
    }

    const answer = extractOutputText(data);
    if (!answer) {
      const msErr = Date.now() - t0;
      void logEvent({ sessionId, conversationId, eventType: "chat_empty_answer", ms: msErr });
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

    // log response (non bloquant)
    void logEvent({ sessionId, conversationId,searchId, eventType: "chat_response", ms });

    return res.json({ ok: true, answer: clean, promptVersion: PROMPT_VERSION, sessionId, conversationId, searchId });
  } catch (err) {
    const msErr = Date.now() - t0;
    console.error("[/chat] ERROR", err);
    void logEvent({ sessionId, conversationId, eventType: "chat_backend_error", ms: msErr });

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
