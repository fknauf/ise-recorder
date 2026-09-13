"use client";

export default function GlobalError({
  error
}: {
  error: Error
}) {
  console.error(error);

  return (
    // global-error must include html and body tags
    <html>
      <body>
        <h1>Unexpected Error</h1>

        <section>
          <p>{error.message}</p>
        </section>
      </body>
    </html>
  );
}
