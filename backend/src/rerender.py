#!/usr/bin/env python3

"""
Program to rerender a recording from chunks on the ise-recorder backend server
"""

import asyncio
from argparse import ArgumentParser
import logging
from pathlib import Path

from ise_record.postprocess import postprocess_recording

async def main():
    """
    Main function. Parses command line, calls postprocessing and prints results.
    """

    parser = ArgumentParser(
        prog="ise-rerender",
        description="Manually (re)execute postprocessing for a ise-recorder recording"
    )
    parser.add_argument('recording_directory', type=Path)
    parser.add_argument('-l', '--log-level', default="INFO")
    argv = parser.parse_args()

    logging.basicConfig(level=argv.log_level)
    result = await postprocess_recording(argv.recording_directory)
    print(f"Result: {result.reason.name}, output = {result.output_file}")

if __name__ == "__main__":
    asyncio.run(main())
