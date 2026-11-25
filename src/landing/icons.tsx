// Crisp 24x24 stroke icons matching Circuit's icon sheet.
import type { JSX } from "solid-js";

export type IconName =
  | "logo"
  | "github"
  | "sun"
  | "moon"
  | "file-plus"
  | "folder-plus"
  | "collapse"
  | "chev-r"
  | "chev-d"
  | "drive"
  | "alert"
  | "pencil"
  | "trash"
  | "check"
  | "x"
  | "files"
  | "search"
  | "branch"
  | "box"
  | "play"
  | "stop"
  | "sliders"
  | "folder"
  | "file"
  | "split"
  | "more"
  | "left"
  | "right"
  | "reload"
  | "globe"
  | "monitor"
  | "tablet"
  | "phone"
  | "external"
  | "terminal"
  | "plus"
  | "tabs"
  | "cpu"
  | "x-circle"
  | "code";

function iconBody(name: IconName): JSX.Element {
  switch (name) {
    case "logo":
      return (
        <>
          <circle
            cx="12"
            cy="12"
            r="8"
            stroke-width="3.4"
            stroke-dasharray="3.14 3.14"
            stroke-linecap="butt"
          />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case "github":
      return (
        <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
      );
    case "sun":
      return (
        <>
          <circle cx="12" cy="12" r="3.8" />
          <path d="M12 2.8v2M12 19.2v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.8 12h2M19.2 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      );
    case "moon":
      return <path d="M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z" />;
    case "file-plus":
      return (
        <>
          <path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
          <path d="M13.5 3.5v5h5M12 11.5v6M9 14.5h6" />
        </>
      );
    case "folder-plus":
      return (
        <>
          <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z" />
          <path d="M12 10.5v5M9.5 13h5" />
        </>
      );
    case "collapse":
      return <path d="m7 10 5-5 5 5M7 19l5-5 5 5" />;
    case "chev-r":
      return <path d="m9.5 6 6 6-6 6" />;
    case "chev-d":
      return <path d="m6 9.5 6 6 6-6" />;
    case "drive":
      return (
        <>
          <rect x="3" y="13" width="18" height="7" rx="1.5" />
          <path d="M5.5 13 8 5h8l2.5 8M7 16.5h.01" />
        </>
      );
    case "alert":
      return (
        <>
          <path d="M12 4 3 19.5h18z" />
          <path d="M12 10v4.5M12 17h.01" />
        </>
      );
    case "pencil":
      return (
        <>
          <path d="M16.5 4.5a2.1 2.1 0 0 1 3 3L8.5 18.5 4.5 19.5l1-4z" />
        </>
      );
    case "trash":
      return <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" />;
    case "check":
      return <path d="m5 12.5 4.5 4.5L19 7.5" />;
    case "x":
      return <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />;
    case "files":
      return (
        <>
          <path d="M15 3H9a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
          <path d="M15 3v5h5" />
          <path d="M4 8v11a2 2 0 0 0 2 2h9" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-4.2-4.2" />
        </>
      );
    case "branch":
      return (
        <>
          <circle cx="6.5" cy="5.5" r="2.2" />
          <circle cx="6.5" cy="18.5" r="2.2" />
          <circle cx="17.5" cy="7.5" r="2.2" />
          <path d="M6.5 7.7v8.6" />
          <path d="M17.5 9.7c0 4.3-5.5 3.6-10 6.2" />
        </>
      );
    case "box":
      return (
        <>
          <path d="M20.5 7.5 12 3 3.5 7.5v9L12 21l8.5-4.5z" />
          <path d="m3.5 7.5 8.5 4.5 8.5-4.5" />
          <path d="M12 12v9" />
        </>
      );
    case "play":
      return <path d="M7.5 5v14l11-7z" />;
    case "stop":
      return <rect x="6" y="6" width="12" height="12" rx="1.5" />;
    case "sliders":
      return (
        <>
          <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
          <circle cx="15" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="17" cy="18" r="2" />
        </>
      );
    case "folder":
      return (
        <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z" />
      );
    case "file":
      return (
        <>
          <path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
          <path d="M13.5 3.5v5h5" />
        </>
      );
    case "split":
      return (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M12 4.5v15" />
        </>
      );
    case "more":
      return <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="3" />;
    case "left":
      return <path d="M19 12H5.5M11 6l-6 6 6 6" />;
    case "right":
      return <path d="M5 12h13.5M13 6l6 6-6 6" />;
    case "reload":
      return (
        <>
          <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
          <path d="M19.5 4.5v4.5H15" />
        </>
      );
    case "globe":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z" />
        </>
      );
    case "monitor":
      return (
        <>
          <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
          <path d="M8.5 20h7M12 16.5V20" />
        </>
      );
    case "tablet":
      return (
        <>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M11 17.5h2" />
        </>
      );
    case "phone":
      return (
        <>
          <rect x="7" y="3" width="10" height="18" rx="2" />
          <path d="M11 17.5h2" />
        </>
      );
    case "external":
      return (
        <>
          <path d="M14 4.5h5.5V10M19.5 4.5 11 13" />
          <path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
        </>
      );
    case "terminal":
      return (
        <>
          <rect x="3" y="4.5" width="18" height="15" rx="2" />
          <path d="m7 9.5 3 2.5-3 2.5M12.5 15H17" />
        </>
      );
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "tabs":
      return (
        <>
          <rect x="3" y="8" width="13" height="12" rx="1.5" />
          <path d="M7.5 8V5.5A1.5 1.5 0 0 1 9 4h10.5A1.5 1.5 0 0 1 21 5.5v8.5a1.5 1.5 0 0 1-1.5 1.5H16" />
        </>
      );
    case "cpu":
      return (
        <>
          <rect x="6" y="6" width="12" height="12" rx="1.5" />
          <path d="M9.5 9.5h5v5h-5zM9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" />
        </>
      );
    case "x-circle":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
        </>
      );
    case "code":
      return <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5" />;
  }
}

export function Icon(props: { readonly name: IconName; readonly class?: string }) {
  return (
    <svg class={props.class ? `lp-ico ${props.class}` : "lp-ico"} viewBox="0 0 24 24" aria-hidden="true">
      {iconBody(props.name)}
    </svg>
  );
}
