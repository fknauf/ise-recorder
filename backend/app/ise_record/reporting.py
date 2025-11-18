from .postprocess import PostProcessingResult

from email.message import EmailMessage
import logging
import smtplib
from textwrap import dedent

logger = logging.getLogger(__name__)

def send_report(
        job_title: str,
        result: PostProcessingResult,
        sender: str | None,
        recipient: str | None
) -> None:
    subject = f'ise-record finished {job_title}'

    content = dedent(
        """
        ise-record just finished rendering {job_title}.

        success: {success}

        output file: {output}
        """).format(
            job_title=job_title,
            success=result.success,
            output=result.output_file
        )

    msg = EmailMessage()

    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject
    msg.set_content(content)

    logger.info(msg)
