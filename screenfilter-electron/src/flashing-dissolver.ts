// Full-screen quad vertex shader (shared by all passes)
const VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

// Pass 1: Flash Belief Update
// Per pixel: flash_rel_prev = exp(dist(curr, prev)) - 0.05
//            flash_rel_avg  = exp(dist(curr, avg))  - 0.05
//            delta = flash_rel_prev * flash_rel_avg
//            belief = max(belief * delta, 1.0)
// Belief decays toward 1.0 at rest (small dist → exp≈1 → delta≈0.9025),
// and grows above 1.0 when flashing (large dist → large exp → large delta).
const BELIEF_UPDATE_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_prevFrame;
uniform sampler2D u_currentFrame;
uniform sampler2D u_colorAvg;
uniform sampler2D u_belief;

void main() {
    vec3 prev = texture(u_prevFrame, v_uv).rgb;
    vec3 curr = texture(u_currentFrame, v_uv).rgb;
    vec3 avg  = texture(u_colorAvg,   v_uv).rgb;
    float oldBelief = texture(u_belief, v_uv).r;

    float distPrev = distance(curr, prev);
    float distAvg  = distance(curr, avg);

    float flashRelPrev = exp(distPrev) - 0.05;
    float flashRelAvg  = exp(distAvg)  - 0.05;

    float delta = flashRelPrev * flashRelAvg;

    // Clamp to min 1.0 so belief never reaches zero.
    float newBelief = max(oldBelief * delta, 1.0);

    fragColor = vec4(newBelief, 0.0, 0.0, 1.0);
}`;

// Pass 2: Color EMA
// Maintains a running average of the raw frame colors.
const COLOR_EMA_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_currentFrame;
uniform sampler2D u_colorAvg;
uniform float u_colorAlpha;
uniform float u_firstFrame;

void main() {
    vec3 curr = texture(u_currentFrame, v_uv).rgb;
    vec3 avg  = texture(u_colorAvg,    v_uv).rgb;

    // EMA: avg = avg + alpha * (curr - avg); on first frame, snap to curr.
    vec3 newAvg = mix(avg + u_colorAlpha * (curr - avg), curr, u_firstFrame);

    fragColor = vec4(newAvg, 1.0);
}`;

// Pass 3: Output
// If flash belief > threshold (baseline is 1.0), draw averaged color; otherwise transparent.
const OUTPUT_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_belief;
uniform sampler2D u_colorAvg;
uniform float u_threshold;

