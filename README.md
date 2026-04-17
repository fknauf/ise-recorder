# ISE-Recorder

This is a fairly simple web-based lecture recorder. Recordings are stored on
the client-side in the browser's OPFS.

There's optional support for a post-processing backend server, configurable in
the environment variable `ISE_RECORD_API_URL`. If it is set, the recorded
streams will be posted there chunk by chunk and the server notified to start
post-processing when the recording stops.

Video streams can be marked as main or overlay, and post-processing consists of
overlaying the overlay stream (usually the speaker on a webcam) over the main
stream (usually lecture slides) in the top-right corner such that the slides
are not obstructed but the speaker remains recognizable. If there are multiple
audio streams, they will all be attached to the resulting video file. If there
is no overlay, post-processing just indexes the main video stream.

Recordings that don't fit the mold of 1 main video, 0-1 overlay, n audio streams
require manual post-processing.

## Get started

I recommend running in docker:

    mkdir -m 777 data
    docker compose build
    docker compose up

then visit http://localhost:3000.

The stock `compose.yml` includes a backend that mounts the `data` directory to
its dumping ground, so postprocessed recordings will appear there. The `data`
dir only needs mode 777 if the user configured in the `compose.yml` differs
from the one running in the backend container, which can happen with
rootless docker or if your uid:gid is not `1000:1000`. Giving it mode 777
just avoids the need for configuration before getting started.

For production environments, it's recommended to mount a data directory owned
by the process user in the backend container. You can run it behind a reverse
proxy that handles TLS. I haven't tested serving it in a subdirectory, so I
recommend using a subdomain; the most straightforward config is to have the
frontend at `/` and the backend (if you want one) at `/api`.

## Hack it yourself

Clone repo and for the frontend run

    cd frontend
    npm install
    npm run dev
    # or if you want to use the postprocessing backend:
    ISE_RECORD_API_URL=http://localhost:8000 npm run dev

For the backend run

    cd backend
    python -m venv .venv
    . .venv/bin/activate
    pip install -e . --group dev
    fastapi dev
