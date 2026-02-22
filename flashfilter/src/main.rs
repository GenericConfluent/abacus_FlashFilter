mod filter;
mod platform;

use std::sync::{mpsc, Arc};

use filter::{FilterConfig, FilterPipeline};
use platform::{Frame, FrameCapture, PlatformCapture};
use winit::{
    application::ApplicationHandler,
    dpi::PhysicalPosition,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::{Window, WindowAttributes, WindowLevel},
};

// ---------------------------------------------------------------------------
// GPU render state (wgpu surface + filter pipeline)
// ---------------------------------------------------------------------------

struct RenderState {
    surface:        wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    filter:         FilterPipeline,
}

impl RenderState {
    async fn new(window: Arc<Window>, width: u32, height: u32) -> Result<Self, Box<dyn std::error::Error>> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends:             wgpu::Backends::PRIMARY,
            flags:                wgpu::InstanceFlags::default(),
            dx12_shader_compiler: Default::default(),
            gles_minor_version:   Default::default(),
        });

        let surface = instance.create_surface(window)?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference:       wgpu::PowerPreference::HighPerformance,
                compatible_surface:     Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .ok_or("no suitable GPU adapter found")?;

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label:             None,
                    required_features: wgpu::Features::empty(),
                    required_limits:   wgpu::Limits::default(),
                    memory_hints:      Default::default(),
                },
                None,
            )
            .await?;

        let caps = surface.get_capabilities(&adapter);
        let surface_fmt = caps.formats[0];

        // Prefer PostMultiplied alpha so the OS compositor treats the alpha
        // channel from our output shader as real window transparency.
        let alpha_mode = [
            wgpu::CompositeAlphaMode::PostMultiplied,
            wgpu::CompositeAlphaMode::PreMultiplied,
            wgpu::CompositeAlphaMode::Auto,
        ]
        .into_iter()
        .find(|m| caps.alpha_modes.contains(m))
        .unwrap_or(wgpu::CompositeAlphaMode::Auto);

        let surface_config = wgpu::SurfaceConfiguration {
            usage:                        wgpu::TextureUsages::RENDER_ATTACHMENT,
            format:                       surface_fmt,
            width,
            height,
            present_mode:                 wgpu::PresentMode::AutoVsync,
            alpha_mode,
            view_formats:                 vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &surface_config);

        let filter = FilterPipeline::new(
            device,
            queue,
            surface_fmt,
            width,
            height,
            FilterConfig::default(),
        );

        Ok(Self { surface, surface_config, filter })
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 { return; }
        self.surface_config.width  = width;
        self.surface_config.height = height;
        self.surface.configure(self.filter.device(), &self.surface_config);
    }

    /// Run the filter pipeline for one frame.  If no captured frame is
    /// available yet, we skip rendering — the window starts transparent so the
    /// desktop shows through until the first real frame arrives.
    fn render(&mut self, frame: Option<&Frame>) {
        let Some(f) = frame else { return };

        let output = match self.surface.get_current_texture() {
            Ok(t)  => t,
            Err(e) => { eprintln!("swap-chain error: {e}"); return; }
        };
        let view = output.texture.create_view(&Default::default());
        self.filter.process_frame(&f.data, &view);
        output.present();
    }
}

// ---------------------------------------------------------------------------
// winit application handler
// ---------------------------------------------------------------------------

struct App {
    window:   Option<Arc<Window>>,
    state:    Option<RenderState>,
    frame_rx: mpsc::Receiver<Frame>,
    latest:   Option<Frame>,
}

impl App {
    fn new(frame_rx: mpsc::Receiver<Frame>) -> Self {
        Self { window: None, state: None, frame_rx, latest: None }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let monitor = event_loop
            .primary_monitor()
            .expect("no primary monitor detected");
        let size = monitor.size(); // physical pixels

        let attrs = WindowAttributes::default()
            .with_title("flashfilter")
            .with_inner_size(size)
            .with_position(PhysicalPosition::new(0_i32, 0_i32))
            .with_decorations(false)
            .with_transparent(true)
            .with_resizable(false)
            .with_window_level(WindowLevel::AlwaysOnTop);

        let window = Arc::new(
            event_loop.create_window(attrs).expect("window creation failed"),
        );

        // Platform-specific: make input pass through the window and exclude it
        // from the screen-capture pipeline so it never appears in our own
        // captured frames.
        #[cfg(windows)]
        platform::windows::setup_window(&window);
        #[cfg(target_os = "macos")]
        platform::macos::setup_window(&window);

        let state = pollster::block_on(RenderState::new(
            window.clone(),
            size.width,
            size.height,
        ))
        .expect("GPU initialisation failed");

        self.window = Some(window.clone());
        self.state  = Some(state);
        window.request_redraw();
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: winit::window::WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),

            WindowEvent::Resized(size) => {
                if let Some(s) = &mut self.state {
                    s.resize(size.width, size.height);
                }
            }

            WindowEvent::RedrawRequested => {
                // Drain the channel, keeping only the most recent frame.
                // Only render when a *new* frame has arrived; re-running the
                // filter on stale data would advance the EMA with zero motion
                // and cause flash detections to decay far too quickly.
                let mut new_frame = false;
                while let Ok(f) = self.frame_rx.try_recv() {
                    self.latest = Some(f);
                    new_frame = true;
                }
                if new_frame {
                    if let Some(s) = &mut self.state {
                        s.render(self.latest.as_ref());
                    }
                }
            }

            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        // Re-render as fast as possible, matching the original's ~1 ms target.
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    // Screen capture runs on its own thread so it never blocks the render loop.
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Frame>(1);

    std::thread::spawn(move || {
        let mut cap = match PlatformCapture::new() {
            Ok(c)  => c,
            Err(e) => { eprintln!("capture initialisation failed: {e}"); return; }
        };
        loop {
            if let Some(frame) = cap.capture() {
                // Bounded channel of size 1: if the GPU is busy we drop the
                // incoming frame rather than buffering stale data.
                let _ = frame_tx.try_send(frame);
            }
        }
    });

    let event_loop = EventLoop::new().expect("event loop creation failed");
    event_loop.set_control_flow(ControlFlow::Poll);

    let mut app = App::new(frame_rx);
    event_loop.run_app(&mut app).expect("event loop error");
}
