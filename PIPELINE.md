# Launch pipeline: payments to your personal monobank account, hosting for free

Buyers pay into a monobank **jar (банка)** on your personal account. No ФОП and no merchant account are needed.

## How it works

```
Buyer clicks "Купити PDF — 85 грн"
   │
   ▼
/pay/ page: "Your order code: 912466" + button "Оплатити в monobank"
   │                                   (jar page opens with amount 85 and the code pre-filled)
   ▼
Buyer pays into your jar: any Visa/Mastercard, Apple Pay, Google Pay; code in the comment
   │
   ├─▶ monobank notifies the site instantly (webhook)
   └─▶ backup: the site checks the jar statement once a minute while a buyer is waiting
   │
   ▼
/pay/ page turns into "Дякуємо! Завантажити PDF" automatically (usually within a minute)
```

- Money lands in your jar, and you move it to your card in the app at any time.
- Order matching is automatic. Partial payments are handled ("pay the remaining 35 грн with the same code"),
  as are duplicate notifications. Payments without a code are kept in the database, and you can see them in the app.
- If a buyer forgets the code, they email you with their receipt and you send the PDF by hand.
- Orders are stored in **Cloudflare D1**, a free database (5 GB, 100k writes/day, about 3 writes per order).

| Part | Service | Cost |
|---|---|---|
| Hosting + checkout code | Cloudflare Workers (static assets + Worker) | Free |
| Order database | Cloudflare D1 | Free |
| Code storage | GitHub, private repo | Free |
| Payments | monobank jar (банка) | Free for you (buyers paying from other banks' cards may pay their bank's fee) |
| Address | `translation-book.<you>.workers.dev`, or your own domain | Free, or ~$10/yr |

**Price:** 85 грн (≈ $1.99), set in `site.price_uah` in `catalog.json`.

> **Know the limits of a personal account.** NBU guidance asks banks to flag personal accounts
> that receive many transfers from different people (roughly 100+ a month). monobank can then ask
> about the source of funds or limit the account. The personal API is meant for personal use.
> Keep the confirmation of the new law handy.

---

## Phase 0: Rights and the book file

