"""
ISE-Recorder backend service. Stores chunk files and does postprocessing.

This module defines the HTTP API endpoints and validates inputs.
"""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, ExitStack
import logging
from typing import Annotated

import anyio
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    HTTPException,
    Path,
    Request,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import Field

from ise_record.core.auth import UserInfo
from ise_record.core.logconfig import setup_logging
from ise_record.core.postprocess import OUTPUT_FILENAME
from ise_record.core.recordings import (
    RecordingDiskState,
)
from ise_record.glue.auth import get_user_info, load_oidc_client, OidcServerState
from ise_record.glue.enclave import Enclave, get_enclave, get_enclave_by_user_digest
from ise_record.glue.jobs import (
    get_jobs_semaphore,
    postprocessing_task,
)
from ise_record.glue.models import (
    ChunkLocation,
    RecordingResponse,
    RenderRequest,
    SafeRecording,
    UnfinishedRecording,
)
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


@router.put(
    "/recordings/{recording}/tracks/{track}/chunks/{index}", status_code=status.HTTP_204_NO_CONTENT
)
async def upload_chunk_endpoint(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    enclave: Annotated[Enclave, Depends(get_enclave)],
    location: Annotated[ChunkLocation, Path()],
) -> None:
    """
    Endpoint for the upload of chunk files.
    """
    index_limit = 10**settings.chunk_file_digits
    if location.index >= index_limit:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Lecture has been going on too long. "
                f"Attempted to store {location.index} chunks (max = {index_limit})"
            ),
        )

    with enclave.claim_upload(location.recording):
        track_path = enclave.recording_dir(location.recording) / location.track
        out_name = f"chunk.{location.index:0{settings.chunk_file_digits}d}"
        out_path = track_path / out_name
        logger.debug("saving %s", out_path)

        await track_path.mkdir(parents=True, exist_ok=True)

        # use temporary file instead of a fixed name so simultaneous uploads to the same chunk
        # don't try to write to the same file. That's an edge case that shouldn't happen in normal
        # operation, but it's tidier semantics this way.
        async with anyio.NamedTemporaryFile(
            mode="wb", dir=str(track_path), prefix=f"part.{out_name}."
        ) as part:
            async for content in request.stream():
                await part.write(content)

            await part.flush()
            # atomic replace at the end so the postprocessing logic can never see half-written chunks.
            await anyio.Path(str(part.name)).replace(out_path)


@router.post("/recordings/{recording}/render", status_code=status.HTTP_202_ACCEPTED)
async def schedule_job_endpoint(  # pylint: disable=too-many-arguments,too-many-positional-arguments
    background_tasks: BackgroundTasks,
    exit_stack: Annotated[ExitStack, Depends(_get_request_exit_stack)],
    settings: Annotated[Settings, Depends(get_settings)],
    enclave: Annotated[Enclave, Depends(get_enclave)],
    jobs_semaphore: Annotated[asyncio.Semaphore, Depends(get_jobs_semaphore)],
    recording: SafeRecording,
    render: RenderRequest,
) -> RecordingResponse:
    """Endpoint for the scheduling of postprocessing jobs"""

    exit_stack.enter_context(enclave.claim_rendering(recording))

    disk_state = await enclave.disk_state(recording)

    if disk_state == RecordingDiskState.NONEXISTENT:
        logger.warning("Bad postprocessing request: Recording %s does not exist", recording)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Recording {recording} does not exist",
        )

    if disk_state == RecordingDiskState.NOT_RENDERABLE:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Recording {recording} is not renderable",
        )

    background_tasks.add_task(
        postprocessing_task,
        enclave.recording_dir(recording),
        render.recipient,
        settings.smtp,
        jobs_semaphore,
    )

    return UnfinishedRecording.model_construct(state="rendering", name=recording)


@router.get("/recordings", dependencies=[Depends(_require_auth_configured)])
async def recordings_list_endpoint(
    enclave: Annotated[Enclave, Depends(get_enclave)],
) -> list[RecordingResponse]:
    """Endpoint to obtain a list of completed and rendering recordings for the active user"""
    return await user_recordings_list(enclave)


@router.delete(
    "/recordings/{recording}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(_require_auth_configured)],
)
async def purge_endpoint(
    enclave: Annotated[Enclave, Depends(get_enclave)],
    user_info: Annotated[UserInfo | None, Depends(get_user_info)],
    recording: SafeRecording,
) -> None:
    """Endpoint to purge a recording directory"""
    await purge_recording(recording, enclave, user_info)


@router.get(
    "/downloads/{user_digest}/{recording}", dependencies=[Depends(_require_auth_configured)]
)
async def download_endpoint(
    enclave: Annotated[Enclave | None, Depends(get_enclave_by_user_digest)],
    recording: SafeRecording,
    totp: Annotated[str, Field(pattern=r"\A[0-9]+\z")],
) -> FileResponse:
    """Endpoint for downloading a completed recording that the active user owns"""
    if enclave is None or not enclave.verify_totp(totp, recording):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    file_path = enclave.recording_dir(recording) / OUTPUT_FILENAME
    if not await file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    return FileResponse(file_path, filename=f"{recording}.webm")


@router.get("/health")
def health_check_endpoint():
    """Endpoint for container health checks"""
    logger.debug("health check requested")
    return {"status": "healthy"}


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
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["Authorization", "Content-Type"],
        )
    application.include_router(router, prefix=settings.route_prefix)
    return application


app = create_app()
