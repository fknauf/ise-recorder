"""
UserInfo as the one reading of a provider's claims, whether they come from the access token or
from the UserInfo endpoint.

Providers disagree on how they write claims -- Apple and Cognito send email_verified as the
string "true", Entra does not send it at all -- and a claim that one of them gets wrong must not
cost the user the others. Only the subject is load-bearing: it names the home directory, so
without a usable one there is nobody to file anything under.
"""

# pylint: disable=missing-function-docstring

from typing import Any

from pydantic import ValidationError
import pytest

from ise_record.core.auth import UserInfo


@pytest.mark.parametrize(
    "claim, verified",
    [
        pytest.param(True, True, id="bool"),
        pytest.param(False, False, id="bool-false"),
        pytest.param("true", True, id="string"),
        pytest.param("false", False, id="string-false"),
        pytest.param(None, None, id="null"),
        pytest.param("nope", None, id="garbage"),
        pytest.param(["true"], None, id="wrong-type"),
    ],
)
def test_email_verified_is_read_the_way_providers_write_it(claim: Any, verified: bool | None):
    assert (
        UserInfo.model_validate({"sub": "abc", "email_verified": claim}).email_verified is verified
    )


def test_a_missing_email_verified_is_unknown_rather_than_false():
    # the recipient sources tell the two apart: oidc wants True, oidc-unverified takes either
    assert UserInfo.model_validate({"sub": "abc", "email": "a@example.edu"}).email_verified is None


@pytest.mark.parametrize("field", ["preferred_username", "email"])
@pytest.mark.parametrize("claim", [42, ["a@example.edu"], {"value": "a@example.edu"}])
def test_a_claim_of_the_wrong_type_is_dropped_and_the_rest_kept(field: str, claim: Any):
    user = UserInfo.model_validate(
        {
            "sub": "abc",
            "preferred_username": "lecturer",
            "email": "lecturer@example.edu",
            "email_verified": True,
            field: claim,
        }
    )

    assert getattr(user, field) is None
    assert user.email_verified is True


def test_a_malformed_address_is_kept_for_the_report_to_judge():
    # whether an address is fit to mail is normalize_recipient's call, against the allowed
    # domains; turning it away here would hide why no report went out
    assert (
        UserInfo.model_validate({"sub": "abc", "email": "not an address"}).email == "not an address"
    )


def test_claims_that_are_not_about_the_user_are_ignored():
    claims = {
        "sub": "abc",
        "iss": "https://idp.example.edu",
        "aud": "ise",
        "exp": 1,
        "scope": "openid",
    }

    assert UserInfo.model_validate(claims) == UserInfo(sub="abc")


@pytest.mark.parametrize("claims", [{}, {"sub": None}, {"sub": 42}, {"sub": ["abc"]}])
def test_claims_without_a_usable_subject_are_nobody(claims: dict[str, Any]):
    with pytest.raises(ValidationError):
        UserInfo.model_validate(claims)


def test_a_user_cannot_be_changed_once_read():
    # one UserInfo is cached and handed to every request of that user
    user = UserInfo(sub="abc", email="lecturer@example.edu")

    with pytest.raises(ValidationError):
        user.email = "mallory@example.edu"  # type: ignore[misc]
