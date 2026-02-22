// Pass 3 — Output
//
// For each pixel: if the delta history value exceeds the flash threshold,
// replace that pixel with the averaged colour (opaque).  Otherwise output
// fully transparent so the real desktop shows through.

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

@group(0) @binding(0) var delta_hist:  texture_2d<f32>;
@group(0) @binding(1) var color_avg:   texture_2d<f32>;
@group(0) @binding(2) var tex_sampler: sampler;

struct Params {
    threshold: f32,
}
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let flash_val = textureSample(delta_hist, tex_sampler, uv).r;

    if flash_val > params.threshold {
        // Flashing pixel — cover it with the averaged (stable) colour
        let avg = textureSample(color_avg, tex_sampler, uv).rgb;
        return vec4<f32>(avg, 1.0);
    }

    // Not flashing — fully transparent, desktop shows through
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
