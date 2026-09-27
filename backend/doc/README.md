# ISE-Recorder Backend: Technical Documentation

## Purpose

The ISE-Recorder backend combines the tracks recorded by the frontend into one video file such that the main
display (slides) and overlay (speaker video) are arranged in a sensible manner, i.e. such that the speaker is
visible but does not obscure the content on the slides. This may involve cropping of black bars from the slide
stream and rearrangement depending on the format of the slides; the following figure shows the way this backend
treats the main cases:

![Cropping Variants](postprocessing.svg)

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

The API is an HTTP API with the following endpoints:

| Endpoint | Method | Purpose | Parameters |
| - | - | - | - |
| `/api/chunks` | POST | Stream chunks of a media stream | recording name, track name, chunk index, chunk data |
| `/api/jobs` | POST | Schedule postprocessing job | recording name, notification email address |
| `/api/health` | GET | Monitoring | none |
| `/api/recordings` | GET | Retrieve list of user's recordings | none, needs auth |
| `/api/recordings/{recording}` | DELETE | Purge recording from server | none, needs auth |
| `/api/recordings/{user}/{recording}` | GET | Downnload recording | TOTP for the recording as returned from `/api/recordings` |

For convenience of implementation on the frontend side, `/api/chunks` accepts input encoded as `multipart/form-data` with the
following fields:

- `recording`: name of recording (string)
- `track`: name of the track (string)
- `index`: number of the chunk in the track (integer)
- `chunk`: chunk data (file)

This is meant to work with the following Typescript snippet:

```typescript
const data = new FormData();
data.append("recording", "GVS_2026-01-23T123456.789Z");
data.append("track", "stream");
data.append("index", "0");
data.append("chunk", chunk); // where chunk is of type Blob

const request: RequestInit = {
    method: "POST",
    body: data
};
```

The `/api/jobs` endpoint accepts a JSON object (with `Content-Type: application/json`) in the body shaped like

```json
{
    "recording": "GVS_2026-01-23T123456.789Z",
    "recipient": "lecturer@uni.edu"
}
```

Where `recording` must match a recording name for which chunks have been stored before.

The `/api/health` endpoint returns HTTP status 200 and `{ "status": "healthy" }` as long as the server is running; it
is useful for primitive monitoring such as docker health checks.

The `/api/recordings` endpoint retrieves a list of the user's (as identified by the bearer token in the HTTP
`Authorization` header) recordings, sorted into completed, rendering, and unprocessed recordings. For completed
recordings, the file size and a per-recording download TOTP (valid for two minutes) are also returned, as well
as a user name digest for use with the download endpoint. See the "Downloads" section below for an explanation
why this is necessary. The shape of the response is thus

```json
{
    "user": "021ef10ad....",
    "completed": [
        {
            "name": "GVS_2026-09-11T123456.789Z",
            "size": 1048576,
            "totp": "1234567890"
        },
        {
            "name": "GVS_2026-09-28T123456.789Z",
            "size": 1048576,
            "totp": "0123456789"
        }
    ],
    "rendering": [
        {
            "name": "GVS_2026-09-25T123456.789Z",
        }
    ],
    "unprocessed": {
        {
            "name": "GVS_2026-09-04T123456.789Z",
        }
    }
}
```

The download endpoint must make do without a bearer token, which is why there's a username in the path. It
needs the `totp` field retrieved from `/api/recordings` as a GET parameter (`?totp=0123456789`) for authentication.

A `DELETE` query to `/api/recordings/{recording}` uses a bearer token that already has the user information, so
it's omitted from the path there. I know this is a bit ugly, and a future version might rethink this design (unless
I suddenly get lots of users who develop against the API and backwards-compatibility becomes critical).

## Where to find what

All source code is in the `src` directory, most of it into a python module `ise_record`. This module
has two submodules `ise_record.core` and `ise_record.glue`, of which `core` concerns itself with core
functionality such as postprocessing, reporting, and authentication, while the `glue` module is
concerned with binding the core functionality up to a FastAPI server instance, i.e. wrapping it up
in dependables, deciding which HTTP errors to return in case of failure, etc.

### Top-level modules

Directly under `ise_record` there are two modules

