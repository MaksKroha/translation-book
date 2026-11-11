// Book pages: a Turnstile token works only once. If the visitor clicked "Купити" and then came
// back with the browser's Back button, the page is restored with the used token; reload it so
// the Buy button gets a fresh one.
window.addEventListener("pageshow", function (e) {
  if (e.persisted && document.querySelector(".cf-turnstile")) location.reload();
});
