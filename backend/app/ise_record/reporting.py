"""
    ISE-Recorder reporting module. Alerts a user that a postprocessing
    job is finished.
"""

from email.message import EmailMessage
import logging
import smtplib
from textwrap import dedent
from typing import NamedTuple

from .postprocess import Result, ResultReason

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
        result: Result
) -> None:
    """
       Sends a report about a finished job to the specified recipient.
    """

    subject = f'ise-record finished {job_title}'

    match result.reason:
        case ResultReason.SUCCESS:
            message = 'Encoding succeded. Enjoy your video file.'
        case ResultReason.FAILURE:
            message = 'Encoding failed. Check server logs.'
        case ResultReason.MAIN_STREAM_MISSING:
            message = 'Missing main display stream. Manual intervention required.'

    content = dedent(
        """
        ise-record just finished rendering {job_title}.

        output file: {output}

        reason: {reason}
        """).format(
            job_title=job_title,
            output=result.output_file,
            reason=message
        )

    msg = EmailMessage()

    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject
    msg.set_content(content)

    logger.debug("Report generated: \n%s", msg)

    if smtp_sink.server is None or sender is None:
        logger.debug("Not sending report: incomplete SMTP configuration.")
        return
    if recipient is None or recipient.strip() == "":
        logger.info("Not sending report: no recipient specified.")
        return

    logger.info("Sending report, result = %s", result.reason.name)
    logger.debug("SMTP through %s:%d as %s",
                 smtp_sink.server, smtp_sink.port, smtp_sink.local_hostname)

    with smtplib.SMTP(
        host=smtp_sink.server,
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
