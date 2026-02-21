// Full-screen quad vertex shader (shared by both passes)
const VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

// Pass 1: EMA update
// Computes euclidean distance between prev and current frame,
// then blends into the historical delta buffer.
const EMA_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_prevFrame;
uniform sampler2D u_currentFrame;
uniform sampler2D u_history;
uniform float u_alpha;       // EMA blending factor (0.8)
uniform float u_firstFrame;  // 1.0 on first frame (seeds history with delta)

void main() {
    vec3 prev = texture(u_prevFrame, v_uv).rgb;
    vec3 curr = texture(u_currentFrame, v_uv).rgb;
    float hist = texture(u_history, v_uv).r;

    float delta = distance(prev, curr);

    // EMA: hist = hist + alpha * (delta - hist)
    // On first frame, just use delta directly (no history yet).
    float newHist = mix(hist + u_alpha * (delta - hist), delta, u_firstFrame);

    fragColor = vec4(newHist, newHist, newHist, 1.0);
}`;

// Pass 2: Threshold + output
// Reads the historical delta buffer and outputs either a dimmed
// overlay or a fully transparent pixel.
const THRESHOLD_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_history;
uniform float u_threshold;
uniform float u_dimAmount;   // how dark the overlay is (0..1), e.g. 0.6

void main() {
    float flashValue = texture(u_history, v_uv).r;

    if (flashValue > u_threshold) {
        // Draw a dark semi-transparent overlay to dim this pixel
        fragColor = vec4(0.0, 0.0, 0.0, u_dimAmount);
    } else {
        // Fully transparent — real screen shows through
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

function createTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    private emaProgram: WebGLProgram;
    private thresholdProgram: WebGLProgram;

    // Full-screen quad VAO
    private quadVAO: WebGLVertexArrayObject;

    // Frame textures (uploaded each frame)
    private prevFrameTex: WebGLTexture;
    private currentFrameTex: WebGLTexture;

    // History ping-pong textures + FBOs
    private historyTexA: WebGLTexture;
    private historyTexB: WebGLTexture;
    private historyFboA: WebGLFramebuffer;
    private historyFboB: WebGLFramebuffer;
    private readFromA: boolean = true; // which history tex to read from

    // Temp canvas for extracting ImageBitmap → texImage2D
    private tmpCanvas: OffscreenCanvas;
    private tmpCtx: OffscreenCanvasRenderingContext2D;

    private firstFrame: boolean = true;
    private hasPrevFrame: boolean = false;

    // Tuning parameters
    private alpha: number = 0.8;
    private threshold: number = 0.08; // in [0,1] range (colors are normalized)
    private dimAmount: number = 0.6;

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

        // Enable blending for transparent output
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Compile programs
        this.emaProgram = createProgram(gl, VERT_SRC, EMA_FRAG_SRC);
        this.thresholdProgram = createProgram(gl, VERT_SRC, THRESHOLD_FRAG_SRC);

        // Create full-screen quad (-1..1)
        this.quadVAO = gl.createVertexArray()!;
        gl.bindVertexArray(this.quadVAO);
        const quadBuf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,  1, -1,  -1, 1,
            -1,  1,  1, -1,   1, 1,
        ]), gl.STATIC_DRAW);
        // Bind a_position for both programs
        const emaPos = gl.getAttribLocation(this.emaProgram, 'a_position');
        const thrPos = gl.getAttribLocation(this.thresholdProgram, 'a_position');
        gl.enableVertexAttribArray(emaPos);
        gl.vertexAttribPointer(emaPos, 2, gl.FLOAT, false, 0, 0);
        if (thrPos !== emaPos) {
            gl.enableVertexAttribArray(thrPos);
            gl.vertexAttribPointer(thrPos, 2, gl.FLOAT, false, 0, 0);
        }
        gl.bindVertexArray(null);

        // Create textures
        this.prevFrameTex = createTexture(gl, captureWidth, captureHeight);
        this.currentFrameTex = createTexture(gl, captureWidth, captureHeight);
        this.historyTexA = createTexture(gl, captureWidth, captureHeight);
        this.historyTexB = createTexture(gl, captureWidth, captureHeight);

        // Create FBOs for history ping-pong
        this.historyFboA = createFBO(gl, this.historyTexA);
        this.historyFboB = createFBO(gl, this.historyTexB);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Temp canvas for bitmap → texture conversion
        this.tmpCanvas = new OffscreenCanvas(captureWidth, captureHeight);
        this.tmpCtx = this.tmpCanvas.getContext('2d', { willReadFrequently: false })! as OffscreenCanvasRenderingContext2D;
    }

    private uploadBitmapToTexture(bitmap: ImageBitmap, tex: WebGLTexture) {
        const gl = this.gl;
        // Draw bitmap to temp canvas, then upload
        this.tmpCtx.drawImage(bitmap, 0, 0, this.width, this.height);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // Flip Y so top-left canvas origin maps to WebGL's bottom-left origin
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.tmpCanvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    feedFrame(frame: ImageBitmap) {
        const gl = this.gl;

        // Swap: current becomes prev, upload new frame as current
        if (this.hasPrevFrame) {
            // Swap texture references so prev = old current
            const tmp = this.prevFrameTex;
            this.prevFrameTex = this.currentFrameTex;
            this.currentFrameTex = tmp;
        }

        this.uploadBitmapToTexture(frame, this.currentFrameTex);

        if (!this.hasPrevFrame) {
            // First frame: also copy to prev so delta starts at 0
            this.uploadBitmapToTexture(frame, this.prevFrameTex);
            this.hasPrevFrame = true;
            return; // Skip rendering on very first frame
        }

        // --- Pass 1: EMA update ---
        // Read from history A (or B), write to the other
        const readHistTex = this.readFromA ? this.historyTexA : this.historyTexB;
        const writeFbo = this.readFromA ? this.historyFboB : this.historyFboA;
        const writeHistTex = this.readFromA ? this.historyTexB : this.historyTexA;

        gl.useProgram(this.emaProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo);
        gl.viewport(0, 0, this.width, this.height);

        // Bind textures to units
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.prevFrameTex);
        gl.uniform1i(gl.getUniformLocation(this.emaProgram, 'u_prevFrame'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.currentFrameTex);
        gl.uniform1i(gl.getUniformLocation(this.emaProgram, 'u_currentFrame'), 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, readHistTex);
        gl.uniform1i(gl.getUniformLocation(this.emaProgram, 'u_history'), 2);

        gl.uniform1f(gl.getUniformLocation(this.emaProgram, 'u_alpha'), this.alpha);
        gl.uniform1f(gl.getUniformLocation(this.emaProgram, 'u_firstFrame'), this.firstFrame ? 1.0 : 0.0);

        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        this.readFromA = !this.readFromA;
        this.firstFrame = false;

        // --- Pass 2: Threshold + output to screen ---
        gl.useProgram(this.thresholdProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); // draw to canvas
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, writeHistTex); // the one we just wrote to
        gl.uniform1i(gl.getUniformLocation(this.thresholdProgram, 'u_history'), 0);

        gl.uniform1f(gl.getUniformLocation(this.thresholdProgram, 'u_threshold'), this.threshold);
        gl.uniform1f(gl.getUniformLocation(this.thresholdProgram, 'u_dimAmount'), this.dimAmount);

        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    destroy() {
        const gl = this.gl;
        gl.deleteProgram(this.emaProgram);
        gl.deleteProgram(this.thresholdProgram);
        gl.deleteTexture(this.prevFrameTex);
        gl.deleteTexture(this.currentFrameTex);
        gl.deleteTexture(this.historyTexA);
        gl.deleteTexture(this.historyTexB);
        gl.deleteFramebuffer(this.historyFboA);
        gl.deleteFramebuffer(this.historyFboB);
    }
}
