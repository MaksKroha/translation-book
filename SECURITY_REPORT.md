# Security review: translation-book e-book store

Reviewed 2026-11-11 · code at commit `54b097b` · live site https://translation-book.vladyslavzariskyi.workers.dev
Scope: find only. No files were changed apart from this report.

## 1. Summary

The core protection works. I couldn't get the PDF without paying: the `/protected/` block held against 18 path tricks, order tokens can't be guessed, and I found no XSS, SQL injection or open redirect. The biggest real risk is **availability**. Anyone can create unlimited orders, even from inside another website, so a few minutes of scripted requests can use up the free Cloudflare database or request quota for the day. Checkout then stops, payments go unrecorded, and monobank may switch your webhook off. The second-biggest problem isn't in the code: the PDF buyers receive says *"Неофіційне видання для особистого користування"*, while the site and the public offer call it an official, licensed translation. **Fix first:** put Cloudflare Turnstile (or a rate limit) on `POST /buy`, add a scheduled poll so a dead webhook can't lose payments, and resolve the "unofficial" wording before you promote the site.

## 2. Findings

| ID | Title | Severity | Status | Location |
|---|---|---|---|---|
| F1 | Anyone can use up the free-tier quotas: checkout and payment detection stop, and the webhook can get switched off | High | Likely (cross-site order creation **Confirmed**) | `functions/buy/[slug].js:7`, `functions/api/mono-hook/[secret].js:20` |
| F2 | The delivered PDF says "unofficial edition", but the site and the offer say "official, licensed" | High | Confirmed | PDF p.2; `build.py:238`, `build.py:357`, `catalog.json:4` |
| F3 | The Worker holds a token that reads all your personal banking data and can redirect your webhook | Medium | Theoretical | `lib/jar.js:109-116` |
| F4 | The build installs unpinned tools that run with access to the PDFs and to your deploy rights | Medium | Theoretical | `requirements.txt:1`, deploy command `npx wrangler deploy` |
| F5 | Payments can be silently lost or credited to the wrong order | Medium | Likely | `lib/jar.js:74-101`, `lib/jar.js:114` |
| F6 | The webhook secret is the only lock, and it ends up in logs and shell history | Low | Likely | `functions/api/mono-hook/[secret].js:6`, `wrangler.jsonc:21`, `tools/monobank.py:73` |
| F7 | Download links never expire and have no download limit | Low | Likely | `functions/download/index.js:16` |
| F8 | The live site and the public offer still say `https://example.com` | Low | Confirmed | `catalog.json:5` |
| F9 | No security headers | Low | Confirmed | `lib/html.js:28`, all responses |
| F10 | The `/pay/` page polls forever and reloads in a loop on errors | Low | Likely | `functions/pay/index.js:61-68` |
| F11 | Malformed URLs crash the Worker, and `__proto__` passes the "book exists" check | Low | Confirmed | `src/worker.js:10,13`, `functions/buy/[slug].js:8` |
| F12 | Personal data: your identity is public; buyers' names and IPs are kept | Info | Confirmed | `catalog.json:6,15`, `lib/jar.js:83` |
| F13 | Business and fraud risks of a personal jar | Info | n/a | n/a |

## 3. Findings in detail

### F1: Anyone can shut down checkout and payment detection for a day (High, Likely)

**What it is.** Every `POST /buy/<slug>` request writes a new row to the database. There is no limit, no bot check, and no check of which website the request came from. The site runs on Cloudflare's free tier, which has hard daily caps:

- D1: 100,000 rows written per day. Each order writes about 3 (the row plus two indexes; PIPELINE.md says the same).
- Workers: 100,000 requests per day.

**How a bad actor would use it.**
1. Run a loop that sends `POST /buy/one-up-on-wall-street-ukrainian`. About 33,000 requests, a few minutes from one laptop, use up the day's database writes. Alternatively, about 100,000 requests to any URL that runs the Worker (`/api/order`, `/pay/`, even a 404 path) use up the request quota.
2. The endpoint accepts posts from any website, so the attacker can hide an auto-submitting form on a busy page and make visitors' browsers create the orders. Those come from thousands of different IPs, which defeats simple per-IP limits.

