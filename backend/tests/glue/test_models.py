# pylint: disable=missing-class-docstring
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-few-public-methods
# pyright: reportPrivateUsage=false

"""
The recording-name rule, which is the half of a contract whose other half is in TypeScript.

The frontend derives a directory name from a lecture title and this end has to accept it. A
name that gets rejected here is not a recoverable error: a 422 on /api/chunks is permanent,
so there is no retry and no postprocessing, and the recording survives in the browser's OPFS
and nowhere else. That has happened, which is why the corpus below is deliberately the same
one as in frontend/__tests__/util/recordingName.test.ts -- the two files pin the same titles
from opposite sides, and a change to either rule should turn one of them red.

Validation is two stages with a deliberate division of labour. _normalize_for_filesystem
does only what the pattern cannot express -- NFC composition, the byte-length cap, the
characters no filesystem will take, and the Windows device names -- and the pattern does
everything it can state itself, over categories L, M and N plus "._-".

That line is drawn where it is because the pattern is what actually guarantees the leading
character: it runs last, so nothing that fails it can reach the filesystem. A strip of
leading dots in the first stage would look like it were winning safety that is won in the
second, and an invariant that appears to be enforced in two places is one you stop checking.
The repairs that remain are the ones with no second line of defence, and they share a
property: they are data-dependent. A leading dot fails on chunk zero of every recording, so
a client that produces one finds out the first time it runs. An overlong name passes every
test with "Lecture 1" and fails in production on a long Chinese title, mid-lecture, where a
422 is permanent and costs the whole recording.

The pattern was relaxed from \\w (categories L, Nd, Nl, No plus underscore) to L, M, N, which
is what admits scripts whose vowels are combining marks. \\w already carried Chinese and
Korean; what it dropped was every Indic and Southeast Asian script, where the Hindi for
"Hindi" came out with its vowels deleted.

Invisible characters are spelled as escapes throughout. They are indistinguishable from
nothing on screen, so a literal one would make the interesting half of a test unreadable and
survive an editor quietly deleting it.
"""

import unicodedata

import pytest
from pathvalidate import sanitize_filename
from pydantic import BaseModel, ValidationError

from ise_record.glue.models import SafeRecording, _normalize_for_filesystem


class Name(BaseModel):
    recording: SafeRecording


def validated(value: str) -> str:
    """ The name as the endpoint would store it, or a ValidationError. """
    return Name(recording=value).recording


def accepted(value: str) -> bool:
    try:
        validated(value)
        return True
    except ValidationError:
        return False


# the timestamp the frontend appends, with the colons already stripped
STAMP = "2025-12-21T123456.789Z"

# NAME_MAX on ext4, and what pathvalidate caps a filename at on every platform it knows.
# server.py no longer names this number -- it relies on pathvalidate's default -- so the
# bound is pinned by test_the_effective_length_bound_is_the_one_the_filesystem_has below
# rather than shared with the code.
NAME_MAX_BYTES = 255


# --- names the frontend actually produces ----------------------------------

@pytest.mark.parametrize("name", [
    f"GVS_{STAMP}",
    f"Übung_3_{STAMP}",
    f"Version_1.0_{STAMP}",
    f"3D_Modelling_{STAMP}",          # a digit is a legal first character
    f"_scratch_{STAMP}",              # and so is an underscore
    f"NET_{STAMP}",                   # ".NET", after the frontend drops the leading dot
    f"rf_{STAMP}",                    # "-rf", likewise
    f"etcpasswd_{STAMP}",             # "../../etc/passwd", likewise
    STAMP,                            # an empty title leaves the timestamp to name it
])
def test_a_name_the_frontend_derives_is_accepted(name: str):
    assert validated(name) == name, "the frontend's own output must survive untouched"


@pytest.mark.parametrize("name", [
    f"机器学习第一讲_{STAMP}",                      # Chinese
    f"数据结构算法_{STAMP}",
    f"한국어_강의_{STAMP}",                          # Korean
    f"हिन्दी_व्याकरण_{STAMP}",   # Devanagari: Mc and Mn throughout
    f"ภาษาไทย_{STAMP}",                        # Thai
    f"Tiếng_Việt_{STAMP}",
    f"العربية_{STAMP}",                        # Arabic
])
def test_a_non_latin_name_is_accepted_unchanged(name: str):
    # the point of the relaxation. Under the old \\w rule the Devanagari entry was the one
    # that failed, and it failed for every chunk of the lecture
    assert validated(name) == name


