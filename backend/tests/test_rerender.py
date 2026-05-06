# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-many-locals
# pylint: disable=protected-access
# pylint: disable=no-member

from pathlib import Path

import pytest
from pytest_mock import MockerFixture
import rerender # pyright: ignore[reportMissingTypeStubs]

from ise_record.postprocess import Result, ResultReason

@pytest.mark.asyncio
async def test_rerender(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))

    mocker.patch("sys.argv", [ "./rerender.py", "foo" ])
    mock_postprocess = mocker.patch("rerender.postprocess_recording", autospec=True, return_value=expected_result)
    mock_basic_config = mocker.patch("logging.basicConfig")

    await rerender.main()

    mock_basic_config.assert_called_once_with(level="INFO")
    mock_postprocess.assert_called_once_with(Path("foo"))

@pytest.mark.asyncio
async def test_rerender_loglevel(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))

    mocker.patch("sys.argv", [ "./rerender.py", "--log-level", "DEBUG", "foo" ])
    mock_postprocess = mocker.patch("rerender.postprocess_recording", autospec=True, return_value=expected_result)
    mock_basic_config = mocker.patch("logging.basicConfig")

    await rerender.main()

    mock_basic_config.assert_called_once_with(level="DEBUG")
    mock_postprocess.assert_called_once_with(Path("foo"))
