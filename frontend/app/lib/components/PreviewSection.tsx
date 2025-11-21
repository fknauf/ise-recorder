import { Flex } from "@adobe/react-spectrum";
import { PreviewCard } from "./PreviewCard";
import { VideoPreview } from "./VideoPreview";
import { AudioPreview } from "./AudioPreview";

interface PreviewSectionProps {
  displayTracks: MediaStreamTrack[]
  videoTracks: MediaStreamTrack[]
  audioTracks: MediaStreamTrack[]
  mainDisplay: MediaStreamTrack | null,
  overlay: MediaStreamTrack | null,
  hasDisabledButtons: boolean,
  onToggleMainDisplay: (track: MediaStreamTrack, enabled: boolean) => void,
  onToggleOverlay: (track: MediaStreamTrack, enabled: boolean) => void,
  onRemoveDisplayTrack: (track: MediaStreamTrack) => void
  onRemoveVideoTrack: (track: MediaStreamTrack) => void
  onRemoveAudioTrack: (track: MediaStreamTrack) => void
}

export function PreviewSection(
  {
    displayTracks,
    videoTracks,
    audioTracks,
    mainDisplay,
    overlay,
    hasDisabledButtons,
    onToggleMainDisplay,
    onToggleOverlay,
    onRemoveDisplayTrack,
    onRemoveVideoTrack,
    onRemoveAudioTrack
  }: PreviewSectionProps
) {
  const video_preview_card = (track: MediaStreamTrack, label: string, onRemove: (track: MediaStreamTrack) => void) =>
    <PreviewCard
      key={`preview-card-${track.id}`}
      label={label}
      hasDisabledButtons={hasDisabledButtons}
      onRemove={() => onRemove(track)}
    >
      <VideoPreview
        track={track}
        switchesDisabled={hasDisabledButtons}
        isMainDisplay={mainDisplay === track}
        isOverlay={overlay === track}
        onToggleMainDisplay={isSelected => onToggleMainDisplay(track, isSelected) }
        onToggleOverlay={isSelected => onToggleOverlay(track, isSelected) }
      />
    </PreviewCard>;

  return (
    <Flex direction="row" gap="size-100" justifyContent="center" wrap>
      {
        displayTracks.map((track, ix) => video_preview_card(track, `Screen capture ${ix}`, onRemoveDisplayTrack))
      }
      {
        videoTracks.map(track => video_preview_card(track, track.label, onRemoveVideoTrack))
      }
      {
        audioTracks.map(track =>
          <PreviewCard
            key={`preview-card-${track.id}`}
            label={track.label}
            hasDisabledButtons={hasDisabledButtons}
            onRemove={() => onRemoveAudioTrack(track)}
          >
            <AudioPreview track={track}/>
          </PreviewCard>
        )
      }
    </Flex>
  );
}
