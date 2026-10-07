# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-many-locals
# pylint: disable=protected-access
# pylint: disable=no-member
# pylint: disable=redefined-outer-name

import json
import os
from pathlib import Path
import shutil
from subprocess import CalledProcessError
import tempfile
from typing import Any
from unittest.mock import AsyncMock, call

import anyio
import pytest
from pytest_mock import MockerFixture

from ise_record.core.postprocess import (
    _run_command,  # pyright: ignore[reportPrivateUsage]
    concat_chunks,
    ConcatenatedFile,
    determine_crop_area,
    generate_ffmpeg_filter,
    generate_overlay_scale,
    pick_target_geometry,
    postprocess_recording,
    postprocess_tracks,
    Rectangle,
    Result,
    ResultReason,
    video_properties,
    VideoProperties,
)

from ..harness import ASSETS


@pytest.mark.asyncio
async def test_run_command():
    res = await _run_command(["/usr/bin/env", "echo", "Hello, world."])
    assert res == b"Hello, world.\n"


@pytest.mark.asyncio
async def test_run_command_error():
    with pytest.raises(CalledProcessError) as ex:
        await _run_command(["/usr/bin/env", "false", "foo", "bar"])

    assert ex.value.stdout == b""
    assert ex.value.stderr == b""
    assert ex.value.cmd == ["/usr/bin/env", "false", "foo", "bar"]
    assert ex.value.returncode != 0


def test_determine_crop_area():
    width, height = 1920, 1080
    crop_none = Rectangle(width=1920, height=1080, left=0, top=0)
    crop_letter = Rectangle(width=1920, height=720, left=0, top=180)
    crop_pillar = Rectangle(width=1600, height=1080, left=160, top=0)

    crop_letter_insignificant = Rectangle(width=1920, height=1070, left=0, top=5)
    crop_pillar_insignificant = Rectangle(width=1901, height=1080, left=10, top=0)

    assert determine_crop_area(width, height, crop_none) == crop_none
    assert determine_crop_area(width, height, crop_letter) == crop_letter
    assert determine_crop_area(width, height, crop_pillar) == crop_pillar

    assert determine_crop_area(width, height, crop_letter_insignificant) == crop_none
    assert determine_crop_area(width, height, crop_pillar_insignificant) == crop_none


def test_determine_crop_area_crops_from_just_over_one_percent():
    # 19 columns of a 1920 wide stream are under one percent and kept; 20 are over it
    width, height = 1920, 1080

    assert determine_crop_area(
        width, height, Rectangle(width=1901, height=1080, left=10, top=0)
    ) == Rectangle(width=1920, height=1080, left=0, top=0)
    assert determine_crop_area(
        width, height, Rectangle(width=1900, height=1080, left=10, top=0)
    ) == Rectangle(width=1900, height=1080, left=10, top=0)


@pytest.mark.asyncio
async def test_video_properties():
    sample_path = ASSETS / "sample.webm"

    info = await video_properties(anyio.Path(sample_path))

    assert info.width == 480
    assert info.height == 270

    assert info.needs_cropping()
    assert info.crop.width == 217
    assert info.crop.height == 170
    assert info.crop.left == 125
    assert info.crop.top == 53


@pytest.mark.asyncio
async def test_video_properties_reads_a_path_the_filtergraph_would_choke_on(tmp_path: Path):
    # The path reaches ffprobe through a lavfi filtergraph -- movie=<path>,cropdetect --
    # where "," ";" "[" "]" "=" and "\'" are all syntax. A recording directory is named
    # after a lecture title, so they are reachable from user input: a title containing a
    # comma used to turn into "No such filter: 'b/full.webm'".
    #
    # They are not escaped, because filtergraph unescaping runs up to three levels deep
    # and the obvious attempts get "\'" wrong. Instead the path is kept out of the graph:
    # only the fixed file name goes in, and the directory rides along as the subprocess's
    # working directory, which no parser ever sees. Revert that and this test fails.
    track_path = tmp_path / "GVS,1[2];x='y'" / "stream"
    track_path.mkdir(parents=True)
    shutil.copy(ASSETS / "sample.webm", track_path / "full.webm")

    info = await video_properties(anyio.Path(track_path / "full.webm"))

    # the same file as test_video_properties, so only the path can account for a difference
    assert info.width == 480
    assert info.height == 270
    assert info.crop == Rectangle(width=217, height=170, left=125, top=53)


