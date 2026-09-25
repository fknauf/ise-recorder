"""
The OpenID client on its own: provider discovery, what it accepts as proof of who the caller
is, and the UserInfo lookup that supplies a name when the token does not carry one.

How the app maps these outcomes to responses, and caches them per subject, is in
glue/test_auth.py. The stand-in provider is in harness.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from datetime import datetime, timedelta, UTC
from typing import Any

import jwt
import pytest

from ise_record.core.auth import OidcClient, ProviderUnreachable, REQUIRED_CLAIMS, Unauthenticated

from ..harness import AUDIENCE, CLIENT_ID, DEFAULT_SUBJECT, make_key, Provider
from .conftest import discover

# --- what counts as a valid token ------------------------------------------


def test_valid_token_is_accepted(oidc: OidcClient, provider: Provider):
    claims = oidc.validate_access_token(provider.mint())

    assert claims["sub"] == DEFAULT_SUBJECT
    assert claims["preferred_username"] == "lecturer"


def test_garbage_token_is_rejected(oidc: OidcClient):
    with pytest.raises(Unauthenticated):
        oidc.validate_access_token("not-a-jwt")


def test_expired_token_is_rejected(oidc: OidcClient, provider: Provider):
    stale = datetime.now(UTC) - timedelta(hours=1)
    token = provider.mint(iat=stale, exp=stale + timedelta(minutes=5))

    with pytest.raises(Unauthenticated):
        oidc.validate_access_token(token)


def test_wrong_issuer_is_rejected(oidc: OidcClient, provider: Provider):
    with pytest.raises(Unauthenticated):
        oidc.validate_access_token(provider.mint(iss="https://evil.example.com"))


def test_wrong_audience_is_rejected(oidc: OidcClient, provider: Provider):
    with pytest.raises(Unauthenticated):
        oidc.validate_access_token(provider.mint(aud="some-other-app"))


def test_a_token_for_the_client_rather_than_the_api_is_rejected(
    oidc: OidcClient, provider: Provider
):
    # `aud` of the client id is what an OIDC ID token carries, so on a normal deployment
    # this is the audience check refusing an ID token -- no inspection of the token's kind
    # needed, and nothing else in this module has to care.
    with pytest.raises(Unauthenticated):
        oidc.validate_access_token(provider.mint(aud=CLIENT_ID))


@pytest.mark.parametrize("claim", REQUIRED_CLAIMS)
def test_missing_required_claim_is_rejected(oidc: OidcClient, provider: Provider, claim: str):
    # mint() drops a claim whose override is None, so this asks for each required claim in
    # turn. Parametrized over the constant itself: adding a claim to REQUIRED_CLAIMS without
    # a provider that sends it is how this went wrong before.
    with pytest.raises(Unauthenticated):
        oidc.validate_access_token(provider.mint(**{claim: None})) # type: ignore


def test_an_access_token_without_a_scope_claim_is_accepted(oidc: OidcClient, provider: Provider):
    # "scope" was in REQUIRED_CLAIMS once. It is not a claim every provider emits -- Entra
    # ID spells it "scp" -- and a required claim that some conforming provider omits is a
    # deployment that cannot authenticate at all, with a bare 401 to explain it.
    assert "scope" not in oidc.validate_access_token(provider.mint(scope=None))


@pytest.mark.asyncio
async def test_an_id_token_is_accepted_when_the_provider_collapses_the_two_identifiers(
    provider: Provider,
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
    collapsed = await discover(provider, audience=CLIENT_ID)

    id_token_shaped = provider.mint(
        aud=CLIENT_ID, scope=None, at_hash="PQhwSWwbKnhNqMPtUXQAhg", nonce="nonce-abcdef0123456789"
    )

    assert collapsed.validate_access_token(id_token_shaped)["sub"] == DEFAULT_SUBJECT


def forge(provider: Provider, key: Any, algorithm: str) -> str:
    claims: dict[str, Any] = {
        "iss": provider.issuer,
        "sub": "nobody",
        "aud": AUDIENCE,
        "scope": "openid",
        "iat": datetime.now(UTC),
        "exp": datetime.now(UTC) + timedelta(minutes=5),
    }
    return jwt.encode(claims, key, algorithm=algorithm, headers={"kid": "key-1"})


def test_unsigned_token_is_rejected(oidc: OidcClient, provider: Provider):
    with pytest.raises(Unauthenticated):
        oidc.validate_access_token(forge(provider, "", "none"))


def test_token_signed_by_an_unknown_key_is_rejected(oidc: OidcClient, provider: Provider):
    stranger, _ = make_key("key-1")

    with pytest.raises(Unauthenticated):
        oidc.validate_access_token(forge(provider, stranger, "RS256"))


def test_unknown_kid_is_rejected(oidc: OidcClient, provider: Provider):
    provider.add_key("key-2")
    token = provider.mint(kid="key-2")
    del provider.keys["key-2"]

    with pytest.raises(Unauthenticated):
        oidc.validate_access_token(token)


# --- operational behavior -------------------------------------------------


def test_rotated_signing_key_is_picked_up_without_restart(
    instant_jwks_refresh: None,  # pylint: disable=unused-argument
    oidc: OidcClient,
    provider: Provider,
):
    oidc.validate_access_token(provider.mint())

    # The provider rotates: a new key appears and the old one is withdrawn.
    provider.add_key("key-2")
    del provider.keys["key-1"]

    oidc.validate_access_token(provider.mint(kid="key-2"))


def test_unreachable_jwks_is_reported_as_such(oidc: OidcClient, provider: Provider):
    # distinct from Unauthenticated: the caller's token may be fine, and telling them it is
    # not would send them to log in again for nothing
    token = provider.mint()
    provider.jwks_available = False

    with pytest.raises(ProviderUnreachable):
        oidc.validate_access_token(token)


def test_jwks_is_cached_between_validations(oidc: OidcClient, provider: Provider):
    for _ in range(4):
        oidc.validate_access_token(provider.mint())

    assert provider.jwks_fetch_count == 1


# --- the signing algorithm comes from the key set --------------------------


@pytest.mark.parametrize(
    "advertised",
    [
        ["none"],
        ["HS256"],
        [],
        None,
    ],
)
@pytest.mark.asyncio
async def test_metadata_algorithm_list_is_not_consulted(provider: Provider, advertised: Any):
    # Whatever the discovery document claims, the key set decides. A provider advertising
    # nothing usable for id tokens must not stop valid access tokens being verified.
    provider.signing_algorithms = advertised
    oidc = await discover(provider)

    oidc.validate_access_token(provider.mint())


def test_key_without_an_alg_member_still_verifies(oidc: OidcClient, provider: Provider):
    # RFC 7517 makes "alg" optional; PyJWT infers RS256 from kty=RSA.
    del provider.keys["key-1"][1]["alg"]

    oidc.validate_access_token(provider.mint())


@pytest.mark.asyncio
async def test_key_claiming_an_insecure_algorithm_is_refused(oidc: OidcClient, provider: Provider):
    # Prime the cache with the real key, then have the provider serve a symmetric key under
    # the same kid. PyJWK would bind HS256 to it; the denylist must refuse it.
    oidc.validate_access_token(provider.mint())

    # The served key is the one the token below is signed with, so the only thing standing
    # between the forgery and acceptance is the denylist. A mismatched key would make this
    # test pass on a plain signature failure and say nothing about the denylist at all. 32
    # bytes, because PyJWT warns about shorter HMAC keys and we do not want the warning to be
    # the reason this is refused either.
    provider.keys["key-1"][1].clear()
    provider.keys["key-1"][1].update(
        {
            "kty": "oct",
            "alg": "HS256",
            "k": "bEM2SVVab2FrdGVwNnFQY2JKTE5oUTFqaU9WbEFxS1k",
            "kid": "key-1",
            "use": "sig",
        }
    )
    forged = forge(provider, "lC6IUZoaktep6qPcbJLNhQ1jiOVlAqKY", "HS256")

    # A fresh client, so the poisoned key set is fetched rather than read from the cache.
    fresh = await discover(provider)

    with pytest.raises(Unauthenticated):
        fresh.validate_access_token(forged)


# --- provider metadata -----------------------------------------------------

# OIDC Discovery 1.0 lists userinfo_endpoint as RECOMMENDED, not REQUIRED, so its absence
# is not an error and must not take the service down with it.


def test_discovery_records_the_userinfo_endpoint(oidc: OidcClient, provider: Provider):
    assert oidc.userinfo_endpoint == f"{provider.issuer}/userinfo"


@pytest.mark.asyncio
async def test_discovery_survives_a_provider_that_advertises_no_userinfo_endpoint(
    provider: Provider,
):
    provider.advertise_userinfo = False

    assert (await discover(provider)).userinfo_endpoint is None


# --- the UserInfo lookup ---------------------------------------------------

# Kanidm does not put profile claims in an access token even when the profile scope was
# granted, which the spec permits -- identity claims are only promised in the id token and
# at the UserInfo endpoint. So a token without preferred_username is not an error, and the
# name is asked for here instead. Any failure to get one is None: a cosmetic directory name
# is not worth failing an upload over, and one that could not be made sense of is not worth
# guessing at either.


@pytest.mark.asyncio
async def test_the_username_comes_from_userinfo(oidc: OidcClient, provider: Provider):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")

    assert await oidc.query_username(provider.mint(), DEFAULT_SUBJECT) == "lecturer"
    assert provider.userinfo_fetch_count == 1


@pytest.mark.asyncio
async def test_userinfo_is_asked_with_the_callers_access_token(
    oidc: OidcClient, provider: Provider
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")
    token = provider.mint(preferred_username=None)

    await oidc.query_username(token, DEFAULT_SUBJECT)

    # the access token is the credential for UserInfo too; nothing else would authorize us
    assert provider.userinfo_authorization == f"Bearer {token}"


@pytest.mark.asyncio
async def test_userinfo_about_a_different_subject_is_discarded(
    oidc: OidcClient, provider: Provider
):
    # OIDC Core 5.3.2 requires this check: an answer about somebody else would otherwise
    # put this caller's recordings in a directory named after them
    provider.serve_userinfo(sub="somebody-else", preferred_username="mallory")

    assert await oidc.query_username(provider.mint(), DEFAULT_SUBJECT) is None


@pytest.mark.parametrize(
    "response",
    [
        (404, "text/plain", b""),  # nothing known about the caller
        (502, "text/html", b"<html><body>502 Bad Gateway</body></html>"),  # a proxy, not the OP
        (403, "application/json", b'{"error":"insufficient_scope"}'),  # profile not granted
        (200, "application/jwt", b"eyJhbGciOiJSUzI1NiJ9.e30.sig"),  # signed UserInfo
        (200, "application/json", b""),  # nothing at all
        (200, "application/json", b'["not", "an", "object"]'),  # json, wrong shape
        (200, "application/json", b'{"preferred_username":"lecturer"}'),  # no sub to check
        (
            200,
            "application/json",
            f'{{"sub":"{DEFAULT_SUBJECT}","preferred_username":42}}'.encode(),
        ),
    ],
)
@pytest.mark.asyncio
async def test_unusable_userinfo_yields_no_username(
    oidc: OidcClient, provider: Provider, response: tuple[int, str, bytes]
):
    provider.serve_userinfo_raw(*response)

    assert await oidc.query_username(provider.mint(), DEFAULT_SUBJECT) is None


@pytest.mark.asyncio
async def test_unreachable_userinfo_yields_no_username(oidc: OidcClient, provider: Provider):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")
    token = provider.mint()
    provider.stop()

    assert await oidc.query_username(token, DEFAULT_SUBJECT) is None


@pytest.mark.asyncio
async def test_no_userinfo_endpoint_yields_no_username_without_asking(provider: Provider):
    provider.advertise_userinfo = False
    # served, but never advertised: if the endpoint were guessed at rather than taken from
    # the discovery document, this name would come back and give it away
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")
    oidc = await discover(provider)

    assert await oidc.query_username(provider.mint(), DEFAULT_SUBJECT) is None
    assert provider.userinfo_fetch_count == 0
