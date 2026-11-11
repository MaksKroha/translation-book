# Adding a new book

From an English PDF to a book page that sells, start to finish. The first-time setup (Cloudflare,
monobank, Turnstile) is in [PIPELINE.md](PIPELINE.md); this guide assumes the site is already live.

```
English PDF
   │  ../translator   (/translate-book or /translate-batch, then QA, review, assemble)
   ▼
books/<slug>/out/<slug>.uk.md
   │  ../translator   tools/make_pdf.py   (title page and imprint from book.toml)
   ▼
<slug>.uk.pdf  +  cover image
   │  copy into website/books/book_N/
   ▼
catalog.json entry  ──▶  python3 build.py  ──▶  git push  ──▶  Cloudflare builds and deploys (~2 min)
   ▼
Live: /<website-slug>/ with a working Купити button, in the sitemap
```

Nothing in the Worker code changes per book. The book page, `/buy/<slug>`, the protected PDF copy,
the sitemap and the home-page card are all generated from `catalog.json`.

---

## 0. Before you start

- [ ] **Licence.** Every book page says "офіційний переклад", and the public offer (§3) says the
      translations are published under licences from the rights holders. Only add books you hold
      a licence for (Ukrainian e-book distribution). Keep a PDF copy of the licence.
- [ ] **Cover rights:** your own design, or one you have permission to use.
- [ ] **Source PDF with a text layer.** Scanned books need OCR first:
      `ocrmypdf -l eng input.pdf input.ocr.pdf`

## 1. Translate (in `../translator`)

```bash
cd ~/MineFiles/books-trans/translator
```

In Claude Code, inside that folder, run one of:

```
/translate-book ~/Books/some-book.pdf --pages 7-312   # subagents, uses your Claude plan
/translate-batch ~/Books/some-book.pdf                # Batch API, about half the price (needs ANTHROPIC_API_KEY)
/translate-book <slug>                                # resume an interrupted run
```

- `--pages` skips front matter (copyright page, original table of contents, index).
- The run prints the translator **slug** (e.g. `one-up-on-wall-street-by-peter-lynch`). The steps below call it `<slug>`.
- Rough cost: **≈ $4–6 per 100k-word book** on the batch path (`translator/README.md`).

Check that it finished cleanly:

```bash
.venv/bin/python tools/book.py status <slug> -v
.venv/bin/python tools/book.py qa <slug> all -q        # lists only chunks that still have problems
.venv/bin/python tools/book.py assemble <slug>         # → books/<slug>/out/<slug>.uk.md (+ .epub, .docx)
```

## 2. Make the PDF (in `../translator`)

1. [ ] Fill in `books/<slug>/book.toml`. Use the first book's file as a model, **minus its last imprint line**:
   ```toml
   [meta]
   title_uk  = "Українська назва"
   author_uk = "Ім'я Прізвище"

   [pdf]
   title_lines = ["Українська", "назва"]          # how the title breaks on the title page
   author      = "Ім'я Прізвище"
   coauthor    = "у співавторстві з …"           # delete the line if there's no co-author
   subtitle    = "…"
   translation_note = "ПЕРЕКЛАД З АНГЛІЙСЬКОЇ"
   imprint = [
     "Оригінальне видання: Author. *Original Title.* City: Publisher, Year.",
     "Copyright © Year by Author.",
     "Переклад з англійської.",
   ]
   ```
   - **Don't** add *"Неофіційне видання для особистого користування"*. It contradicts the
     "official, licensed" claims on the site (security report, F2). The first book's
     `book.toml` still contains that line, so if you ever rebuild that PDF, delete the line there first.
   - Once the licence is signed, you can add a rights line, e.g.
     *"Переклад українською © 2026 <you>. Видано за ліцензією <rights holder>."*
2. [ ] Build it:
   ```bash
   .venv/bin/python tools/make_pdf.py <slug>             # → books/<slug>/out/<slug>.uk.pdf
   ```
