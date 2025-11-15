'use client';

import { Key } from "@adobe/react-spectrum";
import { useRef, ReactNode, useEffect } from "react";
import { Flex, Text } from '@adobe/react-spectrum';

export interface VideoPreviewProps {
    deviceId: Key,
    track: MediaStreamTrack | undefined
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
        <video
            ref={videoRef}
            autoPlay={true}
            muted={true}
            id={`video-preview-${props.deviceId}`}
            width={384}
            height={216}
            style={{backgroundColor: "blue"}}
        />
    )
}
