/**
 * Stand-ins for what the browser's media APIs hand the app.
 */

/**
 * A live video track, captured from a canvas nobody draws on. That is all a MediaRecorder, a
 * <video> element or the store needs: a real MediaStreamTrack that records, plays, and ends
 * when it is stopped.
 */
export function canvasVideoTrack(width = 64, height = 48): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.captureStream().getVideoTracks()[0];
}

/** A device the way enumerateDevices reports one. */
export const makeDevice = (deviceId: string, groupId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo => ({
  deviceId, groupId, kind, label,
  toJSON: () => JSON.stringify({ deviceId, groupId, kind, label })
});