3. [ ] Check the result:
   ```bash
   P=books/<slug>/out/<slug>.uk.pdf
   pdfinfo "$P" | grep -E 'Title|Author|Pages|File size'      # Pages goes into catalog.json
   pdftotext -f 1 -l 3 -layout "$P" - | less                  # title page, imprint, dedication
   pdftotext "$P" - | grep -i "неофіційне видання"            # must print nothing
   ```
   - Open it and skim: title page, table of contents, a few chapters, the last page.
   - Spell names the same way everywhere: cover, PDF, site. For book 1, the cover says
     "Ротшильда" but the PDF says "Ротчайлд".
   - The file must be **under 25 MB**, Cloudflare's limit for one static file. Book 1 is 0.9 MB.

## 3. Cover

- [ ] Portrait image, PNG or JPG, at least **800 px wide** (the build makes 320/640 px WebP files and an 800 px JPEG
      for social previews). Any portrait ratio works; book 1's is about 2:3.
- [ ] The text on it must match the PDF (title, author spelling).

## 4. Put the files in the website repo

```bash
cd ~/MineFiles/books-trans/website
mkdir books/book_2                                  # next free number
cp ../translator/books/<slug>/out/<slug>.uk.pdf books/book_2/
cp ~/path/to/cover.png books/book_2/
```

The PDFs are committed to git (Cloudflare builds from the repo), so **the GitHub repo must stay private**.

## 5. Add the catalog entry

Copy the existing book object in `catalog.json` → `books`, paste it after it (mind the comma), and
change every field:

| Field | What it's for | Notes |
|---|---|---|
| `slug` | Page URL `/<slug>/` and the Buy route | Lowercase Latin, hyphens, e.g. `the-intelligent-investor-ukrainian`. **Never change it after the first sale.** |
| `source_dir` | Folder from step 4 | `"books/book_2"` |
| `cover`, `pdf` | File names inside `source_dir` | |
| `title_uk`, `subtitle_uk` | Page heading and subtitle | |
| `title_original`, `subtitle_original` | English title, shown and used for search | |
| `author_uk`, `author_en` | Author in both languages | |
| `coauthor_uk` | Small line next to the author | `""` if none |
| `author_wiki` | Author's Wikipedia page (structured data for Google) | Ukrainian article if it exists |
| `pages` | "PDF, N сторінок" | From `pdfinfo` in step 2 |
| `original_year` | Year of the original edition | Number, no quotes |
| `edition_note` | "Видання" row, e.g. which edition you translated | |
| `seo_title` | Browser tab and Google title | About 60 characters; put both titles in it |
| `seo_description` | Google snippet | About 150–160 characters, with the price |
| `alternate_names` | Spellings people search for | English title + "українською", typos, short forms |
| `description_uk` | "Про книжку" section | List of paragraphs (2–3) |
| `description_en` | English paragraph at the bottom, for English searches | One paragraph |
| `toc` | "Зміст" section | One string per chapter. A string starting with `"# "` becomes a part heading. Quick start: `grep '^# ' ../translator/books/<slug>/out/<slug>.uk.md` |
| `faq` | "Питання та відповіді" section | 3–5 `{"q": …, "a": …}` objects. Answer real searches ("Чи є … українською?"); it helps the page match them |
| `price_uah` | Optional per-book price | Leave out to use `site.price_uah` (99) |

## 6. Build and look at it locally

```bash
python3 build.py                                    # should print "Built 2 book page(s)" and no new warnings
python3 -m http.server -d public 8000               # then open http://localhost:8000/<slug>/
```

- [ ] The page, cover, description, contents and FAQ look right, on a phone-width window too.
- [ ] The home page shows the new card.
- [ ] `ls public/protected/` lists `<slug>-<hash>.pdf`.

The local server only serves static files. Купити (and everything under `/buy`, `/pay`, `/download`)
only works on the live site.

## 7. Publish

```bash
git add books/book_2 catalog.json
git status            # expect only the new book folder and catalog.json
git commit -m "Add <book title>"
git push
```

