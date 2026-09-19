# pylint: disable=line-too-long
# pylint: disable=missing-class-docstring
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=redefined-outer-name
# pylint: disable=too-many-instance-attributes

from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import threading
from typing import Any, Iterator

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
import jwt
import pytest

from ise_record import auth
from ise_record.auth import (
    OidcConfiguration,
    REQUIRED_CLAIMS,
    discover_oidc_config,
    fs_safe_user_name,
    prepare_user_home_dir
)
from ise_record.server import create_app
from ise_record.settings import OidcSettings, Settings

CLIENT_ID = "ise-recorder"
# Distinct from CLIENT_ID on purpose, and that is the normal deployment: an OIDC ID token's
# `aud` is the client id, an access token's names the resource server, so a backend with an
# audience of its own never sees an ID token pass. compose-with-auth.yml configures exactly
# this pair. Only the test that is about a provider collapsing the two sets them equal.
AUDIENCE = "ise-recorder-api"
DEFAULT_SUBJECT = "b472c41f9b227e6596e921541f46dc9d7"


def make_key(kid: str) -> tuple[rsa.RSAPrivateKey, dict[str, Any]]:
    """ Generate an RSA key pair and the JWK describing its public half """
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True) # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType, reportAttributeAccessIssue]
    jwk.update({"kid": kid, "use": "sig", "alg": "RS256"}) # pyright: ignore[reportUnknownMemberType]
    return private_key, jwk # pyright: ignore[reportUnknownVariableType]


class Provider:
    """ A stand-in OpenID provider serving discovery and JWKS documents over HTTP """

    def __init__(self) -> None:
        self.keys: dict[str, tuple[rsa.RSAPrivateKey, dict[str, Any]]] = {}
        self.jwks_available = True
        self.jwks_fetch_count = 0
        # None means the endpoint 404s: a provider that has nothing to say about the caller
        self.userinfo_response: tuple[int, str, bytes] | None = None
        self.userinfo_fetch_count = 0
        self.userinfo_authorization: str | None = None
        # userinfo_endpoint is only RECOMMENDED in OIDC Discovery 1.0, so a conforming
        # provider may leave it out
        self.advertise_userinfo = True
        self.signing_algorithms: list[Any] = ["RS256"]
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def issuer(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_port}"

    def add_key(self, kid: str) -> None:
        self.keys[kid] = make_key(kid)

    def start(self) -> None:
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # pylint: disable=invalid-name
                if self.path.endswith("/.well-known/openid-configuration"):
                    metadata: dict[str, Any] = {
                        "issuer": provider.issuer,
                        "authorization_endpoint": f"{provider.issuer}/authorize",
                        "token_endpoint": f"{provider.issuer}/token",
                        "jwks_uri": f"{provider.issuer}/jwks",
                        "id_token_signing_alg_values_supported": provider.signing_algorithms,
                    }
                    if provider.advertise_userinfo:
                        metadata["userinfo_endpoint"] = f"{provider.issuer}/userinfo"
                    return provider.respond(self, metadata)

                if self.path.endswith("/jwks"):
                    provider.jwks_fetch_count += 1
                    if not provider.jwks_available:
                        self.send_response(503)
                        self.end_headers()
                        return None
                    return provider.respond(self, {
                        "keys": [jwk for _, jwk in provider.keys.values()]
                    })

                if self.path.endswith("/userinfo"):
                    provider.userinfo_fetch_count += 1
                    provider.userinfo_authorization = self.headers.get("Authorization")
                    if provider.userinfo_response is None:
                        self.send_response(404)
                        self.end_headers()
                        return None
                    return provider.respond_raw(self, *provider.userinfo_response)

                self.send_response(404)
                self.end_headers()
                return None

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        # serve_forever polls for the shutdown flag, and defaults to doing so twice a
        # second -- which every test would then wait out in teardown
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self._thread.start()

    @staticmethod
    def respond(handler: BaseHTTPRequestHandler, body: dict[str, Any]) -> None:
        Provider.respond_raw(handler, 200, "application/json", json.dumps(body).encode())

    @staticmethod
    def respond_raw(
        handler: BaseHTTPRequestHandler, status: int, content_type: str, body: bytes
    ) -> None:
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def serve_userinfo(self, **claims: Any) -> None:
        """ Answer UserInfo with these claims, the way a provider holding them would """
        self.userinfo_response = (200, "application/json", json.dumps(claims).encode())

    def serve_userinfo_raw(self, status: int, content_type: str, body: bytes) -> None:
        """ Answer UserInfo with a body of our choosing, for the shapes providers get wrong """
        self.userinfo_response = (status, content_type, body)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def mint(self, kid: str = "key-1", **overrides: Any) -> str:
        """ Issue a signed access token, with claim overrides applied last """
        now = datetime.now(timezone.utc)
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "sub": DEFAULT_SUBJECT,
            "aud": AUDIENCE,
            "azp": CLIENT_ID,
            "client_id": CLIENT_ID,
            "scope": "openid profile email",
            "preferred_username": "lecturer",
            "iat": now,
            "exp": now + timedelta(minutes=5),
        }
        claims.update(overrides)
        claims = {name: value for name, value in claims.items() if value is not None}

        private_key, _ = self.keys[kid]
        return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": kid})


