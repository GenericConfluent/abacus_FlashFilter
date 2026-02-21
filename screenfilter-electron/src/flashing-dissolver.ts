export class FlashingDissolver {
    readonly ctx: OffscreenCanvasRenderingContext2D;
    history: ImageData[];
    captureWidth: number;
    captureHeight: number;
    pixelCount: number;
    timeout: NodeJS.Timeout;

    constructor(captureWidth: number, captureHeight: number) {
        const canvas = new OffscreenCanvas(captureWidth, captureHeight)
        const ctx = canvas.getContext("2d", {
            willReadFrequently: true
        })
        if (!ctx) throw new Error("Failed to create OffscreenCanvasRenderingContext2D");
        this.ctx = ctx;
        this.history = [];
        this.captureWidth = captureWidth;
        this.captureHeight = captureHeight;
        this.pixelCount = captureWidth * captureHeight;
        this.timeout = setInterval(() => this._analyze(), 333)
    }

    _isRedSaturated(r: number, g: number, b: number): boolean {
        const denom = r + g + b;
        if (denom == 0) return false;
        return r / denom >= 0.8
    }

    _getRedFlashValue(r: number, g: number, b: number): number {
        return Math.ceil((r - g - b) * 320);
    }

    _isRedFlashTransition(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): boolean {
        if (!(this._isRedSaturated(r1, g1, b1) || this._isRedSaturated(r2, g2, b2))) return false;
        const delta = Math.abs(this._getRedFlashValue(r1, g1, b1) - this._getRedFlashValue(r2, g2, b2));
        return delta > 20
    }



    _analyze() {
        if (this.history.length < 2) return;

        for (const frame of this.history) {
            let frameData: Uint8ClampedArray = frame.data;

            let rgb = Uint8ClampedArray.of(3)
            let pixelIdx = 0;
            for (let i = 0; i < frameData.length; ++i) {
                rgb[i % 3] = frameData[i];
                if (i % 3 == 0) {
                    let r = rgb[0];
                    let g = rgb[1];
                    let b = rgb[2];
                    pixelIdx++;
                }
            }
            for (const value of frameData) {
                this.pixelStates
            }

            console.log(frameData);
        }
    }

    feedFrame(frame: ImageBitmap) {
        if (this.history.length > 10) this.history.shift();
        this.ctx.drawImage(frame, 0, 0, this.captureWidth, this.captureHeight);
        this.history.push(this.ctx.getImageData(0, 0, this.captureWidth, this.captureHeight));
    }

    destroy() {
        clearInterval(this.timeout);
    }
}