# --- what gets repaired rather than refused ---------------------------------

@pytest.mark.parametrize("sent,stored", [
    ("a/b", "ab"),                      # a separator cannot survive in one path component
    ("A/////", "A"),
    ("a\x00b", "ab"),
    ("a:b", "ab"), ("a*b", "ab"), ("a?b", "ab"), ("a|b", "ab"), ("a\\b", "ab"),
    ("a\tb", "ab"), ("a\nb", "ab"),     # control characters, which is why these and not " "
    ("trailing.", "trailing"),          # Windows drops these silently, which is worse
    ("trailing..", "trailing"),
    ("trailing ", "trailing"),
    (" leading", "leading"),
])
def test_a_name_no_filesystem_would_take_is_cleaned_rather_than_rejected(sent: str, stored: str):
    # what is left of the repair stage: characters a filesystem refuses outright, which the
    # pattern cannot express because it is a whitelist and these are absences. Note that a
    # tab is repaired and a plain space is not -- a tab is a control character and goes at
    # this stage, where a space is merely outside the pattern and is refused at the next one
    assert validated(sent) == stored


@pytest.mark.parametrize("name,stored", [
    ("COM1", "COM1_"),
    ("COM1.whatever", "COM1_.whatever"),
    ("CON", "CON_"),
    ("PRN", "PRN_"),
])
def test_a_windows_device_name_is_renamed(name: str, stored: str):
    # unreachable through the frontend, which always appends "_<timestamp>" and so never
    # leaves a device name in the stem -- "COM1_2025-12-21T123456.789Z" is a perfectly
    # ordinary filename. This is for the day the recordings are copied to a Windows share
    assert validated(name) == stored


def test_the_frontends_own_names_are_never_a_device_name():
    # the property that makes the case above unreachable from the product, stated so that a
    # change to the separator between title and timestamp has to come past it
    assert validated(f"COM1_{STAMP}") == f"COM1_{STAMP}"
    assert validated(f"NUL_{STAMP}") == f"NUL_{STAMP}"


# --- what no client can get past this ---------------------------------------

@pytest.mark.parametrize("name", [
    "../../etc/passwd", "..;/",          # would escape the recording directory
    "a\u202eb",                          # right-to-left override: directory name spoofing
    "a\u200bb", "a\u200db",              # zero width space and joiner
    "\u0308leading",                     # a mark may not open a name
    "机器学习（第一讲）",                         # fullwidth parens are Ps/Pe, not letters
    "\U0001F393",                        # emoji are still out: So is outside L, M and N
    "GVS%x", "GVS;x", "GVS=x", "GVS,x", "GVS!x",
])
def test_an_unsafe_name_is_rejected(name: str):
    assert not accepted(name)


@pytest.mark.parametrize("name", [
    ".NET", ".hidden", "...leading",     # hidden on the server, where a human looks for it
    "-rf", "--force",                    # argv-shaped, and ffmpeg reads arguments as options
    "a b", "two  spaces",                # a space in a path is a nuisance in every script
    "Anna\u00a0Schmidt",                 # non-breaking space
    "\u3000\u674e\u3000",                       # ideographic space, as a CJK IME sends it
])
def test_a_name_the_pattern_alone_refuses(name: str):
    # these used to be repaired in the first stage, which made it look as though the leading
    # character were guaranteed there. It is guaranteed by the pattern, which runs last and
    # cannot be bypassed -- so the repair was leniency for clients that are not the frontend,
    # bought at the price of an invariant that appeared to live in two places.
    #
    # The frontend never sends any of these: normalizeLectureTitle maps Zs to "_" and
    # unsafeNameStart drops a leading dot or dash before the name is ever derived.
    assert not accepted(name)


def test_the_pattern_is_anchored():
    # pydantic's `pattern` is a search, not a full match, so an unanchored rule would accept
    # anything with one good character anywhere in it. This is the whole defence against
    # traversal, and it is one \\A away from being silently gone. The probes need a legal
    # prefix and an illegal tail that survives sanitising, or the repair stage hides the hole
    assert not accepted("GVS%x")
    assert not accepted("GVS（x）")
    assert not accepted("../../etc/passwd")


