#!/bin/sh

cd $(dirname "$0")
exec uvicorn --workers 3 --host 0.0.0.0 --port "${PORT:-8000}" "$@" server:app
