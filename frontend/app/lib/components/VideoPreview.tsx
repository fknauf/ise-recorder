'use client';

import { Flex, Switch } from "@adobe/react-spectrum";
import { useRef, ReactNode, useEffect } from "react";

export interface VideoPreviewProps {
  track: MediaStreamTrack | undefined,
  width: number
  height: number
  isMainDisplay: boolean,
  isOverlay: boolean,
  switchesDisabled: boolean,
  onToggleMainDisplay: (isSelected: boolean) => void,
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
  const videoRef = useRef<HTMLVideoElement>(null);

  // React doesn't currently allow setting the srcObject property directly through JSX,
  // so we have to do it with a useEffect hook.
  useEffect(() => {
    const currentVideo = videoRef.current;

    if(currentVideo !== null) {
      const trackStream = track ? new MediaStream([track]) : null;
      currentVideo.srcObject = trackStream;
    }
  }, [track])

  return (
    <Flex direction="column" gap="size-100">
      <video
        ref={videoRef}
        autoPlay
        muted
        width={width}
        height={height}
        className="video-preview"
      />

      <Flex direction="row" justifyContent="space-between">
        <Switch
          isDisabled={switchesDisabled}
          isSelected={isMainDisplay}
          onChange={onToggleMainDisplay}
        >
          Main Display
        </Switch>
        <Switch
          isDisabled={switchesDisabled}
          isSelected={isOverlay}
          onChange={onToggleOverlay}
        >
          Overlay
        </Switch>
      </Flex>
    </Flex>
  );
}
