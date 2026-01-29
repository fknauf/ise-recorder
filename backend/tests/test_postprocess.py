# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-many-locals

import os
from pathlib import Path
from subprocess import CalledProcessError
import tempfile
from unittest.mock import AsyncMock, call

import pytest
import ise_record.postprocess
from ise_record.postprocess import (
    _run_command,
    concat_chunks,
    generate_overlay_scale,
    generate_ffmpeg_filter,
    pick_target_geometry,
    postprocess_recording,
    postprocess_tracks,
    Rectangle,
    Result,
    ResultReason,
    video_properties,
    VideoProperties
)

@pytest.mark.asyncio
async def test_run_command():
    res = await _run_command([ "/bin/echo", "Hello, world." ])
    assert res == b"Hello, world.\n"

@pytest.mark.asyncio
async def test_run_command_error():
    with pytest.raises(CalledProcessError) as ex:
        await _run_command([ "/bin/false", "foo", "bar" ])

    assert ex.value.stdout == b""
    assert ex.value.stderr == b""
    assert ex.value.cmd == [ "/bin/false", "foo", "bar" ]
    assert ex.value.returncode != 0

@pytest.mark.asyncio
async def test_video_properties():
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"

    info = await video_properties(sample_path)

    print(info)

    assert info.width == 480
    assert info.height == 270

    assert info.needs_cropping()
    assert info.crop.width == 217
    assert info.crop.height == 170
    assert info.crop.left == 125
    assert info.crop.top == 53

@pytest.mark.asyncio
async def test_concat_chunks():
    first_data = bytes(range(256))
    second_data = bytes(range(255, -1, -1))

    with tempfile.TemporaryDirectory() as tempdir:
        temp_path = Path(tempdir)

        with open(temp_path / "chunk.0000", "wb") as chnk1:
            chnk1.write(first_data)
        with open(temp_path / "chunk.0001", "wb") as chnk2:
            chnk2.write(second_data)

        await concat_chunks(temp_path)

        assert os.path.isfile(temp_path / "full.webm")

        with open(temp_path / "full.webm", "rb") as full:
            content = full.read()
            assert content == first_data + second_data

def test_pick_target_geometry():
    assert pick_target_geometry(Rectangle(left=0, top=0, width=   1, height=   1)) == (1280,  720)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1279, height= 719)) == (1280,  720)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1280, height= 720)) == (1280,  720)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1280, height= 721)) == (1280,  800)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1280, height= 800)) == (1280,  800)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1280, height= 801)) == (1920, 1080)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1281, height= 800)) == (1920, 1080)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=1921, height=1081)) == (1920, 1080)
    assert pick_target_geometry(Rectangle(left=0, top=0, width=3840, height=2160)) == (1920, 1080)

    assert pick_target_geometry(Rectangle(left=99, top=99, width=1440, height=1000)) == (1920, 1080)

def test_generate_overlay_scale():
    crop_none       = Rectangle(left=  0, top=  0, width=1920, height=1080)
    crop_pillar     = Rectangle(left=210, top=  0, width=1500, height=1080)
    crop_letter     = Rectangle(left=  0, top=140, width=1920, height= 800)
    crop_negligible = Rectangle(left= 10, top= 10, width=1900, height=1060)

    filter_none       = generate_overlay_scale(crop_none,       1920, 1080)
    filter_pillar     = generate_overlay_scale(crop_pillar,     1920, 1080)
    filter_letter     = generate_overlay_scale(crop_letter,     1920, 1080)
    filter_negligible = generate_overlay_scale(crop_negligible, 1920, 1080)

    assert filter_none   == "scale=192:108:force_original_aspect_ratio=increase"
    assert filter_pillar == "scale=420:108:force_original_aspect_ratio=increase"
    assert filter_letter == "scale=192:140:force_original_aspect_ratio=increase"
    assert filter_negligible == filter_none

