import { expect, test, vi } from "vitest";
import { appStoreWrapper } from "../helpers/appStore";
import { makeDevice } from "../helpers/media";
import { act, render, renderHook, screen } from "@testing-library/react";
import { useAppStore } from "@/lib/hooks/useAppStore";
import { RefreshEffect, useMediaDevices } from "@/lib/hooks/useMediaDevices";
import userEvent from "@testing-library/user-event";
import { useMediaTracks } from "@/lib/hooks/useMediaTracks";
import _ from "lodash";
import { showError } from "@/lib/utils/notifications";

// an explicit factory, so a failure path logs nothing and queues no toast outside a Provider
vi.mock("@/lib/utils/notifications");

const wrapper = appStoreWrapper();

const mockVideoDevices = [
  makeDevice("c1", "1", "videoinput", "Camera 1"),
  makeDevice("c2", "2", "videoinput", "Camera 2")
];

const mockAudioDevices = [
  makeDevice("m1", "1", "audioinput", "Microphone 1"),
  makeDevice("m2", "2", "audioinput", "Microphone 2"),
  makeDevice("m3", "3", "audioinput", "Microphone 3")
];

test("useMediaDevices().openDisplayStream works", async () => {
  const mockTrack = { label: "abc" };
  const mockStream = {
    getAudioTracks: vi.fn().mockReturnValue([]),
    getVideoTracks: vi.fn().mockReturnValue([ mockTrack ])
  };

  navigator.mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(mockStream);

  const TestComponent = () => {
    const { openDisplayStream } = useMediaDevices();
    const displayTracks = useAppStore(state => state.displayTracks);
    const mainDisplay = useAppStore(state => state.mainDisplay);
    const overlay = useAppStore(state => state.overlay);

    return (
      <>
        <button onClick={openDisplayStream}>Click</button>
        <ul>
          {displayTracks.map((track, ix) => <li key={ix}>{track.label}</li>)}
        </ul>
        <div data-testid="main">
          { mainDisplay?.label }
        </div>
        <div data-testid="overlay">
          { overlay?.label }
        </div>
      </>
    );
  };

  render(<TestComponent/>, { wrapper });

  const user = userEvent.setup();

  await user.click(await screen.findByRole("button"));
  const trackList = await screen.findAllByRole("listitem");

  expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledExactlyOnceWith();
  expect(trackList.length).toBe(1);
  expect(trackList[0]).toHaveTextContent(mockTrack.label);
  expect(await screen.findByTestId("main")).toHaveTextContent(mockTrack.label);
  expect(await screen.findByTestId("overlay")).toBeEmptyDOMElement();

  const mockTrack2 = { label: "def" };
  const mockStream2 = {
    getAudioTracks: vi.fn().mockReturnValue([]),
    getVideoTracks: vi.fn().mockReturnValue([ mockTrack2 ])
  };

  navigator.mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(mockStream2);

  await user.click(await screen.findByRole("button"));
  const trackList2 = await screen.findAllByRole("listitem");

  expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledExactlyOnceWith();
  expect(trackList2.length).toBe(2);
  expect(trackList2[0]).toHaveTextContent(mockTrack.label);
  expect(trackList2[1]).toHaveTextContent(mockTrack2.label);
  expect(await screen.findByTestId("main")).toHaveTextContent(mockTrack.label);
  expect(await screen.findByTestId("overlay")).toBeEmptyDOMElement();
});

