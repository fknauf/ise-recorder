"use client";

import { Switch } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
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
    <div className={style({
      display: "flex",
      flexDirection: "column",
      gap: 8
    })}
    >
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

      <div className={style({
        display: "flex",
        flexDirection: "row",
        justifyContent: "space-between"
      })}
      >
        <Switch
          isDisabled={switchesDisabled}
          isSelected={isMainDisplay}
          onChange={onToggleMainDisplay}
          data-testid="vp-toggle-main"
        >
          Main Display
        </Switch>
        <Switch
          isDisabled={switchesDisabled}
          isSelected={isOverlay}
          onChange={onToggleOverlay}
          data-testid="vp-toggle-overlay"
        >
          Overlay
        </Switch>
      </div>
    </div>
  );
}
