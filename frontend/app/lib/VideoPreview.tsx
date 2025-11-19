'use client';

import { useRef, ReactNode, useEffect } from "react";

export interface VideoPreviewProps {
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
            autoPlay
            muted
            width={384}
            height={216}
            style={{backgroundColor: "blue"}}
        />
    )
}
