"use client";

import { ReactNode } from "react";
import { ActionButton, Flex, Text, View } from "@adobe/react-spectrum";
import { VideoPreview } from "./VideoPreview";
import { AudioPreview } from "./AudioPreview";
import { useMediaTracks } from "../hooks/useMediaTracks";
import { useActiveRecording } from "../hooks/useActiveRecording";

interface PreviewCardProps {
  label: string | undefined
  hasDisabledButtons: boolean
  onRemove: () => void
  children: ReactNode
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
      <ActionButton marginTop="auto" onPress={onRemove} isDisabled={hasDisabledButtons}>Remove</ActionButton>
    </Flex>
  </View>;

/**
 * Previews section on the main page, basically a collection of preview cards for all active streams.
 */
export interface PreviewSectionProps {
  canvasWidth: number
  canvasHeight: number
}

export function PreviewSection(
  {
    canvasWidth,
    canvasHeight
  }: Readonly<PreviewSectionProps>
) {
  const {
    displayTracks,
    videoTracks,
    audioTracks,
    mainDisplay,
    overlay,
    selectMainDisplay,
    selectOverlay,
    removeTrack
  } = useMediaTracks();

  const activeRecording = useActiveRecording();

  const hasDisabledButtons = activeRecording.state !== "idle";

  const video_preview_card = (track: MediaStreamTrack, label: string) =>
    <PreviewCard
      key={`preview-card-${track.id}`}
      label={label}
      hasDisabledButtons={hasDisabledButtons}
      onRemove={() => removeTrack(track)}
    >
      <VideoPreview
        track={track}
        width={canvasWidth}
        height={canvasHeight}
        switchesDisabled={hasDisabledButtons}
        isMainDisplay={mainDisplay === track}
        isOverlay={overlay === track}
        onToggleMainDisplay={isSelected => selectMainDisplay(isSelected ? track : undefined)}
        onToggleOverlay={isSelected => selectOverlay(isSelected ? track : undefined)}
      />
    </PreviewCard>;

  return (
    <Flex direction="row" gap="size-100" justifyContent="center" wrap>
      {
        displayTracks.map((track, ix) => video_preview_card(track, `Screen capture ${ix}`))
      }
      {
        videoTracks.map(track => video_preview_card(track, track.label))
      }
      {
        audioTracks.map(track =>
          <PreviewCard
            key={`preview-card-${track.id}`}
            label={track.label}
            hasDisabledButtons={hasDisabledButtons}
            onRemove={() => removeTrack(track)}
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
