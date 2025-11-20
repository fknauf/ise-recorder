'use client';

import { ActionButton, Divider, Flex, Item, Text, MenuTrigger, Menu, TextField } from "@adobe/react-spectrum";
import CallCenter from '@spectrum-icons/workflow/CallCenter';
import MovieCamera from '@spectrum-icons/workflow/MovieCamera';
import Circle from '@spectrum-icons/workflow/Circle';
import DeviceDesktop from '@spectrum-icons/workflow/DeviceDesktop';
import Stop from '@spectrum-icons/workflow/Stop';
import { useCallback, useEffect, useState } from "react";
import VideoPreview from "./lib/VideoPreview";
import AudioPreview from "./lib/AudioPreview";
import { PreviewCard } from "./lib/PreviewCard";
import { SavedRecordingsCard } from "./lib/SavedRecordingCard";
import { getRecordingsList, RecordingFileList, appendToRecordingFile } from "./lib/filesystem";
import { scheduleRenderingJob as schedulePostprocessing, sendChunkToServer } from "./lib/serverStorage";
import isEmail from 'validator/es/lib/isEmail';
import useSWR from "swr";
import { clientGetPublicServerEnvironment } from "./env/lib";

interface RecordingJob {
  recorder: MediaRecorder
  finished: Promise<void>
}

interface RecordingJobs {
  name: string,
  recorders: MediaRecorder[]
}

// This is necessary because device ids are not unique in FF 145. See https://bugzilla.mozilla.org/show_bug.cgi?id=2001440
const deviceUniqueId = (dev: MediaDeviceInfo) => JSON.stringify([ dev.groupId, dev.deviceId ])
const splitDeviceUniqueId = (devUid: string): [ string, string ] => JSON.parse(devUid);
const deviceConstraints = (groupId: string, deviceId: string): MediaTrackConstraints =>
  ({
    groupId: { exact: groupId },
    deviceId: { exact: deviceId }
  });

const trackIsFromDevice = (track: MediaStreamTrack, groupId: string, deviceId: string) =>
  track.getSettings().groupId === groupId && track.getSettings().deviceId == deviceId;

const unsafeCharacters = /[^A-Za-z0-9_.-]/g;

const validateLectureTitle = (title: string) => !unsafeCharacters.test(title) || 'unsafe character in lecture title';
const validateEmail = (email: string) => email.trim() === '' || isEmail(email) || 'invalid e-mail address';

