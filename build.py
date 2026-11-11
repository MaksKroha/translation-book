#!/usr/bin/env python3
"""Build the static bookstore into ./public from catalog.json.

    python3 build.py

Only ./public is deployed. Source PDFs in ./books are never copied there:
copies go to public/protected/ (blocked by functions/protected) and are served
only by functions/download after monobank confirms payment.
"""
import datetime as dt
import hashlib
import html
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "public"
ASSETS = ROOT / "assets"
TODAY = dt.date.today().isoformat()

e = html.escape


def load():
    cat = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
    site = cat["site"]
    site["url"] = site["url"].rstrip("/")
    warnings = []
    if "example.com" in site["url"]:
        warnings.append("site.url is still example.com — set your real domain (canonical URLs and sitemap depend on it).")
    if not site.get("sales_enabled"):
        warnings.append("site.sales_enabled is false — Buy buttons show 'Незабаром'.")
    if not site["jar"]["url"] or not site["jar"]["account_id"]:
        warnings.append("site.jar.url / site.jar.account_id are empty — run: python3 tools/monobank.py jars")
    if "Ваше ім" in site["seller"]["name"]:
        warnings.append("site.seller.name is not filled in.")
    if "example.com" in site["contact_email"]:
        warnings.append("site.contact_email is still a placeholder.")
    if site.get("sales_enabled") and not site.get("turnstile_site_key"):
        # Fail the build (the live site stays as it is) rather than deploy a Buy button with no bot check.
        sys.exit("ERROR: site.turnstile_site_key is empty, but sales_enabled is true. Create a free "
                 "Turnstile widget (Cloudflare dashboard → Turnstile), put its site key in catalog.json and "
                 "its secret key in the Worker secret TURNSTILE_SECRET_KEY. See PIPELINE.md, step 3.6.")
    return site, cat["books"], warnings


def price_uah(site, book):
    return book.get("price_uah", site["price_uah"])


def make_covers(book):
    """Resize the source cover into light WebP/JPEG files (the PNG is ~2.5 MB)."""
    src = ROOT / book["source_dir"] / book["cover"]
    dst = OUT / book["slug"]
    dst.mkdir(parents=True, exist_ok=True)
    img = Image.open(src).convert("RGB")
    ratio = img.height / img.width
    out = {}
    for w in (320, 640):
        r = img.resize((w, round(w * ratio)), Image.LANCZOS)
        r.save(dst / f"cover-{w}.webp", "WEBP", quality=82, method=6)
        out[w] = (w, round(w * ratio))
    # JPEG for social previews (Telegram, Facebook, Viber don't all show WebP)
    img.resize((800, round(800 * ratio)), Image.LANCZOS).save(
        dst / "cover.jpg", "JPEG", quality=85, optimize=True, progressive=True)
    return out


def head(site, *, title, description, path, image=None, jsonld=None, og_type="website"):
    url = f"{site['url']}{path}"
    img = f"{site['url']}{image}" if image else None
    tags = [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{e(title)}</title>",
        f'<meta name="description" content="{e(description)}">',
        f'<link rel="canonical" href="{e(url)}">',
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
        '<link rel="stylesheet" href="/style.css">',
        '<meta name="theme-color" content="#14110d">',
        f'<meta property="og:type" content="{og_type}">',
        f'<meta property="og:site_name" content="{e(site["name"])}">',
        '<meta property="og:locale" content="uk_UA">',
        f'<meta property="og:title" content="{e(title)}">',
        f'<meta property="og:description" content="{e(description)}">',
        f'<meta property="og:url" content="{e(url)}">',
        '<meta name="twitter:card" content="summary_large_image">',
    ]
    if img:
        tags.append(f'<meta property="og:image" content="{e(img)}">')
    if jsonld:
        data = json.dumps(jsonld, ensure_ascii=False, indent=1).replace("</", "<\\/")
        tags.append(f'<script type="application/ld+json">{data}</script>')
    return "\n".join(tags)


def header(site):
    return f"""<header class="top"><div class="wrap">
<a class="logo" href="/">{e(site['name'])}</a>
</div></header>"""


