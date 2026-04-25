""" Logging setup for ise-recorder  """

import logging

def health_check_filter(record: logging.LogRecord):
    """ Filter out successful health checks done by the container itself """
    return (
        not isinstance(record.args, tuple)
        or len(record.args) < 5
        or not record.args[0].startswith("127.0.0.1:")
        or record.args[1] != "GET"
        or record.args[2] != "/api/health"
        or not (200 <= record.args[4] < 300)
    )

def setup_logging():
    """
    Set up logging to match uvicorn options and filter out the container's
    health check
    """
    logging.getLogger('uvicorn.access').addFilter(health_check_filter)

    uvicorn_logger = logging.getLogger('uvicorn.error')
    logging.basicConfig(level=uvicorn_logger.getEffectiveLevel())
