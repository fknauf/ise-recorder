"""
Pydantic models for fastapi request parameters and return values
"""

from typing import Annotated, Literal
import unicodedata

from pathvalidate import sanitize_filename
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from pydantic.alias_generators import to_camel


def _normalize_for_filesystem(value: str) -> str:
    return sanitize_filename(unicodedata.normalize("NFC", value), platform="universal")


SafeRecording = Annotated[
    str,
    BeforeValidator(_normalize_for_filesystem),
    Field(
        pattern=r"\A[\p{L}\p{N}_][\p{L}\p{M}\p{N}._-]*\z",
        min_length=1,
        description="Name of the recording. Usually consists of Lecture Title and Timestamp",
        examples=["PSU_2026-02-13T16.43.09.313Z"],
    ),
]


class ApiModel(BaseModel):
    """Base for request and response bodies: snake_case in Python, camelCase on the wire"""

    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, serialize_by_alias=True)


class RenderRequest(ApiModel):
    """Metadata sent with a render request, such as the recipient of the completion report"""

    # backend will validate before sending email. We want the postprocessing to work even if
    # someone has a typo in the mail address or doesn't specify a recipient, so we don't reject
    # a malformed recipient here (we just don't send mail later)
    recipient: Annotated[
        str | None,
        Field(
            default=None,
            description="Recipient of the completion notification",
            examples=["mustermann@vss.uni-hannover.de", None],
        ),
    ]


class ChunkLocation(ApiModel):
    """chunk upload metadata"""

    recording: SafeRecording
    track: Annotated[
        str,
        Field(
            pattern=r"\A[a-z][a-z0-9-]*\z",
            description="Name of the track, e.g. stream, overlay, audio-0",
            examples=["stream", "overlay", "audio-0"],
        ),
    ]
    index: Annotated[
        int,
        Field(
            ge=0, description="Running number of the chunk in the track. Start at 0.", examples=[0]
        ),
    ]


class UnfinishedRecording(ApiModel):
    """Information needed to display a recording in the UI"""

    state: Literal["rendering", "unprocessed"]
    name: str


class DownloadableRecording(ApiModel):
    """Per-downloadable-file information for the frontend"""

    state: Literal["completed"]
    name: str
    size: int
    download_url: str


RecordingResponse = Annotated[
    UnfinishedRecording | DownloadableRecording, Field(discriminator="state")
]
