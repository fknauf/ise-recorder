# ISE-Recorder

This is a fairly simple web-based lecture recorder. Its job is to capture your
slides, capture your webcam, and optionally postprocess them such that the
speaker is overlaid over the slide stream in a sensible manner.

Recordings are stored on the client-side in the browser's OPFS and optionally
streamed to a post-processing backend server. If post-processing is enabled,
the recorded streams will be posted to the backend chunk by chunk, followed by
a notification to start post-processing when the recording stops. The backend
can authenticate users against an OpenID Connect service or run without
authentication. The latter is only advisable in small private-network deployments
where everyone in the network is trusted, of course. You don't want the whole
Internet to be able to write to your server and schedule compute-heavy jobs. You
know how those guys are.

Video streams can be marked as main or overlay, and post-processing consists of
overlaying the overlay stream (usually the speaker on a webcam) over the main
stream (usually lecture slides) in the top-right corner such that the slides
are not obstructed but the speaker remains recognizable. If there are multiple
audio streams, they will all be attached to the resulting video file. If there
is no overlay, post-processing just indexes the main video stream. If there is
no stream marked as main display, ISE-Recorder will make a best-effort guess.

If there are additional screen or video streams, they will be streamed to the
backend but not used in post-processing. It's then possible to process the
recording manually.

If a backend and authentication are configured, then it's also possible to
download, delete, and schedule re-rendering of processed recordings, as well
as to re-upload recordings that are stored in the browser.

## Take a look

![ISE-Recorder-Screenshot](screenshot.png)

## Get started

I recommend running in docker:

    mkdir -m 777 data
    docker compose build
    docker compose up

then visit http://localhost:3000.

The stock `compose.yml` includes a backend that mounts the `data` directory to
its dumping ground, so postprocessed recordings will appear there. The `data`
dir only needs mode 777 if the user configured in the `compose.yml` differs
from the one running in the backend container, which can happen with
rootless docker or if your uid:gid is not `1000:1000`. Giving it mode 777
just avoids the need for configuration before getting started.

For production environments, it's advisable to mount a data directory owned by
the process user in the backend container. You can run it behind a reverse
proxy that handles TLS. I haven't tested serving it in a subdirectory, so I
recommend using a subdomain; the most straightforward config is to have the
frontend at `/` and the backend (if you want one) at `/api`.

In most production environments it's also strongly advised to configure
OpenID-Connect authentication. See `compose-with-auth.yml` for a toy example.

## Configuration

Configuration happens through environment variables. Example values for all of
them are shown in `compose.yml`, and `compose-with-auth.yml` contains an
example deployment with a toy keycloak openid provider.

### Frontend

Frontend configuration consists mostly of pointing it at a post-processing
backend and an openid provider for authentication. It has the following
variables for settings;

* `ISE_RECORD_API_URL`

    Base URL of the post-processing backend API

    | Default | Example |
    | - | - |
    | unset | `https://record.example.edu` |


* `ISE_RECORD_AUTH`

    Whether to enable authentication. Defaults to `oidc` if `ISE_RECORD_API_URL`
    is set, `disabled` otherwise.

    | Default | Possible values |
    | - | - |
    | with backend: `oidc` <br> frontend-only: `disabled`  | `oidc`, `disabled` |

* `ISE_RECORD_OIDC_PROVIDER_URL`

    URL of the OpenID Connect provider, same as in the backend.

    | Default | Example |
    | - | - |
    | unset | `https://auth.example.edu/realms/ise` |

* `ISE_RECORD_OIDC_CLIENT_ID`

    Client-ID as configured in the OIDC provider

    | Default | Example |
    | - | - |
    | unset | `ise-recorder` |

