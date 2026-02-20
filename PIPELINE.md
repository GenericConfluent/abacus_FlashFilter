# Real-Time Epilepsy-Safe Screen Capture Pipeline

## The Big Picture

You're building a system that sits **between the user and the screen** — like a safety net with a tiny delay. Here's the full flow:

```mermaid
graph LR
    A[Screen] -->|capture @ 30fps| B[Frame Ring Buffer]
    B -->|each frame| C[Analysis Engine]
    C -->|risk flags| D[Filter Engine]
    D -->|safe frame| E[Display Window]
    
    style A fill:#1a1a2e,color:#fff,stroke:#e94560
    style B fill:#1a1a2e,color:#fff,stroke:#0f3460
    style C fill:#1a1a2e,color:#fff,stroke:#e94560
    style D fill:#1a1a2e,color:#fff,stroke:#16213e
    style E fill:#1a1a2e,color:#fff,stroke:#0f3460
```

---

## Stage 1: Screen Capture (Getting the Frames)

### How it works
At 30 fps, you get a new frame every **~33ms**. The OS gives you raw pixel buffers.

```
macOS: ScreenCaptureKit → SCStreamOutput delegate → CMSampleBuffer (GPU texture)
Windows: Graphics.Capture → Direct3D11CaptureFrame (GPU texture)  
Linux: PipeWire → DMA-BUF or SHM buffer
```

### Key detail: Self-exclusion
Your display window must be **excluded** from what gets captured, or you'll get infinite recursion (screen-in-a-screen).

```
macOS example (pseudocode):
  filter = SCContentFilter(
    display: mainDisplay,
    excludingApplications: [myApp],  ← your overlay window
    exceptingWindows: []
  )
  stream = SCStream(filter, config, delegate)
  stream.startCapture()
```

Each captured frame arrives as a **GPU-side texture** (not CPU RAM). This is important for performance — you want to keep data on the GPU as much as possible.

---

## Stage 2: The Ring Buffer (Creating the Delay)

### Why a buffer?
You need a **small delay** (e.g., 100–200ms, or about 3–6 frames at 30fps) so you have time to analyze frames *before* showing them. This is the "safety gap."

### How it works

```
Ring Buffer (size = N frames, e.g. 6 for ~200ms at 30fps)
┌─────┬─────┬─────┬─────┬─────┬─────┐
│ F0  │ F1  │ F2  │ F3  │ F4  │ F5  │
└─────┴─────┴─────┴─────┴─────┴─────┘
  ↑                               ↑
  Display pointer              Write pointer
  (oldest analyzed frame)      (newest captured frame)
```

- **Write pointer**: Where the newest captured frame goes
- **Display pointer**: The frame currently being shown (N frames behind)
- Frames between them are being analyzed

### Data stored per frame
```
struct FrameData {
    texture: GPUTexture       // the raw pixels
    timestamp: f64            // when it was captured
    luminance_map: [f32]      // per-pixel relative luminance (computed)
    red_saturation: [f32]     // per-pixel red saturation (computed)
    is_analyzed: bool         // has analysis completed?
    flash_regions: [Rect]     // detected flash areas
    pattern_regions: [Rect]   // detected harmful pattern areas
}
```

---

## Stage 3: Analysis Engine (Detecting Flashes)

This is the core. For each new frame, you run detection **against the buffered history**.

### Step 3a: Compute Relative Luminance

For every pixel, convert from sRGB to **relative luminance** using the W3C formula:

```
For each pixel (R, G, B) in 0–255 range:

1. Linearize (undo sRGB gamma):
   R_lin = (R/255 ≤ 0.04045) ? R/255/12.92 : ((R/255 + 0.055)/1.055)^2.4
   G_lin = (same for G)
   B_lin = (same for B)

2. Relative luminance:
   L = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
   
   Result: L is in range [0.0, 1.0]
   (0.0 = pure black, 1.0 = pure white)
```

### Step 3b: Detect Luminance Flashes (frame-to-frame)

Compare the luminance map of the **current frame** vs the **previous frame**:

```
For each pixel (x, y):
    diff = abs(L_current[x,y] - L_previous[x,y])
    
    if diff >= 0.1:           ← WCAG threshold (10% relative luminance change)
        mark pixel as "flashing"
```

This gives you a **flash mask** — a binary image showing which pixels flashed.

### Step 3c: Detect Red Flashes

A "red flash" is a transition to/from saturated red:

```
For each pixel:
    red_saturated = (R / (R + G + B)) >= 0.8  AND  (R_lin - G_lin - B_lin) > 0
    
    if red_saturated_current != red_saturated_previous:
        mark pixel as "red flashing"
```

### Step 3d: Count Transitions Over 1 Second (The WCAG Rule)

This is where it gets interesting. You need to look at the **history** of each pixel region.

> **WCAG Rule**: No more than **3 general flashes** or **3 red flashes** within any 1-second period.

