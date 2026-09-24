"""
background job implementation + accessor for the list of currently running jobs
"""

import logging
from pathlib import Path
from typing import Annotated

from fastapi import Depends, Request

from ise_record.core.postprocess import postprocess_recording
from ise_record.core.reporting import normalize_recipient, send_report
from ise_record.settings import SmtpSettings

from ise_record.glue.user_home import get_current_user_home

logger = logging.getLogger(__name__)

async def get_running_jobs(
        request: Request,
        user_home: Annotated[Path, Depends(get_current_user_home)]
) -> set[Path]:
    """ Recordings that currently have a postprocessing job in flight. """
    return request.app.state.per_user_running_jobs[user_home]

async def get_running_jobs_snapshot(
        running_jobs: Annotated[set[Path], Depends(get_running_jobs)]
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
        running_jobs: set[Path]
) -> None:
    """
    Postprocessing job function, i.e. processes a recording and sends a report mail

    :param recording_path Path of the recording on disk
    :param report_recipient e-mail address of the report recipient
    :param smtp_settings SMTP mailer configuration
    :param running_jobs set in the app state where the job is registered as currently-running
    """

    # Job's already running, so don't start it a second time.
    if recording_path in running_jobs:
        logger.warning("Already postprocessing %s, ignoring duplicate job", recording_path)
        return

    running_jobs.add(recording_path)

    try:
        job_result = await postprocess_recording(recording_path)

        if smtp_settings is not None:
            normalized_recipient = normalize_recipient(
                report_recipient,
                list(smtp_settings.allowed_domains)
            )

            if normalized_recipient is not None:
                await send_report(
                    smtp_settings=smtp_settings,
                    recipient=normalized_recipient,
                    job_title=recording_path.name,
                    result=job_result)
        else:
            logger.debug("Not sending report: SMTP not configured.")

    finally:
        running_jobs.discard(recording_path)
