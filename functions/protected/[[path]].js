// Blocks direct access to the paid PDFs. They are served only through /download/ after payment.
export const onRequest = () => new Response("Not found", { status: 404 });
