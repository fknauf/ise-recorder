FROM python:3.15-alpine

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

RUN apk --no-cache upgrade && apk add --no-cache ffmpeg
RUN --mount=type=tmpfs,target=/tmp/build \
    --mount=type=bind,source=pyproject.toml,target=/tmp/build/pyproject.toml \
    pip install --only-deps /tmp/build

RUN --mount=type=tmpfs,target=/tmp/build \
    --mount=type=bind,source=pyproject.toml,target=/tmp/build/pyproject.toml \
    --mount=type=bind,source=src,target=/tmp/build/src,rw \
    pip install --no-deps /tmp/build && \
    pip uninstall -y pip

COPY src/run_server.sh /app/
RUN ln -s /usr/local/bin/ise-rerender /app/rerender.py
RUN mkdir data && chown 1000:1000 data

USER 1000:1000
ENTRYPOINT [ "/app/run_server.sh" ]

HEALTHCHECK \
    --interval=5m \
    --timeout=5s \
    --start-period=30s \
    --start-interval=5s \
    CMD wget --spider --tries=1 "http://127.0.0.1:${PORT:-8000}${ISE_RECORD_ROUTE_PREFIX}/api/health"
