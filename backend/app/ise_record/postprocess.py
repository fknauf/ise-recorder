"""
    ISE-Recorder postprocessing module. Combines camera and slide feeds into a useful
    whole. Tries to handle partially available data in the most sensible way possible
    (e.g. missing camera feed -> still produce slides with audio)
"""

import json
import logging
from pathlib import Path
from subprocess import run, CalledProcessError, PIPE
import sys
from typing import NamedTuple, Tuple

logger = logging.getLogger(__name__)

class PostProcessingResult(NamedTuple):
    """ Result of a postprocessing job """
    success: bool
    output_file: Path | None

class Rectangle(NamedTuple):
    """ rectangular area in a video stream, used for cropping """
    width: int
    height: int
    left: int
    top: int

    def crop_filter(self) -> str:
        """ returns an ffmpeg crop filter for rectangle """
        return f'crop={self.width}:{self.height}:{self.left}:{self.top}'

class VideoProperties(NamedTuple):
    """ Properties of a video stream that we need for postprocessing """
    width: int
    height: int
    has_audio: bool
    crop: Rectangle

    def needs_cropping(self) -> bool:
        """ determines if this video stream needs to be cropped """
        return self.width != self.crop.width or self.height != self.crop.height

def _log_error(err: CalledProcessError) -> None:
    logger.error("Failed with return code %d.\n" \
                 "command = %s\n\n" \
                 "stdout\n------\n%s\n\n" \
                 "stderr\n------\n%s\n",
                 err.returncode, ' '.join(err.args), err.stdout, err.stderr)


def video_properties(path: Path) -> VideoProperties:
    """
        Extract the information required for postprocess_picture_in_picture from a video file

        The most involved bit here is the crop detection that figures out what the slide stream
        can be sensibly cropped to. We use ffmpeg's avfilter plugin for that, which gives us a
        list of sensible crop dimensions for successive time slices in the video file. We just
        use the most expansive of these to be on the safe side. We really expect them all to be
        the same anyway.
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

    probe_result = run(probe_command, stdout=PIPE, stderr=PIPE, check=True, text=True)

    info = json.loads(probe_result.stdout)

    # frontend can only generate files with one video stream
    video_stream = next(s for s in info['streams'] if s['codec_type'] == 'video')
    has_audio = next((s for s in info['streams'] if s['codec_type'] == 'audio'), None) is not None

    width = int(video_stream['width'])
    height = int(video_stream['height'])

    packets = [ p for p in info['packets'] if 'tags' in p ]

    crop_left   = min((int(p['tags']['lavfi.cropdetect.x1']) for p in packets), default=0)
    crop_top    = min((int(p['tags']['lavfi.cropdetect.y1']) for p in packets), default=0)
    crop_right  = max((int(p['tags']['lavfi.cropdetect.x2']) for p in packets), default=width)
    crop_bottom = max((int(p['tags']['lavfi.cropdetect.y2']) for p in packets), default=height)

    return VideoProperties(
        width = width,
        height = height,
        has_audio = has_audio,
        crop = Rectangle(
            width = (crop_right - crop_left + 1),
            height = (crop_bottom - crop_top + 1),
            left = crop_left,
            top = crop_top
        )
    )

def concat_chunks(track_path: Path) -> Path:
    """
        Concatenates the chunk files supplied by frontend to get the full stream file that
        we can feed to ffmpeg.
    """
    target_path = track_path / "full.webm"

    with open(target_path, 'wb') as dest:
        for src_path in sorted(track_path.glob('chunk.*')):
            with open(src_path, 'rb') as src:
                dest.write(src.read())

    return target_path

def pick_target_geometry(content: Rectangle) -> Tuple[int, int]:
    """
        Picks the most appropriate out of a list of standardized output geometries.
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

