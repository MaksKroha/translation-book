// "Замовити переклад" page (build.py → request_page).
// - After the first click the button is switched off, so a double click doesn't send the form
//   twice (the second copy would fail the bot check and show an error page).
// - A Turnstile token works only once. If the visitor comes back with the browser's Back button
//   (say, to fix a field), get a fresh token but keep what they typed.
(function () {
  var form = document.querySelector(".request-form");
  if (!form) return;
  var button = form.querySelector("button[type=submit]");
  form.addEventListener("submit", function () { button.disabled = true; });
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    button.disabled = false;
    try { window.turnstile.reset(); } catch (err) { location.reload(); }
  });
})();
