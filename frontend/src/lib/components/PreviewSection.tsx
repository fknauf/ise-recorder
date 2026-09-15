"use client";

import { ReactNode } from "react";
import { ActionButton, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
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
  <div className={style({
    borderStyle: "solid",
    borderRadius: "lg",
    borderWidth: 1,
    borderColor: "gray-300",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: 8
  })}
  >
    <div className={style({
      display: "flex",
      flexDirection: "column",
      gap: 8,
      height: "100%",
      justifyContent: "start"
    })}
    >
      <Text>{label}</Text>
      {children}
    </div>
    <ActionButton
      onPress={onRemove}
      isDisabled={hasDisabledButtons}
      styles={style({ width: "100%" })}
    >Remove
    </ActionButton>
  </div>;

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
    <div className={style({
      display: "flex",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      justifyContent: "center"
    })}
    >
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
    </div>
  );
}