* `ISE_RECORD_OIDC_MAX_AGE`

    OIDC max_age in seconds. Sessions past `ISE_RECORD_OIDC_MAX_AGE` will be
    considered stale, i.e. ise-recorder will not assume that there is enough time left
    before its expiry to record a full lecture. It will then force the user to reauthenticate
    when a recording is started. Should be set to at least several hours shorter than the OIDC
    max session age.

    | Default | Example |
    | - | - |
    | unlimited | `79200` |

* `ISE_RECORD_OIDC_AUTO_SIGNIN`

    If set to true, the page will attempt auto-signin with the oidc provider on
    page load. This is more convenient for authenticated users but disables anonymous use
    (i.e., no backend, browser storage only)

    | Default | Possible values |
    | - | - |
    | `false` | `true`, `false` |

* `ISE_RECORD_SHOW_VERSION`

    Show a version indicator on the main page

    | Default | Possible values |
    | - | - |
    | `false` | `true`, `false` |

### Backend

The backend configuration splits into broadly three categories: General
operation, reporting, and authentication.

General operation options concern where and how video files are stored and
cross-origin resource sharing. If reporting is configured, the system will send
a report e-mail to the lecturer after post-processing has concluded. For this
to work, the backend needs an SMTP relay in its config. Finally, authentication
is the flip side to the frontend authentication. If the backend is to require
authentication, an OpenID provider and audience must be configured that match
the frontend configuration.

The backend has the following configuration envvars:

* `ISE_RECORD_ROUTE_PREFIX`

    Route prefix where the API endpoints will be mounted. If set,
    the prefix must be included in the frontend's `ISE_RECORD_API_URL`.

    | Default | Example |
    | - | - |
    | unset | `/foo` |

* `ISE_RECORD_DESTDIR`

    Base directory where the uploaded chunks and processed video
    files will be stored

    | Default | Example |
    | - | - |
    | `./data` | `/app/data` |

* `ISE_RECORD_CHUNK_FILE_DIGITS`

    Length of the numerical suffix on uploaded chunks. 4 is
    default and enough for about 14 hours of recording.

    | Default | Example |
    | - | - |
    | `4` | `5` |

* `ISE_RECORD_CORS_ORIGINS`

    If the backend is served on a different domain than the frontend, list the
    frontend's base URL here. By default, all CORS queries are disallowed.

    | Default | Example |
    | - | - |
    | unset | `[ "https://record-ui.example.edu" ]` |

* `ISE_RECORD_AUTH`

    The type of authentication the backend requires. Defaults to `oidc`.
    If set to `oidc`, `ISE_RECORD_OIDC_PROVIDER_URL` and `ISE_RECORD_OIDC_AUDIENCE`
    must also be configured. If set to `disabled`, they must be left unset.

    | Default | Possible values |
    | - | - |
    | `oidc` | `oidc`, `disabled` |

* `ISE_RECORD_OIDC_PROVIDER_URL`

    URL of the OpenID authentication provider. Same as in the frontend.

    | Default | Example |
    | - | - |
    | unset |  `http://keycloak.localhost:8080/realms/ise` |

* `ISE_RECORD_OIDC_AUDIENCE`

    Audience name that the OpenID provider calls ise-recorder

    | Default | Example |
    | - | - |
    | unset | `ise-recorder-api` |

* `ISE_RECORD_OIDC_LEEWAY_SECONDS`

    Allowable clock skew in seconds between frontend and backend,
    used in the expiration check for access tokens

    | Default | Example |
    | - | - |
    | `30` | `15` |

* `ISE_RECORD_OIDC_HTTP_TIMEOUT_SECONDS`

    Timeout in seconds for OpenID discovery and userinfo queries

    | Default | Example |
    | - | - |
    | `5` | `10` |

* `ISE_RECORD_SMTP_SERVER`

    Hostname or IP address of the SMTP relay

    | Default | Example |
    | - | - |
    | unset | `mail.example.edu` |