@pytest.mark.asyncio
async def test_video_properties_without_crop_detection_uses_the_whole_frame(
    mocker: MockerFixture, tmp_path: Path
):
    # a stream too short for cropdetect to report anything: nothing to crop away, then
    probe: dict[str, list[Any]] = {
        "streams": [{"codec_type": "video", "width": 640, "height": 480}],
        "packets": [],
    }
    mocker.patch(
        "ise_record.core.postprocess._run_command",
        autospec=True,
        return_value=json.dumps(probe).encode(),
    )

    info = await video_properties(anyio.Path(tmp_path / "full.webm"))

    assert info == VideoProperties(
        width=640, height=480, crop=Rectangle(width=640, height=480, left=0, top=0)
    )


def make_track(tempdir: str, names: list[str]) -> Path:
    """A track directory holding the named chunk files, each containing its own name."""
    track_path = Path(tempdir)

    for name in names:
        with open(track_path / name, "wb") as chunk:
            chunk.write(name.encode())

    return track_path


async def concat_names(names: list[str]) -> tuple[bool, str]:
    """Concatenate a track made of the given files; report completeness and the result."""
    with tempfile.TemporaryDirectory() as tempdir:
        track_path = make_track(tempdir, names)
        result = await concat_chunks(anyio.Path(track_path))

        return result.incomplete, Path(result.path).read_bytes().decode()


@pytest.mark.asyncio
async def test_concat_chunks_accepts_a_gapless_track():
    incomplete, content = await concat_names([f"chunk.{i:04d}" for i in range(4)])

    assert incomplete is False
    assert content == "chunk.0000chunk.0001chunk.0002chunk.0003"


@pytest.mark.asyncio
async def test_concat_chunks_truncates_at_a_gap():
    # A gap means the frontend never delivered that chunk. The webm stream does not
    # survive one, so everything after it is unusable and is deliberately dropped rather
    # than concatenated into a file that looks whole.
    incomplete, content = await concat_names(["chunk.0000", "chunk.0001", "chunk.0003"])

    assert incomplete is True
    assert content == "chunk.0000chunk.0001"


@pytest.mark.asyncio
async def test_concat_chunks_rejects_a_track_that_does_not_start_at_zero():
    incomplete, content = await concat_names(["chunk.0001", "chunk.0002"])

    assert incomplete is True
    assert content == ""


@pytest.mark.asyncio
async def test_concat_chunks_rejects_inconsistent_padding():
    # chunk_file_digits is a setting. If it changes between recordings a track can hold
    # both widths, and then the lexicographic sort no longer matches numeric order -- the
    # one case that would otherwise produce a wrongly ordered file rather than a short one.
    incomplete, content = await concat_names(["chunk.0000", "chunk.001"])

    assert incomplete is True
    assert content == "chunk.0000"


@pytest.mark.asyncio
async def test_concat_chunks_rejects_a_non_numeric_chunk():
    incomplete, content = await concat_names(["chunk.0000", "chunk.0001", "chunk.tmp"])

    assert incomplete is True
    # the stray file is not concatenated: it is not part of the stream
    assert content == "chunk.0000chunk.0001"


