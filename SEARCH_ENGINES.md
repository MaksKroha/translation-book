# Getting onto Google and Bing

Step by step: tell Google and Bing the site exists, prove it's yours, and hand them the list of pages.
About 30 minutes of clicking, then a few days of waiting.

**Your site:** `https://translation-book.vladyslavzariskyi.workers.dev/`

Already done by the build (checked on the live site): `sitemap.xml` lists all pages with the right
address, and `robots.txt` points to it while keeping crawlers out of `/buy/`, `/pay/`, `/api/`,
`/download/` and `/protected/`.

---

## Part 1. Google Search Console

### 1.1 Add the site

1. [ ] Open https://search.google.com/search-console and sign in with the Google account you want to keep for the shop.
2. [ ] Click **Add property**. On first use it's the welcome screen; later it's in the property menu, top left.
3. [ ] Of the two boxes, use **URL prefix** (right), not **Domain** (left).
   **Domain** needs control over the domain's DNS, and `workers.dev` belongs to Cloudflare.
4. [ ] Enter exactly `https://translation-book.vladyslavzariskyi.workers.dev/` → **Continue**.

### 1.2 Prove the site is yours (HTML tag)

Use the **HTML tag** method, not **HTML file**. The site redirects every `.html` address (`/x.html` → `/x`),
and Google can reject a verification file that redirects.

1. [ ] In the **Verify ownership** window, open **Other verification methods → HTML tag**. Google shows something like:
   ```html
   <meta name="google-site-verification" content="AbC123xyz..." />
   ```
   Keep this window open.
2. [ ] Copy **only the code between the quotes after `content=`** (`AbC123xyz...`) into `catalog.json`:
   ```json
   "google_site_verification": "AbC123xyz...",
   ```
   (Pasting the whole tag would break the JSON because of its quotes.)
3. [ ] Build and check the tag is on the home page:
   ```bash
   python3 build.py
   grep google-site-verification public/index.html      # prints the tag
   ```
4. [ ] Publish:
   ```bash
   git add catalog.json && git commit -m "Google Search Console verification" && git push
   ```
5. [ ] Wait about 2 minutes for the deploy (Workers & Pages → translation-book → Deployments). Then open
       `view-source:https://translation-book.vladyslavzariskyi.workers.dev/` in Chrome or Firefox and search
       (Ctrl+F) for `google-site-verification`.
6. [ ] Back in Search Console → **Verify** → "Ownership verified".

**Keep the code in `catalog.json` forever.** Google checks it regularly, and if it disappears you lose access
to the property after a grace period.

### 1.3 Submit the sitemap

1. [ ] Left menu → **Indexing → Sitemaps**.
2. [ ] Under **Add a new sitemap**, the site address is already filled in. Type `sitemap.xml` → **Submit**.
3. [ ] Expect **Status: Success** and **Discovered pages: 5** (home, the book, payment info, offer, contacts).
   - "Couldn't fetch" in the first hours or days is common for a new property. Leave it; it usually turns into
     Success by itself. If it still fails after 3 days, check that the sitemap URL above opens in your browser.

You submit the sitemap once. It's regenerated on every build (new books are added automatically), and Google re-reads it.

### 1.4 Ask Google to index the main pages

1. [ ] In the search bar at the top ("Inspect any URL in …"), paste the book page and press Enter:
   `https://translation-book.vladyslavzariskyi.workers.dev/one-up-on-wall-street-ukrainian/`
2. [ ] It will probably say **URL is not on Google**. Click **Request indexing** and wait about a minute for "Indexing requested".
3. [ ] Do the same for the home page `https://translation-book.vladyslavzariskyi.workers.dev/`.
4. [ ] Optional: **Test live URL** should say "URL is available to Google", which shows Google can read the page.

There's a daily limit of about 10 requests, and asking twice doesn't speed anything up. Use it for new or changed pages only.

### 1.5 Check the structured data

The pages carry machine-readable book data (price, availability, breadcrumbs) that Google can show in results.

1. [ ] Open https://search.google.com/test/rich-results → paste the book URL → **Test URL**.
2. [ ] Expect **Product snippets** (99 UAH, in stock) and **Breadcrumbs**, both valid.
   - Yellow warnings about optional fields (`review`, `aggregateRating`, `brand`) are fine.
   - If **Merchant listings** shows warnings about shipping or returns, ignore them: it's a digital download.
   - Red **errors** mean something is broken. Send the report to Claude.
3. FAQ and Book results won't appear, and that's expected. Google stopped showing FAQ rich results in 2026, and Book
   results are for Google's partners only. The FAQ section on the page still helps it match the questions people type.

### 1.6 Speed check

1. [ ] Open https://pagespeed.web.dev → paste the book URL → **Analyze** → **Mobile** tab.
2. [ ] Aim for **90+ Performance**. The book page loads the Turnstile bot-check script, so a few points lower
       than the home page is normal.

### 1.7 What happens next

