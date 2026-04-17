FROM python:3.14-alpine

RUN apk --no-cache upgrade && apk add --no-cache ffmpeg

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_NO_WARN_SCRIPT_LOCATION=1

WORKDIR /app
COPY pyproject.toml ./
RUN pip install .
COPY src ./

ENTRYPOINT [ "/app/run_server.sh" ]

HEALTHCHECK \
    --interval=5m \
    --timeout=5s \
    --start-period=5s \
    CMD wget --spider --tries=1 "http://localhost:${PORT:-8000}/api/health"
