"""
    ISE-Recorder reporting module. Alerts a user that a postprocessing
    job is finished.
"""

from email.message import EmailMessage
import logging
from textwrap import dedent
from typing import NamedTuple, List

import aiosmtplib
from email_validator import validate_email, EmailNotValidError

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

def _is_in_domain(domain: str, normalized_address: str):
    return normalized_address.endswith(f'@{domain}') or normalized_address.endswith(f'.{domain}')

def _is_whitelisted(normalized_address: str, whitelist: List[str]):
    if whitelist == []:
        return True
    return next((True for d in whitelist if _is_in_domain(d, normalized_address)), False)

def normalize_recipient(address: str | None, domain_whitelist: List[str]) -> str | None:
    """
        Normalize a request-supplied (and therefore untrusted) e-mail address. Checks if the address
        is a valid email address and if the domain is whitelisted, if domain whitelisting is
        configured.

        :param address unsanitized input email address
        :param domain_whitelist list of allowed domains, or empty list if domains are unrestricted
        :return the normalized address if the address is allowed, or None otherwise
    """

    if address is None or address.strip() == "":
        return None

    try:
        validated = validate_email(address)
        if _is_whitelisted(validated.normalized, domain_whitelist):
            return validated.normalized
    except EmailNotValidError:
        logging.warning("Invalid or blacklisted recipient address: %s", address)

    return None

async def send_report(
        smtp_sink: SmtpSink,
        sender: str | None,
        recipient: str | None,
        job_title: str,
        result: Result
) -> None:
    """
       Sends a report about a finished job to the specified recipient.

       :param smtp_sink SMTP endpoint to connect to for sending
       :param sender sender address that should appear in the message
       :param recipient address of the recipient
       :param job_title job title to use in the subject line
       :param result job result data to be formatted into the message
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

    try:
        await aiosmtplib.send(
            msg,
            hostname = smtp_sink.server,
            port = smtp_sink.port,
            local_hostname = smtp_sink.local_hostname,
            start_tls = smtp_sink.starttls,
            username = smtp_sink.username,
            password = smtp_sink.password
        )
    except aiosmtplib.errors.SMTPException as ex:
        logger.warning("Unable to send message: %s", ex.message)
