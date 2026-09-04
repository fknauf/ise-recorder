"""
   ISE-Recorder backend service. Stores chunk files and does postprocessing.

   This module defines the HTTP API endpoints and validates inputs.
"""

import logging
import os
from typing import Annotated, Optional

import aiofiles
from fastapi import (
    APIRouter, BackgroundTasks, Depends, FastAPI, Form, HTTPException, UploadFile, status
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field

from .auth import decode_access_token, get_user_db, get_current_user, sign_access_token
from .auth_base import User, UserDatabase
from .auth_yolo import yolo_user
from .logconfig import setup_logging
from .postprocess import postprocess_recording
from .reporting import normalize_recipient, send_report, SmtpSink
from .settings import AuthBackend, Settings, get_settings

SAFE_NAME_REGEX = '^\\w[\\w.-]*$'

setup_logging()
logger = logging.getLogger(__name__)
router = APIRouter()

class ChunkUpload(BaseModel):
    """ An uploaded chunk with metadata """

    recording: Annotated[
        str,
        Field(
            pattern=SAFE_NAME_REGEX,
            description="Name of the recording. Usually consists of Lecture Title and Timestamp",
            examples=["PSU_2026-02-13T164309.313"],
        )
    ]
    track: Annotated[
        str,
        Field(
            pattern=SAFE_NAME_REGEX,
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
    user: Annotated[User, Depends(get_current_user)]
) -> dict[str, str | int]:
    """
    POST endpoint for the upload of chunk files.
    """
    index_limit = 10 ** settings.chunk_file_digits
    if upload.index >= index_limit:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Lecture has been going on too long. "
                f"Attempted to store {upload.index} chunks (max = {index_limit})"
            )
        )

    filename = f'chunk.{upload.index:0{settings.chunk_file_digits}d}'

    track_path = settings.destdir / user.relative_home_dir / upload.recording / upload.track
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

async def _postprocessing_task(job: PostProcessingJob, settings: Settings, user: User) -> None:
    recording_path = settings.destdir / user.relative_home_dir / job.recording
    job_result = await postprocess_recording(recording_path)

    normalized_recipient = normalize_recipient(job.recipient, list(settings.smtp_allowed_domains))

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

@router.post('/api/jobs', status_code=status.HTTP_202_ACCEPTED)
def schedule_job(
    job: PostProcessingJob,
    background_tasks: BackgroundTasks,
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[User, Depends(get_current_user)]
):
    """ Endpoint for the scheduling of postprocessing jobs """

    if not os.path.isdir(settings.destdir / user.relative_home_dir / job.recording):
        logger.warning("Bad postprocessing request: Recording %s does not exist", job.recording)
        raise HTTPException(status_code=400, detail=f'Recording {job.recording} does not exist')

    background_tasks.add_task(_postprocessing_task, job, settings, user)

    return job

@router.get('/api/health')
def health_check():
    """ Endpoint for container health checks """
    logger.debug("health check requested")
    return { "status": "healthy" }

def _oauth_response(
        content: any,
        status_code: int = status.HTTP_200_OK,
) -> JSONResponse:
    return JSONResponse(
        status_code = status_code,
        content = content,
        headers = {
            "Cache-Control": "no-store",
            "Pragma": "no-cache"
        }
    )

def _oauth_error(
        error: str,
        description: str
) -> JSONResponse:
    return _oauth_response(
        content = {
            "error": error,
            "error_description": description
        },
        status_code = status.HTTP_400_BAD_REQUEST
    )
    

@router.get('/api/auth/status')
def auth_system_status(
    settings: Annotated[Settings, Depends(get_settings)]
):
    return {
        "required": settings.auth_backend != AuthBackend.YOLO
    }

@router.post('/api/auth/login')
def authenticate_for_jwt(
    auth_request: Annotated[OAuth2PasswordRequestForm, Depends()],
    settings: Annotated[Settings, Depends(get_settings)],
    user_db: Annotated[UserDatabase, Depends(get_user_db)]
):
    """ Endpoint to obtain a JWT for the chunk/job endpoints """
    if settings.auth_backend == AuthBackend.YOLO:
        user = yolo_user
    else:
        user = user_db.authenticate(auth_request.username, auth_request.password)

    if user is None:
        return _oauth_error("invalid_grant", "Could not validate credentials")

    return _oauth_response(sign_access_token(user, settings))

@router.post('/api/auth/refresh')
def refresh_auth_token(
    refresh_token: Annotated[str, Form()],
    settings: Annotated[Settings, Depends(get_settings)],
    user_db: Annotated[UserDatabase, Depends(get_user_db)]
):
    """ Endpoint to obtain a JWT for the chunk/job endpoints """
    if settings.auth_backend == AuthBackend.YOLO:
        return None

    user = decode_access_token(refresh_token, settings.auth_jwt_secret)

    if user is None:
        return _oauth_error("invalid_grant", "Invalid refresh token")
    elif not user_db.user_exists(user.username):
        return _oauth_error("invalid_grant", "User does no longer exist")

    return _oauth_response(sign_access_token(user, settings))

def create_app(
        settings: Optional[Settings] = None
) -> FastAPI:
    """ Application factory. Creates a FastAPI app configured with the given settings. """
    application = FastAPI()

    if settings is None:
        settings = get_settings()
    else:
        application.dependency_overrides[get_settings] = lambda: settings

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
