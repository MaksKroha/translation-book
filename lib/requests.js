// Translation requests ("Замовити переклад", build.py → request_page): a visitor asks for a book,
// the request is saved in D1 and emailed to you through Resend (https://resend.com).
//
// - Saved first, emailed second, so a request is never lost. If the email fails (Resend down, the
//   RESEND_API_KEY secret missing, the daily cap reached), emailed_at stays empty and the 5-minute
//   cron (src/worker.js → scheduled) sends it later, a few per run.
// - Quotas: at most site.requests_emails_per_day emails per 24 hours (Resend's free plan allows 100),
//   at most NEW_PER_DAY new requests per 24 hours from everyone together, and PER_VISITOR_PER_DAY
//   from one email address. The form itself has the same Origin + Turnstile checks as Buy.
// - Personal data: only the form fields are stored, and the cron deletes requests older than
//   KEEP_DAYS. Nothing the visitor typed is written to the logs.
//
// Table translation_requests (created automatically):
//   id          the number in the email subject (never reused, so old emails never point elsewhere),
//   created (unix time), title, author, link, email, comment,
//   emailed_at  when the email to you went out (empty = not yet; the cron retries),
//   tried_at    last send attempt,
//   status      'new'; you set 'done' or 'declined' in the D1 console (SQL in PIPELINE.md).
import catalog from "./catalog.generated.js";
import { esc } from "./html.js";

const RESEND = "https://api.resend.com/emails";
const PER_VISITOR_PER_DAY = 5;
const NEW_PER_DAY = 100;  // protects the free database quota if someone gets past Turnstile
const RETRY_PER_RUN = 3;  // emails per cron run (the run shares D1's 50-queries limit with the jar poll)
const KEEP_DAYS = 180;
const SENDING = 60;       // seconds one send attempt may take; a retry waits at least this long
const DAY = 86400;

export const LIMITS = { title: 200, author: 200, link: 500, email: 254, comment: 1000 };

const now = () => Math.floor(Date.now() / 1000);
let schemaReady = false;