Cloudflare builds and deploys in about 2 minutes (Workers & Pages → translation-book → Deployments).
If the build fails, the old version stays live. The build log names the problem (see Troubleshooting).

## 8. Check the live site (no real money needed)

1. [ ] Open `https://<your-site>/<slug>/` → **Купити** → the `/pay/` page shows the right title and price. Note the code.
2. [ ] Cloudflare → D1 → `bookstore` → **Console**, unlock that test order:
   ```sql
   UPDATE orders SET status='paid', paid_kop=price_kop WHERE code='123456';
   ```
3. [ ] Reload `/pay/` → **Завантажити PDF** → the file opens and it's the new book.
4. [ ] Delete the test order:
   ```sql
   DELETE FROM orders WHERE code='123456';
   ```

The payment flow itself is the same for every book. It was tested with real money once (PIPELINE.md, Phase 4).

## 9. Get it found

- [ ] Google Search Console → **URL inspection** → `https://<your-site>/<slug>/` → **Request indexing**.
      The sitemap already includes the new page.
- [ ] Bing Webmaster Tools → **URL Submission** → the new URL.
- [ ] https://search.google.com/test/rich-results → the new URL → **Product snippets** and **Breadcrumbs** with no
      errors (details in [SEARCH_ENGINES.md](SEARCH_ENGINES.md), 1.5).
- [ ] Did visitors ask for this book? Find them with the "same book" SQL in PIPELINE.md, Phase 7
      (**Translation requests**), write to each with **Написати: переклад готовий**, then mark them done.
- [ ] Promote it: PIPELINE.md, Phase 6.

---

## Changing a book that's already on sale

- **Fix the text or replace the PDF:** rebuild it in `../translator`, copy it over the old file in
  `books/book_N/` (same name, or update `pdf`), then `python3 build.py`, commit and push. Buyers' existing
  download links keep working and get the new file.
- **Change the price:** set `price_uah` on the book. Orders that already exist keep their old price.
- **Don't delete a book's entry or change its `slug`** once someone has bought it. Their download link
  looks the book up by slug, so it would stop working ("Замовлення не знайдено"). There's no per-book
  "stop selling" switch yet; ask Claude to add one instead.

## Troubleshooting

| Problem | Fix |
|---|---|
| Build fails with `KeyError: 'something'` | That field is missing from the new catalog entry. Every field in the table except `price_uah` is required (`coauthor_uk` can be `""`) |
| Build fails with `FileNotFoundError` | `source_dir`, `cover` or `pdf` doesn't match the real folder or file name (case matters) |
| Build fails: `site.turnstile_site_key is empty` | The Turnstile key was removed from `catalog.json`; see PIPELINE.md 3.6 |
| `catalog.json` error with a line number | JSON syntax: usually a missing comma between book objects, or a trailing comma after the last item |
| Deploy fails with a file-size error | The PDF is over 25 MB. Compress the images in it or rebuild with smaller images |
| Book page says "Незабаром" | `sales_enabled` is false in `catalog.json` (it applies to all books) |
| `/pay/` shows the wrong price | `price_uah` on the book, or `site.price_uah`, then rebuild and push |
| Downloaded PDF is the old version | The new file wasn't copied into `books/book_N/` before the build, or the push hasn't deployed yet |
| `make_pdf.py` fails | It needs `pandoc` and `xelatex` with Cyrillic fonts; see `translator/CLAUDE.md` |

## Checklist

```
[ ] Licence + cover rights on file
[ ] Translated, QA clean, assembled                    (../translator)
[ ] book.toml filled, no "Неофіційне видання" line     (../translator)
[ ] PDF built and checked: pages, imprint, names, < 25 MB
[ ] PDF + cover in books/book_N/
[ ] catalog.json entry, every field changed
[ ] python3 build.py, page checked locally
[ ] Committed and pushed, deploy green
[ ] Live: Купити → /pay/ → test unlock → download → test order deleted
[ ] Search Console: request indexing
[ ] Visitors who requested this book: written to, marked done
```
