# ScreenFilter

A real-time screen capture and photosensitive epilepsy safety filter. ScreenFilter captures your display, analyzes each frame for seizure-inducing content (rapid flashes, red saturation, harmful patterns), and presents a filtered, safe version back to the user — all within milliseconds.

Built for [HackED 2026](https://github.com/GenericConfluent/hacked2026).

## The Problem

Photosensitive epilepsy affects roughly 1 in 4,000 people. Rapid flashing, high-contrast strobing, and certain spatial patterns in video content can trigger seizures. While content creators can follow guidelines, there's no real-time safety net for *live* screen content — games, streams, ads, or web pages can all contain unexpected triggers.

## Our Solution

ScreenFilter acts as a transparent overlay that:

1. **Captures** the entire screen at 30fps (excluding its own window to avoid recursion)
2. **Buffers** frames in a ring buffer, creating a small (~100–200ms) delay
3. **Analyzes** each frame for WCAG 2.0 photosensitivity violations
4. **Filters** dangerous regions (via luminance clamping and blur) before display
5. **Presents** the safe output in a borderless, always-on-top, click-through overlay

```
Screen → Capture → Buffer → Analyze → Filter → Display (safe)
                    ↑                              │
                    └──── ~200ms delay ─────────────┘
```

## WCAG Compliance Criteria

We follow [WCAG 2.0 Guideline 2.3.1](https://www.w3.org/TR/WCAG20/#seizure) — content is considered safe if **either**:

- There are no more than **3 general flashes** and no more than **3 red flashes** within any 1-second period, **or**
- The combined area of concurrent flashes occupies no more than **25% of a 341×256 pixel rectangle** (at 1024×768 reference resolution)

### What We Detect

| Hazard | Detection Method |
|--------|-----------------|
| **Luminance flashes** | Frame-to-frame relative luminance change ≥ 0.1 |
| **Red saturation flashes** | Transitions to/from saturated red (`R/(R+G+B) ≥ 0.8`) |
| **Spatial patterns** | Harmful repeating patterns with high contrast (future) |

## Tech Stack

- **Electron** — Cross-platform desktop app with screen capture APIs
- **TypeScript** — Type-safe application logic
- **desktopCapturer / getDisplayMedia** — Native screen capture
- Inspired by [EA IRIS](https://github.com/electronicarts/IRIS) photosensitivity analysis algorithms

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- npm

### Installation

```bash
cd screenfilter-electron
npm install
```

### Running

```bash
npm start
```

This builds the TypeScript and launches the Electron overlay. Click **Start** to begin screen capture.

## Architecture

```
screenfilter-electron/
├── src/
│   ├── main.ts          # Electron main process — window setup, capture config
│   └── renderer.ts      # Renderer process — capture stream, analysis, display
├── index.html           # Overlay UI
├── package.json
└── tsconfig.json
```

### Main Process (`main.ts`)
Creates a **frameless, transparent, always-on-top, click-through** window — the overlay sits on top of everything but doesn't intercept mouse/keyboard input. Configures `desktopCapturer` to grab the full screen.

### Renderer Process (`renderer.ts`)
Requests a display media stream at 30fps, pipes it into a `<video>` element for display. This is where frame analysis and filtering will be added.

## Pipeline (In Progress)

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────────┐
│   Capture   │───▶│ Ring Buffer  │───▶│   Analyze    │───▶│    Filter    │───▶│   Display   │
│  (30 fps)   │    │ (~6 frames)  │    │  luminance   │    │  blur/clamp  │    │  overlay    │
│             │    │              │    │  flash count  │    │              │    │             │
└─────────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └─────────────┘
```

### Luminance Analysis

Each pixel is converted to relative luminance using the W3C formula:

```
L = 0.2126 × R_linear + 0.7152 × G_linear + 0.0722 × B_linear
```

Frame-to-frame luminance differences are tracked per-region, and transitions are counted over a rolling 1-second window.

### Filtering Strategy

When a region is flagged:
- **Luminance clamping** — limit brightness delta to below the 0.1 flash threshold
- **Gaussian blur** — smooth the flagged region to reduce contrast

## Roadmap

- [x] Electron overlay with screen capture
- [ ] Frame ring buffer with configurable delay
- [ ] Per-frame luminance computation (Canvas/WebGL)
- [ ] Flash transition counting (rolling 1-second window)
- [ ] Red saturation flash detection
- [ ] Area threshold check (WCAG small-area exemption)
- [ ] Real-time blur/clamp filter on flagged regions
- [ ] Spatial pattern detection (referencing EA IRIS algorithms)
- [ ] Settings UI (delay, sensitivity, filter mode)
- [ ] Cross-platform testing (macOS, Windows, Linux)

## References

- [WCAG 2.0 Guideline 2.3.1 — Three Flashes or Below Threshold](https://www.w3.org/TR/WCAG20/#seizure)
- [EA IRIS — Photosensitivity Analysis Tool](https://github.com/electronicarts/IRIS)
- [Harding Test (ITC Guidelines)](https://www.hardingfpa.com/)

## License

ISC
