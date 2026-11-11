// monobank personal-API webhook: https://<site>/api/mono-hook/<MONO_HOOK_SECRET>
// monobank sends GET once to check the URL, then POST for every transaction on your accounts.
// Only transactions of the configured jar are stored; everything else is ignored.
//
// With the right secret it always answers 200, at once, and saves the transaction in the background.
// monobank switches the webhook off after repeated failed (or slow) deliveries and doesn't turn it
// back on, so a database problem must never look like a failure. Anything that couldn't be saved
// here is picked up by the jar poll (cron every 5 min, see src/worker.js).
import { recordTx } from "../../../lib/jar.js";

const valid = (params, env) => !!env.MONO_HOOK_SECRET && params.secret === env.MONO_HOOK_SECRET;

export function onRequestGet({ params, env }) {
  return valid(params, env) ? new Response("ok") : new Response("Not found", { status: 404 });
}

export async function onRequestPost({ params, env, request, waitUntil }) {
  if (!valid(params, env)) return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => null);
  if (body && body.type === "StatementItem" && body.data) {
    waitUntil(
      recordTx(env, body.data.account, body.data.statementItem)
        .catch((e) => console.error("webhook: not saved, the jar poll will retry", e)),
    );
  }
  return new Response("ok");
}