def footer(site):
    return f"""<footer class="foot"><div class="wrap">
<nav class="foot__links"><a href="/oplata/">Оплата і доставка</a><a href="/oferta/">Публічна оферта</a><a href="/contacts/">Контакти</a></nav>
<p>Оплата карткою Visa / Mastercard, Apple Pay, Google Pay через monobank.</p>
<p>© {dt.date.today().year} {e(site['name'])} · {e(site['seller']['name'])} · <a href="mailto:{e(site['contact_email'])}">{e(site['contact_email'])}</a></p>
</div></footer>"""


def page(site, head_html, body):
    return f"""<!doctype html>
<html lang="uk">
<head>
{head_html}
</head>
<body>
{header(site)}
<main class="wrap">
{body}
</main>
{footer(site)}
</body>
</html>
"""


TURNSTILE_JS = "https://challenges.cloudflare.com/turnstile/v0/api.js"


def buy_button(site, book, extra_class=""):
    if site.get("sales_enabled"):
        # Turnstile adds a hidden "cf-turnstile-response" field that functions/buy/[slug].js verifies.
        # interaction-only: invisible unless Cloudflare needs the visitor to tick a box.
        # data-action must match TURNSTILE_ACTION in functions/buy/[slug].js.
        widget = (f'<div class="cf-turnstile" data-sitekey="{e(site["turnstile_site_key"])}" data-action="buy" '
                  'data-appearance="interaction-only" data-language="uk"></div>')
        return (f'<form class="buy-form {extra_class}" method="post" action="/buy/{e(book["slug"])}">{widget}'
                f'<button class="buy" type="submit">Купити PDF — {price_uah(site, book)} грн</button></form>')
    return f'<span class="buy buy--off {extra_class}">Незабаром</span>'


def picture(book, sizes, alt, eager=False):
    w, h = sizes[640]
    load_attr = 'fetchpriority="high"' if eager else 'loading="lazy"'
    s = book["slug"]
    return (f'<img src="/{s}/cover-640.webp" '
            f'srcset="/{s}/cover-320.webp 320w, /{s}/cover-640.webp 640w" '
            f'sizes="(min-width: 760px) 300px, 60vw" width="{w}" height="{h}" '
            f'alt="{e(alt)}" {load_attr} decoding="async">')


def book_jsonld(site, book):
    url = f"{site['url']}/{book['slug']}/"
    return {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": ["Book", "Product"],
                "@id": url + "#book",
                "name": book["title_uk"],
                "alternateName": book["alternate_names"],
                "description": " ".join(book["description_uk"]),
                "url": url,
                "image": f"{site['url']}/{book['slug']}/cover.jpg",
                "inLanguage": "uk",
                "bookFormat": "https://schema.org/EBook",
                "numberOfPages": book["pages"],
                "author": {"@type": "Person", "name": book["author_uk"],
                           "alternateName": book["author_en"], "sameAs": book["author_wiki"]},
                "translationOfWork": {
                    "@type": "Book",
                    "name": book["title_original"],
                    "inLanguage": "en",
                    "author": {"@type": "Person", "name": book["author_en"]},
                    "datePublished": str(book["original_year"]),
                },
                "offers": {
                    "@type": "Offer",
                    "price": str(price_uah(site, book)),
                    "priceCurrency": "UAH",
                    "availability": "https://schema.org/InStock" if site.get("sales_enabled")
                    else "https://schema.org/PreOrder",
                    "url": url,
                },
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": site["name"], "item": site["url"] + "/"},
                    {"@type": "ListItem", "position": 2, "name": book["title_uk"], "item": url},
                ],
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {"@type": "Question", "name": f["q"],
                     "acceptedAnswer": {"@type": "Answer", "text": f["a"]}}
                    for f in book["faq"]
                ],
            },
        ],
    }


def render_toc(items):
    out, open_list = [], False
    for it in items:
        if it.startswith("# "):
            if open_list:
                out.append("</ul>")
            out.append(f"<h3>{e(it[2:])}</h3><ul>")
            open_list = True
        else:
            if not open_list:
                out.append("<ul>")
                open_list = True
            out.append(f"<li>{e(it)}</li>")
    if open_list:
        out.append("</ul>")
    return "\n".join(out)


