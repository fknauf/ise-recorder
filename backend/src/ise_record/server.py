"""
   ISE-Recorder backend service. Stores chunk files and does postprocessing.

   This module defines the HTTP API endpoints and validates inputs.
"""

from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path
from typing import Annotated, AsyncGenerator
import unicodedata

import aiofiles
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status
)
from fastapi.middleware.cors import CORSMiddleware
from pathvalidate import sanitize_filename
from pydantic import BaseModel, BeforeValidator, Field

from .auth import get_current_user_home, load_oidc_config
from .logconfig import setup_logging
from .postprocess import postprocess_recording
from .reporting import normalize_recipient, send_report
from .settings import Settings, get_settings

def _normalize_for_filesystem(value: str) -> str:
    return sanitize_filename(unicodedata.normalize("NFC", value), platform="universal")

SafeRecording = Annotated[
    str,
    BeforeValidator(_normalize_for_filesystem),
    Field(
        pattern=r"\A[\p{L}\p{N}_][\p{L}\p{M}\p{N}._-]*\z",
        min_length=1,
        description="Name of the recording. Usually consists of Lecture Title and Timestamp",
        examples=["PSU_2026-02-13T164309.313Z"],
    )
]

setup_logging()
logger = logging.getLogger(__name__)
router = APIRouter()

class ChunkUpload(BaseModel):
    """ An uploaded chunk with metadata """

    recording: SafeRecording
    track: Annotated[
        str,
        Field(
            pattern=r"\A[a-z][a-z0-9-]*\z",
            description="Name of the track, e.g. stream, overlay, audio-0",
            examples=["stream", "overlay", "audio-0"]
        )
    ]
    index: Annotated[
        int,
        Field(
            ge=0,
            description="Running number of the chunk in the track. Start at 0.",
            examples=[0]
        )
    ]
    chunk: Annotated[
        UploadFile,
        Field(
            description="video/audio blob to store, as file"
        )
    ]

@router.post('/api/chunks', status_code=status.HTTP_201_CREATED)
async def upload_chunk(
    upload: Annotated[ChunkUpload, Form()],
    settings: Annotated[Settings, Depends(get_settings)],
    user_home: Annotated[str, Depends(get_current_user_home)]
) -> dict[str, str | int]:
    """
    POST endpoint for the upload of chunk files.
    """
    index_limit = 10 ** settings.chunk_file_digits
    if upload.index >= index_limit:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Lecture has been going on too long. "
                f"Attempted to store {upload.index} chunks (max = {index_limit})"
            )
        )

    filename = f'chunk.{upload.index:0{settings.chunk_file_digits}d}'

    track_path = settings.destdir / user_home / upload.recording / upload.track
    filepath = track_path / filename
    logger.debug("saving %s", filepath)

    os.makedirs(track_path, exist_ok=True)

    async with aiofiles.open(filepath, "wb") as out:
        while content := await upload.chunk.read(128 * 1024):
            await out.write(content)

    return {
        "recording": upload.recording,
        "track": upload.track,
        "index": upload.index,
        "filename": filename
    }

class PostProcessingJob(BaseModel):
    """ DTO for a postprocessing job the client wants to schedule """

    recording: SafeRecording
    # backend will validate before sending email. We want the postprocessing to work even if
    # someone has a typo in the mail address or doesn't specify a recipient, so we don't reject
    # a malformed recipient here (we just don't send mail later)
    recipient: Annotated[
        str | None,
        Field(
            default=None,
            description="Recipient of the completion notification",
            examples=["mustermann@vss.uni-hannover.de", None]
        )
    ]

def get_running_jobs(request: Request) -> set[Path]:
    """ Recordings that currently have a postprocessing job in flight. """
    return request.app.state.running_jobs

async def _postprocessing_task(
        job: PostProcessingJob,
        settings: Settings,
        user: str,
        running_jobs: set[Path]
) -> None:
    recording_path = settings.destdir / user / job.recording

    # Job's already running, so don't start it a second time.
    if recording_path in running_jobs:
        logger.warning("Already postprocessing %s, ignoring duplicate job", recording_path)
        return

    running_jobs.add(recording_path)

    try:
        job_result = await postprocess_recording(recording_path)

        if settings.smtp is not None:
            normalized_recipient = normalize_recipient(
                job.recipient,
                list(settings.smtp.allowed_domains)
            )

            if normalized_recipient is not None:
                await send_report(
                    smtp_settings=settings.smtp,
                    recipient=normalized_recipient,
                    job_title=job.recording,
                    result=job_result)
        else:
            logger.debug("Not sending report: SMTP not configured.")

    finally:
        running_jobs.discard(recording_path)

@router.post('/api/jobs', status_code=status.HTTP_202_ACCEPTED)
def schedule_job(
    job: PostProcessingJob,
    background_tasks: BackgroundTasks,
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[str, Depends(get_current_user_home)],
    running_jobs: Annotated[set[Path], Depends(get_running_jobs)]
):
    """ Endpoint for the scheduling of postprocessing jobs """

    if not os.path.isdir(settings.destdir / user / job.recording):
        logger.warning("Bad postprocessing request: Recording %s does not exist", job.recording)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Recording {job.recording} does not exist'
        )

    background_tasks.add_task(_postprocessing_task, job, settings, user, running_jobs)

    return job

@router.get('/api/health')
def health_check():
    """ Endpoint for container health checks """
    logger.debug("health check requested")
    return { "status": "healthy" }

def create_app(
        settings: Settings | None = None
) -> FastAPI:
    """ Application factory. Creates a FastAPI app configured with the given settings. """
    override_settings = settings
    settings = settings if settings is not None else get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncGenerator[None]:
        if settings.auth_required:
            # Attempt to load openid config at application start instead of first request. This
            # isn't strictly necessary but will log an error if the openid provider is unreachable.
            await load_oidc_config(application.state, settings)
        else:
            logger.warning("no OpenID provider configured -- endpoints are unauthenticated")
        yield

    application = FastAPI(lifespan=lifespan)
    application.state.running_jobs = set()

    if override_settings is not None:
        application.dependency_overrides[get_settings] = lambda: override_settings

    if settings.cors_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type"],
        )
    application.include_router(router)
    return application

app = create_app()
