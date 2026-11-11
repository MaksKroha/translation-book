// GET /api/order?o=<token> — JSON status for the /pay/ page. Triggers the statement fallback poll.
import { getOrder, pollJar } from "../../lib/jar.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get("o");
  try {
    let order = await getOrder(env, token);
    if (!order) return json({ status: "unknown" }, 404);
    // Give the webhook ~20 s to arrive before spending the once-a-minute statement request.
    if (order.status !== "paid" && Date.now() / 1000 - order.created > 20) {
      await pollJar(env);
      order = await getOrder(env, token);
    }
    return json({ status: order.status, paid_kop: order.paid_kop, price_kop: order.price_kop });
  } catch (e) {
    console.error(e);
    return json({ status: "error" }, 502);
  }
}
