// GET /download/?o=<token> — streams the PDF, only for a paid order.
import { getOrder } from "../../lib/jar.js";
import { statusPage, contactLine } from "../../lib/html.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get("o") || "";

  let order;
  try {
    order = await getOrder(env, token);
  } catch (e) {
    console.error(e);
    return statusPage("Спробуйте ще раз за хвилину", contactLine(), { status: 502 });
  }
  if (!order || order.status !== "paid") {
    return new Response(null, { status: 302, headers: { Location: `/pay/?o=${encodeURIComponent(token)}` } });
  }

  // env.ASSETS serves the file directly; the public /protected/* URL is blocked by functions/protected.
  const file = await env.ASSETS.fetch(new URL(order.book.file, url.origin));
  if (!file.ok) {
    console.error("missing file", order.book.file, file.status);
    return statusPage("Файл тимчасово недоступний", contactLine(), { status: 500 });
  }
  return new Response(file.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${order.slug}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
