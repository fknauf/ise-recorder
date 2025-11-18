"""
    ISE-Recorder reporting module. Alerts a user that a postprocessing
    job is finished.
"""

from email.message import EmailMessage
import logging
import smtplib
from textwrap import dedent
from typing import NamedTuple

from .postprocess import PostProcessingResult

logger = logging.getLogger(__name__)

class SmtpSink(NamedTuple):
    """ A destination for SMTP messages (parameter object) """

    server: str | None
    port: int
    starttls: bool
    username: str | None
    password: str | None
    local_hostname: str | None

def send_report(
        smtp_sink: SmtpSink,
        sender: str | None,
        recipient: str | None,
        job_title: str,
        result: PostProcessingResult
) -> None:
    """
       Sends a report about a finished job to the specified recipient.
    """

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

    if smtp_sink.server is None or sender is None or recipient is None or recipient.strip() == "":
        return

    with smtplib.SMTP(
        host = smtp_sink.server,
        port=smtp_sink.port,
        local_hostname=smtp_sink.local_hostname
    ) as smtp:
        if smtp_sink.username is not None:
            smtp.login(smtp_sink.username, smtp_sink.password)
        if smtp_sink.starttls:
            smtp.starttls()
            smtp.ehlo(smtp_sink.local_hostname or "")
        smtp.send_message(msg=msg, from_addr=sender, to_addrs=recipient)
        smtp.quit()
