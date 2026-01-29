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
from pydantic import BaseModel, EmailStr, Field, IPvAnyAddress
from pydantic_extra_types.domain import DomainStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from ise_record.postprocess import postprocess_recording
from ise_record.reporting import normalize_recipient, send_report, SmtpSink

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
    smtp_allowed_domains: List[DomainStr] = []

    chunk_file_digits: int = 4
    safe_name_regex: str = '^[A-Za-z0-9_.-]+$'

    model_config = SettingsConfigDict(env_prefix="ise_record_")

settings = Settings()
app = FastAPI()

uvicorn_logger = logging.getLogger('uvicorn.error')
logging.basicConfig(
    level=uvicorn_logger.level,
    handlers=uvicorn_logger.handlers)

logger = logging.getLogger(__name__)

@app.post('/api/chunks', status_code=status.HTTP_201_CREATED)
async def upload_chunk(
    recording: Annotated[str, Form(pattern=settings.safe_name_regex)],
    track: Annotated[str, Form(pattern=settings.safe_name_regex)],
    index: Annotated[int, Form(ge=0, lt=10 ** settings.chunk_file_digits)],
    chunk: Annotated[UploadFile, File()]
):
    """ POST endpoint for the upload of chunk files """

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

    recording: Annotated[str, Field(pattern=settings.safe_name_regex)]
    # backend will validate before sending email. We want the postprocessing to work
    # even if someone has a typo in the mail address or doesn't specify a recipient
    recipient: Optional[str] = None

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
