import { useRef } from 'react';

// Playwright writes WebM files without a duration header, so the browser reports
// Infinity and the seek bar is dead. Seeking far past the end forces it to scan
// the file and resolve the real duration, after which scrubbing works.
export default function VideoPlayer({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  const resolveDuration = () => {
    const video = ref.current;
    if (!video || Number.isFinite(video.duration)) return;

    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      video.currentTime = 0;
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = 1e7;
  };

  return <video ref={ref} src={src} controls preload="auto" onLoadedMetadata={resolveDuration} />;
}
