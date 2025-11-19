'use client';

import { Flex, Switch } from "@adobe/react-spectrum";
import { useRef, ReactNode, useEffect } from "react";

export interface VideoPreviewProps {
    track: MediaStreamTrack | undefined,
    isMainDisplay: boolean,
    isOverlay: boolean,
    switchesDisabled: boolean,
    onToggleMainDisplay: (isSelected: boolean) => void,
    onToggleOverlay: (isSelected: boolean) => void
}

export default function VideoPreview(
    props: VideoPreviewProps
): ReactNode {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        const currentVideo = videoRef.current;

        if(currentVideo !== null) {
            const trackStream = props.track ? new MediaStream([props.track]) : null;
            currentVideo.srcObject = trackStream;
        }
    }, [videoRef, props.track])

    return (
        <Flex direction="column" gap="size-100">
            <video
                ref={videoRef}
                autoPlay
                muted
                width={384}
                height={216}
                style={{backgroundColor: "blue"}}
            />
            <Flex direction="row" justifyContent="space-between">
                <Switch
                    isDisabled={props.switchesDisabled}
                    isSelected={props.isMainDisplay}
                    onChange={props.onToggleMainDisplay}
                >
                    Main Display
                </Switch>
                <Switch
                    isDisabled={props.switchesDisabled}
                    isSelected={props.isOverlay}
                    onChange={props.onToggleOverlay}
                >
                    Overlay
                </Switch>
            </Flex>
        </Flex>
    );
}
