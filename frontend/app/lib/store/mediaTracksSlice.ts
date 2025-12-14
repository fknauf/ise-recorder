"use client";

import { StateCreator } from "zustand";
import { AppStoreState } from "./store";

type TrackSelection = MediaStreamTrack | undefined;

export interface MediaTracksState {
  displayTracks: readonly MediaStreamTrack[]
  videoTracks: readonly MediaStreamTrack[]
  audioTracks: readonly MediaStreamTrack[]
  mainDisplay: MediaStreamTrack | undefined
  overlay: MediaStreamTrack | undefined

  addDisplayTracks: (tracks: MediaStreamTrack[]) => void
  addVideoTracks: (tracks: MediaStreamTrack[]) => void
  addAudioTracks: (tracks: MediaStreamTrack[]) => void
  removeTrack: (track: MediaStreamTrack) => void

  selectMainDisplay: (newMainDisplay: ((old: TrackSelection) => TrackSelection) | TrackSelection) => void
  selectOverlay: (newOverlay: ((old: TrackSelection) => TrackSelection) | TrackSelection) => void
}

export const createMediaStreamsSlice: StateCreator<
  AppStoreState,
  [],
  [],
  MediaTracksState
> = set => {
  const unselectTrack = (track: MediaStreamTrack) => {
    set(state => ({
      mainDisplay: state.mainDisplay === track ? undefined : state.mainDisplay,
      overlay: state.overlay === track ? undefined : state.overlay
    }));
  };

  return {
    displayTracks: [],
    videoTracks: [],
    audioTracks: [],
    mainDisplay: undefined,
    overlay: undefined,

    addDisplayTracks: tracks => {
      for(const track of tracks) {
        // Remove a track if it ends even if we weren't the ones to end it. This can happen if the user unplugs a device or revokes permissions.
        track.onended = () => {
          unselectTrack(track);
          set(state => ({ displayTracks: state.displayTracks.filter(t => t !== track) }));
        };
      }

      set(state => ({ displayTracks: [ ...state.displayTracks, ...tracks ] }));
    },

    addVideoTracks: tracks => {
      for(const track of tracks) {
        // Remove a track if it ends even if we weren't the ones to end it. This can happen if the user unplugs a device or revokes permissions.
        track.onended = () => {
          unselectTrack(track);
          set(state => ({ videoTracks: state.videoTracks.filter(t => t !== track) }));
        };
      }

      set(state => ({ videoTracks: [ ...state.videoTracks, ...tracks ] }));
    },

    addAudioTracks: tracks => {
      for(const track of tracks) {
        // Remove a track if it ends even if we weren't the ones to end it. This can happen if the user unplugs a device or revokes permissions.
        track.onended = () => {
          set(state => ({ audioTracks: state.audioTracks.filter(t => t !== track) }));
        };
      }

      set(state => ({ audioTracks: [ ...state.audioTracks, ...tracks ] }));
    },

    removeTrack: track => {
      // Track is removed on the "ended" event. The event doesn't fire automatically when we stop the stream ourselves, so we fire it manually.
      track.stop();
      track.dispatchEvent(new Event("ended"));
    },

    selectMainDisplay: (newMainDisplay: ((old: TrackSelection) => TrackSelection) | TrackSelection) => {
      if(newMainDisplay instanceof Function) {
        set(state => ({ mainDisplay: newMainDisplay(state.mainDisplay) }));
      } else {
        set({ mainDisplay: newMainDisplay });
      }
    },

    selectOverlay: (newOverlay: ((old: TrackSelection) => TrackSelection) | TrackSelection) => {
      if(newOverlay instanceof Function) {
        set(state => ({ overlay: newOverlay(state.overlay) }));
      } else {
        set({ overlay: newOverlay });
      }
    }
  };
};
