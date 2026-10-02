"""
Postprocessing jobs: running one, reporting on it, and the limit on how many jobs render at once.

The task knows nothing of the record of busy recordings: /jobs marks the recording as rendering
for the whole request, which a FastAPI request lasts until its background tasks are done. Holding
and releasing that mark, turning away a duplicate and how the listing presents a job all live in
test_server.py; the mark itself in core/test_recordings.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import asyncio
from pathlib import Path
from unittest.mock import ANY

import pytest
from pytest_mock import MockerFixture

from ise_record.core.postprocess import Result, ResultReason
from ise_record.glue.jobs import postprocessing_task
from ise_record.settings import Settings, SmtpSettings

# --- running a job ---------------------------------------------------------


@pytest.mark.asyncio
async def test_postprocessing_task_with_report(mocker: MockerFixture):
    expected_result = Result(reason=ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, return_value=expected_result
    )
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    settings = Settings(
        auth="disabled",
        smtp=SmtpSettings(
            server="localhost",
            port=587,
            local_hostname="smtp.example.de",
            username="server@example.de",
            password="supersecure",
            sender="render@example.de",
            starttls=True,
            allowed_domains=("example.de",),
        ),
    )

    await postprocessing_task(
        settings.destdir / "foo", "lecturer@example.de", settings.smtp, asyncio.Semaphore(1)
    )

    mock_postprocess.assert_called_once_with(settings.destdir / "foo")
    mock_send.assert_called_once_with(
        ANY,
        hostname="localhost",
        port=587,
        local_hostname="smtp.example.de",
        start_tls=True,
        use_tls=False,
        username="server@example.de",
        password="supersecure",
    )

    sent_report = mock_send.call_args[0][0]

    assert "foo" in sent_report["Subject"]
    assert "render@example.de" == sent_report["From"]
    assert "lecturer@example.de" == sent_report["To"]
    assert "foo/presentation.webm" in sent_report.get_payload()


@pytest.mark.asyncio
async def test_postprocessing_task_no_lecturer(mocker: MockerFixture):
    expected_result = Result(reason=ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, return_value=expected_result
    )
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    settings = Settings(
        auth="disabled",
        smtp=SmtpSettings(
            server="localhost",
            port=587,
            local_hostname="smtp.example.de",
            username="server@example.de",
            password="supersecure",
            sender="render@example.de",
            starttls=True,
            allowed_domains=("example.de",),
        ),
    )

    await postprocessing_task(settings.destdir / "foo", None, settings.smtp, asyncio.Semaphore(1))

    mock_postprocess.assert_called_once_with(settings.destdir / "foo")
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_postprocessing_task_no_smtp_config(mocker: MockerFixture):
    expected_result = Result(reason=ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, return_value=expected_result
    )
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    settings = Settings(auth="disabled")

    await postprocessing_task(
        settings.destdir / "foo", "lecturer@example.de", None, asyncio.Semaphore(1)
    )

    mock_postprocess.assert_called_once_with(settings.destdir / "foo")
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

    async def render(self, recording_path: Path) -> Result:
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
    first = asyncio.create_task(postprocessing_task(Path("data/foo"), None, None, slots))
    second = asyncio.create_task(postprocessing_task(Path("data/bar"), None, None, slots))
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
    jobs = [
        asyncio.create_task(postprocessing_task(path, None, None, slots)) for path in recordings
    ]
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
        await postprocessing_task(Path("data/foo"), None, None, slots)

    await asyncio.wait_for(postprocessing_task(Path("data/bar"), None, None, slots), timeout=1)
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

    first = asyncio.create_task(
        postprocessing_task(Path("data/foo"), "lecturer@example.de", smtp_settings, slots)
    )
    second = asyncio.create_task(postprocessing_task(Path("data/bar"), None, None, slots))
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
