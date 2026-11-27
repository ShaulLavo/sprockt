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
