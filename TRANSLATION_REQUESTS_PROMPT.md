# Feature: "Замовити переклад" (request a translation)

Add a section to my website where any visitor can ask for a Ukrainian translation of a specific book.
The visitor sees the estimated time (about one week) and is told they'll get a message when the
translation is ready. **Every request must arrive in my email, in a separate section** (its own Gmail
label, not mixed into my inbox).

I'm not a web developer. Explain decisions in plain language, and keep the code as simple as the rest
of the repo.

## What the site is

A store selling Ukrainian translations of books as PDFs. Code: the current directory (git repo, private
GitHub remote, deployed by Cloudflare Workers Builds on every push to `main`).

- **Live:** https://translation-book.vladyslavzariskyi.workers.dev (Cloudflare Worker + static assets, free plan)
- **Static pages:** `build.py` generates `public/` from `catalog.json` (book pages, home page, legal pages,
  sitemap, robots.txt) and writes `lib/catalog.generated.js` for the Worker.
- **Worker:** `src/worker.js` routes dynamic paths to handlers in `functions/` and sends the rest to
  `env.ASSETS`. Any dynamic path must also be in `run_worker_first` in `wrangler.jsonc`, or the asset
  layer answers it (405 for a POST). `scheduled()` runs every 5 minutes (cron in `wrangler.jsonc`).
- **Database:** Cloudflare D1, binding `DB`. Tables are created in code (see `db()` in `lib/jar.js`).
- **Shared HTML:** `lib/html.js` (`statusPage`, `esc`, `contactLine`); styles in `assets/style.css`.
- **Bot protection already in place** on `POST /buy/<slug>` (`functions/buy/[slug].js`): an Origin check and
  Cloudflare Turnstile (site key in `catalog.json` → `site.turnstile_site_key`, secret in the Worker
  secret `TURNSTILE_SECRET_KEY`, widget markup in `build.py` → `buy_button()`).

Read these first: `README.md`, `PIPELINE.md`, `ADDING_BOOKS.md`, `SECURITY_REPORT.md` (the security review;
its lessons apply to this feature), `build.py`, `catalog.json`, `src/worker.js`, `wrangler.jsonc`,
`functions/buy/[slug].js`, `lib/html.js`, `lib/jar.js`.

## What visitors see

- **Where:**
  - a short section on the home page, below the book grid ("Не знайшли потрібну книгу?"), linking to
  - a dedicated page with the form, with a Latin slug, e.g. `/zamovyty-pereklad/`, in the sitemap, with a
    good title for search (e.g. "Замовити переклад книги українською")
  - a link in the footer
- **The form:** book title (required), author (optional), link to the book, e.g. Goodreads or Amazon
  (optional), the visitor's email (required, so I can write when it's ready), comment (optional).
  Nothing else.
- **Estimate and promise**, shown next to the form and again after sending, along these lines:
  "Орієнтовний термін перекладу — близько тижня. Коли переклад буде готовий, ми напишемо вам на email."
  Keep it an estimate ("орієнтовний", "зазвичай"), not a guarantee. Add one sentence that we'll write
  back if we can't take the book on. Every book page says "офіційний переклад" (licensed), and
  some books won't be possible.
- **After sending:** a thank-you page with the same estimate. A browser refresh must not send the request
  twice (POST → 303 redirect → a static thank-you page is fine).
- **Fallback:** Turnstile needs JavaScript. Under the form, say that they can also write to the contact email.
- **Style:** match the existing pages: Ukrainian only, «» quotes, the ’ apostrophe, mobile-first, the
  existing CSS classes. Propose the copy in code; I'll review it in the diff.

## Where requests go: my email, in its own section

- **Recipient:** the address in `catalog.json` → `site.contact_email` (a Gmail address). Don't hardcode it.
  If it needs its own setting, add `site.requests_email` to `catalog.json`.
- **Separate section:** a Gmail filter puts these emails under their own label and skips the inbox. Make
  the filter easy and reliable:
  - every email has the same subject prefix, e.g. `[Запит на переклад] <title> — <author>`
  - use a plus address (`name+pereklad@gmail.com`) as the recipient if the email provider allows it
  - write me step-by-step Gmail filter instructions (Gmail → search options → criteria → "Skip the Inbox",
    "Apply the label: Запити на переклад")
- **Email content:** plain text is fine. Include every field, the time, and a ready-made reply link
  (`mailto:` the visitor with a prefilled subject and body, e.g. "Переклад «…» готовий: <book page link>").
  Then telling the visitor is one click once the book is live.