def book_page(site, book, sizes):
    alt = f"Обкладинка книги «{book['title_uk']}» ({book['title_original']}) — {book['author_uk']}"
    desc = "\n".join(f"<p>{e(p)}</p>" for p in book["description_uk"])
    faq = "\n".join(
        f"<details><summary>{e(f['q'])}</summary><p>{e(f['a'])}</p></details>" for f in book["faq"])
    body = f"""
<nav class="crumbs" aria-label="Навігація"><a href="/">Усі книги</a> › {e(book['title_uk'])}</nav>

<article class="book">
  <div class="book__cover">{picture(book, sizes, alt, eager=True)}</div>
  <div class="book__info">
    <h1>{e(book['title_uk'])}</h1>
    <p class="sub">{e(book['subtitle_uk'])}</p>
    <p class="author">{e(book['author_uk'])} <span>{e(book['coauthor_uk'])}</span></p>
    <p class="orig"><span lang="en">{e(book['title_original'])}</span> українською · PDF</p>
    <div class="price-row">
      {buy_button(site, book)}
      <span class="note">≈ ${e(site['price_usd_hint'])} · завантаження одразу після оплати</span>
    </div>
    <dl class="facts">
      <dt>Оригінальна назва</dt><dd lang="en">{e(book['title_original'])}: {e(book['subtitle_original'])}</dd>
      <dt>Автор</dt><dd>{e(book['author_uk'])} ({e(book['author_en'])})</dd>
      <dt>Мова</dt><dd>українська (офіційний переклад)</dd>
      <dt>Формат</dt><dd>PDF, {book['pages']} сторінок</dd>
      <dt>Видання</dt><dd>{e(book['edition_note'])}</dd>
    </dl>
  </div>
</article>

<section class="block">
  <h2>Про книжку</h2>
  {desc}
</section>

<section class="block">
  <h2>Зміст</h2>
  <div class="toc">{render_toc(book['toc'])}</div>
</section>

<section class="block">
  <h2>Питання та відповіді</h2>
  {faq}
</section>

<section class="block en" lang="en">
  <h2>{e(book['title_original'])} in Ukrainian</h2>
  <p>{e(book['description_en'])}</p>
</section>

<div class="cta">{buy_button(site, book, "buy--wide")}</div>
"""
    h = head(site, title=book["seo_title"], description=book["seo_description"],
             path=f"/{book['slug']}/", image=f"/{book['slug']}/cover.jpg",
             jsonld=book_jsonld(site, book), og_type="book")
    if site.get("sales_enabled"):
        h += f'\n<script src="{TURNSTILE_JS}" async defer></script>\n<script src="/buy.js" defer></script>'
    return page(site, h, body)


def index_page(site, books, all_sizes):
    cards = []
    for b in books:
        alt = f"«{b['title_uk']}» — {b['author_uk']}"
        cards.append(f"""<li class="card">
  <a href="/{b['slug']}/">
    {picture(b, all_sizes[b['slug']], alt, eager=len(cards) < 2)}
    <h2>{e(b['title_uk'])}</h2>
    <p class="card__orig" lang="en">{e(b['title_original'])}</p>
    <p class="card__author">{e(b['author_uk'])}</p>
    <p class="card__price">{price_uah(site, b)} грн · PDF</p>
  </a>
</li>""")
    names = ", ".join(f"«{b['title_uk']}» ({b['title_original']})" for b in books)
    description = f"{site['tagline']} {names}."
    jsonld = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "WebSite", "name": site["name"], "url": site["url"] + "/", "inLanguage": "uk"},
            {"@type": "ItemList", "itemListElement": [
                {"@type": "ListItem", "position": i + 1, "url": f"{site['url']}/{b['slug']}/",
                 "name": b["title_uk"]} for i, b in enumerate(books)]},
        ],
    }
    body = f"""
<section class="hero">
  <h1>{e(site['name'])}</h1>
  <p>{e(site['tagline'])}</p>
</section>
<ul class="grid">
{chr(10).join(cards)}
</ul>
"""
    h = head(site, title=f"{site['name']} — офіційні українські переклади книг у PDF",
             description=description, path="/", jsonld=jsonld)
    return page(site, h, body)


