/**
 * Build a MediaDeviceInfo for tests.
 *
 * openVideoStream and openAudioStream take the whole MediaDeviceInfo now that MediaDeviceUid is
 * gone, so a bare { groupId, deviceId } literal no longer type-checks -- the interface also
 * carries kind, label and toJSON. Only groupId and deviceId reach createDeviceConstraints; the
 * rest is there to satisfy the type and to give the device a readable label in menus.
 *
 * toJSON matters more than it looks: vitest's diff serializer calls it when printing a failed
 * expectation, so a device that lacks it prints as [object Object] in the one place you need to
 * read it.
 */
export const makeDevice = (
  deviceId: string,
  groupId: string,
  kind: MediaDeviceKind,
  label: string
): MediaDeviceInfo => ({
  deviceId,
  groupId,
  kind,
  label,
  toJSON: () => JSON.stringify({ deviceId, groupId, kind, label })
});
