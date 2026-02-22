use dxgi_capture_rs::{CaptureError, DXGIManager};
use winit::window::Window;

use super::{Frame, FrameCapture};

pub struct DxgiCapture {
    manager: DXGIManager,
}

impl DxgiCapture {
    pub fn new() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // 100 ms timeout — if no new frame arrives in that window we return
        // None rather than blocking the render thread.
        let manager = DXGIManager::new(100)?;
        Ok(Self { manager })
    }
}

impl FrameCapture for DxgiCapture {
    fn capture(&mut self) -> Option<Frame> {
        match self.manager.capture_frame() {
            Ok((pixels, (width, height))) => {
                // dxgi-capture-rs returns BGRA8 structs; convert to packed RGBA
                // bytes so the GPU-side texture format is uniform across
                // platforms.
                let data: Vec<u8> = pixels
                    .iter()
                    .flat_map(|p| [p.r, p.g, p.b, p.a])
                    .collect();
                Some(Frame { data, width, height })
            }
            Err(CaptureError::Timeout) => None,
            Err(e) => {
                eprintln!("DXGI capture error: {e:?}");
                None
            }
        }
    }
}

/// Apply window properties that are only available through Win32:
///   • WS_EX_TRANSPARENT | WS_EX_LAYERED  — mouse/keyboard pass through
///   • WDA_EXCLUDEFROMCAPTURE              — window invisible to DXGI capture
pub fn setup_window(window: &Window) {
    use raw_window_handle::HasWindowHandle;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowDisplayAffinity, SetWindowLongPtrW, GWL_EXSTYLE,
        WDA_EXCLUDEFROMCAPTURE, WS_EX_LAYERED, WS_EX_TRANSPARENT,
    };

    let Ok(handle) = window.window_handle() else { return };
    let raw_window_handle::RawWindowHandle::Win32(h) = handle.as_raw() else { return };

    let hwnd = HWND(h.hwnd.get() as *mut core::ffi::c_void);

    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            ex | WS_EX_TRANSPARENT.0 as isize | WS_EX_LAYERED.0 as isize,
        );

        // Exclude from all screen-capture APIs (DXGI Desktop Duplication,
        // Graphics Capture, PrintWindow, etc.)  Requires Windows 10 20H1+.
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    }
}
