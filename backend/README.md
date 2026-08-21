# ISE-Recorder Backend: Technical Documentation

## Purpose

The ISE-Recorder backend combines the tracks recorded by the frontend into one video file such that the main
display (slides) and overlay (speaker video) are arranged in a sensible manner, i.e. such that the speaker is
visible but does not obscure the content on the slides. This may involve cropping of black bars from the slide
stream and rearrangement depending on the format of the slides; the following figure shows the way this backend
treats the main cases:

![Cropping Variants](doc/postprocessing.svg)

Note that there is some technical nuance to the positioning of the main display stream: the positioning depends
on the relation between the main display stream's content area after cropping and the output geometry, which we
pick from a pre-defined list (at time of writing 1280x720, 1280x800, 1920x1080). If the recorded screen does not
match the aspect ratio of the output geometry (i.e., captured from a 4:3 device, embedded in 16:9), it will be
positioned as if it had been embedded in a surrounding screen matching the output geometry's aspect ratio (in
this example, matching case 3 of the figure).

The normal, expected case is one main display, one overlay, and one audio stream, where the main display and audio
stream arrive combined as "stream" track from the frontend (see the technical documentation there). In addition
to this, the backend explicitly supports recordings without a video overlay and recordings with multiple audio
tracks. All other inputs are handled in a best-effort manner but considered out of scope for this design spec.

## Workflow

The postprocessing backend of ISE-Recorder is built to accept media streams from the ISE-Recorder frontend
and postprocessing jobs after the streams have ended. The operation is sketched in the following sequence
diagram, which shows the frontend streaming a recording A of two tracks (stream and overlay) of n and m
chunks, respectively, to the backend before scheduling a postprocessing job for recording A with the request
to notify lecturer@uni.edu when postprocessing is complete. Afterwards, the processed recording is available
on the server's filesystem.

```mermaid
sequenceDiagram
Frontend ->> Backend: Store (A, stream, 0)
Frontend ->> Backend: Store (A, overlay, 0)
Frontend ->> Backend: ...
Frontend ->> Backend: Store (A, stream, n)
Frontend ->> Backend: Store (A, overlay, m)
Frontend ->>+ Backend: Schedule postprocessing for (A, lecturer@uni.edu)
Backend ->> Backend: Postprocess A
Backend ->>- SMTP: Send notification to lecturer@uni.edu
```

The tracks need not have the same number of chunks because browsers can't force the length of media chunks
precisely, so the number of chunks per stream will drift slightly over time. 

## API

The API is an HTTP API with three endpoints:

| Endpoint | Method | Purpose | Parameters |
| - | - | - | - |
| `/api/chunks` | POST | Stream chunks of a media stream | recording name, track name, chunk index, chunk data |
| `/api/jobs` | POST | Schedule postprocessing job | recording name, notification email address |
| `/api/health` | GET | Monitoring | none |

For convenience of implementation on the frontend side, `/api/chunks` accepts input encoded as `multipart/form-data`, with the
following values:

- `recording`: name of recording (string)
- `track`: name of the track (string)
- `index`: number of the chunk in the track (integer)
- `chunk`: chunk data (file)

The `/api/jobs` endpoint accepts a JSON object (with `Content-Type: application/json`) in the body with two members:

- `recording`: name of recording (string)
- `recipient`: e-mail address of the notification recipient (string)

Where `recording` must match a recording name for which chunks have been stored before.

The `/api/health` endpoint returns HTTP status 200 and `{ "status": "healthy" }` as long as the server is running; it
is useful for primitive monitoring such as docker health checks.

## Where to find what

| File | Purpose |
| - | - |
| `src/ise_record/logconfig.py` | Logging configuration (e.g., filtering out health checks from the log) |
| `src/ise_record/postprocess.py` | Postprocessing logic |
| `src/ise_record/reporting.py` | Notification sending |
| `src/ise_record/server.py` | API definition |
| `rerender.py` | Command-line script to redo postprocessing for a recording |

## Postprocessing Logic

This backend uses ffmpeg command-line utilities for postprocessing. The process has the following phases:

1. Assemble track-wise video/audio files from the stored chunks so that ffmpeg can process them
    - these are treated as temporaries and removed in the end
    - the stored chunks are kept, so they can be recreated at will
2. Analyze the main display stream with ffprobe to figure out
    - the stream's dimensions
    - whether the stream has black bars that need cropping
    - if it does need cropping, what the actual content area is
3. Generate an ffmpeg filter to generate the desired output
    - pick an output geometry that can accommodate the content area of the main display stream
    - crop the main display stream (if necessary)
    - scale the main display stream to match the output geometry
    - position the main display stream as illustrated above
        - in case of vertical black bars, position left
        - in case of horizontal black bars, position vertically centered
    - if there is an overlay stream, scale it to match the unused area and position in the top right
        - scale to match the width of the right black bar in case the main display was positioned left
        - scale to match the height of the top black bar in case the main display was vertically centered
        - in either case, use at least 10% of the output width and height so the speaker remains visible
4. Identify all input files, i.e. stream, overlay, additional audio tracks
5. Combine all those into an ffmpeg command and run it in the background
6. Clean up when finished