**Impact.**
- Until the quota resets (00:00 UTC), "Купити" shows an error and waiting buyers' pages can't confirm payment.
- Buyers who pay during the outage don't get the book. They have to email you.
- When the database fails, the webhook handler returns 500. monobank retries after 60 s and after 600 s, and after the third failure **it switches the webhook off** ([monobank docs](https://monobank.ua/api-docs/monobank/kliientski-personalni-dani/post--personal--webhook)). It stays off after the quota resets, and nothing tells you. From then on, only the slow fallback poll works, and it only looks back 6 hours (see F5).
- On a paid plan, the same flood would cost money instead of causing downtime.

**Evidence.**
```js
// functions/buy/[slug].js:16-18: no rate limit, no Origin check, no bot check
const { token } = await createOrder(env, params.slug);        // INSERT INTO orders …
return new Response(null, { status: 303, headers: { Location: `/pay/?o=${token}`, … } });

// functions/api/mono-hook/[secret].js:16-21: any DB error makes monobank count a failed delivery
} catch (e) { console.error(e); return new Response("error", { status: 500 }); }
```
Live test: I sent `POST /buy/one-up-on-wall-street-ukrainian` with `Origin: https://evil.example` and `Sec-Fetch-Site: cross-site`. The site answered `303` to `/pay/?o=<32-char token>`, and the order was created (test code 849683). I did not run a flood; the rules forbid it.

**Suggested fix.**
- Add **Cloudflare Turnstile** (free) to the Buy form in `build.py` → `buy_button()`, and verify its token in `functions/buy/[slug].js` before calling `createOrder`. This is the most effective single change.
- Reject posts from other sites: in `functions/buy/[slug].js`, return 403 unless `Sec-Fetch-Site` is `same-origin` or the `Origin` header equals the site's own origin.
- Add a Workers Rate Limiting binding (`ratelimits` in `wrangler.jsonc`, keyed on `CF-Connecting-IP`, for example 5 orders per minute). Check the docs for availability on your plan. With a custom domain, a free WAF rate-limiting rule also works.
- Make payment detection independent of the webhook. Add a Cron Trigger (`"triggers": { "crons": ["*/5 * * * *"] }` in `wrangler.jsonc`, plus a `scheduled()` handler in `src/worker.js` that calls `pollJar`). Then make the webhook return 200 even when the database fails (after logging the error), so monobank never switches it off; the cron picks up anything the webhook missed.
- If sales grow, the $5/month Workers Paid plan raises the caps. Set a billing alert if you switch.

### F2: The PDF says "unofficial edition", but the site says "official, licensed" (High, Confirmed)

**What it is.** Page 2 of the PDF every buyer downloads says: *"Переклад з англійської. Неофіційне видання для особистого користування."* The site, however, says "офіційний переклад" and "Офіційні українські переклади", and the public offer says the translations were published "на підставі ліцензій, отриманих від правовласників". In your own PIPELINE.md (Phase 0), replacing that line is still an unticked checkbox.

**How a bad actor would use it.** Any buyer, competitor or rights holder (Simon & Schuster or Peter Lynch's agent) can quote the file against the site. Possible moves: a copyright complaint to Cloudflare (which can take down the whole Worker), a complaint to monobank about commercial activity on a personal account, consumer complaints, card disputes ("not as described"), or public posts.

**Impact.** The site could be taken down, your personal bank account could be frozen or limited, you could face refunds, and the legal exposure falls on you personally because your name is on every page. This isn't legal advice. The point is that the contradiction sits in the product itself and is easy to find.

**Evidence.** Line 15 of the `pdftotext` output for `books/book_1/one-up-on-wall-street-by-peter-lynch.uk.pdf`: "Неофіційне видання для особистого користування." Site claims: `build.py:238` (`українська (офіційний переклад)`), `build.py:305`, `build.py:357`, `catalog.json:4`, `catalog.json:39`.

**Suggested fix.** If you have the licence, replace the line in the PDF with your rights line (PIPELINE Phase 0) and rebuild. If you don't have it yet, set `sales_enabled` to `false` and remove the "офіційний" and licence claims until you do.

### F3: The Worker holds a token to your entire personal bank history (Medium, Theoretical)

**What it is.** `MONO_PERSONAL_TOKEN` is stored as a Worker secret so the fallback poll can read the jar statement (`lib/jar.js:114`). The token isn't limited to the jar. It can read:

- your client info: name, all accounts and cards, balances, jars
- the statements of every account

It can also **set the webhook URL** (`tools/monobank.py:60` does exactly that). It can't move money.

**How a bad actor would use it.** Any code running inside your Worker can read `env.MONO_PERSONAL_TOKEN`. Ways to get code there: a compromised build dependency (F4), access to your Cloudflare account, or push access to your GitHub repo (every push deploys). With the token, an attacker could:

- download your transaction history: who you pay, your income, and transfers with counterparties' names
- point the webhook at their own server and receive every future transaction live, which also quietly breaks your store's instant confirmation

**Impact.** A serious loss of privacy for you, and a degraded store.

**Evidence.** `lib/jar.js:114-116`: ``fetch(`${API}/personal/statement/${…}`, { headers: { "X-Token": env.MONO_PERSONAL_TOKEN } })``. PIPELINE.md:65 states the scope ("can read all your personal statements").

**Suggested fix.**
- Decide whether the fallback poll is worth this risk.
  - Option A (safest): delete the secret in Cloudflare, remove `pollJar`, and rely on the webhook (registered from your laptop) plus a daily check of unmatched payments.
  - Option B: keep the token, but fix F4, turn on 2FA (ideally a hardware key) for Cloudflare, GitHub and the email accounts behind them, give nobody else access, and protect the `main` branch.
- Either way, if you ever suspect a leak, generate a new token at api.monobank.ua (the old one stops working) and register the webhook again.
- The only way to get a narrowly scoped token and signed webhooks is monobank acquiring, which requires a ФОП. Worth it if sales grow.

### F4: Unpinned build tools run with access to the PDFs and your deploy rights (Medium, Theoretical)

**What it is.** Every deploy downloads the newest versions of tools from the internet and runs them on Cloudflare's build machine. That machine has a copy of your private repo (including the PDFs) and a Cloudflare API token that can deploy your Worker. Two tools are affected:

- `npx wrangler deploy`: there is no `package.json` or lockfile, so you get whatever wrangler, and its dependency tree, is newest on npm at that moment.
- `Pillow>=10`: any future Pillow release, installed without a hash check.

**How a bad actor would use it.** They compromise any one of those packages; npm had several such worm attacks in 2025. The malicious version copies out the PDFs, or deploys a modified Worker that sends `MONO_PERSONAL_TOKEN` and `MONO_HOOK_SECRET` to the attacker (see F3). A second path: by default, Workers Builds also builds non-production branches, and those preview versions get the same secrets and the same D1 database. Anyone who can push a branch can run code that sees your secrets.

**Impact.** Leaked PDFs, a stolen banking token, and a tampered site, possibly without you noticing.

**Evidence.** `requirements.txt:1` is `Pillow>=10`; the deploy command is `npx wrangler deploy` (PIPELINE.md:125); there is no `package.json` in the repo.

**Suggested fix.**
- Add a `package.json` with an exact `"wrangler": "x.y.z"` dev dependency, commit `package-lock.json`, and change the deploy command to `npm ci && npx wrangler deploy`.
- Pin Pillow to an exact version with hashes (`pip-compile --generate-hashes` produces `Pillow==… --hash=sha256:…`), and change the build command to `pip install --require-hashes -r requirements.txt && python3 build.py`.
- In Cloudflare → Worker → Settings → Build, turn off builds for non-production branches. Add `"preview_urls": false` to `wrangler.jsonc`.
- On GitHub: turn on 2FA, add no extra collaborators, and protect the `main` branch.

### F5: Payments can be silently lost or credited to the wrong order (Medium, Likely)

**What it is.** There are three weaknesses in `recordTx` and `pollJar` (`lib/jar.js`):

1. **Silent loss after a partial failure.** The transaction is first saved as "processed" (lines 83-85), and the order is updated afterwards in a separate step (lines 94-101). If that second step fails (a D1 hiccup or the quota), monobank retries, but the retry sees "already processed" and does nothing. The buyer has paid and stays "pending" forever.
2. **6-hour blind spot.** The fallback poll only asks for the last 6 hours (line 114), and it only runs while someone has an order page open. If the webhook is off (F1) and a buyer pays, closes the page and comes back the next day, their payment is never matched.
3. **Loose matching.** Any standalone 6-digit number in the buyer's comment *or* in the bank's description counts as a code. Codes never expire, orders that are already paid can still be matched, and when several codes appear the *newest* order wins (lines 74, 87-91). An attacker who mass-creates orders (F1) holds a growing share of all codes, and their orders are always the newest. A buyer's typo, or a second number in the payment (a phone fragment, or a card prefix like `537541******1234`), can then credit the attacker's order instead. Social engineering works the same way: "pay with code 123456 for a discount" makes victims unlock the attacker's order with their own money.

**Impact.** Buyers pay and don't get the book (support work, refunds, reputation), and an attacker occasionally gets a free copy. You lose no money directly.

**Evidence.** The code lines above. Not demonstrated: that would need real payments or forged webhooks.

**Suggested fix (all in `lib/jar.js`).**
- In `recordTx`, look up the order first, then do the `INSERT INTO txs` and the `UPDATE orders` together in one `d.batch([...])`. A D1 batch is a single transaction, so either both happen or neither does.
- Only match orders where `status != 'paid'` and the order was created in the last 7 days. Prefer codes found in `comment` over `description`. If more than one code matches, don't credit any order automatically; leave the payment for manual review.
- Give codes a check digit (5 random digits plus 1 Luhn digit), so a typo can't match a real order.
- Add the scheduled poll from F1, so the 6-hour window is always covered.

### F6: The webhook secret is the only lock, and it ends up in logs and shell history (Low, Likely)

**What it is.** monobank's personal webhook has no signature, so the secret in the URL is the only protection. Anyone with that secret and your jar's account id (in the repo, not on the public site) can POST a fake "payment" and mark any order as paid, which means free downloads at will.

Where the secret leaks today:
- **Cloudflare Workers Logs.** `wrangler.jsonc:21` turns on observability, and Workers Logs record the full URL of every request. That includes `/api/mono-hook/<secret>` once for **every transaction on any of your personal accounts**. Anyone with access to your Cloudflare dashboard, or any future log export, can see it.
- **Shell history and terminal output.** `tools/monobank.py webhook <url>` takes the URL as a command-line argument, so it's saved in `~/.bash_history`, and `tools/monobank.py status` prints it.
- The comparison isn't constant-time (`===`). That isn't practically exploitable over the network; noted only for completeness.

**Evidence.** A wrong secret gets `404` for both `GET` and `POST /api/mono-hook/wrong-secret`, which is correct. I didn't forge a payload (forbidden). The workings are confirmed in the [Workers Logs docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/): every invocation log records the request method and URL.

**Suggested fix.**
- In `wrangler.jsonc`, set `"observability": { "enabled": true, "logs": { "invocation_logs": false } }`. This keeps your `console.error` output and drops the per-request URL logs. It also stops order tokens being logged (F7, F12).
- In `tools/monobank.py`, read the secret with `getpass` and build the URL inside the script, and mask it in the `status` output. Then remove the old line from your shell history and rotate the secret: set a new `MONO_HOOK_SECRET` and register the webhook again.
- Stronger option: treat each webhook call as a hint only, and confirm the transaction through the statement API before marking the order paid. That delays confirmation by up to a minute but makes forged payloads useless. It depends on keeping the token (trade-off with F3).

### F7: Download links never expire and have no download limit (Low, Likely)

**What it is.** `/download/?o=<token>` works forever, any number of times, from any device. Nothing in the PDF identifies the buyer.

**How a bad actor would use it.** A buyer posts their link in a Telegram channel. Every download then runs through your Worker, eating into the daily quota (F1), and you have no button to revoke the link.

**Impact.** Piracy served from your own site, and quota use. Sharing the file itself was always possible, so the extra risk is modest.

**Evidence.** `functions/download/index.js:16` only checks `status === 'paid'`. The `orders` table has no download counter or expiry (`lib/jar.js:20-23`).

**Suggested fix.** Add a `downloads INTEGER DEFAULT 0` column to `orders`, increase it in the download handler, and refuse after about 10 downloads with a "write to us" message. Optionally, expire links 30 days after `paid_at`. To revoke a leaked link: `UPDATE orders SET status='revoked' WHERE code='…'`. Optionally, stamp the order code into the PDF at download time so leaked copies can be traced.

### F8: The live site and the public offer still point to example.com (Low, Confirmed)

**What it is.** `site.url` is still `https://example.com`, and it shows up all over the live site: canonical links, `og:url`, `og:image`, the sitemap, the Sitemap line in `robots.txt`, and the JSON-LD. The public offer itself says it covers purchases "на сайті https://example.com".

**Impact.**
- Google is told the real page lives at example.com, so the book page may never be indexed.
- Social previews have no image.
- The legal offer names a website that isn't yours, so in a dispute a buyer could argue the offer doesn't apply.

**Evidence.** Occurrences of "example.com" on the live site: `/` 4, book page 9, `/oferta/` 3, `/contacts/` 2, `/sitemap.xml` 5, `/robots.txt` 1. The book page contains `<link rel="canonical" href="https://example.com/one-up-on-wall-street-ukrainian/">`.

**Suggested fix.** Set `catalog.json:5` to `"url": "https://translation-book.vladyslavzariskyi.workers.dev"` (or your own domain), rebuild and push. In `build.py:33`, make this a hard error (`sys.exit(...)`) instead of a warning.

### F9: No security headers (Low, Confirmed)

**What it is.** No response sets `Content-Security-Policy`, `X-Frame-Options` / `frame-ancestors`, `Referrer-Policy`, `X-Content-Type-Options` or `Strict-Transport-Security`. A plain `http://` request is answered with 200 instead of a redirect.

**Impact.** Small today, for three reasons:
- I found no XSS for a CSP to stop.
- Browsers force HTTPS on every `.dev` site, because the whole domain ending is on their built-in HTTPS-only list.
- The default browser referrer policy already hides the order token from monobank.

What it does allow: any site can show your pages inside a frame. That's useful for phishing wrappers that look like your shop, and for clickjacking. And once you move to a `.com.ua` domain, nothing will force HTTPS.

**Evidence.** On `/`, the book page, `/pay/`, `/api/order` and `/download/`, the only headers are `content-type`, `cache-control`, `server`, `cf-ray` and sometimes `etag`. `curl http://…/` → `200`.

**Suggested fix.**
- Static pages: have `build.py` write `public/_headers`. The site has no inline styles and only JSON-LD data scripts, which a CSP doesn't block:
  ```
  /*
    Content-Security-Policy: default-src 'self'; script-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'
    X-Frame-Options: DENY
    Referrer-Policy: same-origin
    X-Content-Type-Options: nosniff
    Strict-Transport-Security: max-age=31536000
  ```
- Worker responses (`_headers` doesn't apply to them): add the same headers in `statusPage` (`lib/html.js:28`), in `json()` in `functions/api/order.js`, and in the download response. On `/pay/`, the policy needs `script-src 'unsafe-inline'` (or move the inline script to `/pay.js` and use `'self'`) plus `connect-src 'self'`.

### F10: The `/pay/` page polls forever and reloads in a loop on errors (Low, Likely)

**What it is.** The `/pay/` page checks `/api/order` every 5 s for 5 minutes, then every 30 s **for as long as the tab stays open**. If `/api/order` returns an error (`{"status":"error"}` or `{"status":"unknown"}`), `d.paid_kop` is `undefined`, which is `!== 0`, so the page reloads immediately.

**Impact.** One forgotten tab makes about 2,900 Worker requests a day, so 30 forgotten tabs use most of the free daily quota. During an outage, every open tab reloads every 5-15 s, which makes the outage worse.

**Evidence.** `functions/pay/index.js:62-66`: `if (d.status === "paid" || d.paid_kop !== ${order.paid_kop}) location.reload();` and `setTimeout(check, tries < 60 ? 5000 : 30000)`.

**Suggested fix.** Stop polling after about 15 minutes and leave the "Я оплатив — перевірити" link. Only reload when `d.status === "paid"` or when `typeof d.paid_kop === "number"` and the value has changed. Back off after errors.

### F11: Malformed URLs crash the Worker, and `__proto__` passes the "book exists" check (Low, Confirmed)

**What it is.**
- The router calls `decodeURIComponent`, which throws on a broken `%` sequence. Nothing catches it, so Cloudflare returns error 1101.
- `catalog.books[params.slug]` treats built-in JavaScript names such as `__proto__`, `constructor` and `toString` as existing books. The request then fails at the database.

**Impact.** Error noise in your logs, and 500/502 responses where a 404 belongs. Nothing is exposed and no order is created.

**Evidence.**
- `GET /buy/%E0%A4%A` → `500`, "error code: 1101"
- `GET /api/mono-hook/%E0%A4%A` → `500`, error 1101
- `POST /buy/__proto__` → `502`, "Оплата тимчасово недоступна" (it should be 404)

**Suggested fix.** In `src/worker.js`, wrap `getParams(m)` in try/catch and return 404 on failure. Use `Object.hasOwn(catalog.books, slug)` in `functions/buy/[slug].js:8` and `lib/jar.js:69`.

### F12: Personal data exposure (Info, Confirmed)

- **Your identity is public.** Your full name and personal Gmail address are on every page, the `workers.dev` subdomain is your name, and the monobank jar page shows the owner's name, and usually the amount collected (I didn't open it: it's a third-party site). Expect spam and phishing aimed at you, along the lines of "your buyer's payment failed, confirm here…".
- **Buyer names are kept forever.** For every jar payment, the `txs` table stores the bank's `description` (normally the sender's name) and the comment, with no time limit (`lib/jar.js:83-84`).
- **Logs hold download links and IPs.** Workers Logs keep the URL of every Worker request (order tokens are download links) along with request metadata such as IP and location.
- **All your transactions reach the Worker.** The code drops non-jar transactions before touching the database (`lib/jar.js:79`, checked OK), but they still pass through Cloudflare, and their URLs reach the logs (F6).
- **The offer understates what you keep.** §7 says you only receive what the bank needs to confirm payment. Keeping buyers' names forever goes beyond that.

**Suggested fix.** Use a dedicated contact address and a custom domain. Turn off invocation logs (F6). Stop storing `description`, or delete `txs` rows older than 90 days. Add one sentence about this to §7 of the offer.

### F13: Business and fraud risks of a personal jar (Info)

- **Chargebacks.** A buyer can dispute the card payment with their bank after downloading. The money is pulled back and you can't take back the file. At 99 грн per sale the risk is small; a download counter (F7) gives you evidence.
- **Jar abuse.** The jar link is public, so anyone can deposit any amount with any comment: many small transfers, or comments that look suspicious or sanctions-related. The aim would be to trigger a monobank compliance review of your **whole personal account**, not just the jar. Ordinary success has a similar effect, through the NBU guidance on about 100+ incoming transfers a month that you already note in PIPELINE.md. Sales income is taxable, and selling under a "публічна оферта" as a private person without a ФОП is worth checking with an accountant.
- **Copycats.** The site is static and easy to copy. A copy with the copier's own jar steals your buyers. A copy with *your* jar and their own order codes gains them nothing, but confuses buyers and generates support requests. Mitigation: a custom domain that buyers can recognise, with the official URL printed in the PDF and on your social channels.
- **Refund promise.** The offer promises refunds "to the card" within 7 working days. From a jar, you can only send a new transfer, so make sure you can actually keep that promise.

## 4. Checked and found OK

- **`/protected/` block:** I tried 18 path variants against the real file name: `%70rotected`, `prot%65cted`, `protected%2F` / `%2f`, `//`, `///`, `Protected`, `PROTECTED`, `/./`, `/x/../`, `/%2e/`, `/x/%2e%2e/`, trailing `.`, trailing `/`, no extension, a backslash and `%5C`, plus POST, PUT and a `Range` header. Every one returned 404 or 405, or a 307 redirect to the canonical `/protected/…` path, which is then blocked. A made-up file name gets the same 307, so the redirect doesn't reveal which files exist.
- **The PDF path isn't leaked:** it isn't in any public page, the sitemap, the CSS or any error message. `robots.txt` names only the `/protected/` folder, and the 16-hex-digit hash in the file name (64 bits) can't be guessed.
- **Order tokens:** 24 random bytes from `crypto.getRandomValues` (192 bits), checked against `^[A-Za-z0-9_-]{32}$` before any database query.
- **SQL injection:** every query uses bound parameters, including the dynamic `IN (?,…)` list.
- **XSS:** `/pay/` only outputs the format-checked and URL-encoded token, the digits-only code, the escaped book title and integers. `?o=<script>…` gets a plain 404 page. Static pages escape all catalog text, and the JSON-LD escapes `</`.
- **Open redirect and header injection:** `GET /buy/%2F%2Fevil.example` and `/buy/%5C%5Cevil.example` redirect to `/%2F%2Fevil.example/`, a relative path on your own site. In `/download/?o=%0d%0a…`, the CR/LF characters are encoded.
- **HTTP methods:** OPTIONS and PUT get 405. HEAD runs the GET handler, which doesn't create anything.
- **Webhook:** a wrong secret gets 404 for both GET and POST. Transactions on other accounts are dropped before anything is stored. Repeated deliveries of the same transaction are ignored (`INSERT OR IGNORE` on the transaction id). Negative amounts (your own withdrawals from the jar) are ignored. The webhook and the poll can't both count the same payment.
- **Payment math:** `paid_kop + ? >= price_kop` correctly uses the value from before the update, partial payments add up, and the pay link rounds the amount up.
- **Code collisions:** `code` is `UNIQUE` and creation retries 8 times, so two orders can never share a code. Exhausting the code space would take 600,000+ orders, and the F1 quotas are hit long before that.
- **Caching:** `/pay/`, `/api/order`, the `/buy` redirect and the download are all `no-store` or `private, no-store`. Cloudflare doesn't cache Worker responses here, and static pages are `must-revalidate`. One person can't be served another person's order page or file.
- **Referrer leak:** browsers send only the site's origin to monobank, not the order link, and the jar link has `rel="noopener"`.
- **Git history and config:** none of the 6 commits or `.git/config` contain tokens, secrets or credentials. The remote uses SSH. `public/` and `lib/catalog.generated.js` aren't committed. The jar account id doesn't appear on any public page.

## 5. Out of scope / couldn't test

- **Forbidden by the rules:** actually using up the quotas, forged webhooks, real payments and monobank API calls. F1, F5 and F6 are based on the code and the documentation.
- **The paid download path:** testing it end to end needs a paid order, so I only read the code.
- **Cloudflare and GitHub account settings:** who has access, 2FA, builds for non-production branches, preview URLs, log retention, and whether an old Pages project from the `functions/protected` era is still deployed. Check these in the dashboards.
- **The monobank jar page:** it's a third-party site.
- **Legal and tax status:** listed as risks only; this isn't advice.

**Test data left in your database:** one pending order, code **849683**, created to test the cross-site POST. `POST /buy/__proto__` created nothing. To remove the test order: `DELETE FROM orders WHERE code = '849683';`

**Requests used:** 2 of the 5 allowed `POST /buy` requests, and no more than 20 requests per probe group. I didn't open the test order's pages more than 20 seconds after creating it, so it never triggered a monobank statement call.
