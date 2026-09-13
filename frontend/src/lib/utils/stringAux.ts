const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function utf8ByteLength(cluster: string) {
  let bytes = 0;

  for(const c of cluster) {
    const codePoint = c.codePointAt(0) ?? 0;
    if(codePoint < 0x80) {
      bytes += 1;
    } else if(codePoint < 0x800) {
      bytes += 2;
    } else if(codePoint < 0x10000) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }

  return bytes;
}

export function graphemeAwareTruncateToBytes(str: string, maxBytes: number) {
  // grapheme-aware title truncation for filesystem-safety
  //
  // max file name length in some filesystems is 255, so we need to truncate the title to
  // a length that will be less than that after it is encoded in UTF-8 with the timestamp
  // appended. So stay a bit below that. But also we don't want to break up graphemes that
  // consist of multiple code points, and that's why all this hubbub becomes necessary.

  // One UTF-16 cluster encodes at most 3 UTF-8 bytes
  const maxClusters = Math.floor(maxBytes / 3);

  // Can't be longer than maxBytes after UTF-8 encoding, so no need to inspect.
  if(str.length < maxClusters) {
    return str;
  }

  let bytes = 0;

  for(const { segment, index } of graphemeSegmenter.segment(str)) {
    const segmentBytes = utf8ByteLength(segment);

    if(bytes + segmentBytes > maxBytes) {
      return str.slice(0, index);
    }

    bytes += segmentBytes;
  }

  return str;
}
