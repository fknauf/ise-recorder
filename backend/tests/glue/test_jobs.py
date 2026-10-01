"""
Postprocessing jobs: running one, reporting on it, the per-user record of which recordings
have a job in flight -- which is what keeps a second job for the same recording from starting,
and what the listing reads to show a recording as rendering -- and the limit on how many jobs
render at once.

How /jobs schedules these, and how the listing presents them, lives in test_server.py.
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
from ise_record.glue.enclave import Enclave
from ise_record.glue.jobs import get_job_queue, JobQueue, postprocessing_task
from ise_record.settings import Settings, SmtpSettings

from .conftest import request_for


def queue_for(running_jobs: set[Path] | None = None, slots: int = 1) -> JobQueue:
    """A job queue of its own, for the tests that are not about the limit."""
    return JobQueue(
        semaphore=asyncio.Semaphore(slots),
        running_jobs=running_jobs if running_jobs is not None else set(),
    )


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
        settings.destdir / "foo", "lecturer@example.de", settings.smtp, queue_for()
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
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

    await postprocessing_task(settings.destdir / "foo", None, settings.smtp, queue_for())

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_postprocessing_task_no_smtp_config(mocker: MockerFixture):
    expected_result = Result(reason=ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, return_value=expected_result
    )
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    await postprocessing_task(
        Settings(auth="disabled").destdir / "foo", "lecturer@example.de", None, queue_for()
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_a_second_job_for_a_running_recording_is_dropped(mocker: MockerFixture):
    # the frontend retries a job it got no response to, so a duplicate arrives by accident
    # rather than by malice. Two renders would write over each other's assembled tracks.
    mock_postprocess = mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)

    await postprocessing_task(
        Settings(auth="disabled").destdir / "foo", None, None, queue_for({Path("data/foo")})
    )

    mock_postprocess.assert_not_called()


@pytest.mark.asyncio
async def test_a_job_for_a_different_recording_is_not_dropped(mocker: MockerFixture):
    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(reason=ResultReason.SUCCESS, output_file=None),
    )

    await postprocessing_task(
        Settings(auth="disabled").destdir / "bar", None, None, queue_for({Path("data/foo")})
    )

    mock_postprocess.assert_called_once_with(Path("data/bar"))


@pytest.mark.asyncio
async def test_a_finished_job_releases_the_recording(mocker: MockerFixture):
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(reason=ResultReason.SUCCESS, output_file=None),
    )
    running_jobs: set[Path] = set()

    await postprocessing_task(
        Settings(auth="disabled").destdir / "foo", None, None, queue_for(running_jobs)
    )

    assert running_jobs == set()


@pytest.mark.asyncio
async def test_a_job_that_blows_up_still_releases_the_recording(mocker: MockerFixture):
    # otherwise one unexpected failure locks that recording out of postprocessing until
    # the server is restarted, and rerender.py is the only way back
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        side_effect=RuntimeError("boom"),
    )
    running_jobs: set[Path] = set()

    with pytest.raises(RuntimeError):
        await postprocessing_task(
            Settings(auth="disabled").destdir / "foo", None, None, queue_for(running_jobs)
        )

    assert running_jobs == set()


@pytest.mark.asyncio
async def test_a_running_job_is_registered_while_it_runs(mocker: MockerFixture):
    # the listing shows a recording as rendering for exactly as long as it is in the set
    running_jobs: set[Path] = set()
    seen_while_running: list[set[Path]] = []

    async def fake_postprocess(_recording_path: Path) -> Result:
        seen_while_running.append(set(running_jobs))
        return Result(reason=ResultReason.SUCCESS, output_file=None)

    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, side_effect=fake_postprocess
    )

    await postprocessing_task(Path("data/foo"), None, None, queue_for(running_jobs))

    assert seen_while_running == [{Path("data/foo")}]
    assert running_jobs == set()


# --- the per-user record of running jobs -----------------------------------
#
# Which enclave a caller gets is get_enclave's business, in test_enclave.py; these cover what
# the queue makes of the enclave it is handed.


@pytest.mark.asyncio
async def test_the_queue_registers_jobs_in_the_enclave_it_was_built_for(
    mocker: MockerFixture, tmp_path: Path
):
    # the enclave's set is what the listing, the upload check and the purge check read, so a
    # queue that kept a set of its own would let all three miss a running job
    request = request_for(Settings(destdir=tmp_path, auth="disabled"))
    enclave = Enclave(tmp_path)
    seen_while_running: list[set[Path]] = []

    async def fake_postprocess(_recording_path: Path) -> Result:
        seen_while_running.append(set(enclave.running_jobs))
        return Result(reason=ResultReason.SUCCESS, output_file=None)

    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, side_effect=fake_postprocess
    )

    queue = await get_job_queue(request, enclave)
    await postprocessing_task(tmp_path / "foo", None, None, queue)

    assert queue.running_jobs is enclave.running_jobs
    assert seen_while_running == [{tmp_path / "foo"}]
    assert enclave.running_jobs == set()


@pytest.mark.asyncio
async def test_another_users_job_does_not_block_a_recording_of_the_same_name(
    mocker: MockerFixture, tmp_path: Path
):
    # two lecturers naming a lecture alike is ordinary; only the same recording of the same
    # user counts as a duplicate
    request = request_for(Settings(destdir=tmp_path, auth="disabled"))
    home_a, home_b = tmp_path / "a", tmp_path / "b"
    enclave_a, enclave_b = Enclave(home_a), Enclave(home_b)
    enclave_a.running_jobs.add(home_a / "foo")

    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(reason=ResultReason.SUCCESS, output_file=None),
    )

    await postprocessing_task(home_b / "foo", None, None, await get_job_queue(request, enclave_b))

    mock_postprocess.assert_called_once_with(home_b / "foo")
    assert enclave_a.running_jobs == {home_a / "foo"}


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
    queue = queue_for(slots=1)
    first = asyncio.create_task(postprocessing_task(Path("data/foo"), None, None, queue))
    second = asyncio.create_task(postprocessing_task(Path("data/bar"), None, None, queue))
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
    queue = queue_for(slots=2)
    recordings = [Path("data/a"), Path("data/b"), Path("data/c")]
    jobs = [
        asyncio.create_task(postprocessing_task(path, None, None, queue)) for path in recordings
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
async def test_a_waiting_job_already_counts_as_running(renders: GatedRenders):
    # While it waits for a slot, the listing shows it as rendering, uploads to it are refused
    # and it cannot be purged -- all of which read the running set. A recording that dropped
    # out of it while queued could be purged, or have its chunks rewritten, just before its
    # render starts reading them.
    running_jobs: set[Path] = set()
    queue = queue_for(running_jobs, slots=1)
    first = asyncio.create_task(postprocessing_task(Path("data/foo"), None, None, queue))
    second = asyncio.create_task(postprocessing_task(Path("data/bar"), None, None, queue))
    await settle()

    assert renders.started == [Path("data/foo")]
    assert running_jobs == {Path("data/foo"), Path("data/bar")}

    renders.release(Path("data/foo"))
    renders.release(Path("data/bar"))
    await asyncio.gather(first, second)
    assert running_jobs == set()


@pytest.mark.asyncio
async def test_a_second_job_for_a_waiting_recording_is_dropped(renders: GatedRenders):
    queue = queue_for(slots=1)
    first = asyncio.create_task(postprocessing_task(Path("data/foo"), None, None, queue))
    waiting = asyncio.create_task(postprocessing_task(Path("data/bar"), None, None, queue))
    await settle()

    # a retried request for the job that is still waiting
    await postprocessing_task(Path("data/bar"), None, None, queue)

    renders.release(Path("data/foo"))
    renders.release(Path("data/bar"))
    await asyncio.gather(first, waiting)

    assert renders.started == [Path("data/foo"), Path("data/bar")]


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
    queue = queue_for(slots=1)

    with pytest.raises(RuntimeError):
        await postprocessing_task(Path("data/foo"), None, None, queue)

    await asyncio.wait_for(postprocessing_task(Path("data/bar"), None, None, queue), timeout=1)
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
    queue = queue_for(slots=1)

    first = asyncio.create_task(
        postprocessing_task(Path("data/foo"), "lecturer@example.de", smtp_settings, queue)
    )
    second = asyncio.create_task(postprocessing_task(Path("data/bar"), None, None, queue))
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


@pytest.mark.asyncio
async def test_all_users_share_the_limit(tmp_path: Path, renders: GatedRenders):
    # the limit protects the machine, so a second lecturer's job waits for the first
    # lecturer's like any other
    request = request_for(Settings(destdir=tmp_path, auth="disabled"))
    home_a, home_b = tmp_path / "a", tmp_path / "b"
    queue_a = await get_job_queue(request, Enclave(home_a))
    queue_b = await get_job_queue(request, Enclave(home_b))

    first = asyncio.create_task(postprocessing_task(home_a / "foo", None, None, queue_a))
    second = asyncio.create_task(postprocessing_task(home_b / "foo", None, None, queue_b))
    await settle()

    assert renders.started == [home_a / "foo"]

    renders.release(home_a / "foo")
    renders.release(home_b / "foo")
    await asyncio.gather(first, second)

    assert renders.started == [home_a / "foo", home_b / "foo"]
    assert renders.most_at_once == 1
