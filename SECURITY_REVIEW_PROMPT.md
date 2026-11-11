# Security review: e-book store (find only, do not fix)

You are doing a security review of a small website that I own and operate. Find every weakness
a bad actor could use against the site, its owner, or its buyers. **Report them only: do not change
any files, do not commit, do not deploy.** I'll decide what to fix after reading your report.

I am not a security specialist. Explain each finding in plain language.

## What the site is

A store that sells Ukrainian translations of books as PDFs (currently one book, 99 UAH).

- **Live site:** https://translation-book.vladyslavzariskyi.workers.dev (Cloudflare Worker with static assets)
- **Code:** the current directory (git repo; the GitHub remote is private)
- **Payments:** no payment processor. The buyer pays into a **monobank jar (банка)** on my personal
  account and writes a 6-digit order code in the payment comment. The site detects the payment
  through the **monobank personal API**, then unlocks the PDF download.

### Purchase flow
1. Book page → the "Купити" form does `POST /buy/<slug>` → `functions/buy/[slug].js` creates an order
   in Cloudflare D1 (random 32-char token + unique 6-digit code) → 303 to `/pay/?o=<token>`.
2. `/pay/?o=<token>` (`functions/pay/index.js`) shows the code and a link to the jar
   (`send.monobank.ua/jar/...?a=<amount>&t=<code>`), and polls `GET /api/order?o=<token>`
   (`functions/api/order.js`) every 5 s.
3. Payment detection (`lib/jar.js`):
   - **Webhook:** monobank POSTs every transaction on my personal accounts to
     `/api/mono-hook/<MONO_HOOK_SECRET>` (`functions/api/mono-hook/[secret].js`). Only transactions
     on the configured jar account are stored. The comment is scanned for a standalone 6-digit code,
     and matching orders get `paid_kop` increased (`underpaid` / `paid`).
   - **Polling fallback:** while a buyer waits, the site fetches the jar statement with
     `MONO_PERSONAL_TOKEN`, throttled to once per 61 s through a row in D1.
4. When the order is paid, `/download/?o=<token>` (`functions/download/index.js`) streams the PDF
   from `public/protected/<slug>-<sha256-prefix>.pdf` via `env.ASSETS.fetch`.

### Moving parts
- `src/worker.js`: the Worker entry. It routes `/buy/*`, `/pay/`, `/api/order`, `/api/mono-hook/*`
  and `/download/` to the handlers, blocks `/protected/*`, and sends everything else to `env.ASSETS`.
- `wrangler.jsonc`: assets config (`run_worker_first` list, `not_found_handling: "404-page"`), D1 binding.
- `build.py`: generates `public/` (pages, covers, sitemap, robots, legal pages), copies PDFs to
  `public/protected/`, and writes `lib/catalog.generated.js` (book data used by the Worker).
- `catalog.json`: content and settings (jar URL and account id, seller name, contact email, prices).
- `tools/monobank.py`: local helper to list jars and register the webhook (asks for the token interactively).
- Secrets (Cloudflare, not in the repo): `MONO_PERSONAL_TOKEN` (read-only access to **all** my personal
  monobank statements) and `MONO_HOOK_SECRET`.
- Deploy: Cloudflare Workers Builds from GitHub. The build runs `pip install -r requirements.txt && python3 build.py`, then `npx wrangler deploy`.

## Rules (important)

You have my permission to test the **live site above** within these limits:

- **Allowed:** reading every file in the repo; normal GET requests; small, targeted probes (path
  variations, malformed parameters, wrong webhook secrets, unusual HTTP methods). Keep each probe
  to about 20 requests or fewer.
- **At most 5** real `POST /buy/...` requests in total. Each one creates a database row.
- **Not allowed:**
  - load or stress testing, brute-forcing, or anything that could exhaust Cloudflare's free-tier limits
  - real payments
  - calling the monobank API
  - sending forged webhook payloads with a secret you found or guessed
  - contacting third parties
- If you find a working way to download the PDF without paying, **stop at proof** (status code,
  `Content-Type`, size). Don't save the file.
