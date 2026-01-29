# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-many-locals

import logging
from pathlib import Path

import pytest
import rerender
from ise_record.postprocess import Result, ResultReason

@pytest.mark.asyncio
async def test_rerender(mocker):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))

    mocker.patch("sys.argv", [ "./rerender.py", "foo" ])
    mocker.patch("rerender.postprocess_recording", autospec=True, return_value=expected_result)
    mocker.patch("logging.basicConfig")

    await rerender.main()

    logging.basicConfig.assert_called_once_with(level="INFO")
    rerender.postprocess_recording.assert_called_once_with(Path("foo"))

@pytest.mark.asyncio
async def test_rerender_loglevel(mocker):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))

    mocker.patch("sys.argv", [ "./rerender.py", "--log-level", "DEBUG", "foo" ])
    mocker.patch("rerender.postprocess_recording", autospec=True, return_value=expected_result)
    mocker.patch("logging.basicConfig")

    await rerender.main()

    logging.basicConfig.assert_called_once_with(level="DEBUG")
    rerender.postprocess_recording.assert_called_once_with(Path("foo"))