@pytest.mark.asyncio
async def test_concat_chunks_removes_the_partial_output_when_writing_fails(mocker: MockerFixture):
    # a half-written full.webm left behind would be picked up by a later run as though it
    # were a finished concatenation. The first chunk is already in it when the second one
    # fails to open, so there is something on disk to clean up.
    real_open: Any = anyio.Path.open

    async def open_failing_on_the_second_chunk(self: anyio.Path, *args: Any, **kwargs: Any) -> Any:
        if self.name == "chunk.0001":
            raise OSError("I/O error")
        return await real_open(self, *args, **kwargs)

    mocker.patch.object(
        anyio.Path, "open", autospec=True, side_effect=open_failing_on_the_second_chunk
    )

    with tempfile.TemporaryDirectory() as tempdir:
        track_path = make_track(tempdir, ["chunk.0000", "chunk.0001"])

        with pytest.raises(OSError):
            await concat_chunks(anyio.Path(track_path))

        assert not os.path.exists(track_path / "full.webm")


@pytest.mark.asyncio
async def test_postprocess_tracks_reports_an_incomplete_track_as_partial_success(
    mocker: MockerFixture,
):
    # the flag has to survive the whole pipeline: it is computed per track, but the
    # lecturer only ever sees the recording-level result
    async def mock_concat(p: anyio.Path):
        return ConcatenatedFile(path=p / "full.webm", incomplete=p == Path("foo/overlay"))

    stream_props = VideoProperties(
        width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080)
    )

    mocker.patch("ise_record.core.postprocess._run_command")
    mocker.patch("ise_record.core.postprocess.concat_chunks", wraps=mock_concat)
    mocker.patch(
        "ise_record.core.postprocess.video_properties", AsyncMock(return_value=stream_props)
    )
    mocker.patch("anyio.Path.unlink", autospec=True)
    mocker.patch("anyio.Path.is_dir", autospec=True, return_value=True)
    mocker.patch("anyio.Path.rename", autospec=True)

    result = await postprocess_tracks(
        anyio.Path("foo/stream"), anyio.Path("foo/overlay"), [], anyio.Path("foo/presentation.webm")
    )

    assert result.reason == ResultReason.PARTIAL_SUCCESS
    # the file is still produced and still delivered: a truncated lecture beats no lecture
    assert result.output_file == Path("foo/presentation.webm")


@pytest.mark.asyncio
async def test_postprocess_tracks_reports_failure_over_incompleteness(mocker: MockerFixture):
    async def mock_concat(p: anyio.Path):
        return ConcatenatedFile(path=p / "full.webm", incomplete=True)

    stream_props = VideoProperties(
        width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080)
    )

    mocker.patch(
        "ise_record.core.postprocess._run_command",
        side_effect=CalledProcessError(1, "ffmpeg", b"", b"boom"),
    )
    mocker.patch("ise_record.core.postprocess.concat_chunks", wraps=mock_concat)
    mocker.patch(
        "ise_record.core.postprocess.video_properties", AsyncMock(return_value=stream_props)
    )
    mocker.patch("anyio.Path.unlink", autospec=True)
    mocker.patch("anyio.Path.is_dir", autospec=True, return_value=True)

    result = await postprocess_tracks(
        anyio.Path("foo/stream"), anyio.Path("foo/overlay"), [], anyio.Path("foo/presentation.webm")
    )

    # there is no file to inspect, so "incomplete" would be misleading advice
    assert result.reason == ResultReason.FAILURE
    assert result.output_file is None


def test_pick_target_geometry():
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1, height=1)) == (1280, 720)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1279, height=719)) == (1280, 720)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1280, height=720)) == (1280, 720)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1280, height=721)) == (1280, 800)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1280, height=800)) == (1280, 800)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1280, height=801)) == (1920, 1080)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1281, height=800)) == (1920, 1080)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1921, height=1081)) == (1920, 1080)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=3840, height=2160)) == (1920, 1080)

    assert pick_target_geometry(Rectangle(left=99, top=99, width=1440, height=1000)) == (1920, 1080)