| Module | Purpose |
| - | - |
| `server` | API endpoint definition and server instance construction |
| `settings` | Environment settings to influence server behavior |

### Core modules

The `core` submodule is split into a number of sub-submodules, each of which addresses a specific
concern. These are

| Module | Purpose |
| - | - |
| `auth` | Authentication: OpenID and Download-TOTP (see below) |
| `logconfig` | Logging configuration (e.g., filtering out health checks from the log) |
| `postprocess` | Postprocessing logic, i.e. the actual video rendering |
| `recordings` | Identifying which recordings are finished, rendering, still streaming, etc. |
| `reporting` | Notification e-mail sending |
| `user_home` | Preparing user-specific directories to store their recordings |

### Glue modules

The `glue` submodule is likewise split further into submodules.

| Module | Purpose |
| - | - |
| `auth` | Connects core.auth to fastapi |
| `jobs` | a wrapper around `core.postprocessing` and `core.reporting` to be spawned as a background task |
| `models` | Datatypes for API parameters and return values, for validation and automatic JSON generation |
| `recordings` | Connects core.recordings to fastapi |
| `user_home` | Connects core.user_home to fastapi |stprocessing for a recording |

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
    - this command renders to a temporary file first and renames it to the final name when finished
    - this makes it possible to tell finished from failed post-processings
6. Clean up when finished

## Recording classification

The classification of recordings is derivd from the application and file system state to avoid the need
for a database. The post-processing logic is set up to make this relatively straightforward, in particular
such that the output file only turns up in the file system after rendering has concluded successfully.

So the logic is basically:

1. If the application knows it has started a rendering process that's still running, recording is rendering.
2. If the output file exists, the recording is completed.
3. If thre is no main track, the recording is classified as not renderable.
4. If the newest uploaded chunk in the main stream is younger than five minutes, the stream is considered still streaming
5. Otherwise, it is unprocessed, which typically means postprocessing failed.

Streaming detection is somewhat heuristic, but the stakes are low: if it takes five minutes for a failed
rendering to appear in the list of server-side recordings, that's acceptable until I have a better idea
how to handle it.

## Authentication

The backend supports optional OpenID-Connect-based authentication. In this mode, the backend expects an
`Authorization: Bearer $token` header with an access token with every query, which it validates locally
without per-request calls to the OIDC provider. At server start, it attempts to discover the OIDC provider's
issuer and jwks endpoint, then feeds those to a PyJWT `PyJWKClient`, which handles the key retrieval and
refreshes. The actual token validation and decoding is then also based on PyJWT.

At the moment, the backend does not attempt to distinguish between access and id tokens other than
checking the audience claim against the configured value, i.e. the header is not inspected for
`"typ": "at+jwt"`. This will change in the future, when all common OIDC providers mint their tokens with
that type. Note that there exist OIDC providers where the audience check is unreliable, in particular
kanidm, which forces client id and audience to the same value. They do set `"typ": "at+jwt"`, and that will
ultimately be the test. For the moment, though, I don't have a reliable way to tell apart id and access
tokens from all OIDC providers out there, and as far as I can make out, relying on the audience field
seems to be the standard workaround. So I'm doing that for now.

The access tokens are used to establish trust, i.e. that a request is allowed to store data and schedule
jobs. There are no custom scopes, right now it's all-or-nothing when it comes to permissions. The user's
home directory is derived from `sub`. This is stable but not human-readable, so if `preferred_username`
is present in the token or can be found out through a query against the OICD provider's `userinfo_endpoint`,
the backend derives a human-readable alternative name from `sub` and `preferred_username` for a symlink
to the stable directory. In the future, it may also read the `email` claim for reporting purposes.

## Downloads

Because browsers can't (easily) be made to attach bearer tokens to download requests, we use a
TOTP-based mechanism to authenticate downloads. When the frontend asks for a list of available processed
recordings, the backend generates a TOTP for each file in the list and sends it along with the list of
available files. The frontend attaches the TOTP to the download link as a GET parameter, and the backend
allows downloads only with a matching TOTP. The OTPs are valid for two minutes, and the frontend keeps
polling the backend for new OTPs every minute.
