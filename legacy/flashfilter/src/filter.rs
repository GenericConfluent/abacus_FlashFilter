/// Tuning knobs that mirror the originals in flashing-dissolver.ts.
pub struct FilterConfig {
    /// EMA rate for the delta (flash-detection) history.  Higher = more
    /// reactive to sudden changes.  Default: 0.7
    pub delta_alpha: f32,
    /// EMA rate for the colour average.  Lower = smoother replacement colour.
    /// Default: 0.05
    pub color_alpha: f32,
    /// Normalised delta value [0,1] above which a pixel is considered flashing.
    /// Default: 0.05
    pub flash_threshold: f32,
}

impl Default for FilterConfig {
    fn default() -> Self {
        Self {
            delta_alpha:     0.7,
            color_alpha:     0.05,
            flash_threshold: 0.05,
        }
    }
}

// ---------------------------------------------------------------------------
// GPU-side uniform structs (must match the WGSL layout — 16-byte aligned)
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct DeltaEmaParams {
    alpha:       f32,
    first_frame: f32,
    _pad:        [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ColorEmaParams {
    color_alpha: f32,
    first_frame: f32,
    _pad:        [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct OutputParams {
    threshold: f32,
    _pad:      [f32; 3],
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn make_texture(
    device: &wgpu::Device,
    width:  u32,
    height: u32,
    format: wgpu::TextureFormat,
    usage:  wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label:           None,
        size:            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count:    1,
        dimension:       wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats:    &[],
    })
}

fn make_pipeline(
    device:      &wgpu::Device,
    shader_src:  &str,
    bgl:         &wgpu::BindGroupLayout,
    target_fmt:  wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label:  None,
        source: wgpu::ShaderSource::Wgsl(shader_src.into()),
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label:                None,
        bind_group_layouts:   &[bgl],
        push_constant_ranges: &[],
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label:  None,
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module:              &shader,
            entry_point:         Some("vs_main"),
            buffers:             &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module:              &shader,
            entry_point:         Some("fs_main"),
            targets:             &[Some(wgpu::ColorTargetState {
                format:     target_fmt,
                blend:      None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState {
            topology:           wgpu::PrimitiveTopology::TriangleList,
            strip_index_format: None,
            front_face:         wgpu::FrontFace::Ccw,
            cull_mode:          None,
            unclipped_depth:    false,
            polygon_mode:       wgpu::PolygonMode::Fill,
            conservative:       false,
        },
        depth_stencil: None,
        multisample:   wgpu::MultisampleState::default(),
        multiview:     None,
        cache:         None,
    })
}

fn tex_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type:    wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled:   false,
        },
        count: None,
    }
}

fn sampler_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty:         wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count:      None,
    }
}

fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty:                 wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size:   None,
        },
        count: None,
    }
}