def test_generate_overlay_scale():
    crop_none = Rectangle(left=0, top=0, width=1920, height=1080)
    crop_pillar = Rectangle(left=210, top=0, width=1500, height=1080)
    crop_letter = Rectangle(left=0, top=140, width=1920, height=800)

    filter_none = generate_overlay_scale(crop_none, 1920, 1080)
    filter_pillar = generate_overlay_scale(crop_pillar, 1920, 1080)
    filter_letter = generate_overlay_scale(crop_letter, 1920, 1080)

    assert filter_none == "scale=-1:108,crop=w=min(in_w\\,1920)"
    assert filter_pillar == "scale=420:-1,crop=h=min(in_h\\,1080)"
    assert filter_letter == "scale=-1:140,crop=w=min(in_w\\,1920)"


def test_generate_overlay_scale_keeps_the_speaker_visible_beside_narrow_bars():
    # slides only a little narrower than the frame leave a strip too thin for a face; the
    # overlay takes a tenth of the width anyway and covers the edge of the slides
    crop_slim_pillar = Rectangle(left=60, top=0, width=1800, height=1080)

    assert (
        generate_overlay_scale(crop_slim_pillar, 1920, 1080)
        == "scale=192:-1,crop=h=min(in_h\\,1080)"
    )


def test_generate_ffmpeg_filter():
    stream_nocrop = VideoProperties(
        width=1440, height=810, crop=Rectangle(left=0, top=0, width=1440, height=810)
    )
    stream_pillar = VideoProperties(
        width=1440, height=810, crop=Rectangle(left=120, top=0, width=1200, height=810)
    )
    stream_letterbox = VideoProperties(
        width=1440, height=810, crop=Rectangle(left=0, top=105, width=1440, height=600)
    )

    filter_nocrop = generate_ffmpeg_filter(stream_nocrop, True)
    filter_pillar = generate_ffmpeg_filter(stream_pillar, True)
    filter_letterbox = generate_ffmpeg_filter(stream_letterbox, True)

    filter_nocrop_nooverlay = generate_ffmpeg_filter(stream_nocrop, False)
    filter_pillar_nooverlay = generate_ffmpeg_filter(stream_pillar, False)
    filter_letterbox_nooverlay = generate_ffmpeg_filter(stream_letterbox, False)

    overlay_nocrop = generate_overlay_scale(stream_nocrop.crop, 1920, 1080)
    overlay_pillar = generate_overlay_scale(stream_pillar.crop, 1920, 1080)
    overlay_letterbox = generate_overlay_scale(stream_letterbox.crop, 1920, 1080)

    assert (
        filter_nocrop_nooverlay
        == "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:0:-1,fps=30"
    )
    assert (
        filter_pillar_nooverlay
        == "[0:v]crop=1200:810:120:0,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:0:-1,fps=30"
    )
    assert (
        filter_letterbox_nooverlay
        == "[0:v]crop=1440:600:0:105,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:0:-1,fps=30"
    )

    assert (
        filter_nocrop
        == f"{filter_nocrop_nooverlay}[main];[1:v]{overlay_nocrop}[overlay];[main][overlay]overlay=(main_w-overlay_w):0"
    )
    assert (
        filter_pillar
        == f"{filter_pillar_nooverlay}[main];[1:v]{overlay_pillar}[overlay];[main][overlay]overlay=(main_w-overlay_w):0"
    )
    assert (
        filter_letterbox
        == f"{filter_letterbox_nooverlay}[main];[1:v]{overlay_letterbox}[overlay];[main][overlay]overlay=(main_w-overlay_w):0"
    )


