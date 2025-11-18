#!/bin/bash

exec gunicorn --preload -w 3 -b ":${PORT:-8000}" "$@" server:app