def test_generate_ffmpeg_filter():
    stream_nocrop     = VideoProperties(width=1440, height=810, crop=Rectangle(left=  0, top=  0, width=1440, height=810))
    stream_pillar     = VideoProperties(width=1440, height=810, crop=Rectangle(left=120, top=  0, width=1200, height=810))
    stream_letterbox  = VideoProperties(width=1440, height=810, crop=Rectangle(left=  0, top=105, width=1440, height=600))
    stream_negligible = VideoProperties(width=1440, height=810, crop=Rectangle(left=  7, top=  4, width=1426, height=802))

    filter_nocrop     = generate_ffmpeg_filter(stream_nocrop,     True)
    filter_pillar     = generate_ffmpeg_filter(stream_pillar,     True)
    filter_letterbox  = generate_ffmpeg_filter(stream_letterbox,  True)
    filter_negligible = generate_ffmpeg_filter(stream_negligible, True)

    filter_nocrop_nooverlay     = generate_ffmpeg_filter(stream_nocrop,     False)
    filter_pillar_nooverlay     = generate_ffmpeg_filter(stream_pillar,     False)
    filter_letterbox_nooverlay  = generate_ffmpeg_filter(stream_letterbox,  False)
    filter_negligible_nooverlay = generate_ffmpeg_filter(stream_negligible, False)

    ovly_nocrop    = generate_overlay_scale(stream_nocrop.crop,    1920, 1080)
    ovly_pillar    = generate_overlay_scale(stream_pillar.crop,    1920, 1080)
    ovly_letterbox = generate_overlay_scale(stream_letterbox.crop, 1920, 1080)

    assert filter_nocrop_nooverlay    == "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:0:-1,fps=30"
    assert filter_pillar_nooverlay    == "[0:v]crop=1200:810:120:0,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:0:-1,fps=30"
    assert filter_letterbox_nooverlay == "[0:v]crop=1440:600:0:105,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:0:-1,fps=30"
    assert filter_negligible_nooverlay == filter_nocrop_nooverlay

    assert filter_nocrop    == f"{filter_nocrop_nooverlay   }[main];[1:v]{ovly_nocrop   }[overlay];[main][overlay]overlay=(main_w-overlay_w):0"
    assert filter_pillar    == f"{filter_pillar_nooverlay   }[main];[1:v]{ovly_pillar   }[overlay];[main][overlay]overlay=(main_w-overlay_w):0"
    assert filter_letterbox == f"{filter_letterbox_nooverlay}[main];[1:v]{ovly_letterbox}[overlay];[main][overlay]overlay=(main_w-overlay_w):0"
    assert filter_negligible == filter_nocrop

@pytest.mark.asyncio
async def test_postprocess_tracks(mocker):
    async def mock_concat(dir: Path):
        return dir / "full.webm"
    
    stream_props = VideoProperties(width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080))

    mocker.patch("ise_record.postprocess._run_command")
    mocker.patch("ise_record.postprocess.concat_chunks", wraps=mock_concat)
    mocker.patch("ise_record.postprocess.video_properties", AsyncMock(return_value=stream_props))
    mocker.patch("pathlib.Path.unlink", autospec=True)
    mocker.patch("pathlib.Path.is_dir", return_value=True)

    result = await postprocess_tracks(
        Path("foo/stream"),
        Path("foo/overlay"),
        [],
        Path("foo/presentation.webm")
    )

    assert result.reason == ResultReason.SUCCESS
    assert result.output_file == Path("foo/presentation.webm")

    ise_record.postprocess._run_command.assert_called_once_with([
        "ffmpeg",
        "-i", "foo/stream/full.webm",
        "-i", "foo/overlay/full.webm",
        "-filter_complex", generate_ffmpeg_filter(stream_props, True),
        "-map", "0:a?",
        "-y", "foo/presentation.webm"
    ])

    ise_record.postprocess.concat_chunks.assert_has_calls([
        call(Path("foo/stream")),
        call(Path("foo/overlay"))
    ])

    Path.unlink.assert_has_calls([
        call(Path("foo/stream/full.webm")),
        call(Path("foo/overlay/full.webm"))
    ])

@pytest.mark.asyncio
async def test_postprocess_tracks_no_overlay(mocker):
    async def mock_concat(dir: Path):
        return dir / "full.webm"
    
    def mock_isdir(self: Path):
        return self == Path("foo/stream")
    
    stream_props = VideoProperties(width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080))

    mocker.patch("ise_record.postprocess._run_command")
    mocker.patch("ise_record.postprocess.concat_chunks", wraps=mock_concat)
    mocker.patch("ise_record.postprocess.video_properties", AsyncMock(return_value=stream_props))
    mocker.patch("pathlib.Path.unlink", autospec=True)
    mocker.patch("pathlib.Path.is_dir", wraps=mock_isdir, autospec=True)

    result = await postprocess_tracks(
        Path("foo/stream"),
        Path("foo/overlay"),
        [],
        Path("foo/presentation.webm")
    )

    assert result.reason == ResultReason.SUCCESS
    assert result.output_file == Path("foo/presentation.webm")

    ise_record.postprocess._run_command.assert_called_once_with([
        "ffmpeg",
        "-i", "foo/stream/full.webm",
        "-filter_complex", generate_ffmpeg_filter(stream_props, False),
        "-map", "0:a?",
        "-y", "foo/presentation.webm"
    ])

    ise_record.postprocess.concat_chunks.assert_called_once_with(Path("foo/stream"))
    Path.unlink.assert_called_once_with(Path("foo/stream/full.webm"))

