// Payments go to a monobank jar (банка) on a personal account.
//
// 1. /buy/<slug> creates an order with a secret token (URL credential) and a 6-digit code.
// 2. The buyer pays the price into the jar and writes the code in the jar's comment field.
// 3. monobank's personal API tells us about the payment:
//      - webhook  POST /api/mono-hook/<MONO_HOOK_SECRET>  (instant), and
//      - polling the jar statement: every 5 min by the cron trigger, and while a buyer is waiting
//        (max once per 61 s, API limit). Polling resumes from where the last successful poll
//        ended, so payments that arrived during an outage are still picked up.
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
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS txs_time ON txs (time)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`),
      env.DB.prepare(`INSERT OR IGNORE INTO meta (k, v) VALUES ('last_poll', 0)`),
      // Every jar transaction up to this time has been processed (advanced by successful polls).
      env.DB.prepare(`INSERT OR IGNORE INTO meta (k, v) VALUES ('polled_to', 0)`),
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
// Saving the transaction and crediting the order happen in one D1 batch (a single transaction):
// if anything fails, neither is saved, so a later webhook retry or poll processes it again.
export async function recordTx(env, account, item) {
  const jarId = catalog.site.jar_account_id;
  if (!jarId || account !== jarId || !item || !item.id || !(item.amount > 0)) return false;
  const d = await db(env);
  const id = String(item.id);
  const comment = String(item.comment || "");
  const description = String(item.description || "");

  const codes = [...new Set(`${comment} ${description}`.match(CODE_RE) || [])].slice(0, 5);
  const order = codes.length
    ? await d.prepare(
      `SELECT token FROM orders WHERE code IN (${codes.map(() => "?").join(",")}) ORDER BY created DESC LIMIT 1`,
    ).bind(...codes).first()
    : null;

  const insert = d.prepare(
    "INSERT OR IGNORE INTO txs (id, amount, comment, description, time, order_token) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, item.amount, comment, description, item.time || now(), order ? order.token : null);
  if (!order) {
    await insert.run();
    return false;
  }

  // The UPDATE runs first and only if this transaction id hasn't been stored yet, so a repeat
  // delivery can never credit the order twice.
  const [credit] = await d.batch([
    d.prepare(`UPDATE orders SET
        paid_kop = paid_kop + ?,
        status = CASE WHEN paid_kop + ? >= price_kop THEN 'paid' ELSE 'underpaid' END,
        paid_at = COALESCE(paid_at, ?)
      WHERE token = ? AND NOT EXISTS (SELECT 1 FROM txs WHERE id = ?)`)
      .bind(item.amount, item.amount, now(), order.token, id),
    insert,
  ]);
  return !!(credit.meta && credit.meta.changes);
}

const POLL_OVERLAP = 3600;          // re-read the last hour too, in case a transaction shows up late
const POLL_MAX_LOOKBACK = 31 * 86400; // monobank allows at most 31 days + 1 h per statement request
const POLL_MAX_NEW = 10;            // stays well inside D1's 50-queries-per-invocation limit (free plan)
const STATEMENT_MAX_ITEMS = 500;    // monobank returns at most this many transactions per request

// Read the jar statement and process anything the webhook missed. Runs from the cron trigger
// every 5 minutes and while a buyer waits on /pay/.
// monobank allows 1 statement request per 60 s per token, so we claim a global slot in D1 first.
export async function pollJar(env) {
  const jarId = catalog.site.jar_account_id;
  if (!env.MONO_PERSONAL_TOKEN || !jarId) return;
  const d = await db(env);
  const t = now();
  const claim = await d.prepare("UPDATE meta SET v = ? WHERE k = 'last_poll' AND v <= ?").bind(t, t - 61).run();
  if (!claim.meta || !claim.meta.changes) return; // someone polled less than a minute ago

  // Start where the last successful poll ended, so an outage of any length (up to 31 days) is covered.
  const mark = await d.prepare("SELECT v FROM meta WHERE k = 'polled_to'").first();
  const from = Math.max((mark ? mark.v : 0) - POLL_OVERLAP, t - POLL_MAX_LOOKBACK);
  const res = await fetch(`${API}/personal/statement/${encodeURIComponent(jarId)}/${from}/${t}`, {
    headers: { "X-Token": env.MONO_PERSONAL_TOKEN },
  });
  if (!res.ok) {
    console.error("jar statement", res.status, await res.text().catch(() => ""));
    return;
  }
  const body = await res.json().catch(() => null);
  const items = Array.isArray(body) ? body : [];
  if (items.length >= STATEMENT_MAX_ITEMS) {
    console.error(`jar statement returned ${items.length} items (API maximum): check older payments by hand`);
  }

  // Skip transactions we already have; process the rest oldest first, a few per run.
  const known = new Set(
    (await d.prepare("SELECT id FROM txs WHERE time >= ?").bind(from).all()).results.map((r) => r.id),
  );
  const fresh = items
    .filter((it) => it && it.id && it.amount > 0 && !known.has(String(it.id)))
    .sort((a, b) => (a.time || 0) - (b.time || 0));
  const batch = fresh.slice(0, POLL_MAX_NEW);
  for (const it of batch) await recordTx(env, jarId, it);

  // Everything up to `done` is processed. If the run was cut short, the next poll continues from there.
  const done = fresh.length > batch.length ? batch[batch.length - 1].time || from : t;
  await d.prepare("UPDATE meta SET v = ? WHERE k = 'polled_to' AND v < ?").bind(done, done).run();
}

export function jarPayUrl(order, amountKop) {
  const u = new URL(catalog.site.jar_url);
  u.searchParams.set("a", String(Math.ceil(amountKop / 100)));
  u.searchParams.set("t", order.code);
  return u.toString();
}
