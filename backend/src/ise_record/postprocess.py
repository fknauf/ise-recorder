"""
    ISE-Recorder postprocessing module. Combines camera and slide feeds into a useful
    whole. Tries to handle partially available data in the most sensible way possible
    (e.g. missing camera feed -> still produce slides with audio)
"""

import asyncio
from enum import Enum
import json
import logging
from pathlib import Path
from subprocess import CalledProcessError
from typing import NamedTuple, List, Tuple

import aiofiles

logger = logging.getLogger(__name__)

class ResultReason(Enum):
    """ Reason for a job result, i.e. why a file was produced or not produced. """
    SUCCESS = 1
    FAILURE = 2
    MAIN_STREAM_MISSING = 3

class Result(NamedTuple):
    """ Result of a postprocessing job """
    output_file: Path | None
    reason: ResultReason

class Rectangle(NamedTuple):
    """ rectangular area in a video stream, used for cropping """
    width: int
    height: int
    left: int
    top: int

class VideoProperties(NamedTuple):
    """ Properties of a video stream that we need for postprocessing """
    width: int
    height: int
    crop: Rectangle

    def needs_cropping(self) -> bool:
        """
        determines if this video stream needs to be cropped.
        """
        return self.width > self.crop.width or self.height > self.crop.height

def _log_error(err: CalledProcessError) -> None:
    logger.error("Failed with return code %d.\n" \
                 "command = %s\n\n" \
                 "stdout\n------\n%s\n\n" \
                 "stderr\n------\n%s\n",
                 err.returncode, err.cmd, err.stdout, err.stderr)