@pytest.mark.asyncio
async def test_postprocess_tracks_multi_audio(mocker):
    async def mock_concat(dir: Path):
        return dir / "full.webm"
    
    stream_props = VideoProperties(width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080))

    mocker.patch("ise_record.postprocess._run_command")
    mocker.patch("ise_record.postprocess.concat_chunks", wraps=mock_concat)
    mocker.patch("ise_record.postprocess.video_properties", AsyncMock(return_value=stream_props))
    mocker.patch("pathlib.Path.unlink", autospec=True)
    mocker.patch("pathlib.Path.is_dir", return_value=True)

    result = await postprocess_tracks(
        Path("foo/stream"),
        Path("foo/overlay"),
        [
            Path("foo/audio-0"),
            Path("foo/audio-1"),
            Path("foo/audio-2"),
        ],
        Path("foo/presentation.webm")
    )

    assert result.reason == ResultReason.SUCCESS
    assert result.output_file == Path("foo/presentation.webm")

    ise_record.postprocess._run_command.assert_called_once_with([
        "ffmpeg",
        "-i", "foo/stream/full.webm",
        "-i", "foo/overlay/full.webm",
        "-i", "foo/audio-0/full.webm",
        "-i", "foo/audio-1/full.webm",
        "-i", "foo/audio-2/full.webm",
        "-filter_complex", generate_ffmpeg_filter(stream_props, True),
        "-map", "0:a?",
        "-map", "2:a",
        "-map", "3:a",
        "-map", "4:a",
        "-y", "foo/presentation.webm"
    ])

    ise_record.postprocess.concat_chunks.assert_has_calls([
        call(Path("foo/stream")),
        call(Path("foo/overlay")),
        call(Path("foo/audio-0")),
        call(Path("foo/audio-1")),
        call(Path("foo/audio-2"))
    ])

    Path.unlink.assert_has_calls([
        call(Path("foo/stream/full.webm")),
        call(Path("foo/overlay/full.webm")),
        call(Path("foo/audio-0/full.webm")),
        call(Path("foo/audio-1/full.webm")),
        call(Path("foo/audio-2/full.webm"))
    ])

@pytest.mark.asyncio
async def test_postprocess_tracks_multi_audio_no_overlay(mocker):
    async def mock_concat(dir: Path):
        return dir / "full.webm"
    
    def mock_isdir(self: Path):
        return self != Path("foo/overlay")
    
    stream_props = VideoProperties(width=1920, height=1080, crop=Rectangle(left=0, top=0, width=1920, height=1080))

    mocker.patch("ise_record.postprocess._run_command")
    mocker.patch("ise_record.postprocess.concat_chunks", wraps=mock_concat)
    mocker.patch("ise_record.postprocess.video_properties", AsyncMock(return_value=stream_props))
    mocker.patch("pathlib.Path.unlink", autospec=True)
    mocker.patch("pathlib.Path.is_dir", wraps=mock_isdir, autospec=True)

    result = await postprocess_tracks(
        Path("foo/stream"),
        Path("foo/overlay"),
        [
            Path("foo/audio-0"),
            Path("foo/audio-1"),
            Path("foo/audio-2"),
        ],
        Path("foo/presentation.webm")
    )

    assert result.reason == ResultReason.SUCCESS
    assert result.output_file == Path("foo/presentation.webm")

    ise_record.postprocess._run_command.assert_called_once_with([
        "ffmpeg",
        "-i", "foo/stream/full.webm",
        "-i", "foo/audio-0/full.webm",
        "-i", "foo/audio-1/full.webm",
        "-i", "foo/audio-2/full.webm",
        "-filter_complex", generate_ffmpeg_filter(stream_props, False),
        "-map", "0:a?",
        "-map", "1:a",
        "-map", "2:a",
        "-map", "3:a",
        "-y", "foo/presentation.webm"
    ])

    ise_record.postprocess.concat_chunks.assert_has_calls([
        call(Path("foo/stream")),
        call(Path("foo/audio-0")),
        call(Path("foo/audio-1")),
        call(Path("foo/audio-2"))
    ])

    Path.unlink.assert_has_calls([
        call(Path("foo/stream/full.webm")),
        call(Path("foo/audio-0/full.webm")),
        call(Path("foo/audio-1/full.webm")),
        call(Path("foo/audio-2/full.webm"))
    ])

@pytest.mark.asyncio
async def test_postprocess_recordings(mocker):
    rec_path = Path("foo")
    audio_paths = [ 
        Path("foo/audio-0"),
        Path("foo/audio-1")
    ]

    expected_result = Result(reason=ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mocker.patch("pathlib.Path.is_dir", return_value=True, autospec=True)
    mocker.patch("pathlib.Path.glob", return_value=audio_paths, autospec=True)
    mocker.patch("ise_record.postprocess.postprocess_tracks", return_value=expected_result, autospec=True)

    result = await postprocess_recording(rec_path)

    assert result == expected_result

    ise_record.postprocess.postprocess_tracks.assert_called_once_with(
        rec_path / "stream",
        rec_path / "overlay",
        audio_paths,
        expected_result.output_file
    )

    Path.is_dir.assert_has_calls([
        call(rec_path),
        call(rec_path / "stream")
    ])

    Path.glob.assert_called_once_with(rec_path, "audio-*")
