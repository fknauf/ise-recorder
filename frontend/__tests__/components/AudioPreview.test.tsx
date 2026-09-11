import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import { AudioPreview } from "@/lib/components/AudioPreview";

/**
 * The spectrum is driven by real WebAudio nodes, so rather than feed it sound and
 * compare pixels, the analyser is stubbed to return chosen samples and the 2D context
 * is wrapped to record what gets drawn. That keeps the assertions about behaviour --
 * which colour, which bar heights, how many contexts -- rather than about exact output.
 */

interface DrawnLine {
  x: number
  y: number
  strokeStyle: string
}

interface CanvasSpy {
  lines: DrawnLine[]
  clears: number
}

let canvasSpy: CanvasSpy;
let restoreGetContext: () => void;
let audioContexts: AudioContext[];
let closedContexts: number;

/** Make the analyser report exactly these bytes, so drawing is a pure function of them. */
function stubAnalyser(frequencyBytes: number[], timeDomainBytes: number[]) {
  vi.spyOn(AnalyserNode.prototype, "getByteFrequencyData")
    .mockImplementation((array: Uint8Array) => {
      array.set(frequencyBytes.slice(0, array.length));
    });

  vi.spyOn(AnalyserNode.prototype, "getByteTimeDomainData")
    .mockImplementation((array: Uint8Array) => {
      array.fill(timeDomainBytes[0] ?? 128);
      timeDomainBytes.slice(0, array.length).forEach((value, index) => {
        array[index] = value;
      });
    });
}

/** Silence: every frequency bin empty, time domain sitting at the midpoint. */
const SILENT_FREQUENCIES = new Array(256).fill(0);
const CENTRED_TIME_DOMAIN = [ 128 ];

beforeEach(() => {
  canvasSpy = { lines: [], clears: 0 };
  audioContexts = [];
  closedContexts = 0;

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalClose = AudioContext.prototype.close;

  // record the drawing calls instead of inspecting pixels
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: Parameters<HTMLCanvasElement["getContext"]>
  ) {
    const context = originalGetContext.apply(this, args) as CanvasRenderingContext2D | null;

    if(context === null || args[0] !== "2d") {
      return context;
    }

    return new Proxy(context, {
      get(target, property) {
        if(property === "lineTo") {
          return (x: number, y: number) => {
            canvasSpy.lines.push({ x, y, strokeStyle: String(target.strokeStyle) });
          };
        }

        if(property === "clearRect") {
          return () => {
            canvasSpy.clears += 1;
          };
        }

        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value);
      }
    });
  } as HTMLCanvasElement["getContext"]);

  vi.spyOn(AudioContext.prototype, "close").mockImplementation(function (this: AudioContext) {
    closedContexts += 1;
    return originalClose.call(this);
  });

  const OriginalAudioContext = window.AudioContext;
  class CountingAudioContext extends OriginalAudioContext {
    constructor() {
      super();
      audioContexts.push(this);
    }
  }
  window.AudioContext = CountingAudioContext as unknown as typeof AudioContext;

  restoreGetContext = () => {
    window.AudioContext = OriginalAudioContext;
  };
});

afterEach(async () => {
  restoreGetContext();
  vi.restoreAllMocks();
});

/** One track from a real audio graph, which is what the component is handed in the app. */
function audioTrack(): { track: MediaStreamTrack; dispose: () => Promise<void> } {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  return {
    track: destination.stream.getAudioTracks()[0],
    dispose: () => context.close()
  };
}

/** Render, let the 30fps loop paint at least once, and hand back the render result. */
async function renderPreview() {
  const { track, dispose } = audioTrack();
  const rendered = render(<AudioPreview track={track} width={256} height={100}/>);

  await vi.waitFor(() => expect(canvasSpy.lines.length).toBeGreaterThan(0), { timeout: 2000 });

  return { ...rendered, track, dispose };
}

// --- the visual contract ---------------------------------------------------

test("bar height scales with the level in each frequency bin", async () => {
  // a ramp across the bins: later bins are louder, so their bars must reach higher
  stubAnalyser(new Array(256).fill(0)
    .map((_, index) => index), CENTRED_TIME_DOMAIN);

  const { dispose } = await renderPreview();

  try {
    const firstFrame = canvasSpy.lines.slice(0, 256);
    expect(firstFrame.length).toBeGreaterThan(2);

    // y counts down from the top, so a louder bin means a smaller y
    const quiet = firstFrame[10];
    const loud = firstFrame[200];
    expect(loud.y).toBeLessThan(quiet.y);

    // a silent bin draws no bar at all: it starts and ends at the baseline
    expect(firstFrame[0].y).toBe(100);
  } finally {
    dispose();
  }
});