@pytest.mark.parametrize("name", ["", "   "])
def test_an_empty_name_reports_a_length_error(name: str):
    # "too_short" now means what it says. While the first stage stripped leading dots, "."
    # and ".." arrived here as the empty string and were reported as too short, which told a
    # client author the opposite of what had happened
    with pytest.raises(ValidationError) as excinfo:
        validated(name)

    assert excinfo.value.errors()[0]["type"] == "too_short"


@pytest.mark.parametrize("name", [".", "..", "-", "...", "---"])
def test_a_name_that_is_only_punctuation_is_refused(name: str):
    # deliberately not asserting which error: whether one of these reaches the pattern as
    # itself or as the empty string is pathvalidate's business and differs between them
    # ("..." empties, ".." does not). The contract is that none of them is ever stored
    assert not accepted(name)


# --- the length bound is bytes ----------------------------------------------

@pytest.mark.parametrize("raw,expected_bytes", [
    ("a" * 400, 255),                 # 1 byte a character
    ("ü" * 400, 254),            # 2 bytes: 127 characters, and the 128th would be 256
    ("机" * 200, 255),                 # 3 bytes
    ("\U00020000" * 100, 252),        # 4 bytes: backs off rather than cutting one in half
    ("हि" * 200, 255),                # base plus combining mark
])
def test_an_overlong_name_is_truncated_to_the_byte_budget(raw: str, expected_bytes: int):
    # the failure this avoids is not a rejection but an OSError out of os.makedirs, halfway
    # through a lecture, on every chunk. CJK is three bytes a character, so a title that is
    # comfortable in German is twice over the limit in Chinese
    truncated = validated(raw)

    assert len(truncated.encode("utf-8")) == expected_bytes
    assert len(truncated.encode("utf-8")) <= NAME_MAX_BYTES


def test_the_effective_length_bound_is_the_one_the_filesystem_has():
    # server.py passes no max_len, so the budget is pathvalidate's platform default rather
    # than a number this project states. That is fine while the two agree; this is what
    # notices if they stop
    assert len(sanitize_filename("a" * 500, platform="universal")) == NAME_MAX_BYTES


@pytest.mark.parametrize("raw", ["a" * 400, "机" * 200, "\U00020000" * 100, "हि" * 200])
def test_truncation_never_cuts_a_character_in_half(raw: str):
    # a byte slice can land inside a multi-byte sequence, and the fragment would decode as
    # U+FFFD -- which is not in L, M or N, so it would fail the pattern for the rest of the
    # lecture. This is the same bug the frontend had with substring() over surrogate pairs
    truncated = validated(raw)

    assert truncated.encode("utf-8").decode("utf-8") == truncated
    assert "�" not in truncated


@pytest.mark.parametrize("name", [f"GVS_{STAMP}", "机" * 84, "a"])
def test_a_name_within_the_budget_is_left_alone(name: str):
    assert _normalize_for_filesystem(name) == name


@pytest.mark.parametrize("raw", [
    "a" * 400, "机" * 200, f"GVS_{STAMP}", "COM1", "a b", ".NET", "trailing.", "A/////",
])
def test_normalising_is_idempotent(raw: str):
    # every chunk of a recording is validated separately, and the postprocessing job once
    # more at the end. If a second pass moved the name, the chunks of one lecture would be
    # spread over two directories and the job would find half of them
    once = _normalize_for_filesystem(raw)

    assert _normalize_for_filesystem(once) == once


# --- composition ------------------------------------------------------------

def test_a_decomposed_name_is_stored_in_composed_form():
    # macOS and several IMEs send NFD. Without this the same lecture reaches the server under
    # two names that are identical on screen, lands in two directories, and defeats the
    # in-flight job deduplication, which compares recording names
    decomposed = f"U\u0308bung_{STAMP}"
    composed = f"\u00dcbung_{STAMP}"

    assert decomposed != composed
    assert validated(decomposed) == composed
    assert validated(composed) == composed


def test_normalisation_happens_before_the_budget_is_measured():
    # NFC can shorten the string, so measuring first would truncate more than necessary --
    # and, at the boundary, cut a name that composes to something that would have fitted
    decomposed = "e\u0301" * 200

    assert len(decomposed.encode("utf-8")) > NAME_MAX_BYTES

    truncated = validated(decomposed)

    assert unicodedata.is_normalized("NFC", truncated)
    assert len(truncated.encode("utf-8")) <= NAME_MAX_BYTES