- **Reply-To = the visitor's email**, so a plain "Reply" in Gmail answers them.
- **Sending email from the Worker:** a Worker can't use SMTP, so it needs an email API. What I know (verify it
  against current docs before relying on it):
  - Cloudflare's own `send_email` binding needs a domain onboarded to Cloudflare. I only have
    `*.workers.dev` right now, so it's probably not available.
  - Resend has a free plan (3,000 emails/month, 100/day). Without a verified domain it can only send to
    the account owner's own address, which is enough for notifications to me. The API key would be a
    Worker secret, e.g. `RESEND_API_KEY`.
  - Form-forwarding services (Web3Forms, Formspree, …) are simpler, but a third party then sees every
    visitor's email.
  **Ask me which one before you write the integration.** Give your recommendation. I'll create the account and
  add the secret in Cloudflare myself. Never ask me to paste a secret into the chat.
- **Never lose a request:** save it to D1 first (a new table, e.g. `translation_requests`: id, created,
  title, author, link, email, comment, emailed_at, status), then send the email. If sending fails, leave
  `emailed_at` empty. The existing 5-minute `scheduled()` in `src/worker.js` retries unsent requests, a few
  per run. The visitor gets the thank-you page either way.

## "A message when the translation is ready"

- **Version 1 (build this):** I reply from Gmail, with the reply link above or a plain Reply. Add the SQL I need
  to `PIPELINE.md` (D1 console): list open requests, mark one done (`status = 'done'`), and find everyone
  who asked for the same book.
- **Later (don't build, just describe in your final message):** automatic notification emails to visitors
  need a provider that can send to any address, which means a verified domain of my own. Write down what
  that would take.

## Security and abuse rules (required)

The security review found that anyone could flood the old Buy form and use up the free quotas
(`SECURITY_REPORT.md`, F1). This form must not repeat that:

- **Same protection as `/buy`:** Origin check + Turnstile. Move `fromOwnSite()` and `passedTurnstile()` out of
  `functions/buy/[slug].js` into a shared module in `lib/`, used by both handlers, with a separate Turnstile
  action (e.g. `"request"`). Keep `/buy` behaving exactly as it does now.
- **Protect the email quota:** cap the request emails sent per day (configurable, well under the provider's
  daily limit). Anything over the cap stays in D1 and goes out on a later cron run. Also limit the requests per
  visitor email per day (e.g. 5).
- **Validate everything on the server:** trim, length limits (title/author ≤ 200, link ≤ 500 and `http(s)://`
  only, email ≤ 254 with a sane format check, comment ≤ 1000), strip control characters, and reject CR/LF in
  anything that ends up in an email header (subject, Reply-To). A hidden honeypot field is a cheap extra.
- **Escape all visitor text** anywhere it's shown as HTML (thank-you page, HTML email if you use one), and URL-encode
  it in `mailto:` links.
- **No personal data in URLs or logs:** Workers Logs record every request URL, so keep the visitor's email out of
  query strings and redirects, and don't `console.log` request bodies or addresses.
- **Personal data, minimum and disclosed:** store only the fields above. Delete requests older than, say,
  180 days in the cron. Add a short note under the form and a sentence to the public offer §7
  (`build.py` → `legal_pages()`): we keep the email only to tell the visitor about this translation.
- **Robots:** the form page can be indexed. Add the POST endpoint to `robots.txt` → `Disallow`.
- If you add security headers (report F9), any CSP must allow `https://challenges.cloudflare.com` for scripts
  and frames, or Turnstile breaks.
- **Don't touch the payment logic** (`lib/jar.js` orders/txs, `/pay`, `/download`, the monobank webhook) except to
  add the retry step to `scheduled()`.

## How to work

- **Tools:** plain JS modules for the Worker and Python 3 for `build.py`. No new npm or pip dependencies, no
  `package.json`.
- Node isn't installed here, and `wrangler dev` isn't available. To test the Worker code, download the official
  Node binary into a temporary directory (verify the SHA256 from nodejs.org). Run the real modules with `node:sqlite` as a
  D1 stand-in and a mocked `fetch` that refuses unknown URLs, so tests never call Turnstile, the email provider or
  monobank. Cover at least: happy path, cross-site POST, bad/missing Turnstile token, invalid fields, CR/LF injection,
  email failure then cron retry, the daily caps. Keep all of this outside the repo.
- Run `python3 build.py` and look at the generated pages (`python3 -m http.server -d public 8000`).
- **Don't commit, push or deploy.** I'll review the diff and push myself.

## When you're done

Tell me, briefly:
1. what changed (files) and what a visitor now sees
2. exactly what I have to do, in order: email provider account + Worker secret, the Gmail filter, anything in
   `catalog.json`, then push
3. how you tested it, and what you couldn't test (the real email delivery, the live Turnstile widget)
4. what automatic "ready" notifications would need later

Also update `PIPELINE.md` (setup steps, the new secret, the SQL for handling requests) and the secrets list in
`README.md`.
