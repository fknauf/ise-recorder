"""
Pydantic models for fastapi request parameters and return values
"""

from typing import Annotated
import unicodedata

from fastapi import UploadFile
from pathvalidate import sanitize_filename
from pydantic import BaseModel, BeforeValidator, Field


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
