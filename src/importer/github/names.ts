/**
 * GitHub name rules, shared by the browser importer and the Worker proxy so
 * both refuse the same inputs.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const RELEASE_ASSET = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,250}\.tgz$/;
/** Characters `git check-ref-format` forbids anywhere: controls, space, DEL and `~^:?*[\`. */
// Matching control characters is the point of this pattern.
// oxlint-disable-next-line no-control-regex
const REF_FORBIDDEN = /[\u0000- \u007f~^:?*[\\]/;
const MAX_REF_LENGTH = 255;

export function isOwnerName(name: string): boolean {
  return OWNER.test(name);
}

export function isRepoName(name: string): boolean {
  return REPO.test(name) && name !== "." && name !== ".." && !name.endsWith(".git");
}

/** Strict allowlist for public GitHub release `.tgz` tarball filenames (single path segment). */
export function isReleaseAssetName(name: string): boolean {
  return RELEASE_ASSET.test(name) && !name.includes("..");
}

/**
 * The rules of `git check-ref-format --allow-onelevel`: no forbidden
 * characters, no `..` or `@{`, not `@`, no empty segment, no segment that
 * starts with `.` or ends with `.lock`, and no trailing `.`. Non-ASCII names
 * such as `café` are valid; callers URL-encode each segment.
 */
export function isRefName(ref: string): boolean {
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return false;
  if (REF_FORBIDDEN.test(ref) || ref.includes("..") || ref.includes("@{") || ref === "@") return false;
  if (ref.endsWith(".")) return false;
  return ref.split("/").every(isRefSegment);
}

function isRefSegment(segment: string): boolean {
  return segment !== "" && !segment.startsWith(".") && !segment.endsWith(".lock");
}

/**
 * One `/`-separated component of a longer ref, such as the `release.` in
 * `release./stable` or the `@` in `@/stable`. Only the per-component rules
 * apply; "not `@`" and "no trailing `.`" are rules about the whole ref.
 */
export function isRefComponent(segment: string): boolean {
  if (segment.length > MAX_REF_LENGTH || segment.includes("/")) return false;
  if (REF_FORBIDDEN.test(segment) || segment.includes("..") || segment.includes("@{")) return false;
  return isRefSegment(segment);
}

/** A full 40-hex commit id, which makes an archive immutable and cacheable forever. */
export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/** Encodes each `/`-separated segment of a ref for use in a URL path. */
export function encodeRefPath(ref: string): string {
  return ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