@pytest.mark.asyncio
async def test_postprocess_tracks(mocker: MockerFixture):
    async def mock_concat(p: anyio.Path):
        return ConcatenatedFile(path=p / "full.webm", incomplete=False)

    stream_props = VideoProperties(
        width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080)
    )

    mock_run_command = mocker.patch("ise_record.core.postprocess._run_command")
    mock_concat_chunks = mocker.patch(
        "ise_record.core.postprocess.concat_chunks", wraps=mock_concat
    )
    mocker.patch(
        "ise_record.core.postprocess.video_properties", AsyncMock(return_value=stream_props)
    )
    mock_unlink = mocker.patch("anyio.Path.unlink", autospec=True)
    mocker.patch("anyio.Path.is_dir", autospec=True, return_value=True)
    mock_rename = mocker.patch("anyio.Path.rename", autospec=True)

    result = await postprocess_tracks(
        anyio.Path("foo/stream"), anyio.Path("foo/overlay"), [], anyio.Path("foo/presentation.webm")
    )

    assert result.reason == ResultReason.SUCCESS
    assert result.output_file == Path("foo/presentation.webm")

    mock_run_command.assert_called_once_with(
        [
            "ffmpeg",
            "-i",
            "foo/stream/full.webm",
            "-i",
            "foo/overlay/full.webm",
            "-filter_complex",
            generate_ffmpeg_filter(stream_props, True),
            "-map",
            "0:a?",
            "-y",
            "foo/presentation.part.webm",
        ]
    )

    mock_concat_chunks.assert_has_calls([call(Path("foo/stream")), call(Path("foo/overlay"))])

    mock_rename.assert_has_calls(
        [call(Path("foo/presentation.part.webm"), Path("foo/presentation.webm"))]
    )

    mock_unlink.assert_has_calls(
        [
            call(Path("foo/stream/full.webm"), missing_ok=True),
            call(Path("foo/overlay/full.webm"), missing_ok=True),
        ]
    )


@pytest.mark.asyncio
async def test_postprocess_tracks_no_overlay(mocker: MockerFixture):
    async def mock_concat(p: anyio.Path):
        return ConcatenatedFile(path=p / "full.webm", incomplete=False)

    def mock_isdir(path: anyio.Path) -> bool:
        return path == Path("foo/stream")

    stream_props = VideoProperties(
        width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080)
    )

    mock_run_command = mocker.patch("ise_record.core.postprocess._run_command")
    mock_concat_chunks = mocker.patch(
        "ise_record.core.postprocess.concat_chunks", wraps=mock_concat
    )
    mocker.patch(
        "ise_record.core.postprocess.video_properties", AsyncMock(return_value=stream_props)
    )
    mock_unlink = mocker.patch("anyio.Path.unlink", autospec=True)
    mocker.patch("anyio.Path.is_dir", autospec=True, side_effect=mock_isdir)
    mock_rename = mocker.patch("anyio.Path.rename", autospec=True)

    result = await postprocess_tracks(
        anyio.Path("foo/stream"), anyio.Path("foo/overlay"), [], anyio.Path("foo/presentation.webm")
    )

    assert result.reason == ResultReason.SUCCESS
    assert result.output_file == Path("foo/presentation.webm")

    mock_run_command.assert_called_once_with(
        [
            "ffmpeg",
            "-i",
            "foo/stream/full.webm",
            "-filter_complex",
            generate_ffmpeg_filter(stream_props, False),
            "-map",
            "0:a?",
            "-y",
            "foo/presentation.part.webm",
        ]
    )

    mock_concat_chunks.assert_called_once_with(Path("foo/stream"))
    mock_rename.assert_called_once_with(
        Path("foo/presentation.part.webm"), Path("foo/presentation.webm")
    )

    mock_unlink.assert_has_calls(
        [
            call(Path("foo/presentation.part.webm"), missing_ok=True),
            call(Path("foo/stream/full.webm"), missing_ok=True),
        ]
    )


