// Pass 2 — Color EMA
//
// Maintains a slow running average of raw frame colours so we have a
// "stable" replacement colour ready when a flash is detected.
//   new_avg = avg + color_alpha * (curr - avg)   (normal frames)
//   new_avg = curr                                (first frame: bootstrap)

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    let pos = positions[vi];
    let uv = vec2<f32>(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    return VertexOutput(vec4<f32>(pos, 0.0, 1.0), uv);
}

@group(0) @binding(0) var curr_frame:  texture_2d<f32>;
@group(0) @binding(1) var color_avg:   texture_2d<f32>;
@group(0) @binding(2) var tex_sampler: sampler;

struct Params {
    color_alpha: f32,
    first_frame: f32,
    _pad:        vec2<f32>,
}
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let curr = textureSample(curr_frame, tex_sampler, uv).rgb;
    let avg  = textureSample(color_avg,  tex_sampler, uv).rgb;

    let new_avg = mix(avg + params.color_alpha * (curr - avg), curr, params.first_frame);

    return vec4<f32>(new_avg, 1.0);
}