test("useMediaDevices().openVideoStream works", async () => {
  const mockTracks = [
    {
      label: "abc",
      getSettings: (): MediaTrackSettings => ({
        groupId: "g1",
        deviceId: "d1"
      })
    },
    {
      label: "def",
      getSettings: (): MediaTrackSettings => ({
        groupId: "g2",
        deviceId: "d2"
      })
    }
  ];

  const mockStreams = [
    {
      getAudioTracks: vi.fn().mockReturnValue([]),
      getVideoTracks: vi.fn().mockReturnValue([ mockTracks[0] ])
    }, {
      getAudioTracks: vi.fn().mockReturnValue([]),
      getVideoTracks: vi.fn().mockReturnValue([ mockTracks[1] ])
    }
  ];

  navigator.mediaDevices.getUserMedia = vi.fn().mockImplementation(async (constraints: MediaStreamConstraints) => {
    if(_.isEqual(constraints, {
      video: {
        groupId: { exact: "g1" },
        deviceId: { exact: "d1" }
      },
      audio: false
    })) {
      return mockStreams[0];
    }

    if(_.isEqual(constraints, {
      video: {
        groupId: { exact: "g2" },
        deviceId: { exact: "d2" }
      },
      audio: false
    })) {
      return mockStreams[1];
    }

    throw new OverconstrainedError("");
  });

  const TestComponent = () => {
    const { openVideoStream } = useMediaDevices();
    const videoTracks = useAppStore(state => state.videoTracks);
    const mainDisplay = useAppStore(state => state.mainDisplay);
    const overlay = useAppStore(state => state.overlay);

    return (
      <>
        <button data-testid="btn1" onClick={() => openVideoStream({ groupId: "g1", deviceId: "d1" })}>Dev 1</button>
        <button data-testid="btn2" onClick={() => openVideoStream({ groupId: "g2", deviceId: "d2" })}>Dev 2</button>
        <ul>
          {videoTracks.map((track, ix) => <li key={ix}>{track.label}</li>)}
        </ul>
        <div data-testid="main">
          { mainDisplay?.label }
        </div>
        <div data-testid="overlay">
          { overlay?.label }
        </div>
      </>
    );
  };

  render(<TestComponent/>, { wrapper });

  const user = userEvent.setup();

  await user.click(await screen.findByTestId("btn1"));

  let trackList = await screen.findAllByRole("listitem");

  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({
    video: {
      groupId: { exact: "g1" },
      deviceId: { exact: "d1" }
    },
    audio: false
  });
  expect(trackList.length).toBe(1);
  expect(trackList[0]).toHaveTextContent(mockTracks[0].label);
  expect(await screen.findByTestId("main")).toBeEmptyDOMElement();
  expect(await screen.findByTestId("overlay")).toHaveTextContent(mockTracks[0].label);

  await user.click(await screen.findByTestId("btn1"));

  trackList = await screen.findAllByRole("listitem");
  expect(trackList.length).toBe(1);


  await user.click(await screen.findByTestId("btn2"));

  trackList = await screen.findAllByRole("listitem");
  expect(trackList.length).toBe(2);
  expect(trackList[0]).toHaveTextContent(mockTracks[0].label);
  expect(trackList[1]).toHaveTextContent(mockTracks[1].label);
  expect(await screen.findByTestId("main")).toBeEmptyDOMElement();
  expect(await screen.findByTestId("overlay")).toHaveTextContent(mockTracks[0].label);
});

test("useMediaDevices().openAudioStream works", async () => {
  const mockTracks = [
    {
      label: "abc",
      getSettings: (): MediaTrackSettings => ({
        groupId: "g1",
        deviceId: "d1"
      })
    },
    {
      label: "def",
      getSettings: (): MediaTrackSettings => ({
        groupId: "g2",
        deviceId: "d2"
      })
    }
  ];

  const mockStreams = [
    { getAudioTracks: vi.fn().mockReturnValue([ mockTracks[0] ]) },
    { getAudioTracks: vi.fn().mockReturnValue([ mockTracks[1] ]) }
  ];

  navigator.mediaDevices.getUserMedia = vi.fn().mockImplementation(async (constraints: MediaStreamConstraints) => {
    if(_.isEqual(constraints, {
      video: false,
      audio: {
        groupId: { exact: "g1" },
        deviceId: { exact: "d1" }
      }
    })) {
      return mockStreams[0];
    }

    if(_.isEqual(constraints, {
      video: false,
      audio: {
        groupId: { exact: "g2" },
        deviceId: { exact: "d2" }
      }
    })) {
      return mockStreams[1];
    }

    throw new OverconstrainedError("");
  });

  const TestComponent = () => {
    const { openAudioStream } = useMediaDevices();
    const audioTracks = useAppStore(state => state.audioTracks);
    const mainDisplay = useAppStore(state => state.mainDisplay);
    const overlay = useAppStore(state => state.overlay);

    return (
      <>
        <button data-testid="btn1" onClick={() => openAudioStream({ groupId: "g1", deviceId: "d1" })}>Dev 1</button>
        <button data-testid="btn2" onClick={() => openAudioStream({ groupId: "g2", deviceId: "d2" })}>Dev 2</button>
        <ul>
          {audioTracks.map((track, ix) => <li key={ix}>{track.label}</li>)}
        </ul>
        <div data-testid="main">
          { mainDisplay?.label }
        </div>
        <div data-testid="overlay">
          { overlay?.label }
        </div>
      </>
    );
  };

  render(<TestComponent/>, { wrapper });

  const user = userEvent.setup();

  await user.click(await screen.findByTestId("btn1"));

  let trackList = await screen.findAllByRole("listitem");

  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({
    video: false,
    audio: {
      groupId: { exact: "g1" },
      deviceId: { exact: "d1" }
    }
  });
  expect(trackList.length).toBe(1);
  expect(trackList[0]).toHaveTextContent(mockTracks[0].label);
  expect(await screen.findByTestId("main")).toBeEmptyDOMElement();
  expect(await screen.findByTestId("overlay")).toBeEmptyDOMElement();

  await user.click(await screen.findByTestId("btn1"));

  trackList = await screen.findAllByRole("listitem");
  expect(trackList.length).toBe(1);


  await user.click(await screen.findByTestId("btn2"));

  trackList = await screen.findAllByRole("listitem");
  expect(trackList.length).toBe(2);
  expect(trackList[0]).toHaveTextContent(mockTracks[0].label);
  expect(trackList[1]).toHaveTextContent(mockTracks[1].label);
  expect(await screen.findByTestId("main")).toBeEmptyDOMElement();
  expect(await screen.findByTestId("overlay")).toBeEmptyDOMElement();
});

