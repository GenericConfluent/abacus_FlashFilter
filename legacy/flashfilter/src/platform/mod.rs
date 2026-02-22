/// A single captured screen frame. Pixel data is RGBA, top-to-bottom row order.
pub struct Frame {
    pub data:   Vec<u8>,
    pub width:  u32,
    pub height: u32,
}

pub trait FrameCapture {
    /// Try to return the latest frame. Returns `None` when no new frame is
    /// ready yet (e.g. the capture is running behind or the timeout elapsed).
    fn capture(&mut self) -> Option<Frame>;
}

#[cfg(windows)]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

// Re-export the platform capture type as a single name used by main.rs.
#[cfg(windows)]
pub use windows::DxgiCapture as PlatformCapture;

#[cfg(target_os = "macos")]
pub use macos::ScreenCapture as PlatformCapture;
