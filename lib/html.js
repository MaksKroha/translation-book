import catalog from "./catalog.generated.js";

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Small status page (payment / errors) that matches the static site's look.
export function statusPage(title, bodyHtml, { status = 200, refresh = 0 } = {}) {
  const site = catalog.site;
  const html = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<title>${esc(title)} — ${esc(site.name)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top"><div class="wrap"><a class="logo" href="/">${esc(site.name)}</a></div></header>
<main class="wrap"><section class="hero status"><h1>${esc(title)}</h1>${bodyHtml}</section></main>
<footer class="foot"><div class="wrap"><p><a href="mailto:${esc(site.email)}">${esc(site.email)}</a></p></div></footer>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export const contactLine = () =>
  `<p>Якщо щось пішло не так, напишіть на <a href="mailto:${esc(catalog.site.email)}">${esc(catalog.site.email)}</a> і додайте квитанцію про оплату — ми надішлемо книгу вручну.</p>`;
