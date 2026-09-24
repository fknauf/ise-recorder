"""
    ISE-Recorder reporting module. Alerts a user that a postprocessing
    job is finished.
"""

from email.message import EmailMessage
import logging
from textwrap import dedent

import aiosmtplib
from email_validator import validate_email, EmailNotValidError, ValidatedEmail

from ise_record.settings import SmtpSettings

from ise_record.core.postprocess import Result, ResultReason

logger = logging.getLogger(__name__)

def _is_in_domain(domain: str, validated: ValidatedEmail):
    return any(addr.endswith(f'@{domain}') or addr.endswith(f'.{domain}')
               for addr in (validated.normalized, validated.ascii_email)
               if addr is not None)

def _is_whitelisted(validated_address: ValidatedEmail, whitelist: list[str]):
    if not whitelist:
        return True
    return any(_is_in_domain(d, validated_address) for d in whitelist)

def normalize_recipient(address: str | None, domain_whitelist: list[str]) -> str | None:
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
        validated = validate_email(address, check_deliverability=False)
        if _is_whitelisted(validated, domain_whitelist):
            return validated.normalized

        logger.warning("Recipient address is not whitelisted: %s", address)
    except EmailNotValidError:
        logger.warning("Invalid recipient address: %s", address)

    return None

def generate_report(
        sender: str | None,
        recipient: str | None,
        job_title: str | None,
        result: Result
) -> EmailMessage:
    """
        Generate a report from a job result for e-mail sending

        :param sender e-mail address for the From header
        :param recipient e-mail address for the To header
        :param job_title name of the job to use in subject and body
        :param result job result to describe in the report
        :returns e-mail message, ready for sending
    """

    subject = f'ise-record finished {job_title}'

    match result.reason:
        case ResultReason.SUCCESS:
            message = 'Encoding succeeded. Enjoy your video file.'
        case ResultReason.FAILURE:
            message = 'Encoding failed. Check server logs.'
        case ResultReason.MAIN_STREAM_MISSING:
            message = 'Missing main display stream. Manual intervention required.'
        case ResultReason.PARTIAL_SUCCESS:
            message = (
                'Encoding succeeded, but the stream was incomplete. '
                'Please inspect the file to see what was missing.'
            )
        case _:
            message = "There's a bug in my code and something triggered it. Check server logs."

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

    return msg

async def send_report(
        smtp_settings: SmtpSettings,
        recipient: str | None,
        job_title: str,
        result: Result
) -> None:
    """
       Sends a report about a finished job to the specified recipient.

       :param smtp_settings SMTP settings used for sending
       :param recipient address of the recipient
       :param job_title job title to use in the subject line
       :param result job result data to be formatted into the message
    """

    # Generate report first just so it'll show up in debug logs.
    msg = generate_report(smtp_settings.sender, recipient, job_title, result)
    logger.debug("Report generated: \n%s", msg)

    if recipient is None or recipient.strip() == "":
        logger.info("Not sending report: no recipient specified.")
        return

    logger.info("Sending report, result = %s", result.reason.name)
    logger.debug("SMTP through %s:%s as %s",
                 smtp_settings.server, smtp_settings.port, smtp_settings.local_hostname)

    try:
        await aiosmtplib.send(
            msg,
            hostname = smtp_settings.server,
            port = smtp_settings.port,
            local_hostname = smtp_settings.local_hostname,
            start_tls = smtp_settings.starttls,
            use_tls = smtp_settings.use_tls,
            username = smtp_settings.username,
            password = smtp_settings.password
        )
    except aiosmtplib.errors.SMTPException as ex:
        logger.warning("Unable to send message: %s", ex.message)
