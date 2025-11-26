'use client';

import { ReactNode } from "react";
import { ActionButton, Flex, Text, View } from '@adobe/react-spectrum';
import { VideoPreview } from "./VideoPreview";
import { AudioPreview } from "./AudioPreview";

interface PreviewCardProps {
  label: string | undefined,
  hasDisabledButtons: boolean,
  onRemove: () => void,
  children: Readonly<ReactNode>
}

/**
 * Preview card, i.e. the frame around a video or audio preview. Consists of a frame, title, and a "remove" button.
 * The actual preview is passed in as a child node.
 */
const PreviewCard = (
  {
      label,
      hasDisabledButtons,
      onRemove,
      children
  }: Readonly<PreviewCardProps>
) =>
  <View borderWidth="thin" borderColor="light" borderRadius="medium" padding="size-100">
    <Flex direction="column" justifyContent="center" gap="size-100" height="100%">
      <Text>{label}</Text>
      {children}
      <ActionButton  marginTop="auto" onPress={onRemove} isDisabled={hasDisabledButtons}>Remove</ActionButton>
    </Flex>
  </View>;

/**
 * Previews section on the main page, basically a collection of preview cards for all active streams.
 */
interface PreviewSectionProps {
  displayTracks: readonly MediaStreamTrack[]
  videoTracks: readonly MediaStreamTrack[]
  audioTracks: readonly MediaStreamTrack[]
  mainDisplay: MediaStreamTrack | null,
  overlay: MediaStreamTrack | null,
  canvasWidth: number,
  canvasHeight: number,
  hasDisabledButtons: boolean,
  onMainDisplayChanged: (track: MediaStreamTrack | null) => void,
  onOverlayChanged: (track: MediaStreamTrack | null) => void,
  onRemoveDisplayTrack: (track: MediaStreamTrack) => void
  onRemoveVideoTrack: (track: MediaStreamTrack) => void
  onRemoveAudioTrack: (track: MediaStreamTrack) => void
}

export function PreviewSection(
  {
    displayTracks,
    videoTracks,
    audioTracks,
    mainDisplay,
    overlay,
    canvasWidth,
    canvasHeight,
    hasDisabledButtons,
    onMainDisplayChanged,
    onOverlayChanged,
    onRemoveDisplayTrack,
    onRemoveVideoTrack,
    onRemoveAudioTrack
  }: Readonly<PreviewSectionProps>
) {
  const video_preview_card = (track: MediaStreamTrack, label: string, onRemove: (track: MediaStreamTrack) => void) =>
    <PreviewCard
      key={`preview-card-${track.id}`}
      label={label}
      hasDisabledButtons={hasDisabledButtons}
      onRemove={() => onRemove(track)}
    >
      <VideoPreview
        track={track}
        width={canvasWidth}
        height={canvasHeight}
        switchesDisabled={hasDisabledButtons}
        isMainDisplay={mainDisplay === track}
        isOverlay={overlay === track}
        onToggleMainDisplay={isSelected => onMainDisplayChanged(isSelected ? track : null) }
        onToggleOverlay={isSelected => onOverlayChanged(isSelected ? track : null) }
      />
    </PreviewCard>;

  return (
    <Flex direction="row" gap="size-100" justifyContent="center" wrap>
      {
        displayTracks.map((track, ix) => video_preview_card(track, `Screen capture ${ix}`, onRemoveDisplayTrack))
      }
      {
        videoTracks.map(track => video_preview_card(track, track.label, onRemoveVideoTrack))
      }
      {
        audioTracks.map(track =>
          <PreviewCard
            key={`preview-card-${track.id}`}
            label={track.label}
            hasDisabledButtons={hasDisabledButtons}
            onRemove={() => onRemoveAudioTrack(track)}
          >
            <AudioPreview
              track={track}
              width={canvasWidth}
              height={canvasHeight}
            />
          </PreviewCard>
        )
      }
    </Flex>
  );
}