| When | What you'll see |
|---|---|
| Day 0–2 | Sitemap read; pages show as "Discovered" under **Indexing → Pages** |
| Day 3–7 (a new site can take 2–4 weeks) | The book page appears in Google. Check with a Google search for `site:translation-book.vladyslavzariskyi.workers.dev` |
| After ~2 weeks | **Performance** shows which searches showed your pages and how often people clicked |

Under **Indexing → Pages**, these "not indexed" entries are expected and need no action:
- **Blocked by robots.txt**: `/buy/…`, `/pay/…` and other checkout addresses, which are kept out on purpose
- **Page with redirect**: addresses like `/404.html`, which redirect to their clean form
- **Excluded by 'noindex' tag**: the 404 page
- **Discovered / Crawled – currently not indexed**: normal for a new site; links from other sites help (PIPELINE.md, Phase 6)

---

## Part 2. Bing Webmaster Tools

Bing's index also feeds Yahoo, DuckDuckGo and Ecosia. Do Part 1 first: then Bing can copy everything from Google.

### 2.1 Import from Google Search Console (easiest)

1. [ ] Open https://www.bing.com/webmasters and sign in. A Google account works, and is easiest.
2. [ ] On the welcome screen choose **Import your sites from GSC** → **Import** → allow access with the
       Google account that owns the Search Console property.
3. [ ] Tick `https://translation-book.vladyslavzariskyi.workers.dev/` → **Import**.
       Bing treats the site as verified through Google and imports the sitemap too.
4. [ ] The site appears in the dashboard. Data starts showing within about 48 hours.

### 2.2 Or add it by hand (only if the import doesn't work)

1. [ ] **Add your site manually** → `https://translation-book.vladyslavzariskyi.workers.dev/` → **Add**.
2. [ ] Choose **HTML Meta Tag**. Bing shows `<meta name="msvalidate.01" content="0123ABCD..." />`.
3. [ ] Copy only the code after `content=` into `catalog.json`:
   ```json
   "bing_site_verification": "0123ABCD...",
   ```
4. [ ] `python3 build.py` → `git add catalog.json && git commit -m "Bing verification" && git push` → wait
       about 2 minutes → **Verify**. Keep the code there, as with Google.
5. [ ] Left menu → **Sitemaps** → **Submit sitemap** →
       `https://translation-book.vladyslavzariskyi.workers.dev/sitemap.xml`.

### 2.3 Submit the main pages

1. [ ] Left menu → **URL Submission** → paste the book page and the home page (one per line) → **Submit**.
2. [ ] After a few days, search Bing for `site:translation-book.vladyslavzariskyi.workers.dev`.

---

## Every time you add a book

The sitemap updates by itself. For the new page (also step 9 in [ADDING_BOOKS.md](ADDING_BOOKS.md)):

- [ ] Google Search Console → URL inspection → new URL → **Request indexing**
- [ ] Bing Webmaster Tools → **URL Submission** → new URL
- [ ] Rich Results Test on the new URL (1.5)

## Weekly (5 minutes)

- [ ] Google **Performance**: look at the searches people used. Work new wordings into the book's `faq`,
      `description_uk` or `alternate_names` in `catalog.json`, then build and push.
- [ ] Google **Indexing → Pages**: anything new outside the "expected" list in 1.7?
- [ ] Read any email from Search Console or Bing. They write when something breaks.
- [ ] Bing **Search Performance**: the same check, for Bing.

## If you move to your own domain later

1. Add a new Search Console property of type **Domain** for it. If the domain is on Cloudflare, Google offers
   automatic verification: sign in to Cloudflare when asked and approve.
2. Set `site.url` in `catalog.json` to the new address → build → push → submit the sitemap in the new property.
3. Ask Claude to make the Worker permanently redirect (301) the old `workers.dev` addresses to the new domain.
   Then, in the **old** property: **Settings → Change of address** → choose the new property.
4. Bing: add the new site (import from Google again).
5. Add the new domain to the Turnstile widget (PIPELINE.md 3.6) and re-register the monobank webhook (PIPELINE.md 3.4).

## Troubleshooting

| Problem | Fix |
|---|---|
| Google: "We couldn't find your verification meta tag" | The deploy isn't finished or it failed; check `view-source:` (1.2, step 5). Make sure the whole code was copied, with nothing cut off |
| `build.py` fails with a JSON error after pasting the code | You pasted the whole `<meta …>` tag. Paste only the code between the quotes after `content=` |
| Sitemap stays "Couldn't fetch" for over 3 days | Open `https://translation-book.vladyslavzariskyi.workers.dev/sitemap.xml` in a browser; it should show a list of 5 addresses. If it does, delete the sitemap in Search Console and submit it again |
| "Request indexing" says the quota is exceeded | Wait until tomorrow; the limit is per day |
| Email from Google: "verification lost" | The code was removed from `catalog.json`, or a build without it was deployed. Put it back and push |
| Nothing in `site:` results after 2–4 weeks | Request indexing once more, and get a few links from other sites (PIPELINE.md, Phase 6) |
| Bing import doesn't list the site | The Google account you allowed isn't the owner of the Search Console property. Use the same account, or add the site by hand (2.2) |