@pytest.fixture
def provider() -> Iterator[Provider]:
    instance = Provider()
    instance.add_key("key-1")
    instance.start()
    yield instance
    instance.stop()


@pytest.fixture
def settings(provider: Provider, tmp_path: Path) -> Settings:
    return Settings(
        destdir=tmp_path,
        oidc=OidcSettings(
            provider_url=provider.issuer,
            audience=AUDIENCE
        )
    )


@pytest.fixture
def fresh_settings(provider: Provider, tmp_path: Path) -> Settings:
    return Settings(
        destdir=tmp_path / "fresh",
        oidc=OidcSettings(
            provider_url=provider.issuer,
            audience=AUDIENCE
        )
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def oidc(provider: Provider) -> OidcConfiguration:
    """ What discovery would have produced, for the tests that bypass the app. """
    return OidcConfiguration(
        issuer=provider.issuer,
        userinfo_endpoint=f"{provider.issuer}/userinfo",
        http_timeout=5.0,
        jwk_client=jwt.PyJWKClient(f"{provider.issuer}/jwks"),
    )


@pytest.fixture
def instant_jwks_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Let an unknown kid refetch the key set immediately, instead of after the cooldown.

    Rotation takes milliseconds here and half a minute in production, so without this a
    rotation test would only be measuring PyJWKClient's rate limit. The cooldown is read
    when the client is constructed, which is when the app starts up -- request this
    fixture ahead of `client` so it is patched by then.
    """
    monkeypatch.setattr(auth, "JWKS_REFRESH_COOLDOWN_SECONDS", 0.0)


def upload(client: TestClient, token: str | None, index: int = 0):
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return client.post(
        "/api/chunks",
        headers=headers,
        data={"recording": "foo", "track": "stream", "index": str(index)},
        files={"chunk": b"payload"},
    )

def upload_chunk_path(base_dir: Path, user_segment: str, index: int = 0) -> Path:
    return base_dir / user_segment / "foo" / "stream" / f"chunk.{index:04d}"

def test_valid_token_is_accepted(client: TestClient, provider: Provider):
    assert upload(client, provider.mint()).status_code == 201


def test_chunk_lands_in_a_per_user_directory(client: TestClient, provider: Provider, tmp_path: Path):
    assert upload(client, provider.mint()).status_code == 201

    chunks = list(tmp_path.rglob("chunk.*"))
    assert len(chunks) == 1
    # tmp_path / user / recording / track / chunk.XXXX
    assert len(chunks[0].relative_to(tmp_path).parts) == 4


def test_different_subjects_get_different_directories(
    client: TestClient, provider: Provider, tmp_path: Path
):
    assert upload(client, provider.mint(sub="user-a"), index=0).status_code == 201
    assert upload(client, provider.mint(sub="user-b"), index=1).status_code == 201

    assert len({path.relative_to(tmp_path).parts[0] for path in tmp_path.rglob("chunk.*")}) == 2


def test_missing_token_is_rejected(client: TestClient):
    response = upload(client, None)
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_garbage_token_is_rejected(client: TestClient):
    assert upload(client, "not-a-jwt").status_code == 401


def test_expired_token_is_rejected(client: TestClient, provider: Provider):
    stale = datetime.now(timezone.utc) - timedelta(hours=1)
    token = provider.mint(iat=stale, exp=stale + timedelta(minutes=5))
    assert upload(client, token).status_code == 401


def test_wrong_issuer_is_rejected(client: TestClient, provider: Provider):
    assert upload(client, provider.mint(iss="https://evil.example.com")).status_code == 401


def test_wrong_audience_is_rejected(client: TestClient, provider: Provider):
    assert upload(client, provider.mint(aud="some-other-app")).status_code == 401


def test_a_token_for_the_client_rather_than_the_api_is_rejected(
    client: TestClient, provider: Provider
):
    # `aud` of the client id is what an OIDC ID token carries, so on a normal deployment
    # this is the audience check refusing an ID token -- no inspection of the token's kind
    # needed, and nothing else in this module has to care.
    assert upload(client, provider.mint(aud=CLIENT_ID)).status_code == 401


@pytest.mark.parametrize("claim", REQUIRED_CLAIMS)
def test_missing_required_claim_is_rejected(
    client: TestClient, provider: Provider, claim: str
):
    # mint() drops a claim whose override is None, so this asks for each required claim in
    # turn. Parametrized over the constant itself: adding a claim to REQUIRED_CLAIMS without
    # a provider that sends it is how this went wrong before.
    assert upload(client, provider.mint(kid="key-1", **{claim: None})).status_code == 401


def test_missing_subject_is_rejected(client: TestClient, provider: Provider):
    assert upload(client, provider.mint(sub=None)).status_code == 401


def test_an_access_token_without_a_scope_claim_is_accepted(
    client: TestClient, provider: Provider
):
    # "scope" was in REQUIRED_CLAIMS once. It is not a claim every provider emits -- Entra
    # ID spells it "scp" -- and a required claim that some conforming provider omits is a
    # deployment that cannot authenticate at all, with a bare 401 to explain it.
    assert upload(client, provider.mint(scope=None)).status_code == 201


def test_an_id_token_is_accepted_when_the_provider_collapses_the_two_identifiers(
    provider: Provider, tmp_path: Path
):
    """
    A DECISION, recorded so the next reader does not take it for an oversight.

    Nothing in this module inspects what kind of token it is, because normally it does not
    have to: the audience settles it, which is what the test above shows. Some providers
    force the resource server's audience to equal the client id -- kanidm does -- and then
    an ID token and an access token are indistinguishable and this accepts both.

    That is judged acceptable because it is not a privilege boundary. Whoever holds an ID
    token for this client is the person who just authenticated, and can obtain an access
    token for the same identity whenever they like; accepting one guards against a frontend
    bug, not against an attacker.

    RFC 9068's `typ: at+jwt` header is the standard fix and kanidm already sets it, but
    Keycloak sends `typ: JWT` on its access tokens, so requiring it today would reject a
    supported provider. Revisit when adoption is wider; the claim shapes, measured on both
    providers, are in this file's git history.
    """
    collapsed = Settings(
        destdir=tmp_path,
        oidc=OidcSettings(provider_url=provider.issuer, audience=CLIENT_ID)
    )

    id_token_shaped = provider.mint(
        aud=CLIENT_ID,
        scope=None,
        at_hash="PQhwSWwbKnhNqMPtUXQAhg",
        nonce="nonce-abcdef0123456789"
    )

    with TestClient(create_app(collapsed)) as collapsed_client:
        assert upload(collapsed_client, id_token_shaped).status_code == 201


def test_unsigned_token_is_rejected(client: TestClient, provider: Provider):
    claims: dict[str, Any] = {
        "iss": provider.issuer, "sub": "nobody", "aud": AUDIENCE, "scope": "openid",
        "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    forged = jwt.encode(claims, key="", algorithm="none", headers={"kid": "key-1"})
    assert upload(client, forged).status_code == 401


def test_token_signed_by_an_unknown_key_is_rejected(client: TestClient, provider: Provider):
    stranger, _ = make_key("key-1")
    claims: dict[str, Any] = {
        "iss": provider.issuer, "sub": "nobody", "aud": AUDIENCE, "scope": "openid",
        "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    forged = jwt.encode(claims, stranger, algorithm="RS256", headers={"kid": "key-1"})
    assert upload(client, forged).status_code == 401


def test_unknown_kid_is_rejected(client: TestClient, provider: Provider):
    provider.add_key("key-2")
    token = provider.mint(kid="key-2")
    del provider.keys["key-2"]

    assert upload(client, token).status_code == 401


# --- operational behavior -------------------------------------------------

def test_rotated_signing_key_is_picked_up_without_restart(
    instant_jwks_refresh: None,  # pylint: disable=unused-argument
    client: TestClient,
    provider: Provider,
):
    assert upload(client, provider.mint(), index=0).status_code == 201

    # The provider rotates: a new key appears and the old one is withdrawn.
    provider.add_key("key-2")
    del provider.keys["key-1"]

    assert upload(client, provider.mint(kid="key-2"), index=1).status_code == 201


def test_unreachable_jwks_reports_service_unavailable(client: TestClient, provider: Provider):
    token = provider.mint()
    provider.jwks_available = False

    assert upload(client, token).status_code == 503


def test_jwks_is_cached_between_requests(client: TestClient, provider: Provider):
    for index in range(4):
        assert upload(client, provider.mint(), index=index).status_code == 201

    assert provider.jwks_fetch_count == 1


def test_unconfigured_deployment_stays_open(tmp_path: Path):
    with TestClient(create_app(Settings(destdir=tmp_path))) as client:
        assert upload(client, None).status_code == 201

    assert (tmp_path / "foo" / "stream" / "chunk.0000").is_file()


# --- directory naming ------------------------------------------------------

def digest_of(subject: str) -> str:
    """ The suffix auth.py derives from a subject, which is what keeps users apart. """
    return hashlib.sha3_256(subject.encode("utf-8")).hexdigest()


SUBJECT_DIGEST = digest_of("abc")


# NAME_MAX on ext4. auth.py keeps its own, much smaller cap on the username part; this is
# the bound the filesystem imposes on whatever comes out of it.
NAME_MAX_BYTES = 255

def claims_for(username: Any) -> dict[str, Any]:
    return {"sub": "abc", "preferred_username": username}

async def home_dir_for(tmp_path: Path, username: Any, oidc: OidcConfiguration) -> Path:
    """
    The directory name derived for a username, with the subject held fixed.

    A username that is not a string is absent as far as auth.py is concerned, so these
    calls reach the UserInfo endpoint. The provider fixture leaves it unconfigured, which
    is a 404 -- the same digest fallback the old synchronous helper took directly.
    """
    return await prepare_user_home_dir(tmp_path,  claims_for(username), {}, "access-token", oidc)


@pytest.mark.parametrize("username,expected_prefix", [
    ("lecturer", "lecturer-"),
    ("m.mustermann", "m.mustermann-"),
    ("user@example.com", "user@example.com-"),        # the shape most IdPs actually hand out
    ("mit Leerzeichen", "mit_Leerzeichen-"),          # spaces become separators, not gaps
    ("  padded  ", "padded-"),                        # stripped before the interior collapse
    ("zwei  Leerzeichen", "zwei_Leerzeichen-"),       # and a run of them collapses to one
    ("\u00e4 \u00f6 \u00fc", "\u00e4_\u00f6_\u00fc-"),
    ("\u5f20\u4e09", "\u5f20\u4e09-"),                        # CJK is carried through intact
    ("\u0939\u093f\u0928\u094d\u0926\u0940", "\u0939\u093f\u0928\u094d\u0926\u0940-"),      # and so are combining marks, which \\w dropped
    ("a/b", "ab-"),                                   # the separator goes, the name survives
    ("CON", "CON_-"),                                 # reserved on Windows, renamed by pathvalidate
])
@pytest.mark.asyncio
async def test_readable_username_becomes_the_directory_alias(
    username: str, expected_prefix: str, oidc: OidcConfiguration, tmp_path: Path
):
    home = await home_dir_for(tmp_path, username, oidc)
    expected_alias = tmp_path / f"{expected_prefix}{home.name[:12]}"

    assert home.name == SUBJECT_DIGEST
    assert home.parent == tmp_path
    assert home.exists()

    assert expected_alias.exists()
    assert expected_alias.readlink() == Path(home.name)


@pytest.mark.parametrize("username", [
    None, 42,                          # not a string at all
    "", "   ", "\u3000",                # nothing left after stripping
    "...", "---", "..", "-.-.-",       # nothing usable left at all
    ".hidden", ".NET", "-rf", "-weird",  # a readable name, but not one that may lead
])
@pytest.mark.asyncio
async def test_unusable_username_yields_no_alias_link(
    username: Any, oidc: OidcConfiguration, tmp_path: Path
):
    # the last four are a deliberate trade: rather than strip the leading character and keep
    # a readable prefix, the whole prefix is dropped. Nothing downstream validates this name
    # -- unlike a recording name, there is no pattern behind it -- so the one check at the
    # end of user_home_dir is the entire guarantee, and it is worth keeping obvious
    home = await home_dir_for(tmp_path, username, oidc)

    assert home.name == SUBJECT_DIGEST
    assert set(f.name for f in home.parent.iterdir()) == { SUBJECT_DIGEST }


@pytest.mark.parametrize("username,expected", [
    ("Anna\u00a0Schmidt", "Anna_Schmidt-"),    # non-breaking space, as a web form sends it
    ("\u3000\u674e\u3000", "\u674e-"),                 # ideographic space, as a CJK IME sends it
    ("a\u2003b", "a_b-"),                      # em space
    ("a\tb", "a_b-"),
    ("a\nb", "a_b-"),
])
@pytest.mark.asyncio
async def test_unicode_whitespace_is_a_separator_like_any_other(
    username: str, expected: str, oidc: OidcConfiguration, tmp_path: Path
):
    # \s on a str pattern is Unicode-aware, which is what keeps a pasted U+3000 out of a
    # directory name -- pathvalidate would have left it there
    home = await home_dir_for(tmp_path, username, oidc)
    expected_alias = tmp_path / f"{expected}{home.name[:12]}"

    assert home.name == SUBJECT_DIGEST
    assert home.parent == tmp_path
    assert home.exists()

    assert expected_alias.exists()
    assert expected_alias.readlink() == Path(home.name)


@pytest.mark.asyncio
async def test_the_directory_name_does_not_depend_on_the_composition_of_the_username(
    oidc: OidcConfiguration, tmp_path: Path
):
    # spelled with escapes: the two forms are indistinguishable on screen, so an editor
    # normalizing this file would turn one half of this test into a copy of the other
    decomposed = "U\u0308bung"
    composed = "\u00dcbung"

    assert decomposed != composed
    assert await home_dir_for(tmp_path, decomposed, oidc) == await home_dir_for(tmp_path, composed, oidc)

    assert set(d.name for d in tmp_path.iterdir()) == { SUBJECT_DIGEST, f"\u00dcbung-{SUBJECT_DIGEST[:12]}"}

@pytest.mark.parametrize("username", [
    "lecturer", "a/b", "\\\\server\\share",
    "a" * 300, "\u673a" * 200, "\U00020000" * 100, "\u00e4 \u00f6 \u00fc", "nul\x00byte",
    "%2e%2e%2f", "\u3000\u674e\u3000",
    "\u0308mark"
])
@pytest.mark.asyncio
async def test_alias_name_is_always_a_safe_single_path_segment(
    username: Any, oidc: OidcConfiguration
):
    name = await fs_safe_user_name(claims_for(username), "access-token", oidc)

    assert name, "an empty directory name would put chunks in the destination root"
    assert not name.startswith((".", "-")), "hidden on unix, an option to anything argv-shaped"
    assert "/" not in name and "\x00" not in name
    assert not any(character.isspace() for character in name)
    assert (Path("/data") / name).resolve().parent == Path("/data")

    # the bound that matters is bytes, not characters: NAME_MAX is 255 bytes on ext4 and
    # the 48-character slice can be four bytes a character before the digest is appended
    assert len(name.encode("utf-8")) <= NAME_MAX_BYTES

@pytest.mark.parametrize("username", [
    "../../etc/passwd", "..", "", "-rf", "..;/", "- - - 81457m4573r 9001 - - -", 42, None
])
@pytest.mark.asyncio
async def test_no_alias_for_broken_usernames(username: Any, oidc: OidcConfiguration):
    name = await fs_safe_user_name(claims_for(username), "access-token", oidc)
    assert name is None


@pytest.mark.asyncio
async def test_directory_name_is_stable_for_a_subject(oidc: OidcConfiguration, tmp_path: Path):
    claims = {"sub": "abc", "preferred_username": "lecturer"}

    # separate caches, so this is the derivation agreeing with itself rather than the
    # second call reading back what the first one memoised
    assert (await prepare_user_home_dir(tmp_path, claims, {}, "access-token", oidc)
            == await prepare_user_home_dir(tmp_path, claims, {}, "access-token", oidc))


@pytest.mark.asyncio
async def test_username_collisions_are_separated_by_the_digest(oidc: OidcConfiguration, tmp_path: Path):
    # pathvalidate maps several usernames onto one string -- "DOMAIN\\user" and "DOMAINuser"
    # both come out as the latter -- so the digest is the only thing keeping them apart
    first = await prepare_user_home_dir(
        tmp_path, {"sub": "user-a", "preferred_username": "same"}, {}, "access-token", oidc)
    second = await prepare_user_home_dir(
        tmp_path, {"sub": "user-b", "preferred_username": "same"}, {}, "access-token", oidc)

    assert first != second


# --- the UserInfo fallback -------------------------------------------------

# Kanidm does not put profile claims in an access token even when the profile scope was
# granted, which the spec permits -- identity claims are only promised in the id token and
# at the UserInfo endpoint. So a token without preferred_username is not an error, and
# these cover what auth.py makes of one.

DEFAULT_SUBJECT_DIGEST = digest_of(DEFAULT_SUBJECT)

def test_userinfo_is_not_consulted_when_the_token_carries_the_username(
    client: TestClient, provider: Provider
):
    assert upload(client, provider.mint()).status_code == 201

    # the round trip is per user and on the upload path, so not making it is the point
    assert provider.userinfo_fetch_count == 0


def test_username_comes_from_userinfo_when_the_token_omits_it(
    client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")

    assert upload(client, provider.mint(preferred_username=None)).status_code == 201

    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).exists()
    assert upload_chunk_path(tmp_path, f"lecturer-{DEFAULT_SUBJECT_DIGEST[:12]}").exists()
    assert provider.userinfo_fetch_count == 1


def test_userinfo_is_asked_with_the_callers_access_token(
    client: TestClient, provider: Provider
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")
    token = provider.mint(preferred_username=None)

    assert upload(client, token).status_code == 201

    # the access token is the credential for UserInfo too; nothing else would authorize us
    assert provider.userinfo_authorization == f"Bearer {token}"


def test_userinfo_about_a_different_subject_is_discarded(
    client: TestClient, provider: Provider, tmp_path: Path
):
    # OIDC Core 5.3.2 requires this check: an answer about somebody else would otherwise
    # put this caller's recordings in a directory named after them
    provider.serve_userinfo(sub="somebody-else", preferred_username="mallory")

    assert upload(client, provider.mint(preferred_username=None)).status_code == 201

    assert set(d.name for d in tmp_path.iterdir()) == { DEFAULT_SUBJECT_DIGEST }


@pytest.mark.parametrize("response", [
    (502, "text/html", b"<html><body>502 Bad Gateway</body></html>"),  # a proxy, not the OP
    (403, "application/json", b'{"error":"insufficient_scope"}'),      # profile not granted
    (200, "application/jwt", b"eyJhbGciOiJSUzI1NiJ9.e30.sig"),         # signed UserInfo
    (200, "application/json", b""),                                    # nothing at all
    (200, "application/json", b'["not", "an", "object"]'),             # json, wrong shape
    (200, "application/json", b'{"preferred_username":"lecturer"}'),   # no sub to check
])
def test_unusable_userinfo_falls_back_to_the_digest(
    client: TestClient, provider: Provider, tmp_path: Path, response: tuple[int, str, bytes]
):
    provider.serve_userinfo_raw(*response)

    # a cosmetic directory name is not worth failing an upload over
    assert upload(client, provider.mint(preferred_username=None)).status_code == 201

    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).exists()

def test_userinfo_with_a_non_string_username_falls_back_to_the_digest(
    client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username=42)

    assert upload(client, provider.mint(preferred_username=None)).status_code == 201

    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).exists()
    assert set(d.name for d in tmp_path.iterdir()) == { DEFAULT_SUBJECT_DIGEST }

def test_unreachable_userinfo_does_not_fail_the_upload(
    client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub="offline-user", preferred_username="lecturer")
    # minted while the provider is up, and verified afterwards from the cached key set
    token = provider.mint(sub="offline-user", preferred_username=None)
    assert upload(client, provider.mint(), index=0).status_code == 201
    provider.stop()

    assert upload(client, token, index=1).status_code == 201

    assert (tmp_path / digest_of("offline-user") / "foo" / "stream" / "chunk.0001").is_file()


def test_username_from_userinfo_is_sanitized_like_one_from_the_token(
    client: TestClient, provider: Provider, tmp_path: Path
):
    # UserInfo is a second way into user_home_dir, and must not be a way around it
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="../../etc/passwd")

    assert upload(client, provider.mint(preferred_username=None)).status_code == 201

    assert set(d.name for d in tmp_path.iterdir()) == { DEFAULT_SUBJECT_DIGEST }


def test_userinfo_is_consulted_once_per_subject(
    client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")
    token = provider.mint(preferred_username=None)

    for index in range(3):
        assert upload(client, token, index=index).status_code == 201

    assert provider.userinfo_fetch_count == 1
    assert set(d.name for d in tmp_path.iterdir()) == { DEFAULT_SUBJECT_DIGEST, f"lecturer-{DEFAULT_SUBJECT_DIGEST[:12]}" }


def test_a_recovering_provider_does_not_move_a_directory_already_in_use(
    client: TestClient, provider: Provider, tmp_path: Path
):
    # UserInfo unavailable for the first chunk, so this lecture starts under the digest
    token = provider.mint(preferred_username=None)
    assert upload(client, token, index=0).status_code == 201
    assert set(d.name for d in tmp_path.iterdir()) == { DEFAULT_SUBJECT_DIGEST }

    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")

    # the rest of the lecture has to keep landing beside the first chunk, or the recording
    # is split across two directories and the postprocessing job only ever sees one
    assert upload(client, token, index=1).status_code == 201

    assert set(d.name for d in tmp_path.iterdir()) == { DEFAULT_SUBJECT_DIGEST }
    assert provider.userinfo_fetch_count == 1


# --- a provider that has no UserInfo endpoint ------------------------------

# OIDC Discovery 1.0 lists userinfo_endpoint as RECOMMENDED, not REQUIRED, so its absence
# is not an error and must not take the service down with it.

@pytest.mark.asyncio
async def test_discovery_records_the_userinfo_endpoint(provider: Provider, settings: Settings):
    config = await discover_oidc_config(settings)

    assert config.userinfo_endpoint == f"{provider.issuer}/userinfo"


@pytest.mark.asyncio
async def test_discovery_survives_a_provider_that_advertises_no_userinfo_endpoint(
    provider: Provider, settings: Settings
):
    provider.advertise_userinfo = False

    config = await discover_oidc_config(settings)

    assert config.userinfo_endpoint is None


def test_tokens_are_still_accepted_without_a_userinfo_endpoint(
    provider: Provider, settings: Settings, tmp_path: Path
):
    provider.advertise_userinfo = False

    with TestClient(create_app(settings)) as client:
        assert upload(client, provider.mint()).status_code == 201

    assert set(d.name for d in tmp_path.iterdir()) == { DEFAULT_SUBJECT_DIGEST, f"lecturer-{DEFAULT_SUBJECT_DIGEST[:12]}" }


def test_no_userinfo_endpoint_falls_back_to_the_digest_without_asking(
    provider: Provider, settings: Settings, tmp_path: Path
):
    provider.advertise_userinfo = False
    # served, but never advertised: if the endpoint were guessed at rather than taken from
    # the discovery document, this name would show up in the directory and give it away
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")

    with TestClient(create_app(settings)) as client:
        assert upload(client, provider.mint(preferred_username=None)).status_code == 201

    assert set(d.name for d in tmp_path.iterdir()) == { DEFAULT_SUBJECT_DIGEST }
    assert provider.userinfo_fetch_count == 0


# --- the signing algorithm comes from the key set --------------------------

@pytest.mark.parametrize("advertised", [
    ["none"],
    ["HS256"],
    [],
    None,
])
def test_metadata_algorithm_list_is_not_consulted(
    client: TestClient, provider: Provider, advertised: Any
):
    # Whatever the discovery document claims, the key set decides. A provider advertising
    # nothing usable for id tokens must not stop valid access tokens being verified.
    provider.signing_algorithms = advertised

    assert upload(client, provider.mint()).status_code == 201


def test_key_without_an_alg_member_still_verifies(client: TestClient, provider: Provider):
    # RFC 7517 makes "alg" optional; PyJWT infers RS256 from kty=RSA.
    del provider.keys["key-1"][1]["alg"]

    assert upload(client, provider.mint()).status_code == 201


def test_key_claiming_an_insecure_algorithm_is_refused(
    client: TestClient, provider: Provider, fresh_settings: Settings
):
    # Prime the cache with the real key, then have the provider serve a symmetric key under
    # the same kid. PyJWK would bind HS256 to it; the denylist must refuse it.
    assert upload(client, provider.mint(), index=0).status_code == 201

    # The served key is the one the token below is signed with, so the only thing standing
    # between the forgery and a 201 is the denylist. A mismatched key would make this test
    # pass on a plain signature failure and say nothing about the denylist at all. 32 bytes,
    # because PyJWT warns about shorter HMAC keys and we do not want the warning to be the
    # reason this is refused either.
    provider.keys["key-1"][1].clear()
    provider.keys["key-1"][1].update(
        {
            "kty": "oct",
            "alg": "HS256",
            "k": "bEM2SVVab2FrdGVwNnFQY2JKTE5oUTFqaU9WbEFxS1k",
            "kid": "key-1",
            "use": "sig"
        }
    )
    forged = jwt.encode(
        {
            "iss": provider.issuer, "sub": "nobody", "aud": AUDIENCE, "scope": "openid",
            "iat": datetime.now(timezone.utc),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        "lC6IUZoaktep6qPcbJLNhQ1jiOVlAqKY", algorithm="HS256", headers={"kid": "key-1"},
    )

    # A fresh app, so the poisoned key set is fetched rather than read from the cache.
    with TestClient(create_app(fresh_settings)) as fresh:
        assert upload(fresh, forged).status_code == 401
