"""
Postprocessing jobs: running one, reporting on it, giving up the rendering claim it was handed, and
the limit on how many jobs render at once.

The task gets the recording's rendering claim from the render endpoint and only has to give it up
when its render is done. How the endpoint takes the claim and hands it over, turning away a
duplicate, and how the listing presents a job all live in test_server.py; the claim itself in
core/test_recordings.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name
# pylint: disable=too-few-public-methods

import asyncio
from collections.abc import Coroutine
from contextlib import ExitStack
from typing import Any

import anyio
from anyio import Path
import pytest
from pytest_mock import MockerFixture

from ise_record.core.postprocess import Result, ResultReason
from ise_record.glue.jobs import postprocessing_task
from ise_record.glue.models import RenderRequest
from ise_record.settings import SmtpSettings


def job(
    recording_path: Path | anyio.Path,
    slots: asyncio.Semaphore,
    recipient: str | None = None,
    smtp_settings: SmtpSettings | None = None,
    claim: ExitStack | None = None,
) -> Coroutine[Any, Any, None]:
    """
    A postprocessing job as the render endpoint starts it, with a claim that holds nothing unless
    the test hands one in.
    """
    return postprocessing_task(
        anyio.Path(recording_path),
        RenderRequest(recipient=recipient),
        smtp_settings,
        slots,
        claim if claim is not None else ExitStack(),
    )


class Claim:
    """A stand-in for the rendering claim that notes when it is given up."""

    def __init__(self) -> None:
        self.released = 0

    def stack(self) -> ExitStack:
        """An exit stack holding this claim, as the endpoint hands it to the job"""
        stack = ExitStack()
        stack.callback(self._release)
        return stack

    def _release(self) -> None:
        self.released += 1


# --- running a job ---------------------------------------------------------


# What a report says and how it is sent is core/test_reporting.py's business; a job only decides
# whether there is one, and whom it goes to.

SMTP = SmtpSettings(server="localhost", sender="render@example.de", allowed_domains=("example.de",))
RENDERED = Result(reason=ResultReason.SUCCESS, output_file=Path("data/foo/presentation.webm"))


@pytest.mark.asyncio
async def test_a_job_renders_and_reports_to_the_normalized_recipient(mocker: MockerFixture):
    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, return_value=RENDERED
    )
    mock_send = mocker.patch("ise_record.glue.jobs.send_report", autospec=True)

    await job(Path("data/foo"), asyncio.Semaphore(1), "lecturer@Example.DE", SMTP)

    mock_postprocess.assert_called_once_with(anyio.Path("data/foo"))
    mock_send.assert_called_once_with(
        smtp_settings=SMTP, recipient="lecturer@example.de", job_title="foo", result=RENDERED
    )


@pytest.mark.parametrize(
    "recipient, smtp_settings",
    [
        pytest.param(None, SMTP, id="no-recipient"),
        pytest.param("lecturer@elsewhere.org", SMTP, id="domain-not-allowed"),
        pytest.param("not an address", SMTP, id="malformed-recipient"),
        pytest.param("lecturer@example.de", None, id="no-smtp"),
    ],
)
@pytest.mark.asyncio
async def test_a_job_without_anyone_to_report_to_still_renders(
    mocker: MockerFixture, recipient: str | None, smtp_settings: SmtpSettings | None
):
    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, return_value=RENDERED
    )
    mock_send = mocker.patch("ise_record.glue.jobs.send_report", autospec=True)

    await job(Path("data/foo"), asyncio.Semaphore(1), recipient, smtp_settings)

    mock_postprocess.assert_called_once_with(anyio.Path("data/foo"))
    mock_send.assert_not_called()


# --- the limit on jobs rendering at once -----------------------------------
#
# A render decodes the whole lecture twice -- once to detect the crop, once to encode -- so a
# handful of lectures ending at the same time would otherwise start that many ffmpeg processes
# at once. The fake render below holds each job open until the test lets it finish, so the
# tests can look at which jobs are rendering and which are waiting.


class GatedRenders:
    """Stands in for postprocess_recording; each call waits until release() lets it finish."""

    def __init__(self) -> None:
        self.started: list[Path] = []
        self.running = 0
        self.most_at_once = 0
        self._gates: dict[Path, asyncio.Event] = {}

    async def render(self, recording_path: Path | anyio.Path) -> Result:
        recording_path = Path(recording_path)
        self.started.append(recording_path)
        self.running += 1
        self.most_at_once = max(self.most_at_once, self.running)
        gate = self._gates.setdefault(recording_path, asyncio.Event())

        try:
            await gate.wait()
        finally:
            self.running -= 1

        return Result(reason=ResultReason.SUCCESS, output_file=None)

    def release(self, recording_path: Path) -> None:
        self._gates.setdefault(recording_path, asyncio.Event()).set()


async def settle() -> None:
    """Let every task that can make progress do so."""
    for _ in range(10):
        await asyncio.sleep(0)


@pytest.fixture
def renders(mocker: MockerFixture) -> GatedRenders:
    fake = GatedRenders()
    # a bound async method rather than the object itself: AsyncMock only awaits a side effect
    # it recognizes as a coroutine function, and an object with an async __call__ is not one
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, side_effect=fake.render
    )
    return fake


@pytest.mark.asyncio
async def test_with_one_slot_a_second_job_waits_for_the_first(renders: GatedRenders):
    slots = asyncio.Semaphore(1)
    first = asyncio.create_task(job(Path("data/foo"), slots))
    second = asyncio.create_task(job(Path("data/bar"), slots))
    await settle()

    assert renders.started == [Path("data/foo")]

    renders.release(Path("data/foo"))
    await first
    await settle()

    assert renders.started == [Path("data/foo"), Path("data/bar")]

    renders.release(Path("data/bar"))
    await second
    assert renders.most_at_once == 1


@pytest.mark.asyncio
async def test_as_many_jobs_render_at_once_as_there_are_slots(renders: GatedRenders):
    slots = asyncio.Semaphore(2)
    recordings = [Path("data/a"), Path("data/b"), Path("data/c")]
    jobs = [asyncio.create_task(job(path, slots)) for path in recordings]
    await settle()

    # in the order they were scheduled
    assert renders.started == recordings[:2]

    for path in recordings:
        renders.release(path)
    await asyncio.gather(*jobs)

    assert renders.most_at_once == 2
    assert renders.started == recordings


@pytest.mark.asyncio
async def test_a_job_that_blows_up_gives_its_slot_back(mocker: MockerFixture):
    # otherwise one unexpected failure would leave the server one slot short until it is
    # restarted, and with the default of one slot, render nothing at all
    started: list[Path] = []

    async def fake_postprocess(recording_path: Path) -> Result:
        started.append(recording_path)
        if recording_path == Path("data/foo"):
            raise RuntimeError("boom")
        return Result(reason=ResultReason.SUCCESS, output_file=None)

    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, side_effect=fake_postprocess
    )
    slots = asyncio.Semaphore(1)

    with pytest.raises(RuntimeError):
        await job(Path("data/foo"), slots)

    await asyncio.wait_for(job(Path("data/bar"), slots), timeout=1)
    assert started == [Path("data/foo"), Path("data/bar")]


@pytest.mark.asyncio
async def test_the_report_is_sent_after_the_slot_is_given_back(
    mocker: MockerFixture, renders: GatedRenders
):
    # a slow or unreachable mail relay holds up the one job whose report it is sending, not
    # the render of the next lecture in line
    sending = asyncio.Event()
    relay_answers = asyncio.Event()

    async def slow_send(*_args: object, **_kwargs: object) -> None:
        sending.set()
        await relay_answers.wait()

    mocker.patch("ise_record.glue.jobs.send_report", autospec=True, side_effect=slow_send)
    smtp_settings = SmtpSettings(server="localhost", sender="render@example.de")
    slots = asyncio.Semaphore(1)

    first = asyncio.create_task(job(Path("data/foo"), slots, "lecturer@example.de", smtp_settings))
    second = asyncio.create_task(job(Path("data/bar"), slots))
    await settle()

    renders.release(Path("data/foo"))
    await asyncio.wait_for(sending.wait(), timeout=1)
    await settle()

    # the first job is still waiting for the relay, and the second is already rendering
    assert not first.done()
    assert renders.started == [Path("data/foo"), Path("data/bar")]

    relay_answers.set()
    renders.release(Path("data/bar"))
    await asyncio.gather(first, second)


# --- the rendering claim ---------------------------------------------------
#
# The endpoint hands the job the claim that marks the recording as rendering. While it is held,
# the listing shows a spinner and purges and second renders are turned away; once the render is
# done, the recording has to be free again.


@pytest.mark.asyncio
async def test_the_claim_is_held_while_the_job_waits_for_a_slot_and_renders(
    renders: GatedRenders,
):
    # a job waiting for its slot is as good as rendering: a purge let in then would delete the
    # recording just before its render starts reading it
    slots = asyncio.Semaphore(1)
    claim = Claim()
    first = asyncio.create_task(job(Path("data/foo"), slots))
    second = asyncio.create_task(job(Path("data/bar"), slots, claim=claim.stack()))
    await settle()

    assert claim.released == 0

    renders.release(Path("data/foo"))
    await first
    await settle()

    assert renders.started == [Path("data/foo"), Path("data/bar")]
    assert claim.released == 0

    renders.release(Path("data/bar"))
    await second
    assert claim.released == 1


@pytest.mark.asyncio
async def test_the_claim_is_given_up_before_the_report_is_sent(
    mocker: MockerFixture, renders: GatedRenders
):
    # the video is there once the render is done; a slow mail relay must not keep the card
    # spinning, or the recording from being purged or rendered again
    sending = asyncio.Event()
    relay_answers = asyncio.Event()

    async def slow_send(*_args: object, **_kwargs: object) -> None:
        sending.set()
        await relay_answers.wait()

    mocker.patch("ise_record.glue.jobs.send_report", autospec=True, side_effect=slow_send)
    smtp_settings = SmtpSettings(server="localhost", sender="render@example.de")
    claim = Claim()

    running = asyncio.create_task(
        job(
            Path("data/foo"),
            asyncio.Semaphore(1),
            "lecturer@example.de",
            smtp_settings,
            claim=claim.stack(),
        )
    )
    renders.release(Path("data/foo"))
    await asyncio.wait_for(sending.wait(), timeout=1)

    assert claim.released == 1

    relay_answers.set()
    await running
    assert claim.released == 1


@pytest.mark.asyncio
async def test_a_job_that_blows_up_gives_its_claim_back(mocker: MockerFixture):
    # otherwise the recording would show as rendering, and could be neither purged nor rendered
    # again, until the server is restarted
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        side_effect=RuntimeError("boom"),
    )
    claim = Claim()

    with pytest.raises(RuntimeError):
        await job(Path("data/foo"), asyncio.Semaphore(1), claim=claim.stack())

    assert claim.released == 1
