'use client';

import { useRef, ReactNode, useEffect } from "react";

export interface AudioPreviewProps {
  track: MediaStreamTrack | undefined
  width: number
  height: number
}

export function AudioPreview(
  { track, width, height }: AudioPreviewProps
): ReactNode {
  const canvasElement = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if(!track) {
      return;
    }

    const audioContext = new AudioContext();
    const audioAnalyzer = audioContext.createAnalyser();
    const audioSource = audioContext.createMediaStreamSource(new MediaStream([track]))

    audioAnalyzer.fftSize = 512;
    audioAnalyzer.maxDecibels = 0;
    audioSource.connect(audioAnalyzer);

    const freqData = new Uint8Array(audioAnalyzer.frequencyBinCount);
    const timeData = new Uint8Array(audioAnalyzer.fftSize);

    let timerId: number;

    const renderFunction = () => {
      timerId = requestAnimationFrame(renderFunction);

      const canvas = canvasElement.current;
      const ctx = canvas?.getContext('2d');

      if(!canvas || !ctx) {
        return;
      }

      audioAnalyzer.getByteFrequencyData(freqData);
      audioAnalyzer.getByteTimeDomainData(timeData);

      const space = canvas.width / freqData.length;
      const isClipping = timeData.some(v => v <= 5 || v >= 250);

      ctx.lineWidth = Math.ceil(space);
      ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue(isClipping ? '--warning' : '--foreground');

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for(const [ i, value ] of freqData.entries()) {
        ctx.beginPath();
        ctx.moveTo(space * i, canvas.height);
        ctx.lineTo(space * i, canvas.height - (value * canvas.height / 255));
        ctx.stroke();
      }
    };

    timerId = requestAnimationFrame(renderFunction);
    return () => cancelAnimationFrame(timerId);
  }, [track]);

  return (
    <div>
      <canvas
        ref={canvasElement}
        width={width}
        height={height}
      />
    </div>
  );
}