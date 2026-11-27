// UI chrome icons for editor tabs, search, and quick open; file-type icons come from @shaulavo/workbench-icons.
import type { ReactNode } from "react";
import { FileTypeIcon } from "@shaulavo/workbench-icons/react";

function Icon(props: { class?: string; children: ReactNode }) {
  return (
    <svg className={`ico ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
      {props.children}
    </svg>
  );
}

/** A file's icon in a tab or a result row from @shaulavo/workbench-icons. */
export const FileIcon = (props: { path: string }) => {
  const name = props.path.slice(props.path.lastIndexOf("/") + 1);
  return <FileTypeIcon entry={{ name, type: "file" }} sprite className="ft" />;
};

export const CloseIcon = (props: { class?: string }) => (
  <Icon class={props.class}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Icon>
);

/** A command row in quick open: a chevron prompt. */
export const CommandIcon = () => (
  <Icon>
    <path d="m6 8 4 4-4 4M12 16h6" />
  </Icon>
);

export const AlertIcon = () => (
  <Icon>
    <path d="M12 4 3 19.5h18z" />
    <path d="M12 10v4.5M12 17h.01" />
  </Icon>
);

export const ChevronIcon = (props: { class?: string }) => (
  <Icon class={props.class}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

/** Splits `text` into plain and highlighted runs; `marks` holds indexes into `text`. */
export function Highlighted(props: { text: string; marks: ReadonlySet<number> }) {
  const runs: { text: string; marked: boolean }[] = [];
  for (let index = 0; index < props.text.length; index += 1) {
    const marked = props.marks.has(index);
    const last = runs.at(-1);
    if (last && last.marked === marked) last.text += props.text[index];
    else runs.push({ text: props.text[index] as string, marked });
  }
  return <>{runs.map((run, index) => (run.marked ? <mark key={index}>{run.text}</mark> : run.text))}</>;
}
