# ISE-Recorder

This is a fairly simple web-based lecture recorder. Recordings are stored on
the client-side in the browser's OPFS.

There's optional support for a post-processing backend server, configurable in
the environment variable `ISE_RECORD_API_URL`. If it is set, the recorded
streams will be posted there chunk by chunk and the server notified to start
post-processing when the recording stops.

## Run it yourself

I recommend running in docker:

    docker compose build
    docker compose up

then visit http://localhost:3000

For production environments, you can run it behind a reverse proxy that handles
TLS. I haven't tested serving it in a subdirectory, so I recommend using a
subdomain.

## Hack it yourself

Clone repo and for the frontend run

    cd frontend
    npm install
	# omit the ISE_RECORD_API_URL envvar to run serverless
    ISE_RECORD_API_URL=http://localhost:5000 npm run dev

For the backend run

    cd backend
	python -m venv .venv
	. .venv/bin/activate
	pip install -r app/requirements.txt
	python app/server.py
