"use client";

import { useAppStore } from "./useAppStore";

export function useMediaTracks() {
  const displayTracks = useAppStore(state => state.displayTracks);
  const videoTracks = useAppStore(state => state.videoTracks);
  const audioTracks = useAppStore(state => state.audioTracks);
  const mainDisplay = useAppStore(state => state.mainDisplay);
  const overlay = useAppStore(state => state.overlay);

  const selectMainDisplay = useAppStore(state => state.selectMainDisplay);
  const selectOverlay = useAppStore(state => state.selectOverlay);
  const removeTrack = useAppStore(state => state.removeTrack);

  return {
    displayTracks,
    videoTracks,
    audioTracks,
    mainDisplay,
    overlay,
    selectMainDisplay,
    selectOverlay,
    removeTrack
  };
}