@pytest.mark.asyncio
async def test_postprocess_tracks_multi_audio(mocker: MockerFixture):
    async def mock_concat(p: anyio.Path):
        return ConcatenatedFile(path=p / "full.webm", incomplete=False)

    stream_props = VideoProperties(
        width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080)
    )

    mock_run_command = mocker.patch("ise_record.core.postprocess._run_command")
    mock_concat_chunks = mocker.patch(
        "ise_record.core.postprocess.concat_chunks", wraps=mock_concat
    )
    mocker.patch(
        "ise_record.core.postprocess.video_properties", AsyncMock(return_value=stream_props)
    )
    mock_unlink = mocker.patch("anyio.Path.unlink", autospec=True)
    mocker.patch("anyio.Path.is_dir", autospec=True, return_value=True)
    mock_rename = mocker.patch("anyio.Path.rename", autospec=True)

    result = await postprocess_tracks(
        anyio.Path("foo/stream"),
        anyio.Path("foo/overlay"),
        [
            anyio.Path("foo/audio-0"),
            anyio.Path("foo/audio-1"),
            anyio.Path("foo/audio-2"),
        ],
        anyio.Path("foo/presentation.webm"),
    )

    assert result.reason == ResultReason.SUCCESS
    assert result.output_file == Path("foo/presentation.webm")

    mock_run_command.assert_called_once_with(
        [
            "ffmpeg",
            "-i",
            "foo/stream/full.webm",
            "-i",
            "foo/overlay/full.webm",
            "-i",
            "foo/audio-0/full.webm",
            "-i",
            "foo/audio-1/full.webm",
            "-i",
            "foo/audio-2/full.webm",
            "-filter_complex",
            generate_ffmpeg_filter(stream_props, True),
            "-map",
            "0:a?",
            "-map",
            "2:a",
            "-map",
            "3:a",
            "-map",
            "4:a",
            "-y",
            "foo/presentation.part.webm",
        ]
    )

    mock_concat_chunks.assert_has_calls(
        [
            call(Path("foo/stream")),
            call(Path("foo/overlay")),
            call(Path("foo/audio-0")),
            call(Path("foo/audio-1")),
            call(Path("foo/audio-2")),
        ]
    )

    mock_rename.assert_called_once_with(
        Path("foo/presentation.part.webm"), Path("foo/presentation.webm")
    )

    mock_unlink.assert_has_calls(
        [
            call(Path("foo/stream/full.webm"), missing_ok=True),
            call(Path("foo/overlay/full.webm"), missing_ok=True),
            call(Path("foo/audio-0/full.webm"), missing_ok=True),
            call(Path("foo/audio-1/full.webm"), missing_ok=True),
            call(Path("foo/audio-2/full.webm"), missing_ok=True),
        ]
    )


@pytest.mark.asyncio
async def test_postprocess_tracks_multi_audio_no_overlay(mocker: MockerFixture):
    async def mock_concat(p: anyio.Path):
        return ConcatenatedFile(path=p / "full.webm", incomplete=False)

    def mock_isdir(path: anyio.Path) -> bool:
        return path != Path("foo/overlay")

    stream_props = VideoProperties(
        width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080)
    )

    mock_run_command = mocker.patch("ise_record.core.postprocess._run_command")
    mock_concat_chunks = mocker.patch(
        "ise_record.core.postprocess.concat_chunks", wraps=mock_concat
    )
    mocker.patch(
        "ise_record.core.postprocess.video_properties", AsyncMock(return_value=stream_props)
    )
    mock_unlink = mocker.patch("anyio.Path.unlink", autospec=True)
    mocker.patch("anyio.Path.is_dir", autospec=True, side_effect=mock_isdir)
    mock_rename = mocker.patch("anyio.Path.rename", autospec=True)

    result = await postprocess_tracks(
        anyio.Path("foo/stream"),
        anyio.Path("foo/overlay"),
        [
            anyio.Path("foo/audio-0"),
            anyio.Path("foo/audio-1"),
            anyio.Path("foo/audio-2"),
        ],
        anyio.Path("foo/presentation.webm"),
    )

    assert result.reason == ResultReason.SUCCESS
    assert result.output_file == Path("foo/presentation.webm")

    mock_run_command.assert_called_once_with(
        [
            "ffmpeg",
            "-i",
            "foo/stream/full.webm",
            "-i",
            "foo/audio-0/full.webm",
            "-i",
            "foo/audio-1/full.webm",
            "-i",
            "foo/audio-2/full.webm",
            "-filter_complex",
            generate_ffmpeg_filter(stream_props, False),
            "-map",
            "0:a?",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-map",
            "3:a",
            "-y",
            "foo/presentation.part.webm",
        ]
    )

    mock_concat_chunks.assert_has_calls(
        [
            call(Path("foo/stream")),
            call(Path("foo/audio-0")),
            call(Path("foo/audio-1")),
            call(Path("foo/audio-2")),
        ]
    )

    mock_rename.assert_called_once_with(
        Path("foo/presentation.part.webm"), Path("foo/presentation.webm")
    )

    mock_unlink.assert_has_calls(
        [
            call(Path("foo/stream/full.webm"), missing_ok=True),
            call(Path("foo/audio-0/full.webm"), missing_ok=True),
            call(Path("foo/audio-1/full.webm"), missing_ok=True),
            call(Path("foo/audio-2/full.webm"), missing_ok=True),
        ]
    )


