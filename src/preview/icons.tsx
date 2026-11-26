// The preview toolbar's icons that the shared set (src/ui/icons.tsx) does not have. Drawn like
// the shared ones: 24x24 strokes in the current text color, sized and weighted by `.ico`.
import type { ReactNode } from "react";

function Stroke(props: { children: ReactNode }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      {props.children}
    </svg>
  );
}

export const BackIcon = () => (
  <Stroke>
    <path d="M19 12H5.5M11 6l-6 6 6 6" />
  </Stroke>
);

export const ForwardIcon = () => (
  <Stroke>
    <path d="M5 12h13.5M13 6l6 6-6 6" />
  </Stroke>
);

export const ExternalIcon = () => (
  <Stroke>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13" />
    <path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
  </Stroke>
);

export const DesktopIcon = () => (
  <Stroke>
    <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
    <path d="M8.5 20h7M12 16.5V20" />
  </Stroke>
);

export const TabletIcon = () => (
  <Stroke>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M11 17.5h2" />
  </Stroke>
);

export const PhoneIcon = () => (
  <Stroke>
    <rect x="7" y="3" width="10" height="18" rx="2" />
    <path d="M11 17.5h2" />
  </Stroke>
);

export const PlayIcon = () => (
  <Stroke>
    <path d="M7.5 5v14l11-7z" />
  </Stroke>
);
