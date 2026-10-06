"""
background job implementation + accessor for the job-slot semaphore
"""

import asyncio
from contextlib import ExitStack
import logging

from anyio import Path
from fastapi import Request

from ise_record.core.postprocess import postprocess_recording
from ise_record.core.reporting import normalize_recipient, send_report
from ise_record.glue.models import RenderRequest
from ise_record.settings import SmtpSettings

logger = logging.getLogger(__name__)


async def get_jobs_semaphore(request: Request) -> asyncio.Semaphore:
    """Global jobs semaphore, allows waiting for a slot to run"""
    return request.app.state.jobs_semaphore


async def postprocessing_task(
    recording_path: Path,
    render: RenderRequest,
    smtp_settings: SmtpSettings | None,
    jobs_semaphore: asyncio.Semaphore,
    context: ExitStack,
) -> None:
    """
    Postprocessing job function, i.e. processes a recording and sends a report mail

    :param recording_path Path of the recording on disk
    :param render metadata of the render request, e.g. e-mail address of the report recipient
    :param smtp_settings SMTP mailer configuration
    :param jobs_semaphore semaphore to wait for a slot to do the processing, to limit parallelism
    :param context exit stack that holds the claim that this recording is rendering, which must be
           released after rendering has concluded.
    """
    with context:
        async with jobs_semaphore:
            job_result = await postprocess_recording(recording_path)

    if smtp_settings is not None:
        normalized_recipient = normalize_recipient(
            render.recipient, list(smtp_settings.allowed_domains)
        )

        if normalized_recipient is not None:
            await send_report(
                smtp_settings=smtp_settings,
                recipient=normalized_recipient,
                job_title=recording_path.name,
                result=job_result,
            )
    else:
        logger.debug("Not sending report: SMTP not configured.")