async def _run_command(command: List[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    out, err = await proc.communicate()

    if proc.returncode != 0:
        raise CalledProcessError(
            returncode = proc.returncode,
            cmd = command,
            output = out,
            stderr = err
        )

    return out

def determine_crop_area(
        stream_width: int,
        stream_height: int,
        raw_crop: Rectangle
) -> Rectangle:
    """ 
        Determine the effective cropping area for a stream. Will select the full
        stream rectangle if an insignificant area would be cropped.

        :param stream_width width of the input stream
        :param stream_height height of the input stream
        :param crop_left x coordinate of the leftmost pixel in the detected cropping area
        :param crop_right x coordinate of the rightmost pixel in the detected cropping area
        :param crop_top y coordinate of the top pixel in the detected cropping area
        :param crop_bottom y coordinate of the bottom pixel in the detected cropping area
        :returns the effective cropping area
    """

    slack_width = stream_width - raw_crop.width
    slack_height = stream_height - raw_crop.height

    # less than one percent cropped on each side -> avoid cropping
    if slack_width * 100 <= stream_width and slack_height * 100 <= stream_height:
        return Rectangle(width=stream_width, height=stream_height, left=0, top=0)

    return raw_crop

async def video_properties(path: Path) -> VideoProperties:
    """
        Extract the information required for postprocess_picture_in_picture from a video file

        The most involved bit here is the crop detection that figures out what the slide stream
        can be sensibly cropped to. We use ffmpeg's avfilter plugin for that, which gives us a
        list of sensible crop dimensions for successive time slices in the video file. We just
        use the most expansive of these to be on the safe side. We really expect them all to be
        the same anyway.

        :params path input video file
        :returns properties of the input file
    """

    probe_command = [
        'ffprobe',
        '-print_format', 'json',
        '-f', 'lavfi',
        '-i', f'movie={str(path)},cropdetect',
        '-show_streams',
        '-show_entries', 'packet_tags=lavfi.cropdetect.x1,lavfi.cropdetect.y1,'
                                     'lavfi.cropdetect.x2,lavfi.cropdetect.y2'
    ]

    logger.info("Analyzing %s...", path)
    logger.debug("Probe command = %s", probe_command)

    probe_stdout = await _run_command(probe_command)

    info = json.loads(probe_stdout)

    # frontend can only generate files with one video stream
    video_stream = next(s for s in info['streams'] if s['codec_type'] == 'video')

    width = int(video_stream['width'])
    height = int(video_stream['height'])

    packets = [ p for p in info['packets'] if 'tags' in p ]

    crop_left   = min((int(p['tags']['lavfi.cropdetect.x1']) for p in packets), default=0)
    crop_top    = min((int(p['tags']['lavfi.cropdetect.y1']) for p in packets), default=0)
    crop_right  = max((int(p['tags']['lavfi.cropdetect.x2']) for p in packets), default=width)
    crop_bottom = max((int(p['tags']['lavfi.cropdetect.y2']) for p in packets), default=height)

    logger.debug('%s: size=%dx%d, crop=%d,%d-%d,%d',
                 path, width, height, crop_left, crop_top, crop_right, crop_bottom)

    crop = determine_crop_area(
        stream_width = width,
        stream_height = height,
        raw_crop = Rectangle(
            width = crop_right - crop_left + 1,
            height = crop_bottom - crop_top + 1,
            left = crop_left,
            top = crop_top
        )
    )

    return VideoProperties(
        width = width,
        height = height,
        crop = crop
    )

async def concat_chunks(track_path: Path) -> Path:
    """
        Concatenates the chunk files supplied by the frontend to get the full stream file that
        we can feed to ffmpeg.

        :params track_path directory that contains the input fragments
        :returns path of the assembled stream file
    """
    target_path = track_path / "full.webm"

    async with aiofiles.open(target_path, 'wb') as dest:
        for src_path in sorted(track_path.glob('chunk.*')):
            async with aiofiles.open(src_path, 'rb') as src:
                await dest.write(await src.read())

    return target_path

def pick_target_geometry(content: Rectangle) -> Tuple[int, int]:
    """
        Picks the most appropriate out of a list of standardized output geometries.

        :param content area of the main stream that's going to be used
        :returns target width and height 
    """
    candidates = [
        (1280, 720),  # 16:9
        (1280, 800),  # 16:10
        (1920, 1080)  # 16:9
    ]

    for w, h in candidates:
        if content.width <= w and content.height <= h:
            return w, h

    return candidates[-1]

def generate_overlay_scale(crop: Rectangle, outer_width: int, outer_height: int) -> str:
    """
        Generate a scaling filter appropriate for the overlay stream.
         
        This is meant to make good use of inserted black bars around the main stream, if there are
        any, and otherwise to keep the overlay usefully visible while not hiding important parts
        of the slides.

        :param crop rectangle to which the main stream will be cropped
        :param outer_width target width of the combined output stream
        :param outer_height target height of the combined output stream
        :returns ffmpeg filter that scales the overlay stream appropriately
    """

    # note: if the input stream is not cropped, scaling_x == scaling_y == 1
    scaling_x = outer_width / crop.width
    scaling_y = outer_height / crop.height

    if scaling_x <= scaling_y:
        # letterboxed. Slides will be vertically centered, so we can use half the vertical slack.
        # We will at least use 10% of the screen height, though, just to remain visible.
        # width is cropped if the scaled overlay is wider than the main stream. This seems unlikely
        # to ever happen, but I've run into stranger stuff and am thus overly paranoid.
        #
        # This is also the path for uncropped main streams because I think it's more important to
        # control the height of the overlay than the width if the overlay is going to hide part of
        # the slides. The reasoning is that the top of the slides never contains actual important
        # content, but it might extend all the way to the right side. We'll see how it pans out in
        # practice; most likely it won't make a difference.
        slack_height = outer_height - round(scaling_x * crop.height)
        overlay_height = max(slack_height // 2, outer_height // 10)
        scale_filter = f'scale=-1:{overlay_height},crop=w=min(in_w\\,{outer_width})'
    else:
        # pillarboxed. Slides will appear on the left, so we can use the full horizontal slack.
        # Again, we'll use at least 10% of the screen width, and height is cropped to at most main
        # stream height.
        slack_width = outer_width - round(scaling_y * crop.width)
        overlay_width = max(slack_width, outer_width // 10)
        scale_filter = f'scale={overlay_width}:-1,crop=h=min(in_h\\,{outer_height})'

    return scale_filter

def generate_ffmpeg_filter(stream: VideoProperties, has_overlay: bool) -> str:
    """
        Assembles the picture-in-picture rendering filter for ffmpeg

        :param stream properties of the main video stream
        :param has_overlay whether there is an overlay stream
        :return ffmpeg filter for use with -filter_complex
    """
    outer_width, outer_height = pick_target_geometry(stream.crop)

    # crop if the main stream is something like 4:3 slides captured on a 16:9 screen (or vice versa)
    crop_filter = \
        f'crop={stream.crop.width}:{stream.crop.height}:{stream.crop.left}:{stream.crop.top},' \
        if stream.needs_cropping() else ''

    # scale to desired dimensions, but keep original aspect ratio by decreasing one side length if
    # necessary, then pad to desired dimensions by keeping the content left and vertically centered.
    # This forces the exact dimensions we want, whereas scaling with one dimension set to -1
    # sometimes creates off-by-one errors if the dimensions almost scale up neatly. We had this with
    # an 1198x749 input video that with scale=-1:800 yielded 1281x800 instead of 1280x800 and made
    # the padding filter complain.
    scale_filter = (
        f'scale={outer_width}:{outer_height}:force_original_aspect_ratio=decrease'
        f',pad={outer_width}:{outer_height}:0:-1'
    )

    if not has_overlay:
        return f'[0:v]{crop_filter}{scale_filter},fps=30'

    overlay_scale = generate_overlay_scale(stream.crop, outer_width, outer_height)

    stream_filter = f'[0:v]{crop_filter}{scale_filter},fps=30[main]'
    overlay_filter = f'[1:v]{overlay_scale}[overlay]'
    combine_filter = '[main][overlay]overlay=(main_w-overlay_w):0'

    return f'{stream_filter};{overlay_filter};{combine_filter}'

async def postprocess_tracks(
        stream_dir: Path,
        overlay_dir: Path,
        audio_dirs: List[Path],
        output_path: Path
) -> Result:
    """
        Render the (first) camera stream as an overlay onto the (first) display stream.
        This is the normal case. Frontend feeds us the first camera with all audio tracks
        as "stream" and the (first) captured display as "display-0", so we know where to
        look.

        Most of the logic here is to figure out if and how to crop the display stream, how
        large the overlay should sensibly be, and to construct options that ffmpeg will
        accept. ffmpeg is a little finnicky at times, so this is a little involved.

        :param stream_dir path of the main stream (usually slides + voice)
        :param overlay_dir path of the overlay video stream (usually the speaker)
        :param audio_dirs paths of additional audio streams, if available
        :param output_path where to write the result
        :returns whether the job succeeded, plus info for the e-mail report
    """

    inputs = []

    has_overlay = overlay_dir.is_dir()
    logger.debug("Recording %s an overlay track", "has" if has_overlay else "doesn't have")

    try:
        inputs.append(await concat_chunks(stream_dir))
        stream_props = await video_properties(inputs[0])

        ffmpeg_maps = [
            '-filter_complex', generate_ffmpeg_filter(stream_props, has_overlay),
            '-map', '0:a?'
        ]

        if has_overlay:
            inputs.append(await concat_chunks(overlay_dir))

        for audio_dir in audio_dirs:
            ffmpeg_maps.extend([ '-map', f'{len(inputs)}:a' ])
            inputs.append(await concat_chunks(audio_dir))

        render_command = [
            'ffmpeg'
        ] + [
            arg for path in inputs for arg in [ '-i', str(path) ]
        ] + ffmpeg_maps + [
            '-y', str(output_path)
        ]

        logger.info("Rendering %s...", output_path)
        logger.debug("Render command = %s", render_command)

        await _run_command(render_command)

        logger.info("Render completed")

        return Result(output_file=output_path, reason=ResultReason.SUCCESS)
    except CalledProcessError as err:
        _log_error(err)
        return Result(output_file=None, reason=ResultReason.FAILURE)
    finally:
        for p in inputs:
            p.unlink()

async def postprocess_recording(recording_path: Path) -> Result:
    """
        Postprocess the chunks of a recording. Output will be written to recording_path

        :param recording_path directory that contains the input streams in chunks
        :returns whether postprocessing succeeded and path of the result file
    """

    if not recording_path.is_dir():
        logger.warning("Scheduled postprocessing for non-existent recording %s", recording_path)
        return Result(output_file=None, reason=ResultReason.MAIN_STREAM_MISSING)

    stream_dir = recording_path / "stream"
    overlay_dir = recording_path / "overlay"
    audio_dirs = list(recording_path.glob('audio-*'))
    output_path = recording_path / 'presentation.webm'

    if not stream_dir.is_dir():
        logger.info("%s has no main display stream, nothing to do.", recording_path)
        return Result(output_file=None, reason=ResultReason.MAIN_STREAM_MISSING)

    logger.info("Postprocessing %s", recording_path)
    return await postprocess_tracks(stream_dir, overlay_dir, audio_dirs, output_path)
