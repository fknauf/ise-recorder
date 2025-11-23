#!/usr/bin/python3

"""
   ISE-Recorder backend service. Stores chunk files and does postprocessing.

   This module defines the HTTP API endpoints and validates inputs.
"""

import logging
import os
from pathlib import Path
import re
import threading
from typing import List, Tuple

from email_validator import validate_email, EmailNotValidError
from flask import Flask, request
from flask_cors import CORS

from ise_record import postprocess_recording, send_report, SmtpSink

app = Flask(__name__)

app.config.update(
    DESTDIR = './data',
    SMTP_SERVER = None,
    SMTP_PORT = 0,
    SMTP_LOCAL_HOSTNAME = None,
    SMTP_USERNAME = None,
    SMTP_PASSWORD = None,
    SMTP_SENDER = None,
    SMTP_STARTTLS = False,
    SMTP_ALLOWED_DOMAINS = []
)

app.config.from_prefixed_env("ISE_RECORD")

CORS(app, resources={r"/api/*": { "origins": "*" }})

def _create_track_path(recording: str, track: str) -> Path:
    destdir = Path(app.config["DESTDIR"])
    path = destdir / recording / track
    os.makedirs(path, exist_ok=True)
    return path

def _is_safe_name(name: str | None) -> bool:
    return name is not None and re.fullmatch('^[A-Za-z0-9_.-]+$', name) is not None

def _recording_exists(recording: str | None) -> bool:
    if not _is_safe_name(recording):
        return False

    destdir = Path(app.config["DESTDIR"])
    return os.path.isdir(destdir / recording)

def _is_in_domain(domain: str, normalized_address: str):
    return normalized_address.endswith(f'@{domain}') or normalized_address.endswith(f'.{domain}')

def _is_whitelisted(normalized_address: str):
    whitelist: List[str] = app.config['SMTP_ALLOWED_DOMAINS']

    if whitelist == []:
        return True
    return next((True for d in whitelist if _is_in_domain(d, normalized_address)), False)

def _validate_email(address: str | None) -> str | None:
    if address is None or address.strip() == "":
        return None

    try:
        validated = validate_email(address)
        if _is_whitelisted(validated.normalized):
            return validated.normalized
    except EmailNotValidError:
        logging.warning("Invalid or blacklisted recipient address: %s", address)

    return None

def _postprocessing_task(
        recording: str,
        recipient: str | None
) -> None:
    recording_path = Path(app.config["DESTDIR"]) / recording
    job_result = postprocess_recording(recording_path)

    normalized_recipient = _validate_email(recipient)

    if normalized_recipient is not None:
        smtp_sink = SmtpSink(
            server = app.config['SMTP_SERVER'],
            port = int(app.config['SMTP_PORT']),
            local_hostname = app.config['SMTP_LOCAL_HOSTNAME'],
            starttls = bool(app.config['SMTP_STARTTLS']),
            username = app.config['SMTP_USERNAME'],
            password = app.config['SMTP_PASSWORD'])

        sender = app.config['SMTP_SENDER']

        send_report(
            smtp_sink=smtp_sink,
            sender=sender,
            recipient=normalized_recipient,
            job_title=recording,
            result=job_result)

@app.route('/api/chunks', methods=['POST'])
def upload_chunk():
    """ POST endpoint for the upload of chunk files """

    recording = request.form.get('recording')
    track = request.form.get('track')
    index = request.form.get('index')
    chunk = request.files.get('chunk')

    if not _is_safe_name(recording) or not _is_safe_name(track):
        return f'invalid track {recording}, {track}', 400
    if index is None or not index.isdigit():
        return f'invalid index "{index}"', 400
    if chunk is None:
        return 'no chunk supplied', 400

    filepath = _create_track_path(recording, track) / f'chunk.{index.zfill(4)}'
    chunk.save(filepath)

    return '', 201

@app.route('/api/jobs', methods=['POST'])
def schedule_job():
    """ POST endpoint for the scheduling of postprocessing jobs """

    job_json = request.json
    if job_json is None:
        return 'Bad Request', 400

    recording = job_json.get('recording')
    recipient = job_json.get('recipient')

    if not _recording_exists(recording):
        return 'Bad Request', 400

    thread = threading.Thread(
        target=_postprocessing_task,
        args=(
            recording,
            recipient
        )
    )
    thread.start()

    return '', 201

if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG)
    app.run(debug=True)
else:
    gunicorn_logger = logging.getLogger('gunicorn.error')
    app.logger.handlers = gunicorn_logger.handlers
    app.logger.setLevel(gunicorn_logger.level)
