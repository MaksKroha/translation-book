// POST /buy/<slug> — creates an order with a 6-digit code and sends the buyer to /pay/?o=<token>.
// A form POST (not a link) so search-engine crawlers never create orders.
//
// Two checks run before an order is written to the database:
//   1. Origin: the form must come from our own pages, so other sites can't make their visitors'
//      browsers create orders.
//   2. Cloudflare Turnstile: the form carries a one-time token from the widget on the book page
//      (build.py → buy_button), verified with Cloudflare. Stops scripts creating orders in bulk.
// Both checks live in lib/guard.js (shared with the translation request form).
import catalog from "../../lib/catalog.generated.js";
import { createOrder } from "../../lib/jar.js";
import { statusPage, contactLine } from "../../lib/html.js";
import { fromOwnSite, passedTurnstile } from "../../lib/guard.js";

const TURNSTILE_ACTION = "buy"; // must match data-action in build.py → buy_button()

const tryAgain = (slug) =>
  `<p>Поверніться на сторінку книги й натисніть «Купити» ще раз.</p>
<p><a class="buy" href="/${encodeURIComponent(slug)}/">Спробувати ще раз</a></p>${contactLine()}`;

export async function onRequestPost({ request, params, env }) {
  if (!fromOwnSite(request)) {
    return statusPage("Запит відхилено", `<p><a href="/">До всіх книг →</a></p>`, { status: 403 });
  }

  const book = catalog.books[params.slug];
  if (!book) return statusPage("Книгу не знайдено", `<p><a href="/">До всіх книг →</a></p>`, { status: 404 });

  const configured = !!(env.DB && catalog.site.jar_url && catalog.site.jar_account_id
    && catalog.site.turnstile_site_key && env.TURNSTILE_SECRET_KEY);
  if (!catalog.site.sales_enabled || !configured) {
    if (catalog.site.sales_enabled) {
      console.error("checkout not configured:", JSON.stringify({
        DB: !!env.DB, jar: !!(catalog.site.jar_url && catalog.site.jar_account_id),
        turnstile_site_key: !!catalog.site.turnstile_site_key, TURNSTILE_SECRET_KEY: !!env.TURNSTILE_SECRET_KEY,
      }));
    }
    return statusPage("Продаж незабаром", `<p>Ми ще налаштовуємо оплату. Спробуйте трохи пізніше.</p>`, { status: 503 });
  }

  try {
    const form = await request.formData().catch(() => null);
    if (!(await passedTurnstile(request, env, form && form.get("cf-turnstile-response"), TURNSTILE_ACTION))) {
      return statusPage("Не вдалося перевірити браузер", tryAgain(params.slug), { status: 403 });
    }
    const { token } = await createOrder(env, params.slug);
    return new Response(null, { status: 303, headers: { Location: `/pay/?o=${token}`, "Cache-Control": "no-store" } });
  } catch (e) {
    console.error(e);
    return statusPage("Оплата тимчасово недоступна", `<p>Спробуйте ще раз за хвилину.</p>${contactLine()}`, { status: 502 });
  }
}

export function onRequestGet({ params }) {
  // Someone opened /buy/<slug> directly — send them to the book page.
  return new Response(null, { status: 302, headers: { Location: `/${encodeURIComponent(params.slug)}/` } });
}
