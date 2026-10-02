"""
ISE-Recorder backend service. Stores chunk files and does postprocessing.

This module defines the HTTP API endpoints and validates inputs.
"""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, ExitStack
import logging
import os
from typing import Annotated

import aiofiles
from fastapi import APIRouter, BackgroundTasks, Depends, FastAPI, Form, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import Field

from ise_record.core.auth import UserInfo
from ise_record.core.logconfig import setup_logging
from ise_record.core.postprocess import OUTPUT_FILENAME
from ise_record.core.recordings import RecordingState
from ise_record.glue.auth import get_user_info, load_oidc_client, OidcServerState
from ise_record.glue.enclave import Enclave, get_enclave, get_enclave_by_user_digest
from ise_record.glue.jobs import (
    get_jobs_semaphore,
    postprocessing_task,
)
from ise_record.glue.models import ChunkUpload, PostProcessingJob, RecordingsList, SafeRecording
from ise_record.glue.recordings import purge_recording, user_recordings_list
from ise_record.settings import get_settings, Settings

setup_logging()
logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


def _require_auth_configured(settings: Annotated[Settings, Depends(get_settings)]) -> None:
    if not settings.auth_required:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Server is configured without authentication",
        )


async def _get_request_exit_stack() -> AsyncGenerator[ExitStack]:
    with ExitStack() as stack:
        yield stack


@router.post("/chunks", status_code=status.HTTP_201_CREATED)
async def upload_chunk_endpoint(
    upload: Annotated[ChunkUpload, Form()],
    settings: Annotated[Settings, Depends(get_settings)],
    enclave: Annotated[Enclave, Depends(get_enclave)],
) -> dict[str, str | int]:
    """
    POST endpoint for the upload of chunk files.
    """
    index_limit = 10**settings.chunk_file_digits
    if upload.index >= index_limit:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Lecture has been going on too long. "
                f"Attempted to store {upload.index} chunks (max = {index_limit})"
            ),
        )

    enclave.assert_not_busy(upload.recording)

    filename = f"chunk.{upload.index:0{settings.chunk_file_digits}d}"

    track_path = enclave.home_dir / upload.recording / upload.track
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
        "filename": filename,
    }


@router.post("/jobs", status_code=status.HTTP_202_ACCEPTED)
async def schedule_job_endpoint(  # pylint: disable=too-many-arguments,too-many-positional-arguments
    job: PostProcessingJob,
    background_tasks: BackgroundTasks,
    exit_stack: Annotated[ExitStack, Depends(_get_request_exit_stack)],
    settings: Annotated[Settings, Depends(get_settings)],
    enclave: Annotated[Enclave, Depends(get_enclave)],
    jobs_semaphore: Annotated[asyncio.Semaphore, Depends(get_jobs_semaphore)],
):
    """Endpoint for the scheduling of postprocessing jobs"""

    recording_path = enclave.home_dir / job.recording

    if not await asyncio.to_thread(recording_path.is_dir):
        logger.warning("Bad postprocessing request: Recording %s does not exist", job.recording)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Recording {job.recording} does not exist",
        )

    busy_state = enclave.busy_recordings.classify(recording_path)

    if busy_state == RecordingState.PURGING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Recording {job.recording} is being purged",
        )

    if busy_state is None:
        exit_stack.enter_context(enclave.busy_recordings.mark_rendering(recording_path))
        background_tasks.add_task(
            postprocessing_task, recording_path, job.recipient, settings.smtp, jobs_semaphore
        )

    if settings.auth_required:
        try:
            return await user_recordings_list(enclave)
        except Exception:  # pylint: disable=broad-exception-caught
            # swallow exception so the background job still starts. Just respond with an empty
            # body, frontend will handle that case.
            logger.exception("Failed to retrieve recordings list for %s", job.recording)

    return None


@router.get("/health")
def health_check_endpoint():
    """Endpoint for container health checks"""
    logger.debug("health check requested")
    return {"status": "healthy"}


@router.get("/recordings", dependencies=[Depends(_require_auth_configured)])
async def recordings_list_endpoint(
    enclave: Annotated[Enclave, Depends(get_enclave)],
) -> RecordingsList:
    """Endpoint to obtain a list of completed and rendering recordings for the active user"""
    return await user_recordings_list(enclave)


@router.get(
    "/recordings/{user_digest}/{recording}", dependencies=[Depends(_require_auth_configured)]
)
async def download_endpoint(
    recording: SafeRecording,
    totp: Annotated[str, Field(pattern=r"[0-9]+")],
    enclave: Annotated[Enclave | None, Depends(get_enclave_by_user_digest)],
) -> FileResponse:
    """Endpoint for downloading a completed recording that the active user owns"""

    if enclave is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    file_path = enclave.home_dir / recording / OUTPUT_FILENAME

    if not enclave.download_totp.verify(totp, file_path):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    return FileResponse(file_path, filename=f"{recording}.webm")


@router.delete("/recordings/{recording}", dependencies=[Depends(_require_auth_configured)])
async def purge_endpoint(
    recording: SafeRecording,
    enclave: Annotated[Enclave, Depends(get_enclave)],
    user_info: Annotated[UserInfo | None, Depends(get_user_info)],
) -> RecordingsList:
    """Endpoint to purge a recording directory"""
    enclave.assert_not_busy(recording)

    await purge_recording(recording, enclave, user_info)
    return await user_recordings_list(enclave)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Application factory. Creates a FastAPI app configured with the given settings."""
    override_settings = settings
    settings = settings if settings is not None else get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncGenerator[None]:
        if settings.auth_required:
            # Attempt to load openid config at application start instead of first request. This
            # isn't strictly necessary but will log an error if the openid provider is unreachable.
            await load_oidc_client(application.state, settings.oidc)
        else:
            logger.warning("AUTH is disabled -- endpoints are unauthenticated")
        yield

    application = FastAPI(lifespan=lifespan)

    application.state.oidc = OidcServerState()
    application.state.jobs_semaphore = asyncio.Semaphore(settings.max_parallel_jobs)
    application.state.enclaves = dict[str | None, Enclave]()

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