# The tests above mock anyio.Path.rename, so they pin the arguments ffmpeg is handed and nothing
# else. These two run the same code against a real directory, because the reason for the
# intermediate name is a property of the directory afterwards: presentation.webm is what a
# lecturer downloads and what the completed-recordings listing offers, so it must never be
# a file ffmpeg is still writing into, or stopped writing into halfway.

STREAM_PROPS = VideoProperties(
    width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080)
)


async def fake_concat(track_path: anyio.Path) -> ConcatenatedFile:
    """A concatenation that leaves a real (empty) file where postprocess_tracks expects one."""
    full = Path(track_path) / "full.webm"
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(b"")
    return ConcatenatedFile(path=anyio.Path(full), incomplete=False)


def render_target(command: list[str]) -> Path:
    """The file ffmpeg was told to write, which is the argument after -y."""
    return Path(command[command.index("-y") + 1])


@pytest.mark.asyncio
async def test_the_rendered_file_gets_its_final_name_only_once_it_is_complete(
    mocker: MockerFixture, tmp_path: Path
):
    output_path = tmp_path / "presentation.webm"
    render_targets: list[Path] = []

    async def fake_render(command: list[str], cwd: Path | None = None) -> bytes:  # pylint: disable=unused-argument
        render_targets.append(render_target(command))
        render_target(command).write_bytes(b"rendered")
        return b""

    mocker.patch("ise_record.core.postprocess.concat_chunks", wraps=fake_concat)
    mocker.patch(
        "ise_record.core.postprocess.video_properties", AsyncMock(return_value=STREAM_PROPS)
    )
    mocker.patch("ise_record.core.postprocess._run_command", wraps=fake_render)

    result = await postprocess_tracks(
        anyio.Path(tmp_path / "stream"),
        anyio.Path(tmp_path / "overlay"),
        [],
        anyio.Path(output_path),
    )

    assert result == Result(output_file=anyio.Path(output_path), reason=ResultReason.SUCCESS)
    # ffmpeg wrote somewhere else, and the finished file arrived under its final name by
    # a rename -- which is atomic, so no reader ever sees a partial presentation.webm
    assert render_targets == [tmp_path / "presentation.part.webm"]
    assert output_path.read_bytes() == b"rendered"
    assert not list(tmp_path.glob("*.part.*"))


@pytest.mark.asyncio
async def test_a_failed_render_leaves_nothing_under_the_final_name(
    mocker: MockerFixture, tmp_path: Path
):
    output_path = tmp_path / "presentation.webm"

    async def fake_render(command: list[str], cwd: Path | None = None) -> bytes:  # pylint: disable=unused-argument
        # ffmpeg had started writing before it gave up, which is the case the rename exists for
        render_target(command).write_bytes(b"half a video")
        raise CalledProcessError(1, command, b"", b"boom")

    mocker.patch("ise_record.core.postprocess.concat_chunks", wraps=fake_concat)
    mocker.patch(
        "ise_record.core.postprocess.video_properties", AsyncMock(return_value=STREAM_PROPS)
    )
    mocker.patch("ise_record.core.postprocess._run_command", wraps=fake_render)

    result = await postprocess_tracks(
        anyio.Path(tmp_path / "stream"),
        anyio.Path(tmp_path / "overlay"),
        [],
        anyio.Path(output_path),
    )

    assert result == Result(output_file=None, reason=ResultReason.FAILURE)
    assert not output_path.exists()