```
For each pixel region, maintain a transition counter:

    transitions_in_last_second = 0
    
    for each consecutive frame pair in the last 1 second (last 30 frames):
        if flash_mask[frame_N][x,y] was triggered:
            transitions_in_last_second++
    
    if transitions_in_last_second > 6:    ← 3 flashes = 6 transitions (up+down)
        mark region as FAILING
```

### Step 3e: Area Threshold Check (The "Small Area" Exemption)

> **WCAG**: Flashes are safe if the combined flash area is less than **1/4 of a 341×256 px rectangle** at 1024×768 resolution.

```
Safe area threshold = (341 * 256) / 4 = 21,824 pixels (at 1024x768)

If your screen is higher resolution, scale proportionally:
    scale_x = screen_width / 1024
    scale_y = screen_height / 768
    safe_area = 21,824 * scale_x * scale_y

Count total "failing" pixels in the flash mask:
    if failing_pixel_count < safe_area:
        → PASS (flash is too small to be dangerous)
    else:
        → FAIL (needs filtering)
```

### Putting analysis together (per frame)

```
on_new_frame(frame):
    1. Compute luminance map for this frame
    2. Compute flash mask (vs previous frame)
    3. Compute red flash mask (vs previous frame)
    4. Update per-region transition counters (rolling 1-second window)
    5. Check if any region exceeds 3 flashes/sec AND exceeds area threshold
    6. If failing → store the failing regions as rectangles
    7. Mark frame as analyzed
```

---

## Stage 4: Filter Engine (Making it Safe)

When a frame is flagged, you apply a filter to the dangerous regions **before display**.

### Options for filtering

| Method | Pros | Cons |
|--------|------|------|
| **Gaussian blur** on flash regions | Natural look, reduces contrast | Still shows some motion |
| **Luminance clamp** (limit brightness change) | Preserves detail, just dampens flashes | More complex to tune |
| **Dim/darken** the region | Simple, effective | Can obscure content |
| **Freeze frame** on that region | Eliminates the flash entirely | Looks jarring |

### Recommended: Luminance clamping + blur hybrid

```
For each pixel in a flagged region:
    // Clamp the luminance change to a safe delta
    max_safe_delta = 0.08  // below the 0.1 threshold
    
    actual_delta = L_current - L_previous
    if abs(actual_delta) > max_safe_delta:
        clamped_L = L_previous + sign(actual_delta) * max_safe_delta
        // Reconstruct the pixel color with the clamped luminance
    
    // Then apply a mild Gaussian blur (radius ~5px) for smoothing
```

This approach **dampens the flash** while preserving most of the visual content.

---

## Stage 5: Display (Showing the Safe Output)

Render the (possibly filtered) frame to a **borderless, fullscreen overlay window**.

```
Display loop (runs at 30fps, synced to capture):
    1. Read the frame at the display pointer (oldest analyzed frame)
    2. If frame has flash_regions → apply filter shader
    3. Render to overlay window (using Metal/Vulkan/OpenGL)
    4. Advance display pointer
```

---

## Timing Budget at 30fps

You have **~33ms per frame**. Here's roughly how to budget it:

```
┌──────────────────────────────────────────────────────┐
│ 33ms total budget per frame                          │
├──────────────┬───────────┬────────────┬──────────────┤
│ Capture      │ Luminance │ Flash      │ Filter +     │
│ (~2ms)       │ compute   │ detection  │ Display      │
│              │ (~5ms     │ (~5ms GPU) │ (~5ms)       │
│              │  GPU)     │            │              │
├──────────────┴───────────┴────────────┴──────────────┤
│ ~16ms headroom for spikes                            │
└──────────────────────────────────────────────────────┘
```

> [!TIP]
> The luminance computation and flash detection can be done as **GPU compute shaders**, making them extremely fast. You'd only pull small amounts of data back to the CPU (the region rectangles and transition counts).

---

## The ~200ms Delay Explained

```
Timeline (each tick = 33ms):

t=0     t=33    t=66    t=99    t=132   t=165   t=198
 F0      F1      F2      F3      F4      F5      F6
 ↑                                               ↑
 Displayed                                     Captured
 to user                                       right now

User sees F0 while F1–F5 are being analyzed.
By the time F0 is shown, we've had 6 frames of lookahead
to confirm it is safe (or to apply filters).
```

The user perceives a **~200ms latency** — barely noticeable for most content (similar to wireless headphone latency). For gaming it would be more noticeable, but for general browsing/video watching it's imperceptible.

---

## Summary: What You Need to Build

| Component | Technology | Complexity |
|-----------|-----------|------------|
| Screen capture | ScreenCaptureKit (macOS) | Medium — Apple has good docs |
| Ring buffer | Custom circular buffer holding GPU textures | Low |
| Luminance computation | Metal/WGSL compute shader | Medium |
| Flash detection | CPU or GPU (compare luminance maps, count transitions) | Medium-High |
| Pattern detection | Reference IRIS library (spatial frequency analysis) | High |
| Filter engine | GPU shader (blur + luminance clamp) | Medium |
| Display window | Metal/Vulkan rendered borderless overlay | Medium |

