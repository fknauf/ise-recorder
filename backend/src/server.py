"""
   ISE-Recorder backend service. Stores chunk files and does postprocessing.

   This module defines the HTTP API endpoints and validates inputs.
"""

import logging
import os
from pathlib import Path
from typing import Annotated, List, Optional

import aiofiles
from fastapi import BackgroundTasks, FastAPI, Form, File, HTTPException, UploadFile, status
from pydantic import BaseModel, EmailStr, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from ise_record.logging import setup_logging
from ise_record.postprocess import postprocess_recording
from ise_record.reporting import normalize_recipient, send_report, SmtpSink

SAFE_NAME_REGEX = '^[\\w.-]+$'

class Settings(BaseSettings):
    """
        Configuration settings for the server. Options can be set through ISE_RECORD_VARNAME
        environment variables at server startup.
    """

    destdir: Path = Path("./data")

    smtp_server: Optional[str] = None
    smtp_port: Annotated[int, Field(ge=0, lt=65536)] = 0
    smtp_local_hostname: Optional[str] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_sender: Optional[EmailStr] = None
    smtp_starttls: bool = False
    smtp_allowed_domains: List[str] = []

    chunk_file_digits: int = 4

    model_config = SettingsConfigDict(env_prefix="ise_record_")

settings = Settings()
app = FastAPI()
setup_logging()

logger = logging.getLogger(__name__)

@app.post('/api/chunks', status_code=status.HTTP_201_CREATED)
async def upload_chunk(
    recording: Annotated[
        str,
        Form(
            pattern=SAFE_NAME_REGEX,
            description="Name of the recording. Usually consists of Lecture Title and Timestamp",
            examples=["PSU_2026-02-13T164309.313"],
        )
    ],
    track: Annotated[
        str,
        Form(
            pattern=SAFE_NAME_REGEX,
            description="Name of the track, e.g. stream, overlay, audio-0",
            examples=["stream", "overlay", "audio-0"]
        )
    ],
    index: Annotated[
        int,
        Form(
            ge=0,
            le=10 ** settings.chunk_file_digits - 1,
            description="Running number of the chunk in the track. Start at 0.",
            examples=[0]
        )
    ],
    chunk: Annotated[
        UploadFile,
        File(
            description="video/audio blob to store, as file"
        )
    ]
):
    """
    POST endpoint for the upload of chunk files.
    """
    filename = f'chunk.{index:04d}'

    track_path = settings.destdir / recording / track
    filepath = track_path / filename
    logger.debug("saving %s", filepath)

    os.makedirs(track_path, exist_ok=True)

    async with aiofiles.open(filepath, "wb") as out:
        while content := await chunk.read(128 * 1024):
            await out.write(content)

    return {
        "recording": recording,
        "track": track,
        "index": index,
        "filename": filename
    }

class PostProcessingJob(BaseModel):
    """ DTO for a postprocessing job the client wants to schedule """

    recording: Annotated[
        str,
        Field(
            pattern=SAFE_NAME_REGEX,
            description="Name of the recording. Usually consists of Lecture Title and Timestamp",
            examples=["PSU_2026-02-13T164309.313"]
        )
    ]
    # backend will validate before sending email. We want the postprocessing to work even if
    # someone has a typo in the mail address or doesn't specify a recipient, so we don't reject
    # a malformed recipient here (we just don't send mail later)
    recipient: Annotated[
        Optional[str],
        Field(
            default=None,
            description="Recipient of the completion notification",
            examples=["mustermann@vss.uni-hannover.de", None]
        )
    ]

async def _postprocessing_task(job: PostProcessingJob) -> None:
    recording_path = settings.destdir / job.recording
    job_result = await postprocess_recording(recording_path)

    normalized_recipient = normalize_recipient(job.recipient, settings.smtp_allowed_domains)

    if normalized_recipient is not None:
        smtp_sink = SmtpSink(
            server = settings.smtp_server,
            port = settings.smtp_port,
            local_hostname = settings.smtp_local_hostname,
            starttls = settings.smtp_starttls,
            username = settings.smtp_username,
            password = settings.smtp_password)

        await send_report(
            smtp_sink=smtp_sink,
            sender=settings.smtp_sender,
            recipient=normalized_recipient,
            job_title=job.recording,
            result=job_result)

@app.post('/api/jobs', status_code=status.HTTP_202_ACCEPTED)
def schedule_job(
    job: PostProcessingJob,
    background_tasks: BackgroundTasks
):
    """ Endpoint for the scheduling of postprocessing jobs """

    if not os.path.isdir(settings.destdir / job.recording):
        logger.warning("Bad postprocessing request: Recording %s does not exist", job.recording)
        raise HTTPException(status_code=400, detail=f'Recording {job.recording} does not exist')

    background_tasks.add_task(_postprocessing_task, job)

    return job

@app.get('/api/health')
def health_check():
    """ Endpoint for container health checks """
    logger.debug("health check requested")
    return { "status": "healthy" }