# These run against a real directory: which tracks a recording has is read off the disk, and
# mocking the calls that read it would pin how it is read rather than what comes of it.


@pytest.mark.asyncio
async def test_postprocess_recordings(mocker: MockerFixture, tmp_path: Path):
    rec_path = tmp_path / "foo"
    # the stray directory is not an audio track, and must not be handed on as one
    for track in ["stream", "audio-0", "audio-1", "screenshots"]:
        (rec_path / track).mkdir(parents=True)

    expected_result = Result(
        reason=ResultReason.SUCCESS, output_file=anyio.Path(rec_path / "presentation.webm")
    )

    mock_postprocess_tracks = mocker.patch(
        "ise_record.core.postprocess.postprocess_tracks",
        return_value=expected_result,
        autospec=True,
    )

    result = await postprocess_recording(anyio.Path(rec_path))

    assert result == expected_result

    mock_postprocess_tracks.assert_called_once_with(
        rec_path / "stream",
        rec_path / "overlay",
        [rec_path / "audio-0", rec_path / "audio-1"],
        rec_path / "presentation.webm",
    )


@pytest.mark.asyncio
async def test_postprocess_recordings_nonexistent(mocker: MockerFixture, tmp_path: Path):
    expected_result = Result(reason=ResultReason.MAIN_STREAM_MISSING, output_file=None)

    mock_postprocess_tracks = mocker.patch(
        "ise_record.core.postprocess.postprocess_tracks", autospec=True
    )

    result = await postprocess_recording(anyio.Path(tmp_path / "foo"))

    assert result == expected_result

    mock_postprocess_tracks.assert_not_called()


@pytest.mark.asyncio
async def test_postprocess_recordings_missing_main(mocker: MockerFixture, tmp_path: Path):
    rec_path = tmp_path / "foo"
    for track in ["audio-0", "audio-1"]:
        (rec_path / track).mkdir(parents=True)

    expected_result = Result(reason=ResultReason.MAIN_STREAM_MISSING, output_file=None)

    mock_postprocess_tracks = mocker.patch(
        "ise_record.core.postprocess.postprocess_tracks", autospec=True
    )

    result = await postprocess_recording(anyio.Path(rec_path))

    assert result == expected_result

    mock_postprocess_tracks.assert_not_called()


@pytest.mark.asyncio
async def test_audio_tracks_are_ordered_by_number_not_by_name(
    mocker: MockerFixture, tmp_path: Path
):
    # sort audio-1, audio-2, ..., audio-9, audio-10 instead of audio-1, audio-10, audio-2

    mock_tracks = mocker.patch(
        "ise_record.core.postprocess.postprocess_tracks",
        autospec=True,
        return_value=Result(reason=ResultReason.SUCCESS, output_file=None),
    )

    recording_path = tmp_path / "PSU_2026-02-13T164309.313"
    (recording_path / "stream").mkdir(parents=True)

    audio_dirs = [f"audio-{i}" for i in range(12)]

    for d in audio_dirs:
        (recording_path / d).mkdir()

    await postprocess_recording(anyio.Path(recording_path))
    audio_args = [path.name for path in mock_tracks.call_args.args[2]]

    assert audio_args == audio_dirs


@pytest.mark.asyncio
async def test_a_render_that_crashes_unexpectedly_is_reported_as_failed(
    mocker: MockerFixture, tmp_path: Path
):
    # whatever goes wrong in there, the job ends with a result to report rather than an
    # exception that leaves the lecturer without a mail
    rec_path = tmp_path / "foo"
    (rec_path / "stream").mkdir(parents=True)
    mocker.patch(
        "ise_record.core.postprocess.postprocess_tracks",
        autospec=True,
        side_effect=OSError("disk gone"),
    )

    result = await postprocess_recording(anyio.Path(rec_path))

    assert result == Result(output_file=None, reason=ResultReason.FAILURE)
