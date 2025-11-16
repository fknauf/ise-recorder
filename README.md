# ISE-Recorder

This is a fairly simple web-based lecture recorder. Recordings are stored on
the client-side in the browser's OPFS.

## Live Demo

See https://record.rinderher.de

## Run it yourself

I recommend running in docker:

```
    docker compose build
    docker compose up
```

then visit http://localhost:3000

For production environments, you can run it behind a reverse proxy that handles
TLS. I haven't tested serving it in a subdirectory, so I recommend using a
subdomain.

## Hack it yourself

Clone repo and run

```
npm install
npm run dev
```
