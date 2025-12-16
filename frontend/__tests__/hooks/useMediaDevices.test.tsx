import { expect, test, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { AppStoreProvider, useAppStore } from "@/app/lib/hooks/useAppStore";
import { ReactNode, useEffect } from "react";
import { useMediaDevices } from "@/app/lib/hooks/useMediaDevices";
import userEvent from "@testing-library/user-event";

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

test("useMediaDevices has refresh function that works when permissions are available", async () => {
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

  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([ ...mockVideoDevices, ...mockAudioDevices ]);

  const TestComponent = () => {
    const setObtainedDevicePermissions = useAppStore(state => state.setObtainedDevicePermissions);
    useEffect(() => setObtainedDevicePermissions(), [ setObtainedDevicePermissions ]);

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

  waitFor(async () => {
    const items = await screen.queryAllByRole("listitem");
    expect(items.length).toBe(5);
  });
});
