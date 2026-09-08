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

  return (
    <Flex direction="row" gap="size-100" justifyContent="center" wrap>
      {
        // Screen capture tracks have confusing labels in chromium, so for them we just show a
        // generic label. Webcams provide the device name, which is useful to show to the user.
        [
          ...displayTracks.map((track, ix) => [ track, `Screen capture ${ix}` ] as const),
          ...videoTracks.map(track => [ track, track.label ] as const)
        ].map(([ track, label ]) =>
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
          </PreviewCard>
        )
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
