export type SavedTrack = {
  blob: Blob,
  title: string
};

export type SavedRecording = {
  timestamp: string;
  tracks: SavedTrack[]
};
