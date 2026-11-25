// The Sprockt mark: a chain sprocket whose teeth are flat-topped, like browser tabs. One function
// draws every size of it: the 24px icon, the boot spinner's mask and the large landing drawings.

export interface SprocketShape {
  /** How many teeth. */
  readonly teeth: number;
  /** Radius to the flat top of a tooth. */
  readonly tip: number;
  /** Radius to the valley between teeth. */
  readonly root: number;
  /** Radius of the hole in the middle; 0 leaves the disc solid. */
  readonly bore: number;
  /** Half the angle a tooth covers at its top and at its foot, in degrees. */
  readonly tipHalf: number;
  readonly rootHalf: number;
  /** Centre of the sprocket; the first tooth points straight up. */
  readonly cx: number;
  readonly cy: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

function point(shape: SprocketShape, radius: number, degrees: number): string {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return `${round(shape.cx + radius * Math.cos(radians))} ${round(shape.cy + radius * Math.sin(radians))}`;
}

/** One tooth as a closed path: foot, flat top, foot. `sink` reaches below the root circle. */
export function toothPath(shape: SprocketShape, index: number, sink = 0): string {
  const at = (index * 360) / shape.teeth;
  const foot = shape.root - sink;
  return [
    `M${point(shape, foot, at - shape.rootHalf)}`,
    `L${point(shape, shape.tip, at - shape.tipHalf)}`,
    `L${point(shape, shape.tip, at + shape.tipHalf)}`,
    `L${point(shape, foot, at + shape.rootHalf)}Z`,
  ].join("");
}

/** The whole sprocket as one path. Fill it with `fill-rule="evenodd"` so the bore stays open. */
export function sprocketPath(shape: SprocketShape): string {
  const step = 360 / shape.teeth;
  const teeth = Array.from({ length: shape.teeth }, (_, index) => {
    const at = index * step;
    const start = index === 0 ? `M${point(shape, shape.root, at - shape.rootHalf)}` : "";
    return [
      start,
      `L${point(shape, shape.tip, at - shape.tipHalf)}`,
      `L${point(shape, shape.tip, at + shape.tipHalf)}`,
      `L${point(shape, shape.root, at + shape.rootHalf)}`,
      `A${shape.root} ${shape.root} 0 0 1 ${point(shape, shape.root, at + step - shape.rootHalf)}`,
    ].join("");
  });
  const outline = `${teeth.join("")}Z`;
  if (shape.bore <= 0) return outline;
  const top = point(shape, shape.bore, 0);
  const bottom = point(shape, shape.bore, 180);
  return `${outline}M${top}A${shape.bore} ${shape.bore} 0 1 0 ${bottom}A${shape.bore} ${shape.bore} 0 1 0 ${top}Z`;
}

/** How far the mark turns to index one tooth, in degrees. CSS rotations use the same number. */
export const MARK_STEP_DEGREES = 40;

/** The mark on the 24x24 icon grid: nine wide teeth, a wide bore. */
export const MARK: SprocketShape = {
  teeth: 9,
  tip: 11.5,
  root: 8.9,
  bore: 5.8,
  tipHalf: 9,
  rootHalf: 13,
  cx: 12,
  cy: 12,
};

/** The mark as SVG markup for a 24x24 viewBox: the body in the text color, one tooth lit. */
export const MARK_SVG =
  `<path fill="currentColor" stroke="none" fill-rule="evenodd" d="${sprocketPath(MARK)}"/>` +
  `<path class="mark-lit" stroke="none" d="${toothPath(MARK, 1, 0.9)}"/>`;

const circle = (cx: number, cy: number, radius: number) =>
  `M${round(cx)} ${round(cy - radius)}A${radius} ${radius} 0 1 0 ${round(cx)} ${round(cy + radius)}A${radius} ${radius} 0 1 0 ${round(cx)} ${round(cy - radius)}Z`;

export interface ChainringShape extends SprocketShape {
  /** Spider arms between the toothed ring and the hub, and the angle each one covers. */
  readonly arms: number;
  readonly armDegrees: number;
  /** The windows between the arms run from this radius out to this one. */
  readonly windowInner: number;
  readonly windowOuter: number;
  /** Chainring bolts: their radius, and the radius of the circle they sit on. */
  readonly bolt: number;
  readonly boltCircle: number;
}

/**
 * A chainring: the toothed ring, spider arms and a bolted hub, as one path for
 * `fill-rule="evenodd"`. The large drawing of the mark on the landing page.
 */
export function chainringPath(shape: ChainringShape): string {
  const step = 360 / shape.arms;
  const windows = Array.from({ length: shape.arms }, (_, index) => {
    const from = index * step + shape.armDegrees / 2;
    const to = (index + 1) * step - shape.armDegrees / 2;
    return [
      `M${point(shape, shape.windowOuter, from)}`,
      `A${shape.windowOuter} ${shape.windowOuter} 0 0 1 ${point(shape, shape.windowOuter, to)}`,
      `L${point(shape, shape.windowInner, to)}`,
      `A${shape.windowInner} ${shape.windowInner} 0 0 0 ${point(shape, shape.windowInner, from)}Z`,
    ].join("");
  });
  const bolts = Array.from({ length: shape.arms }, (_, index) => {
    const radians = ((index * step - 90) * Math.PI) / 180;
    return circle(
      shape.cx + shape.boltCircle * Math.cos(radians),
      shape.cy + shape.boltCircle * Math.sin(radians),
      shape.bolt,
    );
  });
  return sprocketPath(shape) + windows.join("") + bolts.join("");
}

/** The large chainring, on a 240x240 grid. */
export const CHAINRING: ChainringShape = {
  teeth: 44,
  tip: 118,
  root: 111,
  bore: 18,
  tipHalf: 1.5,
  rootHalf: 3,
  cx: 120,
  cy: 120,
  arms: 5,
  armDegrees: 16,
  windowInner: 44,
  windowOuter: 96,
  bolt: 4,
  boltCircle: 31,
};
