"use client";

import { Card, Group, Stack, Switch } from "@mantine/core";
import { ReactNode } from "react";

export interface VideoPreviewProps {
  track: MediaStreamTrack
  width: number
  height: number
  isMainDisplay: boolean
  isOverlay: boolean
  switchesDisabled: boolean
  onToggleMainDisplay: (isSelected: boolean) => void
  onToggleOverlay: (isSelected: boolean) => void
}

/**
 * Preview for a video track. Shows the video and switches to mark it as main display or overlay.
 */
export function VideoPreview(
  {
    track,
    width,
    height,
    isMainDisplay,
    isOverlay,
    switchesDisabled,
    onToggleMainDisplay,
    onToggleOverlay
  }: Readonly<VideoPreviewProps>
): ReactNode {
  const attachStream = (ref: HTMLVideoElement | null) => {
    if(ref !== null) {
      ref.srcObject = new MediaStream([track]);
    }
  };

  return (
    <Stack gap="sm">
      <Card.Section>
        <video
          ref={attachStream}
          autoPlay
          muted
          width={width}
          height={height}
          className="video-preview"
          data-testid="preview-video"
          role="img"
        />
      </Card.Section>

      <Group justify="space-between">
        <Switch
          disabled={switchesDisabled}
          checked={isMainDisplay}
          onChange={event => onToggleMainDisplay(event.currentTarget.checked)}
          data-testid="vp-toggle-main"
          label="Main Display"
        />
        <Switch
          disabled={switchesDisabled}
          checked={isOverlay}
          onChange={event => onToggleOverlay(event.currentTarget.checked)}
          data-testid="vp-toggle-overlay"
          label="Overlay"
        />
      </Group>
    </Stack>
  );
}
