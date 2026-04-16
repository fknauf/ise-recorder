#!/bin/sh

exec uvicorn --host 0.0.0.0 --port "${PORT:-8000}" "$@" ise_record.server:app
