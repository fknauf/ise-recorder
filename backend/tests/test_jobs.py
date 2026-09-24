"""
Postprocessing jobs: running one, reporting on it, and the per-user record of which
recordings have a job in flight -- which is what keeps a second job for the same recording
from starting, and what the listing reads to show a recording as rendering.

How /jobs schedules these, and how the listing presents them, lives in test_server.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring

from pathlib import Path
from unittest.mock import ANY

from fastapi import Request
import pytest
from pytest_mock import MockerFixture

from ise_record.jobs import get_running_jobs, get_running_jobs_snapshot, postprocessing_task
from ise_record.postprocess import Result, ResultReason
from ise_record.server import create_app
from ise_record.settings import Settings, SmtpSettings


# --- running a job ---------------------------------------------------------

@pytest.mark.asyncio
async def test_postprocessing_task_with_report(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch("ise_record.jobs.postprocess_recording", autospec=True, return_value=expected_result)
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    settings = Settings(
        smtp = SmtpSettings(
            server="localhost",
            port=587,
            local_hostname="smtp.example.de",
            username="server@example.de",
            password="supersecure",
            sender="render@example.de",
            starttls=True,
            allowed_domains=("example.de",)
        )
    )

    await postprocessing_task(
        settings.destdir / "foo",
        "lecturer@example.de",
        settings.smtp,
        set()
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
        password="supersecure"
    )

    sent_report = mock_send.call_args[0][0]

    assert "foo" in sent_report["Subject"]
    assert "render@example.de" == sent_report["From"]
    assert "lecturer@example.de" == sent_report["To"]
    assert "foo/presentation.webm" in sent_report.get_payload()

@pytest.mark.asyncio
async def test_postprocessing_task_no_lecturer(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch("ise_record.jobs.postprocess_recording", autospec=True, return_value=expected_result)
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    settings = Settings(
        smtp = SmtpSettings(
            server="localhost",
            port=587,
            local_hostname="smtp.example.de",
            username="server@example.de",
            password="supersecure",
            sender="render@example.de",
            starttls=True,
            allowed_domains=("example.de",)
        )
    )

    await postprocessing_task(
        settings.destdir / "foo",
        None,
        settings.smtp,
        set()
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_not_called()

@pytest.mark.asyncio
async def test_postprocessing_task_no_smtp_config(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch("ise_record.jobs.postprocess_recording", autospec=True, return_value=expected_result)
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    await postprocessing_task(
        Settings().destdir / "foo",
        "lecturer@example.de",
        None,
        set()
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_not_called()

@pytest.mark.asyncio
async def test_a_second_job_for_a_running_recording_is_dropped(mocker: MockerFixture):
    # the frontend retries a job it got no response to, so a duplicate arrives by accident
    # rather than by malice. Two renders would write over each other's assembled tracks.
    mock_postprocess = mocker.patch("ise_record.jobs.postprocess_recording", autospec=True)

    await postprocessing_task(
        Settings().destdir / "foo",
        None,
        None,
        { Path("data/foo") }
    )

    mock_postprocess.assert_not_called()

@pytest.mark.asyncio
async def test_a_job_for_a_different_recording_is_not_dropped(mocker: MockerFixture):
    mock_postprocess = mocker.patch("ise_record.jobs.postprocess_recording", autospec=True, return_value=Result(reason=ResultReason.SUCCESS, output_file=None))

    await postprocessing_task(
        Settings().destdir / "bar",
        None,
        None,
        { Path("data/foo") }
    )

    mock_postprocess.assert_called_once_with(Path("data/bar"))

@pytest.mark.asyncio
async def test_a_finished_job_releases_the_recording(mocker: MockerFixture):
    mocker.patch("ise_record.jobs.postprocess_recording", autospec=True, return_value=Result(reason=ResultReason.SUCCESS, output_file=None))
    running_jobs: set[Path] = set()

    await postprocessing_task(
        Settings().destdir / "foo",
        None,
        None,
        running_jobs
    )

    assert running_jobs == set()

@pytest.mark.asyncio
async def test_a_job_that_blows_up_still_releases_the_recording(mocker: MockerFixture):
    # otherwise one unexpected failure locks that recording out of postprocessing until
    # the server is restarted, and rerender.py is the only way back
    mocker.patch("ise_record.jobs.postprocess_recording", autospec=True, side_effect=RuntimeError("boom"))
    running_jobs: set[Path] = set()

    with pytest.raises(RuntimeError):
        await postprocessing_task(
            Settings().destdir / "foo",
            None,
            None,
            running_jobs
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

    mocker.patch("ise_record.jobs.postprocess_recording", autospec=True, side_effect=fake_postprocess)

    await postprocessing_task(Path("data/foo"), None, None, running_jobs)

    assert seen_while_running == [ { Path("data/foo") } ]
    assert running_jobs == set()


# --- the per-user record of running jobs -----------------------------------

def request_for(app_settings: Settings) -> Request:
    """ A bare request against a fresh app; get_running_jobs only reads app.state from it. """
    return Request(scope={ "type": "http", "app": create_app(app_settings) })


@pytest.mark.asyncio
async def test_each_user_has_a_running_job_set_of_their_own(tmp_path: Path):
    request = request_for(Settings(destdir=tmp_path))
    home_a, home_b = tmp_path / "a", tmp_path / "b"

    mine = await get_running_jobs(request, home_a)
    theirs = await get_running_jobs(request, home_b)

    # the same set every time for the same user, or a job would register in one set and the
    # listing would look in another
    assert await get_running_jobs(request, home_a) is mine
    assert mine is not theirs


@pytest.mark.asyncio
async def test_another_users_job_does_not_block_a_recording_of_the_same_name(mocker: MockerFixture, tmp_path: Path):
    # two lecturers naming a lecture alike is ordinary; only the same recording of the same
    # user counts as a duplicate
    request = request_for(Settings(destdir=tmp_path))
    home_a, home_b = tmp_path / "a", tmp_path / "b"
    (await get_running_jobs(request, home_a)).add(home_a / "foo")

    mock_postprocess = mocker.patch("ise_record.jobs.postprocess_recording", autospec=True, return_value=Result(reason=ResultReason.SUCCESS, output_file=None))

    await postprocessing_task(home_b / "foo", None, None, await get_running_jobs(request, home_b))

    mock_postprocess.assert_called_once_with(home_b / "foo")


@pytest.mark.asyncio
async def test_the_snapshot_does_not_follow_later_changes(tmp_path: Path):
    # the snapshot is handed to a dependency that scans the filesystem in the thread pool,
    # while jobs on the event loop keep adding and removing entries. A live view would be
    # iterated mid-change; a copy cannot be.
    running_jobs = await get_running_jobs(request_for(Settings(destdir=tmp_path)), tmp_path)
    running_jobs.add(tmp_path / "foo")

    snapshot = await get_running_jobs_snapshot(running_jobs)
    running_jobs.add(tmp_path / "bar")
    running_jobs.discard(tmp_path / "foo")

    assert snapshot == frozenset({ tmp_path / "foo" })
    assert isinstance(snapshot, frozenset)
