"use client";

import { useEffect } from "react";

export default function GlobalError({ error }: Readonly<{ error: Error }>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

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
