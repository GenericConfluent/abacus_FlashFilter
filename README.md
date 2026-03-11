<img width="806" height="452" alt="image" src="https://github.com/user-attachments/assets/6a2ff603-f914-439c-8a83-155bd05a2607" />

# FlashFilter

Cross Platform Real-time screen flash detection and suppression .

FlashFilter runs as a transparent overlay on top of your screen, continuously analyzing every frame for sudden flashes. When it detects flashing content, it smooths those regions out before they reach your eyes. No configuration, no interaction needed — just run it and forget about it.


## Why this exists

There is currently no good solution for protecting users from unexpected screen flashes. Apple's "Reduce Flashing" feature takes 2-3 seconds to activate and blacks out the entire screen when it does, which makes content completely unusable. Microsoft offers nothing at all. We searched extensively and found no third-party tools that solve this problem either.

Flashing content is a real hazard for people with photosensitive epilepsy, and it causes discomfort for a much wider group — people who get migraines, sensory overload, or simply don't want to get flash-banged while scrolling at night or gaming.


## How it works

FlashFilter uses an Electron app with a WebGL-powered transparent overlay. Each frame is processed entirely on the GPU using custom shaders that track per-pixel temporal intensity patterns to detect rapid oscillations (flashing) while ignoring normal movement like scrolling or dragging windows.

The algorithm runs in constant time and constant memory per frame. There are no frame history buffers and no growing allocations. This means it can keep up with extremely high refresh rates without any performance degradation.

Key numbers:

- 8.3ms detection latency
- Supports refresh rates up to 1000+ FPS
- Constant time and memory per frame regardless of resolution


## Getting started

Prerequisites: Node.js and npm

```
cd flashfilter
npm install
npm run build
npm start
```

The overlay window will launch and begin monitoring your screen immediately. It stays active in the background until you close it.


## Testing

We tested FlashFilter extensively across different use cases:

- Watched a full movie with it running
- Played Call of Duty through the overlay
- Used it as a daily driver for general browsing over a full day

In all cases, the overlay introduced no noticeable interference with normal screen content while successfully catching and smoothing out flash events.


## Tech stack

- Electron
- TypeScript
- WebGL (GPU-accelerated frame processing)
- Node.js


## Limitations

- The Electron runtime results in a larger memory footprint than ideal (around 800MB). A native rewrite could bring this under 10MB.
- Certain carefully shaped flash patterns that align with the screen's refresh rate can slip past detection.
- The algorithm does not yet weight red flashes more heavily, even though research shows red spectrum flashing is more likely to trigger photosensitive seizures.
- Linux support is not yet available due to limitations with Wayland and X11 transparent overlay APIs.


## License

ISC
