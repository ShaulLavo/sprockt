# Landing page

Sprockt's public entry page (`/`), rendered without loading the Waffle/WASI runtime on cold visit.

## Sub-features

- Top navigation bar (desktop links + Light/Dark theme switch + primary CTA; phone theme toggle + hamburger menu).
- Hero section with WebGL grain-gradient backdrop (`hero-fx-pause` motion toggle), interactive Hero IDE showcase (`hero-showcase`), and primary/secondary actions.
- Feature cards band, dark browser/mobile contrast showcase band with marquee pause toggle, Starters & GitHub repo import band (7 starter cards + Blank + Recent workspaces), Under-the-hood Hub diagram & stack table, FAQ accordion + MIT license card, closing CTA, and footer.

## How to get to it (user POV)

Open `/` in any desktop or mobile browser. Toggle Light/Dark via the header theme controls (`theme-light`, `theme-dark`, or `phone-theme-toggle` on phone). Click any starter card (`template-<id>`) or **Blank workspace** (`new-workspace`) to launch a workspace, or submit a GitHub URL/slug in `repo-input`.

## Driving it with agent:browser

```bash
bun run agent:browser look --doctor --viewport desktop --scheme light
bun run agent:browser look --doctor --viewport phone --scheme dark --engine webkit
bun run agent:browser scenario landing-desktop-mobile
```

Inspect `desktop-light-fold.png`, `desktop-dark-fold.png`, `phone-light-fold.png`, and `phone-dark-fold.png` plus `layout.json` (`overflowX === 0`, `crossOriginIsolated === true`, `brokenImages: []`).

## Gotchas

- Cold landing must stay isolated from the Waffle runtime (`e2e/landing.spec.ts` checks bundle isolation and entry size).
- Never use `opacity: 0` scroll-reveal traps that leave sections invisible in full-page screenshots or with Reduced Motion enabled.
- On phone (`390×844`), check that the Waffle Hub diagram pills and hero showcase never create horizontal overflow (`overflowX > 0`).