- **Never print, log or copy secrets or tokens**, even if you find one. Just report where it is exposed.
- **Don't modify any file in the repo.** Put scratch files in a temporary directory.
- Tools: `python3` and `curl` work, and there's headless `google-chrome` for running JS with mocks.
  **Node is not installed**, so you can't run `wrangler dev` locally. When a live probe isn't allowed,
  reason from the code.

## What to look for

Be thorough and adversarial. Think about at least these areas, and go beyond them:

1. **Getting the PDF without paying:** bypassing the `/protected/` block (encoding such as `%2F`/`%2f`,
   double slashes, case, trailing dots, `..`, the asset layer's trailing-slash/`.html` redirects,
   HEAD/OPTIONS), guessing or leaking the file path, forging or guessing order tokens, making an
   order "paid" without paying, abusing the webhook, abusing the matching logic (partial payments,
   multiple codes in one comment, someone else's payment, races).
2. **Payment-matching abuse:** can an attacker make a real buyer's payment unlock *their* order, or
   block a real buyer from getting the book? Think about code collisions and filling the code space
   by mass-creating orders.
3. **Denial of service / cost abuse:** unauthenticated `POST /buy` (no rate limit) versus D1's
   free-tier write limits, statement-API throttling, polling loops, Workers' request quota.
4. **Webhook security:** secret in the URL path (logs, referrers, timing), no signature on payloads,
   what an attacker with the URL can do, and privacy (the webhook receives all my personal transactions).
5. **Secrets and personal data:** `MONO_PERSONAL_TOKEN` scope and blast radius, what ends up in
   Cloudflare logs (`observability` is enabled), personal data published on the site (`catalog.json`
   seller and contact data, the jar page itself), anything sensitive in git history or in `public/`.
6. **Web vulnerabilities:** XSS (the server-rendered HTML in `lib/html.js` and `functions/pay/index.js`,
   including the inline script), open redirects, CSRF, clickjacking, missing security headers
   (CSP, HSTS, X-Frame-Options, Referrer-Policy), cache issues (could Cloudflare or a browser cache
   a paid download or a /pay/ page for someone else?).
7. **Download links as bearer tokens:** sharing, no expiry, no download limit, leaking through
   `Referer`, browser history or analytics.
8. **Build and supply chain:** unpinned `Pillow>=10`, unpinned `npx wrangler`, the build running
   on Cloudflare with access to the private repo (including the PDFs), what a malicious PR or
   dependency could do.
9. **Configuration mistakes:** `wrangler.jsonc` routing (`run_worker_first` coverage versus
   `not_found_handling`), `robots.txt` revealing paths, `site.url` still set to `https://example.com`,
   anything misleading in the legal pages that could be used against the owner.
10. **Business-logic and fraud risks** around a personal jar: chargebacks after download, someone
    routing suspicious money through the jar, fake copies of the site pointing to another jar.
    Report briefly; these aren't code bugs.

For each suspicion, **verify it**: read the exact code path, and probe the live site where the rules allow.
Mark each finding as **Confirmed** (you demonstrated it), **Likely** (strong code evidence, not
demonstrated) or **Theoretical**.

## Report

Write the report to `SECURITY_REPORT.md` in the current directory. That is the only file you may
create in the repo. Put a short summary in chat as well. Structure:

1. **Summary:** 3–5 sentences. Overall risk, and the most important thing to fix first.
2. **Findings table:** ID, title, severity (Critical / High / Medium / Low / Info), status
   (Confirmed / Likely / Theoretical), location (`file:line` or URL).
3. **One section per finding,** most severe first:
   - What it is, in plain language
   - How a bad actor would use it: concrete steps
   - Impact: money, the PDF, my personal data, buyers, availability
   - Evidence: the code excerpt and/or the exact request with the response status (no secrets)
   - Suggested fix: specific, naming the file and the change, but **don't apply it**
4. **Checked and found OK:** what you tested that held up, so I know it was covered.
5. **Out of scope / couldn't test:** anything you couldn't verify and why.

Don't pad the report. If something is fine, say so in one line under "Checked and found OK".