async function table(env) {
  if (!env.DB) throw new Error("D1 binding 'DB' is not configured");
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS translation_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL,
        title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
        emailed_at INTEGER, tried_at INTEGER, status TEXT NOT NULL DEFAULT 'new')`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS translation_requests_created ON translation_requests (created)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS translation_requests_emailed ON translation_requests (emailed_at)"),
    ]);
    schemaReady = true;
  }
  return env.DB;
}

// --- Checking the form ---------------------------------------------------------------------------

// The browser's own rule for <input type="email">, plus a required dot in the domain.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// Control characters, Unicode line/paragraph separators, and the invisible marks that flip text
// direction (used to disguise text).
const CONTROL_RE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
const CONTROL_EXCEPT_NEWLINE_RE = /(?!\n)[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

// Returns { data } with the cleaned fields, or { errors } with messages for the visitor.
export function validateRequest(form) {
  const get = (name) => {
    const v = form && form.get(name);
    return typeof v === "string" ? v : "";
  };
  const errors = [];
  // Title, author and email end up in email headers (subject, Reply-To), where a line break could
  // add headers of its own. Browsers never send line breaks in these fields, so refuse them.
  const oneLine = (name, label) => {
    const v = get(name);
    if (/[\r\n]/.test(v)) errors.push(`${label}: має бути в один рядок.`);
    return v.replace(CONTROL_RE, "").trim();
  };
  const title = oneLine("title", "Назва книги");
  const author = oneLine("author", "Автор");
  const link = oneLine("link", "Посилання");
  const email = oneLine("email", "Email");
  const comment = get("comment").replace(/\r\n?/g, "\n").replace(CONTROL_EXCEPT_NEWLINE_RE, "").trim();

  if (!title) errors.push("Вкажіть назву книги.");
  else if (title.length > LIMITS.title) errors.push(`Назва книги — до ${LIMITS.title} символів.`);
  if (author.length > LIMITS.author) errors.push(`Автор — до ${LIMITS.author} символів.`);

  let href = "";
  if (link) {
    let u = null;
    try { u = new URL(link); } catch { /* not a URL */ }
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) {
      errors.push("Посилання має починатися з https:// (або http://).");
    } else if (link.length > LIMITS.link || u.href.length > LIMITS.link) {
      errors.push(`Посилання — до ${LIMITS.link} символів.`);
    } else {
      href = u.href;
    }
  }

  if (!email) errors.push("Вкажіть email — на нього ми напишемо, коли переклад буде готовий.");
  else if (email.length > LIMITS.email || email.indexOf("@") > 64 || !EMAIL_RE.test(email)) {
    errors.push("Перевірте email: схоже, в ньому помилка.");
  }
  if (comment.length > LIMITS.comment) errors.push(`Коментар — до ${LIMITS.comment} символів.`);

  return errors.length ? { errors } : { data: { title, author, link: href, email, comment } };
}

// --- Saving ---------------------------------------------------------------------------------------

// Saves a checked request. Returns { id }, or { limited: "visitor" | "site" } over a daily limit.
export async function saveRequest(env, r) {
  const d = await table(env);
  const t = now();
  const today = await d.prepare(`SELECT COUNT(*) AS total,
      COUNT(CASE WHEN lower(email) = lower(?) THEN 1 END) AS visitor
      FROM translation_requests WHERE created > ?`).bind(r.email, t - DAY).first();
  if (today.visitor >= PER_VISITOR_PER_DAY) return { limited: "visitor" };
  if (today.total >= NEW_PER_DAY) return { limited: "site" };
  const res = await d.prepare(
    "INSERT INTO translation_requests (created, title, author, link, email, comment) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(t, r.title, r.author, r.link, r.email, r.comment).run();
  return { id: res.meta.last_row_id };
}

// --- Emailing -------------------------------------------------------------------------------------

function emailsPerDay() {
  const n = Number(catalog.site.requests_emails_per_day);
  return Number.isInteger(n) && n > 0 ? n : 50;
}

function kyivTime(t) {
  const d = new Date(t * 1000);
  try {
    const opts = { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" };
    return `${d.toLocaleString("uk-UA", opts)} (за Києвом)`;
  } catch {
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

// A mailto: link with a prefilled subject and body. The address passed EMAIL_RE, but may still hold
// characters such as ? or &, so it's encoded too (except the @). Line breaks in the body are sent
// as CR LF, as the mailto standard (RFC 6068) asks.
const mailto = (to, subject, body) =>
  `mailto:${encodeURIComponent(to).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}`
  + `&body=${encodeURIComponent(body.replace(/\n/g, "\r\n"))}`;

// The email to you. Built only from the saved row, so a retry sends exactly the same email.
export function requestEmail(r) {
  const site = catalog.site;
  const book = `«${r.title}»${r.author ? ` (${r.author})` : ""}`;
  const subject = `[Запит на переклад] #${r.id} ${r.title}${r.author ? ` — ${r.author}` : ""}`;
  const ready = mailto(r.email, `Переклад «${r.title}» готовий`,
    `Добрий день!\n\nВи просили український переклад книги ${book}. Він готовий:\n`
    + `${site.url}/АДРЕСА-КНИГИ/\n\nДякуємо, що звернулися!\n${site.name}`);
  const decline = mailto(r.email, `Переклад «${r.title}»`,
    `Добрий день!\n\nДякуємо за запит на переклад книги ${book}. На жаль, цього разу ми не зможемо `
    + `взятися за цю книгу.\n\nКниги, які вже є українською: ${site.url}/\n\nЗ повагою,\n${site.name}`);
  const done = `UPDATE translation_requests SET status = 'done' WHERE id = ${r.id};`;
  const fields = [
    ["Книга", r.title],
    ["Автор", r.author || "—"],
    ["Посилання", r.link || "—"],
    ["Email", r.email],
    ["Надіслано", kyivTime(r.created)],
  ];

  const text = [
    `Запит на переклад #${r.id}`, "",
    ...fields.map(([k, v]) => `${k}: ${v}`),
    "Коментар:", r.comment || "—", "",
    "Щоб відповісти відвідувачеві, просто натисніть «Відповісти».", "",
    "Переклад готовий — лист-заготовка (замініть АДРЕСА-КНИГИ на адресу сторінки книги):", ready, "",
    "Не можемо взятися — лист-заготовка:", decline, "",
    "Позначити виконаним (Cloudflare → D1 → bookstore → Console):", done,
  ].join("\n");

  const html = `<p><strong>Запит на переклад #${r.id}</strong></p>
<p>${fields.map(([k, v]) => `${k}: ${k === "Посилання" && r.link ? `<a href="${esc(r.link)}">${esc(v)}</a>` : esc(v)}`).join("<br>\n")}</p>
<p>Коментар:</p>
<p style="white-space:pre-wrap">${esc(r.comment || "—")}</p>
<p>Щоб відповісти відвідувачеві, просто натисніть «Відповісти».</p>
<p><a href="${esc(ready)}">Написати: переклад готовий</a> (замініть АДРЕСА-КНИГИ на адресу сторінки книги)<br>
<a href="${esc(decline)}">Написати: не можемо взятися</a></p>
<p>Позначити виконаним (Cloudflare → D1 → bookstore → Console):<br><code>${esc(done)}</code></p>`;

  return { subject, text, html };
}