// --- what a refresh reports ------------------------------------------------
//
// The device menus close again when a refresh already added what the user picked in the
// browser's permission prompt; RecorderControls.test.tsx pins that side. These pin what
// the refresh reports on each of its paths.

function permissionsAre(state: PermissionState) {
  navigator.permissions.query = vi.fn().mockImplementation(
    async (desc: PermissionDescriptor): Promise<PermissionStatus> => ({
      state,
      name: desc.name,
      onchange: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  );
}

const aStream = () => ({
  getTracks: vi.fn().mockReturnValue([ { stop: vi.fn() } ]),
  getVideoTracks: vi.fn().mockReturnValue([ { label: "camera track" } ]),
  getAudioTracks: vi.fn().mockReturnValue([ { label: "microphone track" } ])
});

async function refreshed(refresh: () => Promise<RefreshEffect>) {
  let effect: RefreshEffect | undefined;
  await act(async () => {
    effect = await refresh();
  });
  return effect;
}

test("a refresh that asked for permission reports the devices it added", async () => {
  permissionsAre("prompt");
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(aStream());
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);

  const { result } = renderHook(() => ({ ...useMediaDevices(), ...useMediaTracks() }), { wrapper });

  expect(await refreshed(result.current.refreshMediaDevices)).toBe("added-tracks");
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: true });
  // and it did add them: the report is about what happened, not a guess
  expect(result.current.videoTracks.map(t => t.label)).toStrictEqual([ "camera track" ]);
  expect(result.current.audioTracks.map(t => t.label)).toStrictEqual([ "microphone track" ]);
  expect(result.current.videoDevices).toStrictEqual(mockVideoDevices);
  expect(result.current.audioDevices).toStrictEqual(mockAudioDevices);
});

test("a first refresh with permissions already granted only lists devices", async () => {
  // it still opens a stream to be allowed to read the labels, but closes it again: the
  // user picked nothing, so the menu is where they will
  permissionsAre("granted");
  const stream = aStream();
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(stream);
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);

  const { result } = renderHook(() => ({ ...useMediaDevices(), ...useMediaTracks() }), { wrapper });

  expect(await refreshed(result.current.refreshMediaDevices)).toBe("just-refreshed");
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: true });
  for(const track of stream.getTracks()) {
    expect(track.stop).toHaveBeenCalled();
  }
  expect(result.current.videoTracks).toStrictEqual([]);
  expect(result.current.videoDevices).toStrictEqual(mockVideoDevices);
  expect(result.current.audioDevices).toStrictEqual(mockAudioDevices);
});

test("a later refresh that needs no permission only lists devices", async () => {
  permissionsAre("granted");
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(aStream());
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);

  const { result } = renderHook(() => useMediaDevices(), { wrapper });
  await refreshed(result.current.refreshMediaDevices);

  expect(await refreshed(result.current.refreshMediaDevices)).toBe("just-refreshed");
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  // the list itself is fetched every time: a device may have been plugged in since
  expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
});

test("a refused permission prompt adds nothing and says so", async () => {
  permissionsAre("prompt");
  navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([]);

  const { result } = renderHook(() => ({ ...useMediaDevices(), ...useMediaTracks() }), { wrapper });

  // nothing was added, so the menu stays: it is the one place the user can still try again
  expect(await refreshed(result.current.refreshMediaDevices)).toBe("just-refreshed");
  expect(showError).toHaveBeenCalledWith("Could not obtain device permissions", expect.anything());
  expect(result.current.videoTracks).toStrictEqual([]);
});

