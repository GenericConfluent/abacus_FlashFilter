/* Naive dissolver good at handling flash impulses
 */
export class FlashingDissolverNaive {
    screenWidth: number;
    screenHeight: number;
    ctx: CanvasRenderingContext2D;
    historical_delta_buffer: Float64Array;
    prev_frame: ImageData;
    flashTimestamps: [[number, number]?];
    pixelFlashHistory: Array<number[]>;
    pixelBlackUntil: Float64Array; // Track when each pixel should remain blocked
    pixelColorAverage: Array<{r: number, g: number, b: number}>; // Track average color

    constructor(canvas: HTMLCanvasElement, screenWidth: number, screenHeight: number) {
        this.screenWidth = screenWidth;
        this.screenHeight = screenHeight;
        this.ctx = canvas.getContext('2d', {
            willReadFrequently: true
        })!;
        this.historical_delta_buffer = new Float64Array(this.screenWidth * this.screenHeight);
        this.prev_frame = this.ctx.getImageData(0, 0, this.screenWidth, this.screenHeight);
        this.flashTimestamps = [];
        this.pixelFlashHistory = Array.from({ length: this.screenWidth * this.screenHeight }, () => []);
        this.pixelBlackUntil = new Float64Array(this.screenWidth * this.screenHeight);
        this.pixelColorAverage = Array.from({ length: this.screenWidth * this.screenHeight }, () => ({r: 0, g: 0, b: 0}));
    }

    analyzeFrame(frame: ImageBitmap) {
        const now = performance.now();
        this.ctx.drawImage(frame, 0, 0, this.screenWidth, this.screenHeight);
        let image = this.ctx.getImageData(0, 0, this.screenWidth, this.screenHeight);

        // Save the current frame for next comparison BEFORE modifying it
        const currentFrame = this.ctx.getImageData(0, 0, this.screenWidth, this.screenHeight);

        this.ctx.clearRect(0, 0, this.screenWidth, this.screenHeight);

        for (let i = 0; i < this.screenWidth * this.screenHeight; i++) {
            let r_offset = i * 4;
            let g_offset = i * 4 + 1;
            let b_offset = i * 4 + 2;
            let a_offset = i * 4 + 3;

            const r1 = image.data[r_offset]
            const g1 = image.data[g_offset]
            const b1 = image.data[b_offset]

            const r2 = this.prev_frame.data[r_offset]
            const g2 = this.prev_frame.data[g_offset]
            const b2 = this.prev_frame.data[b_offset]

            const lum1 = 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
            const lum2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
            const delta = Math.abs(lum1 - lum2);

            this.historical_delta_buffer[i] += 0.2 * (delta - this.historical_delta_buffer[i]);

            // Only update average when pixel is NOT flashing
            if (this.historical_delta_buffer[i] <= 35) {
                const avg = this.pixelColorAverage[i];
                avg.r += (r1 - avg.r) * 0.05;
                avg.g += (g1 - avg.g) * 0.05;
                avg.b += (b1 - avg.b) * 0.05;
            }

            if (this.historical_delta_buffer[i] > 15) {
                const history = this.pixelFlashHistory[i];
                history.push(now);
                // Prune entries older than 1 second
                while (history.length > 0 && history[0] < now - 5000) history.shift();
                if (history.length > 3) {
                    this.pixelBlackUntil[i] = now;
                }
            }

            // Check if pixel should be blocked with average color
            if (this.pixelBlackUntil[i] > now) {
                const avg = this.pixelColorAverage[i];
                image.data[r_offset] = Math.round(avg.r);
                image.data[g_offset] = Math.round(avg.g);
                image.data[b_offset] = Math.round(avg.b);
                image.data[a_offset] = 255;
            } else {
                image.data[a_offset] = 0;
            }
        }
        this.ctx.putImageData(image, 0, 0);
        this.prev_frame = currentFrame;
    }
}

