'use client';

import { useRef, ReactNode, useEffect } from "react";

export interface AudioPreviewProps {
  track: MediaStreamTrack | undefined
  width: number
  height: number
}

/**
 * Preview canvas for an audio stream. Paints the FFT spectrum as a histogram.
 *
 * This is mostly meant to give visual feedback that the microphone is working and
 * whether its volume setting is okay.
 */
export function AudioPreview(
  { track, width, height }: Readonly<AudioPreviewProps>
): ReactNode {
  const canvasElement = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if(!track) {
      return;
    }

    // Hook up the audio track to an analyzer node to get the FFT spectrum and the time domain
    // values for clipping detection
    const audioContext = new AudioContext();
    const audioAnalyzer = audioContext.createAnalyser();
    const audioSource = audioContext.createMediaStreamSource(new MediaStream([track]))

    audioAnalyzer.fftSize = 512;
    audioAnalyzer.maxDecibels = 0;
    audioSource.connect(audioAnalyzer);

    const freqData = new Uint8Array(audioAnalyzer.frequencyBinCount);
    const timeData = new Uint8Array(audioAnalyzer.fftSize);

    // Animation is done through a rendering function that schedules itself again and again until
    // the component is unmounted.
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

      // paint spectum as a histrogram. Use the warning color iff audio is clipping.
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