// Resend's error, with any email address in it blanked out, so logs never hold one.
async function resendError(res) {
  const body = await res.json().catch(() => ({}));
  const msg = String(body.message || "").replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, "<email>");
  return `HTTP ${res.status} ${body.name || ""} ${msg}`.trim();
}

// Emails one request to you. Returns true if Resend accepted it; false if it's already sent,
// another run is sending it right now, the daily cap is reached, or sending failed.
export async function deliver(env, id) {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set: translation requests are saved but not emailed (PIPELINE.md, step 3.7)");
    return false;
  }
  const d = await table(env);
  const t = now();
  // Claim the request in one statement, so two runs can't both send it and the cap can't be
  // overshot. The cap counts emails sent in the last 24 hours plus sends in progress.
  const claim = await d.prepare(`UPDATE translation_requests SET tried_at = ?1
      WHERE id = ?2 AND emailed_at IS NULL AND (tried_at IS NULL OR tried_at <= ?1 - ?3)
        AND (SELECT COUNT(*) FROM translation_requests WHERE emailed_at > ?1 - ?4)
          + (SELECT COUNT(*) FROM translation_requests WHERE emailed_at IS NULL AND tried_at > ?1 - ?3) < ?5`)
    .bind(t, id, SENDING, DAY, emailsPerDay()).run();
  if (!claim.meta || !claim.meta.changes) return false;

  const r = await d.prepare("SELECT * FROM translation_requests WHERE id = ?").bind(id).first();
  const { subject, text, html } = requestEmail(r);
  let res;
  try {
    res = await fetch(RESEND, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: catalog.site.requests_from,
        to: [catalog.site.requests_email],
        reply_to: r.email, // a plain "Reply" in Gmail answers the visitor
        subject, text, html,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error(`translation request #${id}: Resend unreachable (${e.name}), the cron will retry`);
    return false;
  }
  if (!res.ok) {
    console.error(`translation request #${id}: Resend refused it, the cron will retry:`, await resendError(res));
    return false;
  }
  await d.prepare("UPDATE translation_requests SET emailed_at = ? WHERE id = ?").bind(now(), id).run();
  return true;
}

// Cron step (every 5 minutes): delete old requests, then email the ones still waiting. The
// least recently tried go first, so one request that keeps failing can't hold up the others.
export async function requestsCron(env) {
  if (!env.DB) return;
  const d = await table(env);
  await d.prepare("DELETE FROM translation_requests WHERE created < ?").bind(now() - KEEP_DAYS * DAY).run();
  const { results } = await d.prepare(
    "SELECT id FROM translation_requests WHERE emailed_at IS NULL ORDER BY COALESCE(tried_at, 0), id LIMIT ?",
  ).bind(RETRY_PER_RUN).all();
  for (const { id } of results) {
    if (!(await deliver(env, id))) break; // key missing, Resend down or daily cap reached: next run
  }
}
