// POST /buy/<slug> — creates an order with a 6-digit code and sends the buyer to /pay/?o=<token>.
// A form POST (not a link) so search-engine crawlers never create orders.
import catalog from "../../lib/catalog.generated.js";
import { createOrder } from "../../lib/jar.js";
import { statusPage, contactLine } from "../../lib/html.js";

export async function onRequestPost({ params, env }) {
  const book = catalog.books[params.slug];
  if (!book) return statusPage("Книгу не знайдено", `<p><a href="/">До всіх книг →</a></p>`, { status: 404 });

  const configured = !!(env.DB && catalog.site.jar_url && catalog.site.jar_account_id);
  if (!catalog.site.sales_enabled || !configured) {
    return statusPage("Продаж незабаром", `<p>Ми ще налаштовуємо оплату. Спробуйте трохи пізніше.</p>`, { status: 503 });
  }

  try {
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
