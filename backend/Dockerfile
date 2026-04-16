FROM python:3.14-alpine

RUN apk --no-cache upgrade && apk add --no-cache ffmpeg

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build
COPY pyproject.toml ./
RUN pip install --no-cache-dir --no-warn-script-location .
COPY src ./
RUN pip install --no-cache-dir --no-warn-script-location . && \
    mkdir /app && \
    ln -s /usr/local/bin/ise-rerender /app/rerender && \
    rm -Rf /build

WORKDIR /app
COPY src/run_server.sh ./
ENTRYPOINT [ "/app/run_server.sh" ]

HEALTHCHECK \
    --interval=5m \
    --timeout=5s \
    --start-period=5s \
    CMD wget --spider --tries=1 "http://localhost:${PORT:-8000}/api/health"
