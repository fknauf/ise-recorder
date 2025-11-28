#!/usr/bin/env python3

from argparse import ArgumentParser
import logging
from pathlib import Path
import sys

from ise_record.postprocess import postprocess_recording

def main():
    parser = ArgumentParser(
        prog="ise-rerender",
        description="Manually (re)execute postprocessing for a ise-recorder recording"
    )

    parser.add_argument('recording_directory')
    parser.add_argument('-l', '--log-level', default="INFO")

    args = parser.parse_args()

    logging.basicConfig(level=args.log_level)

    result = postprocess_recording(Path(args.recording_directory))

    print(f"Result: {result.reason.name}, output = {result.output_file}")

if __name__ == "__main__":
    main()
