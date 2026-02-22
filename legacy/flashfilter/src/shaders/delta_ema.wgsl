// Pass 1 — Delta EMA
//
// Computes the euclidean distance between the previous and current frame,
// then blends it into the running delta history via an EMA:
//   new_hist = hist + alpha * (delta - hist)   (normal frames)
//   new_hist = delta                             (first frame: bootstrap EMA)

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
    // Full-screen triangle. Covers the entire clip space with 3 vertices.
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    let pos = positions[vi];
    // UV: origin at top-left of texture, y flipped relative to NDC.
    let uv = vec2<f32>(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    return VertexOutput(vec4<f32>(pos, 0.0, 1.0), uv);
}

@group(0) @binding(0) var prev_frame:  texture_2d<f32>;
@group(0) @binding(1) var curr_frame:  texture_2d<f32>;
@group(0) @binding(2) var delta_hist:  texture_2d<f32>;
@group(0) @binding(3) var tex_sampler: sampler;

struct Params {
    alpha:       f32,
    first_frame: f32,  // 1.0 on first frame (bootstrap), 0.0 thereafter
    _pad:        vec2<f32>,
}
@group(0) @binding(4) var<uniform> params: Params;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let prev  = textureSample(prev_frame, tex_sampler, uv).rgb;
    let curr  = textureSample(curr_frame, tex_sampler, uv).rgb;
    let hist  = textureSample(delta_hist, tex_sampler, uv).r;

    let delta    = distance(prev, curr);
    // EMA update, bootstrapped on first frame
    let new_hist = mix(hist + params.alpha * (delta - hist), delta, params.first_frame);

    return vec4<f32>(new_hist, new_hist, new_hist, 1.0);
}
