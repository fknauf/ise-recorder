# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-many-locals
# pylint: disable=protected-access
# pylint: disable=no-member
# pylint: disable=duplicate-code  # the send test restates every SMTP setting on purpose

from pathlib import Path
from unittest.mock import ANY

import pytest
from pytest_mock import MockerFixture

from ise_record.core.postprocess import Result, ResultReason
from ise_record.core.reporting import _generate_report, normalize_recipient, send_report
from ise_record.settings import SmtpSettings


def test_normalize_recipient():
    assert normalize_recipient("foo@vss.uni-hannover.de", []) == "foo@vss.uni-hannover.de"
    assert normalize_recipient("Max Mustermann <max.mustermann@vss.uni-hannover.de>", []) is None
    assert normalize_recipient(None, []) is None
    assert normalize_recipient("foo", []) is None

    assert (
        normalize_recipient("foo@vss.uni-hannover.de", ["sra.uni-hannover.de", "example.com"])
        is None
    )
    assert (
        normalize_recipient("foo@vss.uni-hannover.de", ["vss.uni-hannover.de"])
        == "foo@vss.uni-hannover.de"
    )
    assert (
        normalize_recipient("foo@vss.uni-hannover.de", ["uni-hannover.de"])
        == "foo@vss.uni-hannover.de"
    )


# The whitelist is a suffix match, and suffix matches are the classic way to accidentally
# admit a domain someone else registered. These pin the boundary.


@pytest.mark.parametrize(
    "address",
    [
        "foo@uni-hannover.de",  # the domain itself
        "foo@vss.uni-hannover.de",  # a subdomain, which the README says is implied
        "foo@a.b.uni-hannover.de",  # and one further down
    ],
)
def test_the_domain_and_its_subdomains_are_admitted(address: str):
    assert normalize_recipient(address, ["uni-hannover.de"]) == address


@pytest.mark.parametrize(
    "address",
    [
        # someone else's registration that merely ends in the same characters: the leading
        # "." in the subdomain check is the only thing keeping this out
        "foo@eviluni-hannover.de",
        "foo@evil-uni-hannover.de",
        # the whitelisted domain as a label of a domain someone else controls
        "foo@uni-hannover.de.example.com",
        # and as part of the local part, where endswith() never looks
        "uni-hannover.de@example.com",
    ],
)
def test_a_domain_that_only_looks_like_the_whitelisted_one_is_refused(address: str):
    assert normalize_recipient(address, ["uni-hannover.de"]) is None


def test_an_empty_whitelist_admits_everything():
    # Domain whitelisting is optional; unset means an unrestricted relay rather than a
    # backend that silently refuses to notify anyone.
    assert normalize_recipient("foo@example.com", []) == "foo@example.com"


def test_the_whitelist_is_case_insensitive_end_to_end():
    # An operator who writes the domain with a capital letter used to get a backend that
    # accepted every job and sent no mail at all, with nothing but a per-job warning to
    # show for it. SmtpSettings lowers the case on the way in, so this has to go through the
    # settings object rather than hand normalize_recipient a literal list -- that is also
    # exactly what postprocessing_task does.
    settings = SmtpSettings(
        server="mail.example.edu",
        sender="ise-record@example.edu",
        allowed_domains=("Uni-Hannover.DE",),
    )

    assert settings.allowed_domains == ("uni-hannover.de",)

    whitelist = list(settings.allowed_domains)

    # the address side is lowercased by email_validator's normalization, so both halves of
    # the comparison arrive in the same case whatever the lecturer typed
    assert normalize_recipient("Foo@Uni-Hannover.DE", whitelist) == "Foo@uni-hannover.de"
    assert normalize_recipient("Foo@VSS.Uni-Hannover.DE", whitelist) == "Foo@vss.uni-hannover.de"


@pytest.mark.parametrize(
    "configured_domain",
    [
        "bücher.example",  # as the operator would type it
        "xn--bcher-kva.example",  # as DNS and most tooling would show it
        "Bücher.example",  # and neither form is case-sensitive
    ],
)
def test_an_internationalized_domain_matches_in_either_encoding(configured_domain: str):
    # ValidatedEmail.normalized carries the domain in Unicode and ascii_email in punycode.
    # Comparing against only one of them would mean the whitelist silently failed whenever
    # the operator happened to write the other, with nothing but a per-job "not
    # whitelisted" warning to explain it.
    settings = SmtpSettings(
        server="mail.example.edu",
        sender="ise-record@example.edu",
        allowed_domains=(configured_domain,),
    )

    assert (
        normalize_recipient("foo@bücher.example", list(settings.allowed_domains))
        == "foo@bücher.example"
    )
    assert (
        normalize_recipient("foo@lesesaal.bücher.example", list(settings.allowed_domains))
        == "foo@lesesaal.bücher.example"
    )


