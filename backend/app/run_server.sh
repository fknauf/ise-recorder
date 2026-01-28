#!/bin/bash

exec uvicorn --workers 3 --port "${PORT:-8000}" "$@" server:app