- [ ] Signed licence from the rights holder covering **Ukrainian e-book distribution** (for
      *One Up on Wall Street*: Simon & Schuster / Peter Lynch's agent). Keep a PDF copy.
- [ ] Rights to the cover photo.
- [ ] In the PDF, replace *"Неофіційне видання для особистого користування"* ("unofficial edition for
      personal use") with your rights line, e.g. *"Переклад українською © 2026 <you>. Видано за ліцензією <rights holder>."*
- [ ] Use one spelling of the co-author everywhere (the cover says **Ротшильда**, the PDF and site say **Ротчайлд**).
- [ ] Put the final PDF in `books/book_1/`.

## Phase 1: monobank setup (15 min)

1. [ ] **Create a jar** in the monobank app: **Банки → Створити банку**.
   - Name: e.g. "Книги українською" (buyers see it on the payment page).
   - Goal: leave it empty or set it very high, so the jar never shows "goal reached".
   - Use this jar **only** for book sales.
   - Copy the jar link: **Поділитися** → `https://send.monobank.ua/jar/XXXXXXXX`
2. [ ] **Get a personal API token:** open https://api.monobank.ua/ on your computer → scan the QR code
       with the monobank app → copy the token.
   - This token can **read** all your personal statements (it cannot move money).
     Never share it or put it in files. It goes only into Cloudflare as a Secret (Phase 3) and into
     the terminal when the helper script asks for it.
3. [ ] **Find the jar's account id** (different from the link):
   ```bash
   cd ~/MineFiles/books-trans/website
   python3 tools/monobank.py jars          # paste the token when asked
   ```
   It prints each jar's `title`, `account_id` and `sendId`. Note the `account_id` of your books jar.

## Phase 2: Configure and build

1. [ ] Edit `catalog.json`:
   - `site.url`: your address. Without a domain, use `https://translation-book.<your-subdomain>.workers.dev`
     (you pick the project name in Phase 3).
   - `site.contact_email`: a real address you check (buyers who forget the code write here)
   - `site.seller.name`: your name (shown on the Contacts and Offer pages). `tax_id`, `address` and `phone` are optional.
   - `site.jar.url`: the jar link from Phase 1
   - `site.jar.account_id`: the `account_id` from Phase 1
   - Keep `site.sales_enabled: false` for the first deploy.
2. [ ] Run `python3 build.py`. Only the `sales_enabled` warning should remain.
3. [ ] Read the generated **Оферта** and **Оплата і доставка** pages (`public/oferta/index.html`,
       `public/oplata/index.html`). Change the text in `build.py` → `legal_pages()` if needed.
4. [ ] Generate a webhook secret (a random string that hides the webhook URL) and save it in your password manager:
   ```bash
   python3 -c "import secrets; print(secrets.token_urlsafe(24))"
   ```

## Phase 3: Host on Cloudflare (free)

### 3.1 Private GitHub repo
The checkout code can't be deployed by drag-and-drop, so Cloudflare builds the site from GitHub.

1. [ ] github.com → **New repository** → `bookstore` → **Private** (it contains the PDFs) → Create, with no README.
2. [ ] In a terminal:
   ```bash
   cd ~/MineFiles/books-trans/website
   git init -b main
   git add .
   git status          # expect: books/*.pdf, functions/, lib/, tools/, build.py, catalog.json; NOT public/
   git commit -m "Bookstore"
   git remote add origin https://github.com/<your-user>/bookstore.git
   git push -u origin main
   ```
   For the password, use a **personal access token** (GitHub → Settings → Developer settings →
   Personal access tokens → Fine-grained → this repo, "Contents: Read and write").

### 3.2 Database (D1)
- [ ] dash.cloudflare.com → **Storage & Databases → D1** → **Create database** → name `bookstore`.
- [ ] Copy its **Database ID** and paste it into `wrangler.jsonc` → `database_id`, then commit and push.
      The tables are created automatically on first use.

### 3.3 Worker (connected to GitHub)
The repo is a Cloudflare **Worker**: `src/worker.js` runs the checkout, and `public/` holds the static site.
Settings live in `wrangler.jsonc`.

1. [ ] **Workers & Pages → Create → Import a repository** → choose `bookstore`.
       (If you already created the Worker, open it → **Settings → Build** instead.)
2. [ ] Build settings:
   - Build command: `pip install -r requirements.txt && python3 build.py`
   - Deploy command: `npx wrangler deploy`
   - The Worker's name in the dashboard must match `"name"` in `wrangler.jsonc` (`translation-book`).
     If yours is different, change it in the file.
3. [ ] Push (or click **Retry build**). The log should end with a successful `wrangler deploy`.
       The D1 binding `DB` comes from `wrangler.jsonc`, so there's nothing to add by hand.
4. [ ] Worker → **Settings → Variables and Secrets** → add, as type **Secret**:
   - `MONO_PERSONAL_TOKEN` = your personal token
   - `MONO_HOOK_SECRET` = the random string from Phase 2
   Secrets take effect immediately and are kept across deploys.
5. [ ] Check: `https://translation-book.<your-subdomain>.workers.dev` opens, and `/protected/x.pdf` returns **Not found**.
       Use this address as `site.url` if you have no domain yet.

### 3.4 Register the webhook (instant payment confirmation)
```bash
python3 tools/monobank.py webhook https://<your-site>/api/mono-hook/<MONO_HOOK_SECRET>
python3 tools/monobank.py status        # should print the URL
```
monobank checks the URL right away. If it refuses, make sure the deploy from 3.3 finished and the
secret in the URL matches the Cloudflare secret exactly.

> A personal account has **one** webhook. If another app already uses it, it gets replaced. The
> once-a-minute backup check keeps payments working even without the webhook, just slower (up to ~1 minute).

### 3.5 Own domain (optional, recommended)
- [ ] Buy a `.com.ua` (imena.ua, hostiq.ua, …) or a `.com` (Cloudflare Registrar).
- [ ] Cloudflare → **Add a site** → Free plan → switch the nameservers at your registrar.
- [ ] Worker → **Settings → Domains & Routes → Add → Custom domain** → `yourdomain` (and `www.yourdomain`).
- [ ] Update `site.url` → commit → push. Then **re-run 3.4** with the new domain.

## Phase 4: Go live and test with real money (paying yourself)

1. [ ] `catalog.json` → `"sales_enabled": true` → `python3 build.py` → `git commit -am "Open sales" && git push`.
2. [ ] On your phone: book page → **Купити** → you get an order code.
3. [ ] Pay 85 грн into the jar **from a different card** (another bank's card, or a friend's) with the code in the comment.
       Paying yourself just moves your own money.
4. [ ] Within seconds, or at most ~1 minute, the page shows **"Дякуємо за покупку!"** → **Завантажити PDF** works.
5. [ ] Also check:
   - pay **without** a code: the order stays pending (expected; this is the manual-email case)
   - pay **less** than 85: the page asks for the rest
   - reopen the bookmarked page later: the download still works

## Phase 5: Get onto Google and Bing

1. [ ] **Google Search Console** (search.google.com/search-console)
   - Own domain → **Domain** property → accept automatic verification through Cloudflare.
   - workers.dev → **URL prefix** property → "HTML file" → put `googleXXXX.html` in `assets/` → push → Verify.
   - [ ] **Sitemaps** → submit `sitemap.xml`
   - [ ] **URL inspection** → `/one-up-on-wall-street-ukrainian/` and `/` → **Request indexing**
2. [ ] https://search.google.com/test/rich-results → book URL → Product, Book, Breadcrumb and FAQ with no errors.
3. [ ] https://pagespeed.web.dev → the mobile score should be 90+.
4. [ ] bing.com/webmasters → **Import from Google Search Console**.
5. [ ] After 3–7 days, Google `site:yourdomain` and check the book page is listed.

## Phase 6: Promotion (this is what gets you to the top)

- [ ] Telegram investing / finance / book channels: a post or a cheap ad with the link
- [ ] Reddit (r/ukraine, r/UkrainianInvesting, r/books), following each subreddit's rules
- [ ] DOU.ua forum ("Інвестиції") and the Мінфін forum
- [ ] Goodreads: add the Ukrainian edition with a link
- [ ] Bookstagram / BookTok creators: offer a free copy for a review
- [ ] Your own Telegram or Instagram with quotes from the book, linking to the page
- [ ] Friends' blogs linking to the page **with the book name in the link text**

## Phase 7: Routine

**Daily (2 min):** check your email for "I paid but forgot the code" messages. Find the payment in
the jar history in the app, then send the PDF (or the download link from the matching order, see below).

**Weekly (15 min):**
- [ ] Search Console → **Performance**: work weak query variants into `faq` / `description_uk` → push.
- [ ] Cloudflare → your Worker → **Logs**: check for errors.
- [ ] Cloudflare → D1 → `bookstore` → **Console**, to see unmatched payments:
  ```sql
  SELECT datetime(time,'unixepoch') AS t, amount/100.0 AS uah, comment, description
  FROM txs WHERE order_token IS NULL ORDER BY time DESC LIMIT 20;
  ```
  To unlock an order by hand (the buyer gave you their code):
  ```sql
  UPDATE orders SET status='paid', paid_kop=price_kop WHERE code='912466';
  ```
  The buyer's own /pay/ page then shows the download button.

---

## Adding the next book

1. [ ] Licence on file (Phase 0).
2. [ ] Cover + PDF in `books/book_N/`.
3. [ ] Copy the book entry in `catalog.json` and fill in the slug, titles, `seo_title`, `alternate_names`,
       description, `toc` and `faq`. Add `"price_uah": 120` if this book has a different price.
4. [ ] `python3 build.py` → `git add . && git commit -m "Add <book>" && git push`.
5. [ ] Search Console → **Request indexing** for the new URL. Then promote it.

## Files

| Path | What it is |
|---|---|
| `catalog.json` | All content and settings: site, seller, price, jar, books |
| `build.py` | Builds `public/` (pages, covers, sitemap, legal pages) and `lib/catalog.generated.js` |
| `assets/` | CSS and favicon; anything here is copied to the site root |
| `functions/buy/[slug].js` | Starts a purchase: creates an order with a 6-digit code |
| `functions/pay/` | Code + payment instructions, then the download button |
| `functions/api/order.js` | Status check used by the /pay/ page (plus the backup statement check) |
| `functions/api/mono-hook/[secret].js` | monobank webhook receiver |
| `functions/download/` | Sends the PDF, only for paid orders |
| `src/worker.js`, `wrangler.jsonc` | Worker entry (routes + blocks /protected/) and Cloudflare config (assets, D1) |
| `lib/jar.js` | Order logic, D1 storage, payment matching |
| `tools/monobank.py` | Lists jars, registers the webhook |

## Troubleshooting

| Problem | Fix |
|---|---|
| Button says "Незабаром" | `sales_enabled` is false |
| Clicking Buy shows "Продаж незабаром" | The `DB` binding is missing, `jar.url` / `jar.account_id` are empty, or you didn't redeploy after adding bindings |
| Paid with the code, page stays on "Очікуємо оплату" | Wait 1 minute. If it's still stuck: check `MONO_PERSONAL_TOKEN` in Cloudflare and that `jar.account_id` is the **account_id** (not the link id); check Functions logs |
| `tools/monobank.py webhook` fails | Site not deployed yet, wrong secret in the URL, or the URL isn't https |
| monobank error 429 in logs | Normal now and then (API limit: 1 statement request per minute). The webhook still works |
| Cloudflare build fails on Pillow | Set the `PYTHON_VERSION=3.12` variable and retry the deploy |
| Search Console: "Discovered – currently not indexed" | Normal at first. Get 2–3 external links and request indexing again |
