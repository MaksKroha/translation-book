// monobank personal-API webhook: https://<site>/api/mono-hook/<MONO_HOOK_SECRET>
// monobank sends GET once to check the URL, then POST for every transaction on your accounts.
// Only transactions of the configured jar are stored; everything else is ignored.
import { recordTx } from "../../../lib/jar.js";

const valid = (params, env) => !!env.MONO_HOOK_SECRET && params.secret === env.MONO_HOOK_SECRET;

export function onRequestGet({ params, env }) {
  return valid(params, env) ? new Response("ok") : new Response("Not found", { status: 404 });
}

export async function onRequestPost({ params, env, request }) {
  if (!valid(params, env)) return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => null);
  if (body && body.type === "StatementItem" && body.data) {
    try {
      await recordTx(env, body.data.account, body.data.statementItem);
    } catch (e) {
      console.error(e);
      return new Response("error", { status: 500 }); // monobank will retry
    }
  }
  return new Response("ok");
}