def not_found(site):
    h = head(site, title=f"Сторінку не знайдено — {site['name']}", description="Сторінку не знайдено.", path="/404")
    h += '\n<meta name="robots" content="noindex">'
    return page(site, h, '<section class="hero"><h1>Сторінку не знайдено</h1><p><a href="/">До всіх книг →</a></p></section>')


def simple_page(site, path, title, body):
    h = head(site, title=f"{title} — {site['name']}", description=f"{title}. {site['name']}.", path=path)
    return page(site, h, f'<section class="block legal"><h1>{e(title)}</h1>\n{body}\n</section>')


def seller_lines(site):
    s = site["seller"]
    rows = [f"<p><strong>{e(s['name'])}</strong></p>"]
    if s.get("tax_id"):
        rows.append(f"<p>РНОКПП: {e(s['tax_id'])}</p>")
    if s.get("address"):
        rows.append(f"<p>Адреса: {e(s['address'])}</p>")
    if s.get("phone"):
        rows.append(f'<p>Телефон: <a href="tel:{e(s["phone"])}">{e(s["phone"])}</a></p>')
    rows.append(f'<p>E-mail: <a href="mailto:{e(site["contact_email"])}">{e(site["contact_email"])}</a></p>')
    return "\n".join(rows)


def legal_pages(site):
    mail = f'<a href="mailto:{e(site["contact_email"])}">{e(site["contact_email"])}</a>'
    pay_how = ("Оплата здійснюється переказом на банку monobank — будь-якою карткою Visa або Mastercard "
               "(у тому числі іноземною), через Apple Pay чи Google Pay. Після натискання «Купити» ви отримаєте "
               "код замовлення — його потрібно вказати в коментарі до переказу, щоб ми автоматично "
               "підтвердили оплату. Дані вашої картки ми не бачимо й не зберігаємо.")
    pay_short = "Оплата здійснюється переказом на банку monobank із кодом замовлення в коментарі."
    oplata = f"""
<h2>Оплата</h2>
<p>Ціни вказані в гривнях. {pay_how}</p>
<h2>Доставка</h2>
<p>Усі книги — електронні файли у форматі PDF. Фізична доставка не здійснюється. Одразу після успішної оплати відкривається сторінка з кнопкою «Завантажити PDF». Збережіть цю сторінку в закладках — за нею книгу можна завантажити повторно.</p>
<h2>Повернення коштів</h2>
<p>Якщо файл не завантажується, пошкоджений або не відповідає опису, напишіть на {mail} протягом 14 днів після покупки, додавши квитанцію. Ми надішлемо робочий файл або повернемо кошти на картку, з якої було здійснено оплату, протягом 7 робочих днів.</p>
<p>Оскільки цифровий контент надається одразу після оплати, у разі успішного завантаження повернення коштів з інших причин не передбачено.</p>
"""
    oferta = f"""
<p class="note">Редакція від {TODAY}.</p>
<h2>1. Загальні положення</h2>
<p>Цей документ є публічною пропозицією (офертою) {e(site['seller']['name'])} (далі — Продавець) укласти договір купівлі-продажу електронних копій книг на сайті {e(site['url'])} (далі — Сайт). Оплата замовлення є повним і беззастережним прийняттям (акцептом) умов цієї оферти.</p>
<h2>2. Предмет договору</h2>
<p>Продавець надає Покупцеві електронну копію книги у форматі PDF для особистого некомерційного використання. Покупець не має права копіювати, поширювати, публікувати чи продавати файл або його частини третім особам.</p>
<h2>3. Авторські права</h2>
<p>Українські переклади видано Продавцем на підставі ліцензій, отриманих від правовласників оригінальних творів. Усі права захищені.</p>
<h2>4. Ціна та оплата</h2>
<p>Ціна кожної книги вказана на її сторінці в гривнях. {pay_short} Додаткових комісій для Покупця Продавець не встановлює.</p>
<h2>5. Передача товару</h2>
<p>Товар вважається переданим з моменту, коли після успішної оплати Покупцеві стає доступна кнопка завантаження файлу.</p>
<h2>6. Повернення коштів</h2>
<p>Умови повернення описані на сторінці <a href="/oplata/">«Оплата і доставка»</a>.</p>
<h2>7. Персональні дані</h2>
<p>Платіжні дані обробляє банк. Продавець отримує від банку лише інформацію, необхідну для підтвердження оплати, і не передає її третім особам, окрім випадків, передбачених законом.</p>
<h2>8. Інші умови</h2>
<p>Відносини сторін регулюються законодавством України. Продавець може змінювати умови оферти; нові умови діють для замовлень, оформлених після їх публікації на Сайті.</p>
<h2>9. Реквізити Продавця</h2>
{seller_lines(site)}
"""
    contacts = f"""
<p>З питаннями щодо замовлень, оплати чи файлів пишіть — відповідаємо протягом доби.</p>
{seller_lines(site)}
"""
    return {
        "oplata": ("Оплата, доставка і повернення", oplata),
        "oferta": ("Публічна оферта", oferta),
        "contacts": ("Контакти", contacts),
    }


