'use client';

import { useRef, ReactNode, useEffect } from "react";

export interface AudioPreviewProps {
  track: MediaStreamTrack | undefined
}

export function AudioPreview(
  { track }: AudioPreviewProps
): ReactNode {
  const canvasElement = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if(!track) {
      return;
    }

    const audioContext = new AudioContext();
    const audioAnalyzer = audioContext.createAnalyser();
    audioAnalyzer.fftSize = 512;

    const audioSource = audioContext.createMediaStreamSource(new MediaStream([track]))
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
        const space = currentCanvas.width / data.length;
        ctx.lineWidth = space;
        ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--foreground');

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
  }, [track]);

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