export default function Home() {
  ////////////////
  // hooks
  ////////////////

  const [ videoDevices, setVideoDevices ] = useState<MediaDeviceInfo[]>([])
  const [ audioDevices, setAudioDevices ] = useState<MediaDeviceInfo[]>([])
  const [ hasPermissions, setHasPermissions ] = useState(false);

  const [ videoTracks, setVideoTracks ] = useState<MediaStreamTrack[]>([]);
  const [ audioTracks, setAudioTracks ] = useState<MediaStreamTrack[]>([]);
  const [ displayTracks, setDisplayTracks ]= useState<MediaStreamTrack[]>([]);

  const [ activeRecording, setActiveRecording ] = useState<RecordingJobs | null>(null);
  const [ recordings, setRecordings ] = useState<RecordingFileList[]>([]);
  const [ lectureTitle, setLectureTitle ] = useState("")
  const [ lecturerEmail, setLecturerEmail ] = useState("")

  const [ mainDisplay, setMainDisplay ] = useState<MediaStreamTrack | null>(null);
  const [ overlay, setOverlay ] = useState<MediaStreamTrack | null>(null);

  const { data: serverEnv } = useSWR('env', clientGetPublicServerEnvironment)

  useEffect(() => {
    getRecordingsList().then(setRecordings);
  }, [])

  ////////////////
  // logic
  ////////////////

  const isRecording = activeRecording !== null;
  const apiUrl = serverEnv?.api_url

  const refreshUserMediaDevices = async () => {
    if(!hasPermissions) {
      // Request permissions, needs to happen before devices can be enumerated
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

      if(stream) {
        stream.getTracks().forEach(t => t.stop());
        setHasPermissions(true);
      }
    }

    const devs = await navigator.mediaDevices.enumerateDevices();

    setVideoDevices(devs.filter(dev => dev.kind === "videoinput"));
    setAudioDevices(devs.filter(dev => dev.kind === "audioinput"));
  };

  const openDisplayStream = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia();
      const screenTracks = screenStream.getVideoTracks();

      // should only ever be one video track, but let's just grab all just in case. user can
      // still remove them manually if there happen to be more.
      setDisplayTracks([ ...displayTracks, ...screenTracks ]);

      if(!mainDisplay && screenTracks.length > 0) {
        setMainDisplay(screenTracks[0])
      }
    } catch(e) {
      console.log(e);
    }
  };

  const addVideoDevice = async (devUid: string) => {
    const [ groupId, deviceId ] = splitDeviceUniqueId(devUid);

    if(videoTracks.find(track => trackIsFromDevice(track, groupId, deviceId))) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ video: deviceConstraints(groupId, deviceId), audio: false });
    setVideoTracks([...videoTracks, ...stream.getVideoTracks() ])

    if(!overlay) {
      setOverlay(stream.getVideoTracks().at(0) ?? null);
    }
  }

  const addAudioDevice = async (devUid: string) => {
    const [ groupId, deviceId ] = splitDeviceUniqueId(devUid);

    if(audioTracks.find(track => trackIsFromDevice(track, groupId, deviceId))) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceConstraints(groupId, deviceId), video: false });
    setAudioTracks([...audioTracks, ...stream.getAudioTracks()])
  }

  const removeTrackFromPostprocessing = (track: MediaStreamTrack) => {
    if(mainDisplay === track) {
      setMainDisplay(null);
    }

    if(overlay === track) {
      setOverlay(null);
    }
  }

  const removeVideoTrack = (track: MediaStreamTrack) => {
    removeTrackFromPostprocessing(track);
    track.stop();
    setVideoTracks(videoTracks.filter(t => t !== track));
  }

  const removeAudioTrack = (track: MediaStreamTrack) => {
    track.stop();
    setAudioTracks(audioTracks.filter(t => t !== track));
  }

  const removeDisplayTrack = (track: MediaStreamTrack) => {
    removeTrackFromPostprocessing(track);
    track.stop();
    setDisplayTracks(displayTracks.filter(t => t !== track));
  }

  const recordTracks = (
    tracks: MediaStreamTrack[],
    recordingName: string,
    trackTitle: string,
    fileExtension: string,
    options?: MediaRecorderOptions
  ): RecordingJob => {
    const recordedStream = new MediaStream(tracks);
    const newRecorder = new MediaRecorder(recordedStream, options);

    // This is a little bit involved so that we're guaranteed to not drop any chunks and also
    // not process them out of order.
    //
    // This is a problem we have to solve because the OPFS api is extremely asynchronous, so in
    // a naive implementation that starts an appendToRecordingFile job in the ondataavailable
    // handler we could end up with multiple such jobs in flight at the same time, which leads
    // to data loss.
    //
    // To get around this, we instead queue incoming chunks and spawn a background task that
    // appends them to the file sequentially. The event handler signals to the background task
    // through a promise object that is exchanged after every delivered chunk. Promise objects
    // may be dropped without being awaited, but the chunks will be in the queue and handled
    // anyway. The exchange makes clever/ugly use of typescript capturing semantics, but this
    // is the least involved way I came up with.
    const chunkQueue: Blob[] = [];
    let chunkSignalResolve: (finished: boolean) => void
    let chunkSignalPromise = new Promise<boolean>(resolve => chunkSignalResolve = resolve);

    newRecorder.ondataavailable = event => {
      chunkQueue.push(event.data);
      chunkSignalResolve(false);
      chunkSignalPromise = new Promise<boolean>(resolve => chunkSignalResolve = resolve);
    }
    newRecorder.onstop = () => chunkSignalResolve(true);
    newRecorder.onerror = () => chunkSignalResolve(true);

    const finishedPromise = new Promise<void>(resolve => {
      (async () => {
        let finished = false;
        let chunkNum = 0;

        while(!finished) {
          finished = await chunkSignalPromise;

          while(chunkQueue.length > 0) {
            const chunk = chunkQueue.shift();
            if(chunk) {
              sendChunkToServer(apiUrl, chunk, recordingName, trackTitle, chunkNum);
              await appendToRecordingFile(recordingName, `${trackTitle}.${fileExtension}`, chunk);
              setRecordings(await getRecordingsList());

              ++chunkNum;
            }
          }
        }

        resolve();
      })();
    })

    newRecorder.start(5000);

    return {
      recorder: newRecorder,
      finished: finishedPromise
    };
  };

  const startRecording = async () => {
    const noTracksAvailable = displayTracks.length === 0 && videoTracks.length === 0 && audioTracks.length === 0;

    if(isRecording || noTracksAvailable) {
      return;
    }

    const timestamp = new Date();
    const lecturePrefix = lectureTitle ? `${lectureTitle}_` : '';
    const recordingName = `${lecturePrefix}${timestamp.toISOString()}`.replaceAll(unsafeCharacters, '');

    const recordVideo = (tracks: MediaStreamTrack[], trackTitle: string) => recordTracks(tracks, recordingName, trackTitle, 'webm', { mimeType: 'video/webm' });
    const recordAudio = (tracks: MediaStreamTrack[], trackTitle: string) => recordTracks(tracks, recordingName, trackTitle, 'webm', { mimeType: 'audio/webm' });

    const jobs: RecordingJob[] = [];

    // if no main display is selected, guess a sensible default: first captured display if there
    // are display streams, first video input otherwise, but don't use the overlay track.
    const effectiveMainDisplay = mainDisplay ?? displayTracks.filter(t => t !== overlay).at(0) ?? videoTracks.filter(t => t !== overlay).at(0)

    if(effectiveMainDisplay) {
      // attach first audio stream to main display if available, record the rest into individual files.
      // This is because at time of writing MediaRecorder on FF and Chrome does not support multiple
      // audio tracks (nor multiple video tracks, for that matter).
      jobs.push(recordVideo([ effectiveMainDisplay, ...audioTracks.slice(0, 1) ], 'stream'));
      jobs.push(...audioTracks.slice(1).map((track, index) => recordAudio([track], `audio-${index}`)));
    } else {
      // if no video streams are available, record each audio track into its own file
      jobs.push(...audioTracks.map((track, index) => recordAudio([track], `audio-${index}`)));
    }

    if(overlay != null) {
      jobs.push(recordVideo([ overlay ], 'overlay'));
    }

    // If there are more video tracks than main and overlay, record each into its own file for manual postprocessing.
    const notYetHandled = (track: MediaStreamTrack) => track !== effectiveMainDisplay && track !== overlay;
    jobs.push(...videoTracks.filter(notYetHandled).map((track, i) => recordVideo([track], `video-${i}`)));
    jobs.push(...displayTracks.filter(notYetHandled).map((track, i) => recordVideo([track], `display-${i}`)));

    setActiveRecording({
      name: recordingName,
      recorders: jobs.map(job => job.recorder)
    });

    await Promise.all(jobs.map(job => job.finished));

    schedulePostprocessing(apiUrl, recordingName, recordingName, lecturerEmail);
    setRecordings(await getRecordingsList());
  };

  const stopRecording = () => {
    activeRecording?.recorders.forEach(r => r.stop());
    setActiveRecording(null);
  };

  ////////////////
  // view
  ////////////////

  const video_preview_card = (track: MediaStreamTrack, label: string, onRemove: (track: MediaStreamTrack) => void) =>
    <PreviewCard
      key={`preview-card-${track.id}`}
      label={label}
      buttonDisabled={isRecording}
      onRemove={() => onRemove(track)}
    >
      <VideoPreview
        track={track}
        switchesDisabled={isRecording}
        isMainDisplay={mainDisplay === track}
        isOverlay={overlay === track}
        onToggleMainDisplay={isSelected => { setMainDisplay(isSelected ? track : null) }}
        onToggleOverlay={isSelected => { setOverlay(isSelected ? track : null)}}
      />
    </PreviewCard>;

  return (
    <Flex direction="column" width="100vw" height="100vh" gap="size-100">
      <Flex direction="row" justifyContent="center" gap="size-100" marginTop="size-100" wrap>
        <TextField
          label="Lecture Title"
          value={lectureTitle}
          isReadOnly={isRecording}
          isDisabled={isRecording}
          validate={validateLectureTitle}
          onChange={setLectureTitle}
        />
        {
          apiUrl &&
            <TextField
              label="e-Mail"
              validate={validateEmail}
              value={lecturerEmail}
              onChange={setLecturerEmail}
            />
        }

        <Flex direction="row" justifyContent="center" alignSelf="end" gap="size-100" wrap>
          <Divider orientation="vertical" size="S" marginX="size-100"/>

          <ActionButton onPress={openDisplayStream} isDisabled={isRecording} alignSelf="end">
            <DeviceDesktop/>
            <Text>Add Screen/Window</Text>
          </ActionButton>

          <MenuTrigger onOpenChange={refreshUserMediaDevices}>
            <ActionButton isDisabled={isRecording} alignSelf="end">
              <MovieCamera/>
              <Text>Add Video Source</Text>
            </ActionButton>
            <Menu onAction={devUid => addVideoDevice(devUid as string)}>
              { videoDevices.map(dev => <Item key={deviceUniqueId(dev)}>{dev.label}</Item>) }
            </Menu>
          </MenuTrigger>

          <MenuTrigger onOpenChange={refreshUserMediaDevices}>
            <ActionButton isDisabled={isRecording} alignSelf="end">
              <CallCenter/>
              <Text>Add Audio Source</Text>
            </ActionButton>
            <Menu onAction={devUid => addAudioDevice(devUid as string)}>
              { audioDevices.map(dev => <Item key={deviceUniqueId(dev)}>{dev.label}</Item>) }
            </Menu>
          </MenuTrigger>

          <Divider orientation="vertical" size="S" marginX="size-100"/>

          {
            isRecording
            ? <ActionButton alignSelf="end" onPress={stopRecording}><Stop/> <Text>Stop Recording</Text></ActionButton>
            : <ActionButton alignSelf="end" onPress={startRecording}><Circle/> <Text>Start Recording</Text></ActionButton>
          }
        </Flex>
      </Flex>

      <Flex direction="row" gap="size-100" justifyContent="center" wrap>
        {
          displayTracks.map((track, ix) => video_preview_card(track, `Screen capture ${ix}`, removeDisplayTrack))
        }
        {
          videoTracks.map(track => video_preview_card(track, track.label, removeVideoTrack))
        }
        {
          audioTracks.map(track =>
            <PreviewCard
              key={`preview-card-${track.id}`}
              label={track.label}
              buttonDisabled={isRecording}
              onRemove={() => removeAudioTrack(track)}
            >
              <AudioPreview track={track}/>
            </PreviewCard>
          )
        }
      </Flex>

      <Flex direction="row" gap="size-100" wrap>
        {
          recordings.map(r =>
            <SavedRecordingsCard
              key={`saved-recording-${r.name}`}
              recording={r}
              isBeingRecorded={r.name === activeRecording?.name}
              onRemoved={() => getRecordingsList().then(setRecordings) }
            />
          )
        }
      </Flex>
    </Flex>
  );
}