def protect_pdf(book):
    """Copy the PDF to a hard-to-guess path under /protected/ (which a Function blocks)."""
    src = ROOT / book["source_dir"] / book["pdf"]
    digest = hashlib.sha256(src.read_bytes()).hexdigest()[:16]
    rel = f"/protected/{book['slug']}-{digest}.pdf"
    (OUT / "protected").mkdir(exist_ok=True)
    shutil.copy(src, OUT / rel.lstrip("/"))
    return rel


def write_function_catalog(site, books, files):
    data = {
        "site": {
            "name": site["name"],
            "email": site["contact_email"],
            "sales_enabled": bool(site.get("sales_enabled")),
            "turnstile_site_key": site.get("turnstile_site_key", ""),
            "jar_url": site["jar"]["url"],
            "jar_account_id": site["jar"]["account_id"],
        },
        "books": {
            b["slug"]: {
                "title": b["title_uk"],
                "price_kop": int(round(float(price_uah(site, b)) * 100)),
                "file": files[b["slug"]],
                "cover": f"/{b['slug']}/cover.jpg",
            } for b in books
        },
    }
    out = ROOT / "lib" / "catalog.generated.js"
    out.write_text("// Generated by build.py — do not edit.\nexport default "
                   + json.dumps(data, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")


def main():
    site, books, warnings = load()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    for f in ASSETS.iterdir():
        shutil.copy(f, OUT / f.name)

    all_sizes, files = {}, {}
    for b in books:
        files[b["slug"]] = protect_pdf(b)
        sizes = make_covers(b)
        all_sizes[b["slug"]] = sizes
        (OUT / b["slug"] / "index.html").write_text(book_page(site, b, sizes), encoding="utf-8")

    (OUT / "index.html").write_text(index_page(site, books, all_sizes), encoding="utf-8")
    (OUT / "404.html").write_text(not_found(site), encoding="utf-8")
    legal = legal_pages(site)
    for slug, (title, body) in legal.items():
        (OUT / slug).mkdir()
        (OUT / slug / "index.html").write_text(simple_page(site, f"/{slug}/", title, body), encoding="utf-8")
    write_function_catalog(site, books, files)

    urls = ([f"{site['url']}/"] + [f"{site['url']}/{b['slug']}/" for b in books]
            + [f"{site['url']}/{slug}/" for slug in legal])
    (OUT / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{e(u)}</loc><lastmod>{TODAY}</lastmod></url>\n" for u in urls)
        + "</urlset>\n", encoding="utf-8")
    (OUT / "robots.txt").write_text("User-agent: *\nDisallow: /buy/\nDisallow: /pay/\nDisallow: /api/\nDisallow: /download/\nDisallow: /protected/\n\n"
        f"Sitemap: {site['url']}/sitemap.xml\n",
                                    encoding="utf-8")

    print(f"Built {len(books)} book page(s) into {OUT}")
    for w in warnings:
        print("WARNING:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
