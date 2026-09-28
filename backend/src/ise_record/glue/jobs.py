"""
background job implementation + accessor for the list of currently running jobs
"""

import asyncio
from collections import defaultdict
import logging
from pathlib import Path
from typing import Annotated, NamedTuple

from fastapi import Depends, Request

from ise_record.core.postprocess import postprocess_recording
from ise_record.core.reporting import normalize_recipient, send_report
from ise_record.glue.user_home import get_current_user_home
from ise_record.settings import SmtpSettings

logger = logging.getLogger(__name__)


class JobsState(NamedTuple):
    """Jobs-related state attached to the server instance"""

    semaphore: asyncio.Semaphore
    per_user_running_jobs: dict[Path, set[Path]]

    @classmethod
    def create(cls, max_parallelism: int) -> JobsState:
        """Create a JobsState instance from the relevant settings"""
        return cls(
            semaphore=asyncio.Semaphore(max_parallelism),
            per_user_running_jobs=defaultdict[Path, set[Path]](set),
        )


class JobQueue(NamedTuple):
    """
    Per-user aspect of the global jobs queue that prevents more than the configured number of
    ffmpeg processes to run in parallel
    """

    semaphore: asyncio.Semaphore
    running_jobs: set[Path]


async def get_jobs_state(request: Request) -> JobsState:
    """Access the jobs-related state attached to the server instance"""
    return request.app.state.jobs


async def get_running_jobs(
    jobs_state: Annotated[JobsState, Depends(get_jobs_state)],
    user_home: Annotated[Path, Depends(get_current_user_home)],
) -> set[Path]:
    """Recordings that currently have a postprocessing job in flight."""
    return jobs_state.per_user_running_jobs[user_home]


async def get_job_queue(
    jobs_state: Annotated[JobsState, Depends(get_jobs_state)],
    running_jobs: Annotated[set[Path], Depends(get_running_jobs)],
) -> JobQueue:
    """user-specific jobs queue, allows waiting for a slot to run"""
    return JobQueue(semaphore=jobs_state.semaphore, running_jobs=running_jobs)


async def get_running_jobs_snapshot(
    running_jobs: Annotated[set[Path], Depends(get_running_jobs)],
) -> frozenset[Path]:
    """
    Snapshot of the currently running jobs for use in concurrent (def-declared)
    handlers/dependencies
    """
    return frozenset(running_jobs)


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

    # Job's already running, so don't start it a second time.
    if recording_path in job_queue.running_jobs:
        logger.warning("Already postprocessing %s, ignoring duplicate job", recording_path)
        return

    job_queue.running_jobs.add(recording_path)

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
