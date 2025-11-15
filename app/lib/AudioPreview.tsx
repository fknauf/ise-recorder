'use client';

import { Key } from "@adobe/react-spectrum";
import { useRef, ReactNode, useEffect } from "react";


export interface AudioPreviewProps {
    deviceId: Key,
    track: MediaStreamTrack | undefined
}

export default function AudioPreview(
    props: AudioPreviewProps
): ReactNode {
    const canvasElement = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if(!props.track) {
            return;
        }

        const audioContext = new AudioContext();
        const audioAnalyzer = audioContext.createAnalyser();
        audioAnalyzer.fftSize = 512;

        const audioSource = audioContext.createMediaStreamSource(new MediaStream([props.track]))
        audioSource.connect(audioAnalyzer);

        const data = new Uint8Array(audioAnalyzer.frequencyBinCount);
        let timerId: number;

        const renderFunction = () => {
            const currentCanvas = canvasElement.current;

            if(currentCanvas) {
                timerId = requestAnimationFrame(renderFunction);
                audioAnalyzer.getByteFrequencyData(data);

                currentCanvas.width = 384;
                currentCanvas.height = 216;

                const ctx = currentCanvas.getContext('2d');
                if(ctx) {
                    ctx.fillStyle = 'white';
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = '#d5d4d5';
                    const space = currentCanvas.width / data.length;
                    ctx.clearRect(0, 0, currentCanvas.width, currentCanvas.height);

                    data.forEach((value: number, i : number) => {
                        ctx.beginPath();
                        ctx.moveTo(space * i, currentCanvas.height);
                        ctx.lineTo(space * i, currentCanvas.height - value);
                        ctx.stroke();
                    });
                }
            }
        };

        timerId = requestAnimationFrame(renderFunction);
        return () => cancelAnimationFrame(timerId);
    }, [props.deviceId, props.track]);

    return (
        <div>
            <canvas
                ref={canvasElement}
                width={384}
                height={216}
            />
        </div>
    );
}