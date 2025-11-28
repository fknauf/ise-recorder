import logging
from pathlib import Path
import sys

from ise_record.postprocess import postprocess_recording

def main():
    logging.basicConfig(level=logging.INFO)
    print(postprocess_recording(Path(sys.argv[1])))

if __name__ == "__main__":
    main()