* `ISE_RECORD_SMTP_PORT`

    SMTP(s) Port to use. Defaults to 465 if `ISE_RECORD_SMTP_USE_TLS` is
    true, 587 if `ISE_RECORD_SMTP_STARTTLS` is true, 25 otherwise.

    | Default | Example |
    | - | - |
    | `465`, `587` or `25`, see description | `25` |

* `ISE_RECORD_SMTP_LOCAL_HOSTNAME`

    Hostname of the backend server, used for HELO/EHLO

    | Default | Example |
    | - | - |
    | unset | `record-api.example.edu` |

* `ISE_RECORD_SMTP_USERNAME`

    username for SMTP login, if required

    | Default | Example |
    | - | - |
    | unset | `user1` |

* `ISE_RECORD_SMTP_PASSWORD`

    password for SMTP login, if required

    | Default | Example |
    | - | - |
    | unset | `hunter2` |

* `ISE_RECORD_SMTP_SENDER`

    Mail address to put in the "From" header

    | Default | Example |
    | - | - |
    | unset | `ise-record@example.edu` |

* `ISE_RECORD_SMTP_STARTTLS`

    Whether to use the STARTTLS command for encryption. If this is
    unset, STARTTLS will be employed opportunistically. If this is set (to
    either true or false), `ISE_RECORD_SMTP_USE_TLS` must be false or unset.

    | Default | Possible values |
    | - | - |
    | unset | `true`, `false` |

* `ISE_RECORD_SMTP_USE_TLS`

    Whether to use implicit TLS for encryption. If this is true,
    `ISE_RECORD_SMTP_STARTTLS` must be false or unset.

    | Default | Possible values |
    | - | - |
    | `false` | `true`, `false` |

* `ISE_RECORD_SMTP_ALLOWED_DOMAINS`

    Domains that the backend will send mail to. Subdomains are
    implicitly whitelisted.

    | Default | Example |
    | - | - |
    | unset (no restriction) | `[ "example.edu", "example.org" ]` |

## Hack it yourself

### Frontend-Only

A frontend-only dev instance can be started with

    cd frontend
    npm ci

    npm run dev

It will then be reachable under http://localhost:3000.

### Frontend/Backend, no authentication

A development environment with an unauthenticated backend requires some
configuration with environment variables. A comprehensive example of this can
be found in the `compose.yml` file next ot this README. Minimally, the
following environment variables must be supplied:

Frontend:

    cd frontend
    npm ci

    export ISE_RECORD_API_URL=http://localhost:8000
    export ISE_RECORD_AUTH=disabled
    npm run dev

Backend:

    cd backend
    python -m venv .venv
    . .venv/bin/activate
    pip install -e . --group dev

    export ISE_RECORD_CORS_ORIGINS='[ "http://localhost:3000" ]'
    export ISE_RECORD_AUTH=disabled
    fastapi dev

### Frontend/backend with authentication

An authenticated dev environment needs an OpenID provider. The easiest way to
spin one up is to use the provided `compose-with-auth.yml` file, which contains
a preconfigured keycloak instance as part of a more complete sample deployment.
The frontend and backend must then be configured to use that keycloak
authentication provider. Minimally:

Keycloak:

    docker compose -f compose-with-auth.yml up keycloak

Frontend:

    cd frontend
    npm ci

    export ISE_RECORD_API_URL=http://localhost:8000
    export ISE_RECORD_OIDC_PROVIDER_URL=http://keycloak.localhost:8080/realms/ise
    export ISE_RECORD_OIDC_CLIENT_ID=ise-recorder
    npm run dev

Backend:

    cd backend
    python -m venv .venv
    . .venv/bin/activate
    pip install -e . --group dev

    export ISE_RECORD_CORS_ORIGINS='[ "http://localhost:3000" ]'
    export ISE_RECORD_OIDC_PROVIDER_URL=http://keycloak.localhost:8080/realms/ise
    export ISE_RECORD_OIDC_AUDIENCE=ise-recorder-api
    fastapi dev
