# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=redefined-outer-name

import logging
from typing import Any, Iterator

import pytest

from ise_record.logconfig import health_check_filter, setup_logging

# What uvicorn.access logs for every request:
#
#     self.access_logger.info(
#         '%s - "%s %s HTTP/%s" %d',
#         client_addr, method, full_path, http_version, status_code,
#     )
#
# The filter reads those five arguments positionally, so it is coupled to that call and
# to nothing else. If a uvicorn release reorders or renames them, the filter quietly
# stops matching and the health check noise comes back; these tests are what notices.
ACCESS_FORMAT = '%s - "%s %s HTTP/%s" %d'

CONTAINER_CLIENT = "127.0.0.1:54321"


def access_record(*args: Any) -> logging.LogRecord:
    """ A uvicorn.access record carrying the given positional arguments. """
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=ACCESS_FORMAT,
        args=args,
        exc_info=None
    )


def health_check(
    client: str | None = CONTAINER_CLIENT,
    method: str = "GET",
    path: str = "/api/health",
    status: Any = 200
) -> logging.LogRecord:
    return access_record(client, method, path, "1.1", status)


def test_the_containers_own_successful_health_check_is_dropped():
    # The whole point: docker probes this every five seconds, and at debug log level that
    # would bury everything an operator actually wants to read.
    assert health_check_filter(health_check()) is False


@pytest.mark.parametrize("status", [ 200, 204, 299 ])
def test_every_success_status_is_dropped(status: int):
    assert health_check_filter(health_check(status=status)) is False


@pytest.mark.parametrize("status", [ 199, 300, 404, 500, 503 ])
def test_a_health_check_that_did_not_succeed_is_kept(status: int):
    # A failing health check is the one occasion where this line is the most interesting
    # thing in the log, so the filter must not swallow it along with the quiet ones.
    assert health_check_filter(health_check(status=status)) is True


def test_a_health_check_from_somewhere_else_is_kept():
    # Only the container's own probe is noise. An external monitoring system polling the
    # endpoint is traffic the operator asked for and may well want to see.
    assert health_check_filter(health_check(client="10.0.0.7:33445")) is True


def test_an_address_that_merely_starts_like_the_loopback_one_is_kept():
    # "127.0.0.1:" is matched as a prefix, so this is the case that prefix matching could
    # get wrong: a different host whose address happens to begin with those characters.
    assert health_check_filter(health_check(client="127.0.0.10:80")) is True


def test_another_endpoint_from_the_same_address_is_kept():
    # Chunk uploads from a backend on the same host are real traffic, not health checks.
    assert health_check_filter(health_check(path="/api/chunks")) is True


def test_a_path_that_merely_contains_the_health_endpoint_is_kept():
    assert health_check_filter(health_check(path="/api/health/subresource")) is True


def test_another_method_on_the_health_endpoint_is_kept():
    # Nothing in this system POSTs to /api/health, so if something does, that is worth a
    # line in the log rather than silence.
    assert health_check_filter(health_check(method="POST")) is True


def test_a_record_that_is_not_an_access_log_line_is_kept():
    # uvicorn.error and anything else that ends up on this logger carries no args at all,
    # and indexing into it would raise inside logging rather than fail visibly.
    record = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="something happened",
        args=None,
        exc_info=None
    )

    assert health_check_filter(record) is True


def test_a_record_with_too_few_arguments_is_kept():
    assert health_check_filter(access_record(CONTAINER_CLIENT, "GET", "/api/health")) is True


def test_a_record_whose_arguments_are_a_mapping_is_kept():
    # logging replaces a lone Mapping argument with the mapping itself, so record.args is
    # not always a tuple. len() and [0] would both do something surprising on a dict.
    record = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="%(client)s",
        args=({ "client": CONTAINER_CLIENT },),
        exc_info=None
    )

    assert not isinstance(record.args, tuple)
    assert health_check_filter(record) is True


@pytest.mark.parametrize("status", [ "200", 200.0, None ])
def test_a_status_that_is_not_an_integer_is_kept(status: Any):
    # bool is deliberately not in this list: it is an int subclass, and True would compare
    # as 1, which falls outside the success range anyway.
    assert health_check_filter(health_check(status=status)) is True


def test_a_non_string_client_address_is_kept():
    assert health_check_filter(health_check(client=None)) is True


@pytest.mark.parametrize("path", [ "/foo/api/health", "/foo/bar/api/health" ])
def test_a_prefixed_deployments_health_check_is_dropped_too(path: str):
    # ISE_RECORD_ROUTE_PREFIX moves the endpoint, and the container's health check follows
    # it, so matching the path exactly used to leave prefixed deployments logging a line
    # every five seconds. The filter matches the tail instead.
    assert health_check_filter(health_check(path=path)) is False


def test_any_path_ending_in_the_health_endpoint_is_dropped():
    # The cost of the tail match, recorded deliberately: the filter has no idea what the
    # configured prefix is, so it drops anything ending in /api/health. Harmless, because
    # it still takes a GET from the container's own address with a 2xx to get this far,
    # and this deployment serves nothing else that ends that way.
    assert health_check_filter(health_check(path="/not-the-configured-prefix/api/health")) is False


@pytest.fixture
def restored_access_logger() -> Iterator[logging.Logger]:
    """ Let a test touch the global uvicorn.access logger without leaking the change. """
    access_logger = logging.getLogger("uvicorn.access")
    saved = list(access_logger.filters)

    yield access_logger

    access_logger.filters = saved


def test_setup_logging_attaches_the_filter_to_the_access_logger(
    restored_access_logger: logging.Logger
):
    # The filter only does anything if it is wired to the logger uvicorn actually uses,
    # and that wiring is a string ("uvicorn.access") on both sides.
    restored_access_logger.filters = []

    setup_logging()

    # Logger.filter() answers with the record itself rather than True when the record
    # survives, so this asks about truthiness where the filter itself is checked for
    # exactly True and False above.
    assert health_check_filter in restored_access_logger.filters
    assert not restored_access_logger.filter(health_check())
    assert restored_access_logger.filter(health_check(status=503))