def test_an_ascii_only_address_is_unaffected_by_the_punycode_fallback():
    # ascii_email is None for an address whose local part is not ASCII, and matching it
    # must not start admitting anything the Unicode form would have refused.
    settings = SmtpSettings(
        server="mail.example.edu",
        sender="ise-record@example.edu",
        allowed_domains=("uni-hannover.de",),
    )

    whitelist = list(settings.allowed_domains)

    assert normalize_recipient("foo@uni-hannover.de", whitelist) == "foo@uni-hannover.de"
    assert normalize_recipient("foo@eviluni-hannover.de", whitelist) is None
    assert normalize_recipient("föö@uni-hannover.de", whitelist) == "föö@uni-hannover.de"


@pytest.mark.parametrize(
    "reason, output_file, says",
    [
        pytest.param(
            ResultReason.SUCCESS,
            Path("foo/presentation.webm"),
            "Encoding succeeded",
            id="success",
        ),
        pytest.param(ResultReason.FAILURE, None, "Encoding failed", id="failure"),
        pytest.param(
            ResultReason.MAIN_STREAM_MISSING,
            None,
            "Missing main display stream",
            id="main-stream-missing",
        ),
        # the lecturer has a usable file but must know it is short, or they will find out
        # only when the recording stops mid-sentence
        pytest.param(
            ResultReason.PARTIAL_SUCCESS,
            Path("foo/presentation.webm"),
            "incomplete",
            id="partial-success",
        ),
    ],
)
def test_generate_report(reason: ResultReason, output_file: Path | None, says: str):
    result = Result(reason=reason, output_file=output_file)

    report = _generate_report("render@example.de", "lecturer@example.de", "foo_1234", result)

    assert report["From"] == "render@example.de"
    assert report["To"] == "lecturer@example.de"
    assert "foo_1234" in report["Subject"]
    assert "foo_1234" in report.get_payload()
    assert says in report.get_payload()
    if output_file is not None:
        assert str(output_file) in report.get_payload()


def test_generate_report_has_a_message_for_every_result_reason():
    # a reason without a case of its own falls through to the catch-all, which tells the
    # lecturer only that something is wrong with the code. This fails the moment a variant is
    # added without a message for it.
    catch_all = _generate_report(
        "render@example.de",
        "lecturer@example.de",
        "foo_1234",
        Result(reason=None, output_file=None),  # type: ignore[arg-type]  # no reason matches
    ).get_payload()

    for reason in ResultReason:
        report = _generate_report(
            "render@example.de",
            "lecturer@example.de",
            "foo_1234",
            Result(reason=reason, output_file=None),
        )

        assert report.get_payload() != catch_all


@pytest.mark.asyncio
async def test_send_report(mocker: MockerFixture):
    sender = "render@example.de"
    recipient = "lecturer@example.de"
    job_title = "foo_1234"
    result = Result(reason=ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    smtp_settings = SmtpSettings(
        server="localhost",
        port=587,
        local_hostname="render.example.de",
        starttls=True,
        username="server@example.de",
        password="supersecret",
        sender=sender,
    )

    await send_report(
        smtp_settings=smtp_settings, recipient=recipient, job_title=job_title, result=result
    )

    report = _generate_report(sender, recipient, job_title, result)

    mock_send.assert_called_once_with(
        ANY,
        hostname=smtp_settings.server,
        port=smtp_settings.port,
        local_hostname=smtp_settings.local_hostname,
        start_tls=smtp_settings.starttls,
        use_tls=smtp_settings.use_tls,
        username=smtp_settings.username,
        password=smtp_settings.password,
    )

    sent_report = mock_send.call_args.args[0]

    assert sent_report["From"] == report["From"]
    assert sent_report["To"] == report["To"]
    assert sent_report["Subject"] == report["Subject"]
    assert sent_report.get_payload() == report.get_payload()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "starttls,use_tls",
    [
        (None, False),  # opportunistic STARTTLS
        (True, False),  # STARTTLS required
        (False, False),  # plaintext
        (False, True),  # implicit TLS
        (None, True),  # implicit TLS, STARTTLS left to aiosmtplib to skip
    ],
)
async def test_send_report_forwards_the_transport_security_mode(
    mocker: MockerFixture, starttls: bool | None, use_tls: bool
):
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    smtp_settings = SmtpSettings(
        server="mail.example.edu", sender="render@example.de", starttls=starttls, use_tls=use_tls
    )

    await send_report(
        smtp_settings=smtp_settings,
        recipient="lecturer@example.de",
        job_title="foo_1234",
        result=Result(reason=ResultReason.SUCCESS, output_file=Path("foo/presentation.webm")),
    )

    assert mock_send.call_args.kwargs["start_tls"] is starttls
    assert mock_send.call_args.kwargs["use_tls"] is use_tls

    # with no port configured aiosmtplib picks one from these two: 465 for implicit TLS, 587
    # for STARTTLS, 25 otherwise. That delegation is what makes the README's table true.
    assert mock_send.call_args.kwargs["port"] is None
