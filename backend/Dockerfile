FROM python:3.14-alpine

RUN apk update && apk add --no-cache ffmpeg

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY pyproject.toml ./
RUN pip install --no-cache-dir --no-warn-script-location .

COPY src ./

HEALTHCHECK \
    --interval=5m \
    --timeout=5s \
    --start-period=5s \
    CMD wget --spider --tries=1  "http://localhost:${PORT:-8000}/api/health"

ENTRYPOINT [ "/app/run_server.sh" ]
