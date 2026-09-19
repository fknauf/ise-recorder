"""
Token validation: what this service accepts as proof of who the caller is.

What the service then does with that identity -- which directory the caller's recordings
land in, and what the endpoints let them reach -- is in test_user_home.py and
test_server.py. The fixtures and the stand-in provider are in conftest.py and harness.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
import jwt
import pytest

from harness import AUDIENCE, CLIENT_ID, Provider, make_key, upload
from ise_record.auth import discover_oidc_config, REQUIRED_CLAIMS
from ise_record.server import create_app
from ise_record.settings import OidcSettings, Settings



def test_valid_token_is_accepted(auth_client: TestClient, provider: Provider):
    assert upload(auth_client, provider.mint()).status_code == 201


def test_missing_token_is_rejected(auth_client: TestClient):
    response = upload(auth_client, None)
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_garbage_token_is_rejected(auth_client: TestClient):
    assert upload(auth_client, "not-a-jwt").status_code == 401


def test_expired_token_is_rejected(auth_client: TestClient, provider: Provider):
    stale = datetime.now(timezone.utc) - timedelta(hours=1)
    token = provider.mint(iat=stale, exp=stale + timedelta(minutes=5))
    assert upload(auth_client, token).status_code == 401


def test_wrong_issuer_is_rejected(auth_client: TestClient, provider: Provider):
    assert upload(auth_client, provider.mint(iss="https://evil.example.com")).status_code == 401


def test_wrong_audience_is_rejected(auth_client: TestClient, provider: Provider):
    assert upload(auth_client, provider.mint(aud="some-other-app")).status_code == 401


def test_a_token_for_the_client_rather_than_the_api_is_rejected(
    auth_client: TestClient, provider: Provider
):
    # `aud` of the auth_client id is what an OIDC ID token carries, so on a normal deployment
    # this is the audience check refusing an ID token -- no inspection of the token's kind
    # needed, and nothing else in this module has to care.
    assert upload(auth_client, provider.mint(aud=CLIENT_ID)).status_code == 401


@pytest.mark.parametrize("claim", REQUIRED_CLAIMS)
def test_missing_required_claim_is_rejected(
    auth_client: TestClient, provider: Provider, claim: str
):
    # mint() drops a claim whose override is None, so this asks for each required claim in
    # turn. Parametrized over the constant itself: adding a claim to REQUIRED_CLAIMS without
    # a provider that sends it is how this went wrong before.
    assert upload(auth_client, provider.mint(kid="key-1", **{claim: None})).status_code == 401


def test_missing_subject_is_rejected(auth_client: TestClient, provider: Provider):
    assert upload(auth_client, provider.mint(sub=None)).status_code == 401


def test_an_access_token_without_a_scope_claim_is_accepted(
    auth_client: TestClient, provider: Provider
):
    # "scope" was in REQUIRED_CLAIMS once. It is not a claim every provider emits -- Entra
    # ID spells it "scp" -- and a required claim that some conforming provider omits is a
    # deployment that cannot authenticate at all, with a bare 401 to explain it.
    assert upload(auth_client, provider.mint(scope=None)).status_code == 201


def test_an_id_token_is_accepted_when_the_provider_collapses_the_two_identifiers(
    provider: Provider, tmp_path: Path
):
    """
    A DECISION, recorded so the next reader does not take it for an oversight.

    Nothing in this module inspects what kind of token it is, because normally it does not
    have to: the audience settles it, which is what the test above shows. Some providers
    force the resource server's audience to equal the auth_client id -- kanidm does -- and then
    an ID token and an access token are indistinguishable and this accepts both.

    That is judged acceptable because it is not a privilege boundary. Whoever holds an ID
    token for this auth_client is the person who just authenticated, and can obtain an access
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


