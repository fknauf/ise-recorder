import { expect, test, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { AppStoreProvider, useAppStore } from "@/app/lib/hooks/useAppStore";
import { ReactNode, useEffect } from "react";
import { useMediaDevices } from "@/app/lib/hooks/useMediaDevices";
import userEvent from "@testing-library/user-event";
import { useMediaTracks } from "@/app/lib/hooks/useMediaTracks";

const wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
  <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
    {children}
  </AppStoreProvider>;

const makeDevice = (deviceId: string, groupId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo => ({
  deviceId, groupId, kind, label,
  toJSON: () => JSON.stringify({ deviceId, groupId, kind, label })
});

const mockVideoDevices = [
  makeDevice("c1", "1", "videoinput", "Camera 1"),
  makeDevice("c2", "2", "videoinput", "Camera 2")
];

const mockAudioDevices = [
  makeDevice("m1", "1", "audioinput", "Microphone 1"),
  makeDevice("m2", "2", "audioinput", "Microphone 2"),
  makeDevice("m3", "3", "audioinput", "Microphone 3")
];

test("useMediaDevices handles store data", async () => {
  const { result } = renderHook(() => {
    const setMediaDevices = useAppStore(state => state.setMediaDevices);

    useEffect(() => {
      setMediaDevices(mockVideoDevices.concat(mockAudioDevices));
    }, [ setMediaDevices ]);

    return useMediaDevices();
  }, { wrapper });

  await waitFor(() => {
    expect(result.current.videoDevices).toStrictEqual(mockVideoDevices);
    expect(result.current.audioDevices).toStrictEqual(mockAudioDevices);
  });
});


test("useMediaDevices().refreshMediaDevices opens streams before enumerating the first time", async () => {
  navigator.permissions.query = vi.fn().mockImplementation(
    async (desc: PermissionDescriptor): Promise<PermissionStatus> => ({
      state: "granted",
      name: desc.name,
      onchange: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  );

  const onStopTrack = vi.fn();
  const mockTrack = { stop: onStopTrack };
  const mockStream = { getTracks: vi.fn().mockReturnValue([ mockTrack, mockTrack ]) };

  mockTrack.stop = onStopTrack;

  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(mockStream);

  const TestComponent = () => {
    const {
      videoDevices,
      audioDevices,
      refreshMediaDevices
    } = useMediaDevices();

    return (
      <>
        <button role="button" onClick={refreshMediaDevices}>Click</button>
        <ul role="list">
          {
            [ ...videoDevices, ...audioDevices ].map((dev, i) =>
              <li key={`${dev.groupId}/${dev.deviceId}`} data-testid={`dev-${i}`} role="listitem">
                {dev.label}
              </li>
            )
          }
        </ul>
      </>
    );
  };

  render(<TestComponent/>, { wrapper });

  const user = userEvent.setup();

  const btn = await screen.findByRole("button");
  await user.click(btn);

  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: true });
  expect(onStopTrack).toHaveBeenCalledTimes(2);

  await waitFor(async () => {
    const items = await screen.findAllByRole("listitem");
    expect(items.length).toBe(5);

    expect(items[0]).toHaveTextContent(mockVideoDevices[0].label);
    expect(items[1]).toHaveTextContent(mockVideoDevices[1].label);
    expect(items[2]).toHaveTextContent(mockAudioDevices[0].label);
    expect(items[3]).toHaveTextContent(mockAudioDevices[1].label);
    expect(items[4]).toHaveTextContent(mockAudioDevices[2].label);
  });
});

test("useMediaDevices().refreshMediaDevices doesn't open streams the second time", async () => {
  navigator.permissions.query = vi.fn().mockImplementation(
    async (desc: PermissionDescriptor): Promise<PermissionStatus> => ({
      state: "granted",
      name: desc.name,
      onchange: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  );

  const onStopTrack = vi.fn();
  const mockTrack = { stop: onStopTrack };
  const mockStream = { getTracks: vi.fn().mockReturnValue([ mockTrack, mockTrack ]) };

  mockTrack.stop = onStopTrack;

  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(mockStream);

  const TestComponent = () => {
    const {
      videoDevices,
      audioDevices,
      refreshMediaDevices
    } = useMediaDevices();

    return (
      <>
        <button role="button" onClick={refreshMediaDevices}>Click</button>
        <ul role="list">
          {
            [ ...videoDevices, ...audioDevices ].map(dev =>
              <li key={`${dev.groupId}/${dev.deviceId}`} data-testid="devitem" role="listitem">
                {dev.label}
              </li>
            )
          }
        </ul>
      </>
    );
  };

  render(<TestComponent/>, { wrapper });

  const user = userEvent.setup();

  await screen.findByRole("button").then(btn => user.click(btn));
  await screen.findByRole("button").then(btn => user.click(btn));

  expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: true });
});

test("useMediaDevices().refreshMediaDevices adds streams when user was prompted for permission", async () => {
  navigator.permissions.query = vi.fn().mockImplementation(
    async (desc: PermissionDescriptor): Promise<PermissionStatus> => ({
      state: "prompt",
      name: desc.name,
      onchange: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  );

  const mockAudioTrack = { label: "mock audio" };
  const mockVideoTrack = { label: "mock video" };

  const mockStream = {
    getAudioTracks: vi.fn().mockReturnValue([ mockAudioTrack ]),
    getVideoTracks: vi.fn().mockReturnValue([ mockVideoTrack ])
  };

  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);
  navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(mockStream);

  const TestComponent = () => {
    const {
      videoDevices,
      audioDevices,
      refreshMediaDevices
    } = useMediaDevices();

    const {
      videoTracks,
      audioTracks
    } = useMediaTracks();

    return (
      <>
        <button role="button" onClick={refreshMediaDevices}>Click</button>
        <ul role="list" data-testid="devlist">
          {
            [ ...videoDevices, ...audioDevices ].map(dev =>
              <li key={`${dev.groupId}/${dev.deviceId}`} data-testid="devitem" role="listitem">
                {dev.label}
              </li>
            )
          }
        </ul>
        <ul role="list" data-testid="tracklist">
          {
            [ ...videoTracks, ...audioTracks ].map((track, i) =>
              <li key={`track-${i}`} data-testid="trackitem" role="listitem">
                {track.label}
              </li>
            )
          }
        </ul>
      </>
    );
  };

  render(<TestComponent/>, { wrapper });

  const user = userEvent.setup();

  const btn = await screen.findByRole("button");
  await user.click(btn);

  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: true });

  await waitFor(async () => {
    const devs = await screen.queryAllByTestId("devitem");
    expect(devs.length).toBe(5);
    const tracks = await screen.queryAllByTestId("trackitem");
    expect(tracks.length).toBe(2);
  });
});
