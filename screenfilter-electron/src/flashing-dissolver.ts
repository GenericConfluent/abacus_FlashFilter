// Full-screen quad vertex shader (shared by all passes)
const VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

// Pass 1: Delta EMA
// Computes euclidean distance between prev and current frame,
// then blends into the historical delta buffer.
const DELTA_EMA_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_prevFrame;
uniform sampler2D u_currentFrame;
uniform sampler2D u_history;
uniform float u_alpha;
uniform float u_firstFrame;

void main() {
    vec3 prev = texture(u_prevFrame, v_uv).rgb;
    vec3 curr = texture(u_currentFrame, v_uv).rgb;
    float hist = texture(u_history, v_uv).r;

    float delta = distance(prev, curr);

    // EMA: hist = hist + alpha * (delta - hist)
    float newHist = mix(hist + u_alpha * (delta - hist), delta, u_firstFrame);

    fragColor = vec4(newHist, newHist, newHist, 1.0);
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
    vec3 avg = texture(u_colorAvg, v_uv).rgb;

    // EMA: avg = avg + alpha * (curr - avg)
    vec3 newAvg = mix(avg + u_colorAlpha * (curr - avg), curr, u_firstFrame);

    fragColor = vec4(newAvg, 1.0);
}`;

// Pass 3: Output
// If flash detected, draw the averaged color; otherwise transparent.
const OUTPUT_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_deltaHistory;
uniform sampler2D u_colorAvg;
uniform float u_threshold;

void main() {
    float flashValue = texture(u_deltaHistory, v_uv).r;

    if (flashValue > u_threshold) {
        // Replace flashing pixel with the averaged color
        vec3 avg = texture(u_colorAvg, v_uv).rgb;
        fragColor = vec4(avg, 1.0);
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
    private deltaEmaProgram: WebGLProgram;
    private colorEmaProgram: WebGLProgram;
    private outputProgram: WebGLProgram;

    // Full-screen quad VAO
    private quadVAO: WebGLVertexArrayObject;

    // Frame textures (uploaded each frame)
    private prevFrameTex: WebGLTexture;
    private currentFrameTex: WebGLTexture;

    // Delta history ping-pong
    private deltaTexA: WebGLTexture;
    private deltaTexB: WebGLTexture;
    private deltaFboA: WebGLFramebuffer;
    private deltaFboB: WebGLFramebuffer;
    private deltaReadA: boolean = true;

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
    private deltaAlpha: number = 0.7;   // EMA rate for flash detection
    private colorAlpha: number = 0.05;  // EMA rate for color averaging (slower = smoother)
    private threshold: number = 0.05;   // flash detection threshold [0,1]

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

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Compile programs
        this.deltaEmaProgram = createProgram(gl, VERT_SRC, DELTA_EMA_FRAG);
        this.colorEmaProgram = createProgram(gl, VERT_SRC, COLOR_EMA_FRAG);
        this.outputProgram = createProgram(gl, VERT_SRC, OUTPUT_FRAG);

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
        this.prevFrameTex = createTexture(gl, captureWidth, captureHeight);
        this.currentFrameTex = createTexture(gl, captureWidth, captureHeight);

        // Delta history ping-pong
        this.deltaTexA = createTexture(gl, captureWidth, captureHeight);
        this.deltaTexB = createTexture(gl, captureWidth, captureHeight);
        this.deltaFboA = createFBO(gl, this.deltaTexA);
        this.deltaFboB = createFBO(gl, this.deltaTexB);

        // Color average ping-pong
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
            this.prevFrameTex = this.currentFrameTex;
            this.currentFrameTex = tmp;
        }

        this.uploadBitmapToTexture(frame, this.currentFrameTex);

        if (!this.hasPrevFrame) {
            this.uploadBitmapToTexture(frame, this.prevFrameTex);
            this.hasPrevFrame = true;
            return;
        }

        const isFirst = this.firstFrame ? 1.0 : 0.0;

        // --- Pass 1: Delta EMA ---
        const readDeltaTex = this.deltaReadA ? this.deltaTexA : this.deltaTexB;
        const writeDeltaFbo = this.deltaReadA ? this.deltaFboB : this.deltaFboA;
        const writeDeltaTex = this.deltaReadA ? this.deltaTexB : this.deltaTexA;

        gl.useProgram(this.deltaEmaProgram);
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeDeltaFbo);
        gl.viewport(0, 0, this.width, this.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.prevFrameTex);
        gl.uniform1i(gl.getUniformLocation(this.deltaEmaProgram, 'u_prevFrame'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.currentFrameTex);
        gl.uniform1i(gl.getUniformLocation(this.deltaEmaProgram, 'u_currentFrame'), 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, readDeltaTex);
        gl.uniform1i(gl.getUniformLocation(this.deltaEmaProgram, 'u_history'), 2);

        gl.uniform1f(gl.getUniformLocation(this.deltaEmaProgram, 'u_alpha'), this.deltaAlpha);
        gl.uniform1f(gl.getUniformLocation(this.deltaEmaProgram, 'u_firstFrame'), isFirst);

        this.drawQuad();
        this.deltaReadA = !this.deltaReadA;

        // --- Pass 2: Color EMA ---
        const readColorTex = this.colorReadA ? this.colorAvgTexA : this.colorAvgTexB;
        const writeColorFbo = this.colorReadA ? this.colorAvgFboB : this.colorAvgFboA;
        const writeColorTex = this.colorReadA ? this.colorAvgTexB : this.colorAvgTexA;

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
        gl.bindTexture(gl.TEXTURE_2D, writeDeltaTex);
        gl.uniform1i(gl.getUniformLocation(this.outputProgram, 'u_deltaHistory'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, writeColorTex);
        gl.uniform1i(gl.getUniformLocation(this.outputProgram, 'u_colorAvg'), 1);

        gl.uniform1f(gl.getUniformLocation(this.outputProgram, 'u_threshold'), this.threshold);

        this.drawQuad();
    }

    destroy() {
        const gl = this.gl;
        gl.deleteProgram(this.deltaEmaProgram);
        gl.deleteProgram(this.colorEmaProgram);
        gl.deleteProgram(this.outputProgram);
        gl.deleteTexture(this.prevFrameTex);
        gl.deleteTexture(this.currentFrameTex);
        gl.deleteTexture(this.deltaTexA);
        gl.deleteTexture(this.deltaTexB);
        gl.deleteTexture(this.colorAvgTexA);
        gl.deleteTexture(this.colorAvgTexB);
        gl.deleteFramebuffer(this.deltaFboA);
        gl.deleteFramebuffer(this.deltaFboB);
        gl.deleteFramebuffer(this.colorAvgFboA);
        gl.deleteFramebuffer(this.colorAvgFboB);
    }
}
