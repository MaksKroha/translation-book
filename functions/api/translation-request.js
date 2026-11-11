// POST /api/translation-request — the "Замовити переклад" form (build.py → request_page).
//
// Same two checks as the Buy button (lib/guard.js): the form must come from our own pages, and it
// must carry a valid Cloudflare Turnstile token. Then the fields are checked, the request is saved
// to D1 and emailed to you (lib/requests.js).
//
// On success the visitor is redirected (303) to a static thank-you page, so refreshing it can't
// send the request twice. Nothing the visitor typed goes into that URL or into the logs.
import catalog from "../../lib/catalog.generated.js";
import { fromOwnSite, passedTurnstile } from "../../lib/guard.js";
import { validateRequest, saveRequest, deliver } from "../../lib/requests.js";
import { statusPage, esc } from "../../lib/html.js";

const TURNSTILE_ACTION = "request"; // must match data-action in build.py → request_page()
const FORM = "/zamovyty-pereklad/"; // build.py → REQUEST_PATH
const THANKS = "/zamovyty-pereklad/dyakuyemo/"; // build.py → THANKS_PATH

const mail = () => `<a href="mailto:${esc(catalog.site.email)}">${esc(catalog.site.email)}</a>`;
const writeUs = () => `<p>Або напишіть нам на ${mail()} — назву книги й автора.</p>`;
const backToForm =
  `<p>Поверніться до форми кнопкою «Назад» у браузері, виправте й надішліть ще раз.</p>
<p><a class="buy" href="${FORM}">До форми</a></p>`;

const thanks = () => new Response(null, { status: 303, headers: { Location: THANKS, "Cache-Control": "no-store" } });

export async function onRequestPost({ request, env, waitUntil }) {
  if (!fromOwnSite(request)) {
    return statusPage("Запит відхилено", `<p><a href="/">До всіх книг →</a></p>`, { status: 403 });
  }
  if (!env.DB || !catalog.site.turnstile_site_key || !env.TURNSTILE_SECRET_KEY) {
    console.error("translation requests not configured:", JSON.stringify({
      DB: !!env.DB, turnstile_site_key: !!catalog.site.turnstile_site_key, TURNSTILE_SECRET_KEY: !!env.TURNSTILE_SECRET_KEY,
    }));
    return statusPage("Форма тимчасово не працює", writeUs(), { status: 503 });
  }

  try {
    const form = await request.formData().catch(() => null);
    // Honeypot: a field people never see (build.py → request_page). Bots that fill in every field
    // get the thank-you page, but nothing is saved or sent.
    if (form && form.get("website")) return thanks();

    const { data, errors } = validateRequest(form);
    if (errors) {
      const list = errors.map((m) => `<li>${esc(m)}</li>`).join("\n");
      return statusPage("Перевірте форму", `<ul class="steps">\n${list}\n</ul>\n${backToForm}`, { status: 400 });
    }
    if (!(await passedTurnstile(request, env, form.get("cf-turnstile-response"), TURNSTILE_ACTION))) {
      return statusPage("Не вдалося перевірити браузер", backToForm + writeUs(), { status: 403 });
    }

    const saved = await saveRequest(env, data);
    if (saved.limited === "visitor") {
      return statusPage("Ви вже надіслали кілька запитів",
        `<p>З однієї адреси можна надіслати лише кілька запитів на добу. Спробуйте завтра.</p>${writeUs()}`, { status: 429 });
    }
    if (saved.limited === "site") {
      return statusPage("Форма тимчасово не працює",
        `<p>Сьогодні надійшло забагато запитів. Спробуйте завтра.</p>${writeUs()}`, { status: 503 });
    }

    // The request is saved. Email it in the background; if that fails, the cron sends it later.
    waitUntil(deliver(env, saved.id).catch((e) => console.error(`translation request #${saved.id}: not emailed, the cron will retry`, e)));
    return thanks();
  } catch (e) {
    console.error(e);
    return statusPage("Не вдалося надіслати запит", `<p>Спробуйте ще раз за хвилину.</p>${writeUs()}`, { status: 502 });
  }
}

export function onRequestGet() {
  // Someone opened the form's address directly: show them the form.
  return new Response(null, { status: 302, headers: { Location: FORM } });
}