fn uniform_buf(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label:              None,
        size,
        usage:              wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

// ---------------------------------------------------------------------------
// FilterPipeline
// ---------------------------------------------------------------------------

/// Three-pass GPU pipeline replicating flashing-dissolver.ts in WGSL/wgpu.
///
/// Pass 1 — Delta EMA : temporal smoothing of inter-frame pixel differences.
/// Pass 2 — Colour EMA: slow running average of raw frame colours.
/// Pass 3 — Output    : replace flashing pixels; transparent elsewhere.
pub struct FilterPipeline {
    device: wgpu::Device,
    queue:  wgpu::Queue,

    width:  u32,
    height: u32,

    // Ping-pong pair for previous / current captured frame (RGBA8).
    frame_tex:   [wgpu::Texture;     2],
    frame_views: [wgpu::TextureView; 2],
    // Slot holding the *current* frame this render.
    frame_idx:   usize,

    // Ping-pong for delta EMA history (RGBA8, only R channel is meaningful).
    delta_tex:   [wgpu::Texture;     2],
    delta_views: [wgpu::TextureView; 2],
    delta_read:  usize, // slot to *read from* this frame

    // Ping-pong for colour average (RGBA8).
    color_tex:   [wgpu::Texture;     2],
    color_views: [wgpu::TextureView; 2],
    color_read:  usize,

    sampler: wgpu::Sampler,

    delta_ema_pipeline: wgpu::RenderPipeline,
    color_ema_pipeline: wgpu::RenderPipeline,
    output_pipeline:    wgpu::RenderPipeline,

    delta_ema_bgl: wgpu::BindGroupLayout,
    color_ema_bgl: wgpu::BindGroupLayout,
    output_bgl:    wgpu::BindGroupLayout,

    delta_uniform:  wgpu::Buffer,
    color_uniform:  wgpu::Buffer,
    output_uniform: wgpu::Buffer,

    first_frame:    bool,
    has_prev_frame: bool,

    pub config: FilterConfig,
}

impl FilterPipeline {
    pub fn new(
        device:      wgpu::Device,
        queue:       wgpu::Queue,
        surface_fmt: wgpu::TextureFormat,
        width:       u32,
        height:      u32,
        config:      FilterConfig,
    ) -> Self {
        const INT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

        let frame_usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST;
        let ema_usage   = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT;

        let mk = |usage| {
            let t = make_texture(&device, width, height, INT, usage);
            let v = t.create_view(&Default::default());
            (t, v)
        };

        let (ft0, fv0) = mk(frame_usage);
        let (ft1, fv1) = mk(frame_usage);
        let (dt0, dv0) = mk(ema_usage);
        let (dt1, dv1) = mk(ema_usage);
        let (ct0, cv0) = mk(ema_usage);
        let (ct1, cv1) = mk(ema_usage);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter:     wgpu::FilterMode::Linear,
            min_filter:     wgpu::FilterMode::Linear,
            ..Default::default()
        });

        // Pass 1: prev_frame(0), curr_frame(1), delta_hist(2), sampler(3), uniform(4)
        let delta_ema_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label:   Some("delta_ema_bgl"),
            entries: &[
                tex_entry(0), tex_entry(1), tex_entry(2),
                sampler_entry(3),
                uniform_entry(4),
            ],
        });

        // Pass 2: curr_frame(0), color_avg(1), sampler(2), uniform(3)
        let color_ema_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label:   Some("color_ema_bgl"),
            entries: &[
                tex_entry(0), tex_entry(1),
                sampler_entry(2),
                uniform_entry(3),
            ],
        });

        // Pass 3: delta_hist(0), color_avg(1), sampler(2), uniform(3)
        let output_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label:   Some("output_bgl"),
            entries: &[
                tex_entry(0), tex_entry(1),
                sampler_entry(2),
                uniform_entry(3),
            ],
        });

        let delta_ema_pipeline = make_pipeline(
            &device, include_str!("shaders/delta_ema.wgsl"), &delta_ema_bgl, INT,
        );
        let color_ema_pipeline = make_pipeline(
            &device, include_str!("shaders/color_ema.wgsl"), &color_ema_bgl, INT,
        );
        let output_pipeline = make_pipeline(
            &device, include_str!("shaders/output.wgsl"), &output_bgl, surface_fmt,
        );

        let delta_uniform  = uniform_buf(&device, size_of::<DeltaEmaParams>() as u64);
        let color_uniform  = uniform_buf(&device, size_of::<ColorEmaParams>() as u64);
        let output_uniform = uniform_buf(&device, size_of::<OutputParams>()   as u64);

        Self {
            device,
            queue,
            width,
            height,
            frame_tex:   [ft0, ft1],
            frame_views: [fv0, fv1],
            frame_idx:   0,
            delta_tex:   [dt0, dt1],
            delta_views: [dv0, dv1],
            delta_read:  0,
            color_tex:   [ct0, ct1],
            color_views: [cv0, cv1],
            color_read:  0,
            sampler,
            delta_ema_pipeline,
            color_ema_pipeline,
            output_pipeline,
            delta_ema_bgl,
            color_ema_bgl,
            output_bgl,
            delta_uniform,
            color_uniform,
            output_uniform,
            first_frame:    true,
            has_prev_frame: false,
            config,
        }
    }

    pub fn device(&self) -> &wgpu::Device { &self.device }

    /// Upload a new RGBA frame and run all three passes, writing the result
    /// into `surface_view`.  On the very first call the frame is stored and
    /// the EMA textures are primed; no rendering occurs yet.
    pub fn process_frame(&mut self, data: &[u8], surface_view: &wgpu::TextureView) {
        let curr = self.frame_idx;
        let prev = 1 - curr;

        // Upload new frame into the current slot.
        self.queue.write_texture(
            wgpu::ImageCopyTexture {
                texture:   &self.frame_tex[curr],
                mip_level: 0,
                origin:    wgpu::Origin3d::ZERO,
                aspect:    wgpu::TextureAspect::All,
            },
            data,
            wgpu::ImageDataLayout {
                offset:         0,
                bytes_per_row:  Some(4 * self.width),
                rows_per_image: None,
            },
            wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
        );

        if !self.has_prev_frame {
            // Prime the "previous" slot with the same data so Pass 1 sees
            // a zero delta on bootstrap.
            self.queue.write_texture(
                wgpu::ImageCopyTexture {
                    texture:   &self.frame_tex[prev],
                    mip_level: 0,
                    origin:    wgpu::Origin3d::ZERO,
                    aspect:    wgpu::TextureAspect::All,
                },
                data,
                wgpu::ImageDataLayout {
                    offset:         0,
                    bytes_per_row:  Some(4 * self.width),
                    rows_per_image: None,
                },
                wgpu::Extent3d { width: self.width, height: self.height, depth_or_array_layers: 1 },
            );
            self.has_prev_frame = true;
            self.frame_idx = prev; // next call writes to the other slot
            return;
        }

        let first       = if self.first_frame { 1.0_f32 } else { 0.0 };
        let delta_write = 1 - self.delta_read;
        let color_write = 1 - self.color_read;

        // Write uniforms.
        self.queue.write_buffer(
            &self.delta_uniform, 0,
            bytemuck::bytes_of(&DeltaEmaParams {
                alpha:       self.config.delta_alpha,
                first_frame: first,
                _pad:        [0.0; 2],
            }),
        );
        self.queue.write_buffer(
            &self.color_uniform, 0,
            bytemuck::bytes_of(&ColorEmaParams {
                color_alpha: self.config.color_alpha,
                first_frame: first,
                _pad:        [0.0; 2],
            }),
        );
        self.queue.write_buffer(
            &self.output_uniform, 0,
            bytemuck::bytes_of(&OutputParams {
                threshold: self.config.flash_threshold,
                _pad:      [0.0; 3],
            }),
        );

        // Build per-frame bind groups.
        let delta_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label:   Some("delta_ema_bg"),
            layout:  &self.delta_ema_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&self.frame_views[prev]) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.frame_views[curr]) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.delta_views[self.delta_read]) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 4, resource: self.delta_uniform.as_entire_binding() },
            ],
        });

        let color_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label:   Some("color_ema_bg"),
            layout:  &self.color_ema_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&self.frame_views[curr]) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.color_views[self.color_read]) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: self.color_uniform.as_entire_binding() },
            ],
        });

        let output_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label:   Some("output_bg"),
            layout:  &self.output_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&self.delta_views[delta_write]) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.color_views[color_write]) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: self.output_uniform.as_entire_binding() },
            ],
        });

        // Encode all three passes in a single command buffer.
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        // Pass 1 — Delta EMA
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("delta_ema"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view:           &self.delta_views[delta_write],
                    resolve_target: None,
                    ops:            wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes:         None,
                occlusion_query_set:      None,
            });
            pass.set_pipeline(&self.delta_ema_pipeline);
            pass.set_bind_group(0, &delta_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        // Pass 2 — Colour EMA
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("color_ema"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view:           &self.color_views[color_write],
                    resolve_target: None,
                    ops:            wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes:         None,
                occlusion_query_set:      None,
            });
            pass.set_pipeline(&self.color_ema_pipeline);
            pass.set_bind_group(0, &color_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        // Pass 3 — Output to swap-chain surface
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("output"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view:           surface_view,
                    resolve_target: None,
                    ops:            wgpu::Operations {
                        load:  wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes:         None,
                occlusion_query_set:      None,
            });
            pass.set_pipeline(&self.output_pipeline);
            pass.set_bind_group(0, &output_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        self.queue.submit(std::iter::once(enc.finish()));

        // Advance ping-pong state for next frame.
        self.delta_read  = delta_write;
        self.color_read  = color_write;
        self.frame_idx   = prev; // next upload overwrites what is now "previous"
        self.first_frame = false;
    }
}