void main() {
    float belief = texture(u_belief, v_uv).r;

    if (belief > u_threshold) {
        vec3 avg = texture(u_colorAvg, v_uv).rgb;
        fragColor = vec4(avg, 1.0);
    } else {
        fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    }
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shader compile error: ${log}`);
    }
    return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(`Program link error: ${log}`);
    }
    return prog;
}

function createTexture(gl: WebGL2RenderingContext, width: number, height: number, float32: boolean = false): WebGLTexture {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float32) {
        // R32F: single-channel float, values can exceed 1.0 for belief accumulation.
        // Must use NEAREST filtering — LINEAR on float textures requires OES_texture_float_linear.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

function createFBO(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fbo;
}

export class FlashingDissolver {
    private gl: WebGL2RenderingContext;
    private width: number;
    private height: number;

    // Programs
    private beliefUpdateProgram: WebGLProgram;
    private colorEmaProgram: WebGLProgram;
    private outputProgram: WebGLProgram;

    // Full-screen quad VAO
    private quadVAO: WebGLVertexArrayObject;

    // Frame textures (uploaded each frame)
    private prevFrameTex: WebGLTexture;
    private currentFrameTex: WebGLTexture;

    // Flash belief ping-pong (R32F float — values range [1.0, ∞))
    private beliefTexA: WebGLTexture;
    private beliefTexB: WebGLTexture;
    private beliefFboA: WebGLFramebuffer;
    private beliefFboB: WebGLFramebuffer;
    private beliefReadA: boolean = true;

    // Color average ping-pong
    private colorAvgTexA: WebGLTexture;
    private colorAvgTexB: WebGLTexture;
    private colorAvgFboA: WebGLFramebuffer;
    private colorAvgFboB: WebGLFramebuffer;
    private colorReadA: boolean = true;

    // Temp canvas for bitmap → texture upload
    private tmpCanvas: OffscreenCanvas;
    private tmpCtx: OffscreenCanvasRenderingContext2D;

    private firstFrame: boolean = true;
    private hasPrevFrame: boolean = false;

    // Tuning parameters
    private colorAlpha: number = 0.05;  // EMA rate for color averaging (slower = smoother)
    private threshold: number = 1.5;    // flash belief threshold; baseline is 1.0, higher = less sensitive

    constructor(canvas: HTMLCanvasElement, captureWidth: number, captureHeight: number) {
        this.width = captureWidth;
        this.height = captureHeight;

        canvas.width = captureWidth;
        canvas.height = captureHeight;

        const gl = canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
        })!;
        if (!gl) throw new Error('WebGL2 not supported');
        this.gl = gl;

        // Required for rendering to float framebuffers (belief buffer).
        gl.getExtension('EXT_color_buffer_float');

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Compile programs
        this.beliefUpdateProgram = createProgram(gl, VERT_SRC, BELIEF_UPDATE_FRAG);
        this.colorEmaProgram     = createProgram(gl, VERT_SRC, COLOR_EMA_FRAG);
        this.outputProgram       = createProgram(gl, VERT_SRC, OUTPUT_FRAG);

        // Full-screen quad
        this.quadVAO = gl.createVertexArray()!;
        gl.bindVertexArray(this.quadVAO);
        const quadBuf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,  1, -1,  -1, 1,
            -1,  1,  1, -1,   1, 1,
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        // Frame textures
        this.prevFrameTex    = createTexture(gl, captureWidth, captureHeight);
        this.currentFrameTex = createTexture(gl, captureWidth, captureHeight);

        // Flash belief ping-pong (float32, initialized to 1.0)
        this.beliefTexA = createTexture(gl, captureWidth, captureHeight, true);
        this.beliefTexB = createTexture(gl, captureWidth, captureHeight, true);
        this.beliefFboA = createFBO(gl, this.beliefTexA);
        this.beliefFboB = createFBO(gl, this.beliefTexB);

        gl.clearColor(1.0, 1.0, 1.0, 1.0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.beliefFboA);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.beliefFboB);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Color average ping-pong (initialized to 0.0 by default)
        this.colorAvgTexA = createTexture(gl, captureWidth, captureHeight);
        this.colorAvgTexB = createTexture(gl, captureWidth, captureHeight);
        this.colorAvgFboA = createFBO(gl, this.colorAvgTexA);
        this.colorAvgFboB = createFBO(gl, this.colorAvgTexB);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Temp canvas for bitmap → texture
        this.tmpCanvas = new OffscreenCanvas(captureWidth, captureHeight);
        this.tmpCtx = this.tmpCanvas.getContext('2d', { willReadFrequently: false })! as OffscreenCanvasRenderingContext2D;
    }

    private uploadBitmapToTexture(bitmap: ImageBitmap, tex: WebGLTexture) {
        const gl = this.gl;
        this.tmpCtx.drawImage(bitmap, 0, 0, this.width, this.height);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.tmpCanvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    private drawQuad() {
        const gl = this.gl;
        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    feedFrame(frame: ImageBitmap) {
        const gl = this.gl;

        // Swap prev/current, upload new frame
        if (this.hasPrevFrame) {
            const tmp = this.prevFrameTex;
            this.prevFrameTex    = this.currentFrameTex;
            this.currentFrameTex = tmp;
        }

        this.uploadBitmapToTexture(frame, this.currentFrameTex);

        if (!this.hasPrevFrame) {
            // Initialize previous_frame = frame[0] per pseudocode
            this.uploadBitmapToTexture(frame, this.prevFrameTex);
            this.hasPrevFrame = true;
            return;
        }

        const isFirst = this.firstFrame ? 1.0 : 0.0;

        // Determine ping-pong read/write sides up front
        const readBeliefTex  = this.beliefReadA ? this.beliefTexA  : this.beliefTexB;
        const writeBeliefFbo = this.beliefReadA ? this.beliefFboB  : this.beliefFboA;
        const writeBeliefTex = this.beliefReadA ? this.beliefTexB  : this.beliefTexA;

        const readColorTex   = this.colorReadA  ? this.colorAvgTexA : this.colorAvgTexB;
        const writeColorFbo  = this.colorReadA  ? this.colorAvgFboB : this.colorAvgFboA;
        const writeColorTex  = this.colorReadA  ? this.colorAvgTexB : this.colorAvgTexA;

        // --- Pass 1: Belief Update ---
        gl.useProgram(this.beliefUpdateProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeBeliefFbo);
        gl.viewport(0, 0, this.width, this.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.prevFrameTex);
        gl.uniform1i(gl.getUniformLocation(this.beliefUpdateProgram, 'u_prevFrame'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.currentFrameTex);
        gl.uniform1i(gl.getUniformLocation(this.beliefUpdateProgram, 'u_currentFrame'), 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, readColorTex);
        gl.uniform1i(gl.getUniformLocation(this.beliefUpdateProgram, 'u_colorAvg'), 2);

        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, readBeliefTex);
        gl.uniform1i(gl.getUniformLocation(this.beliefUpdateProgram, 'u_belief'), 3);

        this.drawQuad();
        this.beliefReadA = !this.beliefReadA;

        // --- Pass 2: Color EMA ---
        gl.useProgram(this.colorEmaProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeColorFbo);
        gl.viewport(0, 0, this.width, this.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.currentFrameTex);
        gl.uniform1i(gl.getUniformLocation(this.colorEmaProgram, 'u_currentFrame'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, readColorTex);
        gl.uniform1i(gl.getUniformLocation(this.colorEmaProgram, 'u_colorAvg'), 1);

        gl.uniform1f(gl.getUniformLocation(this.colorEmaProgram, 'u_colorAlpha'), this.colorAlpha);
        gl.uniform1f(gl.getUniformLocation(this.colorEmaProgram, 'u_firstFrame'), isFirst);

        this.drawQuad();
        this.colorReadA = !this.colorReadA;

        this.firstFrame = false;

        // --- Pass 3: Output to screen ---
        gl.useProgram(this.outputProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, writeBeliefTex);
        gl.uniform1i(gl.getUniformLocation(this.outputProgram, 'u_belief'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, writeColorTex);
        gl.uniform1i(gl.getUniformLocation(this.outputProgram, 'u_colorAvg'), 1);

        gl.uniform1f(gl.getUniformLocation(this.outputProgram, 'u_threshold'), this.threshold);

        this.drawQuad();
    }

    destroy() {
        const gl = this.gl;
        gl.deleteProgram(this.beliefUpdateProgram);
        gl.deleteProgram(this.colorEmaProgram);
        gl.deleteProgram(this.outputProgram);
        gl.deleteTexture(this.prevFrameTex);
        gl.deleteTexture(this.currentFrameTex);
        gl.deleteTexture(this.beliefTexA);
        gl.deleteTexture(this.beliefTexB);
        gl.deleteTexture(this.colorAvgTexA);
        gl.deleteTexture(this.colorAvgTexB);
        gl.deleteFramebuffer(this.beliefFboA);
        gl.deleteFramebuffer(this.beliefFboB);
        gl.deleteFramebuffer(this.colorAvgFboA);
        gl.deleteFramebuffer(this.colorAvgFboB);
    }
}
