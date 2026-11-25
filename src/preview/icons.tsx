// Stroke icons of the preview toolbar, 24x24, drawn with the current text color. The shapes
// are the ones in the Circuit design's icon sheet.
import type { JSX } from "solid-js";

function Icon(props: { children: JSX.Element }) {
  return (
    <svg
      class="preview-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export const BackIcon = () => (
  <Icon>
    <path d="M19 12H5.5M11 6l-6 6 6 6" />
  </Icon>
);

export const ForwardIcon = () => (
  <Icon>
    <path d="M5 12h13.5M13 6l6 6-6 6" />
  </Icon>
);

export const ReloadIcon = () => (
  <Icon>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4.5H15" />
  </Icon>
);

export const GlobeIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13" />
    <path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
  </Icon>
);

export const DesktopIcon = () => (
  <Icon>
    <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
    <path d="M8.5 20h7M12 16.5V20" />
  </Icon>
);

export const TabletIcon = () => (
  <Icon>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M11 17.5h2" />
  </Icon>
);

export const PhoneIcon = () => (
  <Icon>
    <rect x="7" y="3" width="10" height="18" rx="2" />
    <path d="M11 17.5h2" />
  </Icon>
);

export const AlertIcon = () => (
  <Icon>
    <path d="M12 4 3 19.5h18z" />
    <path d="M12 10v4.5M12 17h.01" />
  </Icon>
);

export const PlayIcon = () => (
  <Icon>
    <path d="M7.5 5v14l11-7z" />
  </Icon>
);

export const StopIcon = () => (
  <Icon>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Icon>
);
