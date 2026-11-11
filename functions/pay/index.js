// GET /pay/?o=<token> — jar mode: payment instructions, then the download button once paid.
import { getOrder, jarPayUrl, pollJar } from "../../lib/jar.js";
import { statusPage, contactLine, esc } from "../../lib/html.js";

const uah = (kop) => (kop / 100).toLocaleString("uk-UA", { maximumFractionDigits: 2 });

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get("o");
  let order;
  try {
    order = await getOrder(env, token);
    if (order && order.status !== "paid" && Date.now() / 1000 - order.created > 20) {
      await pollJar(env);
      order = await getOrder(env, token);
    }
  } catch (e) {
    console.error(e);
    return statusPage("Спробуйте ще раз за хвилину", contactLine(), { status: 502, refresh: 15 });
  }
  if (!order) return statusPage("Замовлення не знайдено", contactLine(), { status: 404 });

  const title = esc(order.book.title);
  const tok = encodeURIComponent(token);

  if (order.status === "paid") {
    return statusPage(
      "Дякуємо за покупку!",
      `<p>«${title}» — ваша.</p>
<p><a class="buy" href="/download/?o=${tok}">Завантажити PDF</a></p>
<p class="note">Збережіть цю сторінку в закладках — за цим посиланням книгу можна завантажити повторно.</p>`,
    );
  }

  const due = order.price_kop - order.paid_kop;
  const underpaid = order.status === "underpaid";
  const code = esc(order.code);
  const body = `
${underpaid ? `<p><strong>Отримали ${uah(order.paid_kop)} грн із ${uah(order.price_kop)} грн.</strong> Доплатіть ${uah(due)} грн з тим самим кодом.</p>` : ""}
<p>«${title}» — <strong>${uah(due)} грн</strong></p>
<div class="code-box">
  <span>Код замовлення</span>
  <strong id="code">${code}</strong>
  <button type="button" class="copy" id="copy">Копіювати</button>
</div>
<ol class="steps">
  <li>Натисніть «Оплатити в monobank». Відкриється банка monobank — платити можна будь-якою карткою, Apple Pay чи Google Pay.</li>
  <li>Сума — <strong>${uah(due)} грн</strong>. У полі <strong>«Коментар»</strong> обов’язково вкажіть код <strong>${code}</strong>.</li>
  <li>Поверніться на цю сторінку — кнопка завантаження з’явиться автоматично (зазвичай до хвилини).</li>
</ol>
<p><a class="buy" href="${esc(jarPayUrl(order, due))}" target="_blank" rel="noopener">Оплатити в monobank</a></p>
<p class="note" id="state">Очікуємо оплату…</p>
<p class="note">Збережіть цю сторінку в закладках. <a href="">Я оплатив — перевірити</a></p>
${contactLine()}
<script>
(function () {
  var btn = document.getElementById("copy");
  btn.addEventListener("click", function () {
    navigator.clipboard && navigator.clipboard.writeText("${code}").then(function () { btn.textContent = "Скопійовано"; });
  });
  var tries = 0;
  function check() {
    fetch("/api/order?o=${tok}", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.status === "paid" || d.paid_kop !== ${order.paid_kop}) location.reload();
    }).catch(function () {}).finally(function () {
      tries++; setTimeout(check, tries < 60 ? 5000 : 30000);
    });
  }
  setTimeout(check, 5000);
})();
</script>`;
  return statusPage(underpaid ? "Оплата неповна" : "Оплата замовлення", body);
}
