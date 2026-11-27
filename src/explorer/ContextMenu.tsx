// Coordinate-anchored context menu backed by `@shaulavo/workbench-ui`'s Base UI `PointContextMenu`.
import { useRef } from "react";
import { PointContextMenu, type ContextMenuItem } from "@shaulavo/workbench-ui";

export interface MenuItem {
  readonly label: string;
  readonly hint?: string;
  readonly danger?: boolean;
  readonly testId: string;
  run(): void;
}

export function ContextMenu(props: {
  x: number;
  y: number;
  items: readonly MenuItem[];
  label: string;
  /** `escaped`: closed without running an item, so focus returns where it was. */
  onClose(escaped?: boolean): void;
}) {
  const ranRef = useRef(false);

  const items: readonly ContextMenuItem[] = props.items.map((item) => ({
    id: item.testId,
    label: item.label,
    hint: item.hint,
    danger: item.danger,
    testId: item.testId,
    onSelect: () => {
      ranRef.current = true;
      props.onClose(false);
      item.run();
    },
  }));

  return (
    <PointContextMenu
      open={true}
      x={props.x}
      y={props.y}
      label={props.label}
      items={items}
      onOpenChange={(open, reason) => {
        if (!open && !ranRef.current) props.onClose(reason === "escape-key");
      }}
    />
  );
}
