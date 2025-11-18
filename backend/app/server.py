#!/usr/bin/python3

from flask import Flask, request
from flask_cors import CORS

import logging
import re
import os
from pathlib import Path
import threading
from email_validator import validate_email, EmailNotValidError

from ise_record import postprocess_recording, send_report

app = Flask(__name__)

app.config['DESTDIR'] = './data'
app.config['REPORT_SENDER'] = None
app.config['SMTP_SERVER'] = ''
app.config['SMTP_PORT'] = ''

app.config.from_prefixed_env("ISE_RECORD")

CORS(app, resources={r"/api/*": { "origins": "*" }})

def create_track_path(recording: str, track: str) -> Path:
    destdir = Path(app.config["DESTDIR"])
    path = destdir / recording / track
    os.makedirs(path, exist_ok=True)
    return path

def is_safe_name(name: str | None) -> bool:
    return name is not None and re.fullmatch('^[A-Za-z0-9_.-]+$', name) is not None

def is_valid_email_or_none(address: str | None) -> bool:
    if address is None:
        return True

    try:
        validate_email(address)
        return True
    except EmailNotValidError:
        return False

def recording_exists(recording: str | None) -> bool:
    if not is_safe_name(recording):
        return False

    destdir = Path(app.config["DESTDIR"])
    return os.path.isdir(destdir / recording)

def postprocessing_task(
        recording: str,
        report_recipient: str | None,
        job_title: str | None
) -> None:
    recording_path = Path(app.config["DESTDIR"]) / recording
    job_result = postprocess_recording(recording_path)

    report_recipient="foo@bar.com"
    if report_recipient is not None:
        send_report(job_title or recording, job_result, app.config['REPORT_SENDER'], report_recipient)

@app.route('/api/chunks', methods=['POST'])
def upload_chunk():
    """ POST endpoint for the upload of chunk files """

    recording = request.form.get('recording')
    track = request.form.get('track')
    index = request.form.get('index')
    chunk = request.files.get('chunk')

    if not is_safe_name(recording) or not is_safe_name(track):
        return f'invalid track {recording}, {track}', 400
    elif index is None or not index.isdigit():
        return f'invalid index "{index}"', 400
    elif chunk is None:
        return 'no chunk supplied', 400

    filepath = create_track_path(recording, track) / f'chunk.{index.zfill(4)}'
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
    job_title = job_json.get('title')

    if not recording_exists(recording) or not is_valid_email_or_none(recipient):
        return 'Bad Request', 400

    thread = threading.Thread(
        target=postprocessing_task,
        args=(
            recording,
            recipient,
            job_title
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