// --- what a refresh asks the browser for ------------------------------------

test("a refresh does not ask for a device whose permission was denied", async () => {
  // asking again would only fail, and take the microphone down with it
  navigator.permissions.query = vi.fn().mockImplementation(
    async (desc: PermissionDescriptor): Promise<PermissionStatus> => ({
      state: desc.name === "camera" ? "denied" : "prompt",
      name: desc.name,
      onchange: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  );
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(aStream());
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue(mockAudioDevices);

  const { result } = renderHook(() => useMediaDevices(), { wrapper });
  await refreshed(result.current.refreshMediaDevices);

  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: false, audio: true });
});

// Firefox reports "granted" for a permission the user granted only temporarily, and then asks
// again anyway. So a first refresh with everything granted may still have put a prompt in front
// of the user, in which case they picked devices there. The hook tells by how long the request
// took: a prompt takes a person, an answer from the browser alone a few milliseconds.

/** A getUserMedia that takes `millis` of the clock the hook measures with. */
function getUserMediaTaking(millis: number) {
  vi.useFakeTimers({ toFake: [ "Date" ] });
  return vi.fn().mockImplementation(async () => {
    vi.setSystemTime(Date.now() + millis);
    return aStream();
  });
}

test.each([
  [ "Firefox, which may have asked anyway", "Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0", "added-tracks" ],
  [ "any other browser, which would have said so", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", "just-refreshed" ]
])("a slow first refresh with permissions granted is taken for a prompt only on %s", async (_label, userAgent, effect) => {
  permissionsAre("granted");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  navigator.mediaDevices.getUserMedia = getUserMediaTaking(2000);
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);

  const { result } = renderHook(() => ({ ...useMediaDevices(), ...useMediaTracks() }), { wrapper });

  expect(await refreshed(result.current.refreshMediaDevices)).toBe(effect);
  expect(result.current.videoTracks.length).toBe(effect === "added-tracks" ? 1 : 0);
});

test("a quick first refresh in Firefox is not taken for a prompt", async () => {
  // the browser answered by itself, so nobody picked anything
  permissionsAre("granted");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0");
  navigator.mediaDevices.getUserMedia = getUserMediaTaking(20);
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);

  const { result } = renderHook(() => ({ ...useMediaDevices(), ...useMediaTracks() }), { wrapper });

  expect(await refreshed(result.current.refreshMediaDevices)).toBe("just-refreshed");
  expect(result.current.videoTracks).toStrictEqual([]);
});

test("a device list the browser will not give out is reported, and what was there stays", async () => {
  permissionsAre("granted");
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(aStream());
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValueOnce([ ...mockVideoDevices, ...mockAudioDevices ]);

  const { result } = renderHook(() => useMediaDevices(), { wrapper });
  await refreshed(result.current.refreshMediaDevices);

  vi.mocked(navigator.mediaDevices.enumerateDevices).mockRejectedValue(new DOMException("gone", "InvalidStateError"));

  expect(await refreshed(result.current.refreshMediaDevices)).toBe("just-refreshed");
  expect(showError).toHaveBeenCalledOnce();
  expect(result.current.videoDevices).toStrictEqual(mockVideoDevices);
});

// --- opening a source that the user or the browser turns down ---------------

test("a screen picker the user cancels adds nothing and is reported", async () => {
  navigator.mediaDevices.getDisplayMedia = vi.fn().mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));

  const { result } = renderHook(() => ({ ...useMediaDevices(), ...useMediaTracks() }), { wrapper });
  await act(() => result.current.openDisplayStream());

  expect(showError).toHaveBeenCalledOnce();
  expect(result.current.displayTracks).toStrictEqual([]);
  expect(result.current.mainDisplay).toBeUndefined();
});

test.each([
  [ "camera", "openVideoStream", "videoTracks" ],
  [ "microphone", "openAudioStream", "audioTracks" ]
] as const)("a %s that cannot be opened adds nothing and is reported", async (_label, open, tracks) => {
  // unplugged since the menu was filled, or held by another program
  navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(new DOMException("busy", "NotReadableError"));

  const { result } = renderHook(() => ({ ...useMediaDevices(), ...useMediaTracks() }), { wrapper });
  await act(() => result.current[open]({ groupId: "g1", deviceId: "d1" }));

  expect(showError).toHaveBeenCalledOnce();
  expect(result.current[tracks]).toStrictEqual([]);
});
