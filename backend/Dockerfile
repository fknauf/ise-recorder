FROM python:3.14-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get -y upgrade \
    && apt-get -y install --no-install-recommends curl ffmpeg \
    && apt-get clean \
    && rm -rf /var/cache/apt/archives /var/lib/apt/lists/*

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
    CMD curl -qf "http://localhost:${PORT:-8000}/api/health"

ENTRYPOINT [ "/app/run_server.sh" ]