test("a silent input draws a flat baseline rather than nothing at all", async () => {
  stubAnalyser(SILENT_FREQUENCIES, CENTRED_TIME_DOMAIN);

  const { dispose } = await renderPreview();

  try {
    const firstFrame = canvasSpy.lines.slice(0, 256);
    // every bar is zero-height, so the user still sees the canvas is live
    expect(firstFrame.every(line => line.y === 100)).toBe(true);
  } finally {
    dispose();
  }
});

test("clipping audio is drawn in the warning colour", async () => {
  document.body.style.setProperty("--foreground", "rgb(1, 2, 3)");
  document.body.style.setProperty("--warning", "rgb(9, 8, 7)");

  // a sample pinned near the rail is what clipping looks like in the time domain
  stubAnalyser(new Array(256).fill(120), [ 251 ]);

  const { dispose } = await renderPreview();

  try {
    expect(canvasSpy.lines[0].strokeStyle).toBe("#090807");
  } finally {
    dispose();
  }
});

test("audio within range is drawn in the foreground colour", async () => {
  document.body.style.setProperty("--foreground", "rgb(1, 2, 3)");
  document.body.style.setProperty("--warning", "rgb(9, 8, 7)");

  stubAnalyser(new Array(256).fill(120), [ 130 ]);

  const { dispose } = await renderPreview();

  try {
    expect(canvasSpy.lines[0].strokeStyle).toBe("#010203");
  } finally {
    dispose();
  }
});

test("the canvas is cleared before each frame rather than drawn over", async () => {
  stubAnalyser(new Array(256).fill(40), CENTRED_TIME_DOMAIN);

  const { dispose } = await renderPreview();

  try {
    await vi.waitFor(() => expect(canvasSpy.clears).toBeGreaterThan(1), { timeout: 2000 });
  } finally {
    dispose();
  }
});

// --- the resource contract -------------------------------------------------

test("mounting builds exactly one AudioContext for the track", async () => {
  stubAnalyser(SILENT_FREQUENCIES, CENTRED_TIME_DOMAIN);

  const { dispose } = await renderPreview();

  try {
    // one for the track fixture, one for the component -- and no more. Browsers cap
    // concurrent AudioContexts at around six, so a per-render context would break the
    // preview as soon as a few microphones are added.
    expect(audioContexts.length).toBe(2);
  } finally {
    dispose();
  }
});

test("re-rendering with the same track reuses the audio graph", async () => {
  stubAnalyser(SILENT_FREQUENCIES, CENTRED_TIME_DOMAIN);

  const { track, rerender, dispose } = await renderPreview();

  try {
    const createdBefore = audioContexts.length;
    const closedBefore = closedContexts;
    rerender(<AudioPreview track={track} width={256} height={100}/>);
    rerender(<AudioPreview track={track} width={256} height={100}/>);

    // The React Compiler memoises attachRenderLoop on `track`, so its identity survives a
    // re-render and React leaves the ref attached. Otherwise the graph is torn down and
    // rebuilt every time: PreviewSection re-renders on every store change, which during a
    // recording is once per chunk, and browsers cap concurrent AudioContexts at around
    // six -- each new one is created before the old finishes closing.
    //
    // This only holds because vitest.config.mts runs the compiler too, via the same babel
    // plugin next build uses. With a plain react() the suite runs un-compiled and this
    // fails, which is what made a redundant useCallback here look load-bearing.
    expect({
      created: audioContexts.length - createdBefore,
      closed: closedContexts - closedBefore
    }).toStrictEqual({ created: 0, closed: 0 });
  } finally {
    dispose();
  }
});

test("switching to a different track rebuilds the graph on the new one", async () => {
  stubAnalyser(SILENT_FREQUENCIES, CENTRED_TIME_DOMAIN);

  const { rerender, dispose } = await renderPreview();
  const replacement = audioTrack();

  try {
    const createdBefore = audioContexts.length;
    const closedBefore = closedContexts;

    rerender(<AudioPreview track={replacement.track} width={256} height={100}/>);

    // the other half of the contract: reuse must not go so far that a track change is
    // ignored, or the preview would keep drawing the microphone the user just swapped away
    expect(audioContexts.length).toBeGreaterThan(createdBefore);
    expect(closedContexts).toBe(closedBefore + 1);
  } finally {
    await replacement.dispose();
    dispose();
  }
});

test("unmounting closes the AudioContext and stops the render loop", async () => {
  stubAnalyser(SILENT_FREQUENCIES, CENTRED_TIME_DOMAIN);

  const { unmount, dispose } = await renderPreview();

  try {
    const closedBefore = closedContexts;
    unmount();

    expect(closedContexts).toBe(closedBefore + 1);

    const drawnAtUnmount = canvasSpy.lines.length;
    await new Promise(resolve => setTimeout(resolve, 200));

    // the 30fps interval would have painted several more frames by now
    expect(canvasSpy.lines.length).toBe(drawnAtUnmount);
  } finally {
    dispose();
  }
});