def test_unsigned_token_is_rejected(auth_client: TestClient, provider: Provider):
    claims: dict[str, Any] = {
        "iss": provider.issuer, "sub": "nobody", "aud": AUDIENCE, "scope": "openid",
        "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    forged = jwt.encode(claims, key="", algorithm="none", headers={"kid": "key-1"})
    assert upload(auth_client, forged).status_code == 401


def test_token_signed_by_an_unknown_key_is_rejected(auth_client: TestClient, provider: Provider):
    stranger, _ = make_key("key-1")
    claims: dict[str, Any] = {
        "iss": provider.issuer, "sub": "nobody", "aud": AUDIENCE, "scope": "openid",
        "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    forged = jwt.encode(claims, stranger, algorithm="RS256", headers={"kid": "key-1"})
    assert upload(auth_client, forged).status_code == 401


def test_unknown_kid_is_rejected(auth_client: TestClient, provider: Provider):
    provider.add_key("key-2")
    token = provider.mint(kid="key-2")
    del provider.keys["key-2"]

    assert upload(auth_client, token).status_code == 401


# --- operational behavior -------------------------------------------------

def test_rotated_signing_key_is_picked_up_without_restart(
    instant_jwks_refresh: None,  # pylint: disable=unused-argument
    auth_client: TestClient,
    provider: Provider,
):
    assert upload(auth_client, provider.mint(), index=0).status_code == 201

    # The provider rotates: a new key appears and the old one is withdrawn.
    provider.add_key("key-2")
    del provider.keys["key-1"]

    assert upload(auth_client, provider.mint(kid="key-2"), index=1).status_code == 201


def test_unreachable_jwks_reports_service_unavailable(auth_client: TestClient, provider: Provider):
    token = provider.mint()
    provider.jwks_available = False

    assert upload(auth_client, token).status_code == 503


def test_jwks_is_cached_between_requests(auth_client: TestClient, provider: Provider):
    for index in range(4):
        assert upload(auth_client, provider.mint(), index=index).status_code == 201

    assert provider.jwks_fetch_count == 1




# --- a deployment with no provider configured ------------------------------

def test_unconfigured_deployment_stays_open(tmp_path: Path):
    with TestClient(create_app(Settings(destdir=tmp_path))) as open_client:
        assert upload(open_client, None).status_code == 201

    assert (tmp_path / "foo" / "stream" / "chunk.0000").is_file()

# --- the signing algorithm comes from the key set --------------------------

@pytest.mark.parametrize("advertised", [
    ["none"],
    ["HS256"],
    [],
    None,
])
def test_metadata_algorithm_list_is_not_consulted(
    auth_client: TestClient, provider: Provider, advertised: Any
):
    # Whatever the discovery document claims, the key set decides. A provider advertising
    # nothing usable for id tokens must not stop valid access tokens being verified.
    provider.signing_algorithms = advertised

    assert upload(auth_client, provider.mint()).status_code == 201


def test_key_without_an_alg_member_still_verifies(auth_client: TestClient, provider: Provider):
    # RFC 7517 makes "alg" optional; PyJWT infers RS256 from kty=RSA.
    del provider.keys["key-1"][1]["alg"]

    assert upload(auth_client, provider.mint()).status_code == 201


def test_key_claiming_an_insecure_algorithm_is_refused(
    auth_client: TestClient, provider: Provider, fresh_auth_settings: Settings
):
    # Prime the cache with the real key, then have the provider serve a symmetric key under
    # the same kid. PyJWK would bind HS256 to it; the denylist must refuse it.
    assert upload(auth_client, provider.mint(), index=0).status_code == 201

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
    with TestClient(create_app(fresh_auth_settings)) as fresh:
        assert upload(fresh, forged).status_code == 401


# --- provider metadata -----------------------------------------------------

# OIDC Discovery 1.0 lists userinfo_endpoint as RECOMMENDED, not REQUIRED, so its absence
# is not an error and must not take the service down with it. What the service then does
# without one is in test_user_home.py.

@pytest.mark.asyncio
async def test_discovery_records_the_userinfo_endpoint(provider: Provider, auth_settings: Settings):
    config = await discover_oidc_config(auth_settings)

    assert config.userinfo_endpoint == f"{provider.issuer}/userinfo"


@pytest.mark.asyncio
async def test_discovery_survives_a_provider_that_advertises_no_userinfo_endpoint(
    provider: Provider, auth_settings: Settings
):
    provider.advertise_userinfo = False

    config = await discover_oidc_config(auth_settings)

    assert config.userinfo_endpoint is None
