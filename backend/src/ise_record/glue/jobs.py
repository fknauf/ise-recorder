"""
background job implementation + accessor for the list of currently running jobs
"""

import asyncio
import logging
from pathlib import Path
from typing import Annotated, NamedTuple

from fastapi import Depends, Request

from ise_record.core.postprocess import postprocess_recording
from ise_record.core.reporting import normalize_recipient, send_report
from ise_record.glue.enclave import Enclave, get_enclave
from ise_record.settings import SmtpSettings

logger = logging.getLogger(__name__)


class JobQueue(NamedTuple):
    """
    Per-user aspect of the global jobs queue that prevents more than the configured number of
    ffmpeg processes to run in parallel
    """

    semaphore: asyncio.Semaphore
    running_jobs: set[Path]


async def get_job_queue(
    request: Request, enclave: Annotated[Enclave, Depends(get_enclave)]
) -> JobQueue:
    """user-specific jobs queue, allows waiting for a slot to run"""
    return JobQueue(
        semaphore=request.app.state.jobs_semaphore, running_jobs=enclave.busy_recordings.rendering
    )


async def postprocessing_task(
    recording_path: Path,
    report_recipient: str | None,
    smtp_settings: SmtpSettings | None,
    job_queue: JobQueue,
) -> None:
    """
    Postprocessing job function, i.e. processes a recording and sends a report mail

    :param recording_path Path of the recording on disk
    :param report_recipient e-mail address of the report recipient
    :param smtp_settings SMTP mailer configuration
    :param job_queue queue to job as running and wait for a slot to do the processing
    """
    try:
        async with job_queue.semaphore:
            job_result = await postprocess_recording(recording_path)

        if smtp_settings is not None:
            normalized_recipient = normalize_recipient(
                report_recipient, list(smtp_settings.allowed_domains)
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
    finally:
        job_queue.running_jobs.discard(recording_path)
