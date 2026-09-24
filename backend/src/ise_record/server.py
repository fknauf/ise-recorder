"""
   ISE-Recorder backend service. Stores chunk files and does postprocessing.

   This module defines the HTTP API endpoints and validates inputs.
"""

from collections import defaultdict
from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path
import shutil
from typing import Annotated, Any, AsyncGenerator, Callable, NoReturn
import unicodedata

import aiofiles
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    Form,
    HTTPException,
    UploadFile,
    status
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pathvalidate import sanitize_filename
from pydantic import BaseModel, BeforeValidator, Field

from .auth import UserInfo, get_user_info, load_oidc_config
from .download_totp import DownloadTotpAuthority, get_download_totp
from .jobs import postprocessing_task, get_running_jobs
from .logconfig import setup_logging
from .postprocess import OUTPUT_FILENAME
from .recording_lists import (
    DownloadableRecording,
    get_downloadable_recordings,
    get_purgeable_recordings,
    get_unprocessed_recordings
)
from .settings import get_settings, Settings
from .user_home import get_current_user_home

def _normalize_for_filesystem(value: str) -> str:
    return sanitize_filename(unicodedata.normalize("NFC", value), platform="universal")

def _require_authentication(
        settings: Annotated[Settings, Depends(get_settings)]
) -> None:
    if not settings.auth_required:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Server is configured without authentication"
        )

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
router = APIRouter(prefix="/api")

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

@router.post('/chunks', status_code=status.HTTP_201_CREATED)
async def upload_chunk(
    upload: Annotated[ChunkUpload, Form()],
    settings: Annotated[Settings, Depends(get_settings)],
    user_home: Annotated[Path, Depends(get_current_user_home)]
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

    track_path = user_home / upload.recording / upload.track
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

@router.post('/jobs', status_code=status.HTTP_202_ACCEPTED)
def schedule_job(
    job: PostProcessingJob,
    background_tasks: BackgroundTasks,
    settings: Annotated[Settings, Depends(get_settings)],
    user_home: Annotated[Path, Depends(get_current_user_home)],
    running_jobs: Annotated[set[Path], Depends(get_running_jobs)]
):
    """ Endpoint for the scheduling of postprocessing jobs """

    recording_path = user_home / job.recording

    if not recording_path.is_dir():
        logger.warning("Bad postprocessing request: Recording %s does not exist", job.recording)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Recording {job.recording} does not exist'
        )

    background_tasks.add_task(
        postprocessing_task,
        recording_path,
        job.recipient,
        settings.smtp,
        running_jobs
    )

    return job

@router.get('/health')
def health_check():
    """ Endpoint for container health checks """
    logger.debug("health check requested")
    return { "status": "healthy" }

@router.get('/recordings', dependencies=[ Depends(_require_authentication) ])
async def get_recordings_list(
    user_home: Annotated[Path, Depends(get_current_user_home)],
    completed: Annotated[list[DownloadableRecording], Depends(get_downloadable_recordings)],
    running_jobs: Annotated[set[Path], Depends(get_running_jobs)],
    unprocessed: Annotated[list[Path], Depends(get_unprocessed_recordings)]
) -> dict[str, Any]:
    """ Endpoint to obtain a list of completed and rendering recordings for the active user """
    running_job_names = sorted([ job.name for job in running_jobs ])

    return {
        "user": user_home.name,
        "completed": [
            {
                "name": rec.name,
                "size": rec.size,
                "totp": rec.totp
            }
            for rec in completed if rec.name not in running_job_names
        ],
        "rendering": [
            {
                "name": name
            }
            for name in running_job_names
        ],
        "unprocessed": [
            {
                "name": dir.name
            }
            for dir in unprocessed
        ]
    }

@router.get(
    '/recordings/{user_digest}/{recording}',
    dependencies=[ Depends(_require_authentication) ]
)
async def download_completed(
    recording: SafeRecording,
    user_digest: Annotated[str, Field(pattern=r"\A[0-9a-f]+\z")],
    totp: Annotated[str, Field(pattern=r"[0-9]+")],
    settings: Annotated[Settings, Depends(get_settings)],
    download_totp: Annotated[DownloadTotpAuthority, Depends(get_download_totp)]
) -> FileResponse:
    """ Endpoint for downloading a completed recording that the active user owns """

    file_path = settings.destdir / user_digest / recording / OUTPUT_FILENAME

    if not download_totp.verify(totp, file_path):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="TOTP could not be verified"
        )

    if not file_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND
        )

    return FileResponse(file_path, filename = f"{recording}.webm")

@router.delete('/recordings/{recording}', dependencies=[ Depends(_require_authentication) ])
def purge_recording(
    recording: SafeRecording,
    user_info: Annotated[UserInfo | None, Depends(get_user_info)],
    user_home: Annotated[Path, Depends(get_current_user_home)],
    purgeable_recordings: Annotated[list[str], Depends(get_purgeable_recordings)],
    download_totp: Annotated[DownloadTotpAuthority, Depends(get_download_totp)]
):
    """ Endpoint to purge a recording directory """

    def fail_purge(
            log: Callable[[str], None],
            status_code: int,
            detail: str
    ) -> NoReturn:
        log(detail)
        raise HTTPException(status_code=status_code, detail=detail)

    if user_info is None:
        fail_purge(
            logger.error,
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User is not authenticated"
        )

    logger.info("User %s (sub = %s) is purging recording %s",
                user_info.preferred_username, user_info.sub, recording)

    recording_path = user_home / recording

    if not recording_path.is_dir(follow_symlinks=False):
        fail_purge(
            logger.warning,
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Recording {recording} does not exist for this user"
        )

    if not recording in purgeable_recordings:
        fail_purge(
            logger.warning,
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Recording {recording} is in use and currently not purgeable"
        )

    try:
        shutil.rmtree(recording_path)
    except Exception: # pylint: disable=broad-exception-caught
        fail_purge(
            logger.exception,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Filesystem error"
        )

    download_totp.forget(recording_path / OUTPUT_FILENAME)

    return {
        "recording": recording,
        "detail": "deleted successfully"
    }

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
    application.state.cached_home_dirs = dict[str, Path]()
    application.state.per_user_running_jobs = defaultdict[Path, set[Path]](set)
    application.state.download_totp = DownloadTotpAuthority()

    if override_settings is not None:
        application.dependency_overrides[get_settings] = lambda: override_settings

    if settings.cors_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )
    application.include_router(router, prefix=settings.route_prefix)
    return application

app = create_app()
