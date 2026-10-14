"use client";

import { ReactNode } from "react";
import { VideoPreview } from "./VideoPreview";
import { AudioPreview } from "./AudioPreview";
import { useMediaTracks } from "../hooks/useMediaTracks";
import { useActiveRecording } from "../hooks/useActiveRecording";
import { Card, CloseButton, Group, Stack, Text, Tooltip, useMantineTheme } from "@mantine/core";

interface PreviewCardProps {
  label: string | undefined
  hasDisabledButtons: boolean
  canvasWidth: number
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
    canvasWidth,
    onRemove,
    children
  }: Readonly<PreviewCardProps>
) => {
  const theme = useMantineTheme();

  return (
    <Card withBorder shadow="sm" padding="sm">
      <Stack justify="flex-start" align="stretch" gap="sm">
        <Group justify="space-between" align="flex-start" maw={canvasWidth} wrap="nowrap">
          <Tooltip label={label} withArrow color={theme.primaryColor}>
            <Text truncate="end">{label}</Text>
          </Tooltip>
          <CloseButton
            onClick={onRemove}
            aria-label="Close"
            data-testid="ps-btn-remove"
            disabled={hasDisabledButtons}
          />
        </Group>
        {children}
      </Stack>
    </Card>
  );
};
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
    <Group justify="center" wrap="wrap" align="stretch">
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
            canvasWidth={canvasWidth}
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
            canvasWidth={canvasWidth}
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
    </Group>
  );
}
