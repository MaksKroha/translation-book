// Payments go to a monobank jar (банка) on a personal account.
//
// 1. /buy/<slug> creates an order with a secret token (URL credential) and a 6-digit code.
// 2. The buyer pays the price into the jar and writes the code in the jar's comment field.
// 3. monobank's personal API tells us about the payment:
//      - webhook  POST /api/mono-hook/<MONO_HOOK_SECRET>  (instant), and
//      - fallback: polling the jar statement (max once per 61 s, API limit) when a buyer is waiting.
// 4. A matching payment with enough money marks the order paid → download unlocked.
//
// Storage: Cloudflare D1 (binding name DB). Tables are created automatically.
import catalog from "./catalog.generated.js";

const API = "https://api.monobank.ua";
let schemaReady = false;

export async function db(env) {
  if (!env.DB) throw new Error("D1 binding 'DB' is not configured");
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (
        token TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, slug TEXT NOT NULL,
        price_kop INTEGER NOT NULL, paid_kop INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, paid_at INTEGER)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS txs (
        id TEXT PRIMARY KEY, amount INTEGER NOT NULL, comment TEXT, description TEXT,
        time INTEGER, order_token TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`),
      env.DB.prepare(`INSERT OR IGNORE INTO meta (k, v) VALUES ('last_poll', 0)`),
    ]);
    schemaReady = true;
  }
  return env.DB;
}

const now = () => Math.floor(Date.now() / 1000);

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomCode() {
  return String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export async function createOrder(env, slug) {
  const book = catalog.books[slug];
  const d = await db(env);
  const token = randomToken();
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    try {
      await d.prepare("INSERT INTO orders (token, code, slug, price_kop, created) VALUES (?, ?, ?, ?, ?)")
        .bind(token, code, slug, book.price_kop, now()).run();
      return { token, code };
    } catch (e) {
      if (!String(e && e.message).includes("UNIQUE")) throw e;
    }
  }
  throw new Error("could not allocate an order code");
}

export async function getOrder(env, token) {
  if (!TOKEN_RE.test(token || "")) return null;
  const d = await db(env);
  const o = await d.prepare("SELECT * FROM orders WHERE token = ?").bind(token).first();
  if (!o || !catalog.books[o.slug]) return null;
  return { ...o, book: catalog.books[o.slug] };
}

// Codes are 6 digits standing alone (not part of a longer number such as a card or phone).
const CODE_RE = /(?<!\d)\d{6}(?!\d)/g;

// Process one statement item from the jar (webhook or polling). Idempotent per transaction id.
export async function recordTx(env, account, item) {
  const jarId = catalog.site.jar_account_id;
  if (!jarId || account !== jarId || !item || !item.id || !(item.amount > 0)) return false;
  const d = await db(env);
  const comment = String(item.comment || "");
  const description = String(item.description || "");
  const ins = await d.prepare("INSERT OR IGNORE INTO txs (id, amount, comment, description, time) VALUES (?, ?, ?, ?, ?)")
    .bind(String(item.id), item.amount, comment, description, item.time || now()).run();
  if (!ins.meta || !ins.meta.changes) return false; // already processed

  const codes = [...new Set(`${comment} ${description}`.match(CODE_RE) || [])].slice(0, 5);
  if (!codes.length) return false;
  const order = await d.prepare(
    `SELECT token FROM orders WHERE code IN (${codes.map(() => "?").join(",")}) ORDER BY created DESC LIMIT 1`,
  ).bind(...codes).first();
  if (!order) return false;

  await d.batch([
    d.prepare("UPDATE txs SET order_token = ? WHERE id = ?").bind(order.token, String(item.id)),
    d.prepare(`UPDATE orders SET
        paid_kop = paid_kop + ?,
        status = CASE WHEN paid_kop + ? >= price_kop THEN 'paid' ELSE 'underpaid' END,
        paid_at = COALESCE(paid_at, ?)
      WHERE token = ?`).bind(item.amount, item.amount, now(), order.token),
  ]);
  return true;
}

// Fallback when the webhook is missing or slow: read the jar statement.
// monobank allows 1 statement request per 60 s per token, so we claim a global slot in D1 first.
export async function pollJar(env) {
  const jarId = catalog.site.jar_account_id;
  if (!env.MONO_PERSONAL_TOKEN || !jarId) return;
  const d = await db(env);
  const t = now();
  const claim = await d.prepare("UPDATE meta SET v = ? WHERE k = 'last_poll' AND v <= ?").bind(t, t - 61).run();
  if (!claim.meta || !claim.meta.changes) return; // someone polled less than a minute ago
  const res = await fetch(`${API}/personal/statement/${encodeURIComponent(jarId)}/${t - 6 * 3600}`, {
    headers: { "X-Token": env.MONO_PERSONAL_TOKEN },
  });
  if (!res.ok) {
    console.error("jar statement", res.status, await res.text().catch(() => ""));
    return;
  }
  const items = await res.json().catch(() => []);
  for (const it of Array.isArray(items) ? items : []) await recordTx(env, jarId, it);
}

export function jarPayUrl(order, amountKop) {
  const u = new URL(catalog.site.jar_url);
  u.searchParams.set("a", String(Math.ceil(amountKop / 100)));
  u.searchParams.set("t", order.code);
  return u.toString();
}
