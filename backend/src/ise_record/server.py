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

import aiofiles
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    Form,
    HTTPException,
    status
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import Field

from ise_record.core.auth import UserInfo
from ise_record.core.download_totp import DownloadTotpAuthority
from ise_record.core.logconfig import setup_logging
from ise_record.core.postprocess import OUTPUT_FILENAME
from ise_record.glue.auth import get_user_info, load_oidc_client, OidcServerState
from ise_record.glue.download_totp import get_download_totp
from ise_record.glue.jobs import postprocessing_task, get_running_jobs
from ise_record.glue.models import ChunkUpload, PostProcessingJob, SafeRecording
from ise_record.glue.recording_lists import (
    DownloadableRecording,
    get_downloadable_recordings,
    get_purgeable_recordings,
    get_unprocessed_recordings
)
from ise_record.glue.user_home import get_current_user_home
from ise_record.settings import get_settings, Settings

def _require_authentication(
        settings: Annotated[Settings, Depends(get_settings)]
) -> None:
    if not settings.auth_required:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Server is configured without authentication"
        )

setup_logging()
logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

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
            await load_oidc_client(application.state, settings)
        else:
            logger.warning("no OpenID provider configured -- endpoints are unauthenticated")
        yield

    application = FastAPI(lifespan=lifespan)

    application.state.oidc = OidcServerState()
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