def pip_filter(display: VideoProperties) -> str:
    """ Assembles the picture-in-picture rendering filter for ffmpeg """
    outer_width, outer_height = pick_target_geometry(display.crop)

    # Use the smaller scaling factor so the full display is always in the output.
    scaling_x = outer_width / display.crop.width
    scaling_y = outer_height / display.crop.height
    scaling_factor = min(scaling_x, scaling_y)

    if scaling_y < scaling_x:
        # e.g. 4:3 slides to 16:9 output
        scale_filter = f'scale=-1:{outer_height}'

        # Slides will appear on the left, so the full slack_width is available for the
        # overlay. But make sure it's still at least visible.
        slack = outer_width - int(scaling_factor * display.crop.width)
        overlay_width = max(slack, outer_width // 10)
        overlay_scale = f'scale={overlay_width}:-1'
    else:
        # e.g. 16:9 slides to 1280x800
        scale_filter = f'scale={outer_width}:-1'

        # slides will be vertically centered, so the overlay should ideally only use
        # the top half of the slack
        slack = outer_height - int(scaling_factor * display.crop.height)
        overlay_height = max(slack // 2, outer_height // 10)
        overlay_scale = f'scale=-1:{overlay_height}'

    # crop if display-0 is something like 4:3 slides captured on a 16:9 screen (or vice versa)
    crop_filter = f'{display.crop.crop_filter()},' if display.needs_cropping() else ''

    # pad to desired dimensions, place content left and vertically centered
    pad_filter = f'pad={outer_width}:{outer_height}:0:-1'

    display_filter = f'[0:v]{crop_filter}{scale_filter},{pad_filter},fps=30[main]'
    overlay_filter = f'[1:v]{overlay_scale}[overlay]'
    combine_filter = '[main][overlay]overlay=(main_w-overlay_w):0'

    return f'{display_filter};{overlay_filter};{combine_filter}'

def postprocess_picture_in_picture(
        stream_dir: Path,
        display_dir: Path,
        output_path: Path
) -> PostProcessingResult:
    """
        Render the (first) camera stream as an overlay onto the (first) display stream.
        This is the normal case. Frontend feeds us the first camera with all audio tracks
        as "stream" and the (first) captured display as "display-0", so we know where to
        look.

        Most of the logic here is to figure out if and how to crop the display stream, how
        large the overlay should sensibly be, and to construct options that ffmpeg will
        accept. ffmpeg is a little finnicky at times, so this is a little involved.
    """

    stream_path = None
    display_path = None

    try:
        stream_path = concat_chunks(stream_dir)
        display_path = concat_chunks(display_dir)

        stream = video_properties(stream_path)
        display = video_properties(display_path)

        ffmpeg_filter = pip_filter(display)

        # map all audio streams if there are any.
        # ffmpeg fails if we pass -map 1:a when there's no audio.
        audio_map = ['-map', '1:a' ] if stream.has_audio else []

        render_command = [
            'ffmpeg',
            '-i', str(display_path),
            '-i', str(stream_path),
            '-filter_complex', ffmpeg_filter,
        ] + audio_map + [
            '-y',
            str(output_path)
        ]

        run(render_command, stdout=PIPE, stderr=PIPE, check=True, text=True)

        return PostProcessingResult(success=True, output_file=output_path)
    except CalledProcessError as err:
        _log_error(err)
        return PostProcessingResult(success=False, output_file=None)
    finally:
        if stream_path is not None:
            stream_path.unlink()
        if display_path is not None:
            display_path.unlink()

def postprocess_index(
        stream_dir: Path,
        output_path: Path
) -> PostProcessingResult:
    """
        Run when there aren't both a camera and display stream, so that picture-in-picture
        makes no sense. In that case we just slap an index onto the video stream.

        This will usually be a recording of slides with just a microphone but no camera.
    """

    stream_path = concat_chunks(stream_dir)

    try:
        command =[ 'ffmpeg', '-i', stream_path, '-y', output_path ]
        run(command, stdout=PIPE, stderr=PIPE, text=True, check=True)

        return PostProcessingResult(success=True, output_file=output_path)
    except CalledProcessError as err:
        _log_error(err)
        return PostProcessingResult(success=False, output_file=None)
    finally:
        stream_path.unlink()

def postprocess_recording(recording_path: Path) -> PostProcessingResult | None:
    """ Postprocess the chunks of a recording """

    if not recording_path.is_dir():
        return PostProcessingResult(
            args=[],
            returncode=255,
            stdout='',
            stderr="Requested postprocessing for recording that doesn't exist")

    stream_dir = recording_path / "stream"
    display_dir = recording_path / "display-0"
    output_path = recording_path / 'presentation.webm'

    if not stream_dir.is_dir():
        # audio only, nothing to do.
        return None

    if display_dir.is_dir():
        return postprocess_picture_in_picture(stream_dir, display_dir, output_path)
    return postprocess_index(stream_dir, output_path)

if __name__ == "__main__":
    print(postprocess_recording(Path(sys.argv[1])))
