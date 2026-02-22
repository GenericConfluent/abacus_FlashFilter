use std::sync::mpsc::{sync_channel, Receiver, SyncSender};

use screencapturekit::{
    cm::CMSampleBuffer,
    cv::CVPixelBufferLockFlags,
    shareable_content::SCShareableContent,
    stream::{
        configuration::{PixelFormat, SCStreamConfiguration},
        content_filter::SCContentFilter,
        output_trait::SCStreamOutputTrait,
        output_type::SCStreamOutputType,
        sc_stream::SCStream,
    },
};
use winit::window::Window;

use super::{Frame, FrameCapture};

// ---------------------------------------------------------------------------
// Frame callback handler
// ---------------------------------------------------------------------------

struct CaptureHandler {
    tx:     SyncSender<Frame>,
    width:  u32,
    height: u32,
}

impl SCStreamOutputTrait for CaptureHandler {
    fn did_output_sample_buffer(
        &self,
        sample: CMSampleBuffer,
        _output_type: SCStreamOutputType,
    ) {
        let Some(pixel_buffer) = sample.image_buffer() else { return };
        let Ok(guard) = pixel_buffer.lock(CVPixelBufferLockFlags::READ_ONLY) else { return };

        let bytes_per_row = guard.bytes_per_row();
        let raw = guard.as_slice();

        let width  = self.width  as usize;
        let height = self.height as usize;

        // Copy each row respecting the stride, converting BGRA → RGBA.
        let mut data = Vec::with_capacity(width * height * 4);
        for row in 0..height {
            let row_start = row * bytes_per_row;
            let row_bytes = &raw[row_start..row_start + width * 4];
            for pixel in row_bytes.chunks_exact(4) {
                // ScreenCaptureKit BGRA layout: [B, G, R, A]
                data.push(pixel[2]); // R
                data.push(pixel[1]); // G
                data.push(pixel[0]); // B
                data.push(pixel[3]); // A
            }
        }

        let _ = self.tx.try_send(Frame {
            data,
            width:  self.width,
            height: self.height,
        });
    }
}

// ---------------------------------------------------------------------------
// Public capture type
// ---------------------------------------------------------------------------

pub struct ScreenCapture {
    // Keep the stream alive for as long as the capture is running.
    _stream: SCStream,
    rx:      Receiver<Frame>,
}

impl ScreenCapture {
    pub fn new() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let content = SCShareableContent::get()?;
        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or("no display found")?;

        let width  = display.width();
        let height = display.height();

        // Capture the entire display; no window exclusions are specified here
        // because our overlay sets NSWindowSharingNone (see setup_window), so
        // it will not appear in the captured frames anyway.
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();

        let config = SCStreamConfiguration::new()
            .with_width(width)
            .with_height(height)
            .with_pixel_format(PixelFormat::BGRA)
            .with_fps(60);

        let (tx, rx) = sync_channel(1);
        let handler  = CaptureHandler { tx, width, height };

        let mut stream = SCStream::new(&filter, &config);
        stream.add_output_handler(handler, SCStreamOutputType::Screen);
        stream.start_capture()?;

        Ok(Self { _stream: stream, rx })
    }
}

impl FrameCapture for ScreenCapture {
    fn capture(&mut self) -> Option<Frame> {
        self.rx.try_recv().ok()
    }
}

// ---------------------------------------------------------------------------
// Window setup
// ---------------------------------------------------------------------------

/// Apply macOS-specific window properties via the Objective-C runtime:
///   • setIgnoresMouseEvents  — input passes through the window
///   • setSharingType: 0      — NSWindowSharingNone, invisible to capture APIs
///   • setCollectionBehavior  — visible on all Spaces / full-screen apps
pub fn setup_window(window: &Window) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use winit::raw_window_handle::HasWindowHandle;

    let Ok(handle) = window.window_handle() else { return };
    let winit::raw_window_handle::RawWindowHandle::AppKit(h) = handle.as_raw() else { return };

    unsafe {
        // raw_window_handle 0.6 gives us the NSView pointer.
        let ns_view: *mut AnyObject = h.ns_view.as_ptr().cast();
        let ns_window: *mut AnyObject = msg_send![ns_view, window];
        if ns_window.is_null() {
            return;
        }

        // Pass all mouse and keyboard events straight through.
        let _: () = msg_send![ns_window, setIgnoresMouseEvents: true];

        // Prevent our overlay from appearing in screenshots / recordings.
        // NSWindowSharingNone = 0
        let _: () = msg_send![ns_window, setSharingType: 0u64];

        // Raise the window level to NSScreenSaverWindowLevel (1000) so the
        // overlay sits above full-screen apps and videos inside their Space.
        let _: () = msg_send![ns_window, setLevel: 1000i64];

        // NSWindowCollectionBehaviorCanJoinAllSpaces   (1 << 0 =   1)
        //   → window appears in every Space, including full-screen app Spaces.
        // NSWindowCollectionBehaviorStationary         (1 << 4 =  16)
        //   → unaffected by Exposé / Mission Control; does not move between Spaces.
        // NSWindowCollectionBehaviorIgnoresCycle       (1 << 6 =  64)
        //   → excluded from Cmd+Tab switcher.
        // NSWindowCollectionBehaviorFullScreenAuxiliary (1 << 8 = 256)
        //   → permitted to appear alongside a full-screen primary window.
        let behavior: u64 = 1 | 16 | 64 | 256;
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
    }
}
