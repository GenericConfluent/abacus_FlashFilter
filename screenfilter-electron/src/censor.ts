type Image = Blob;

export interface CensorContext {
    // This is the ring buffer of images.
    history: Image[];
    // This is the index of most recent image in the ring buffer.
    ring_start: number;
    // This is the max size of the ring buffer.
    ring_size: number;
}

export function censor(ctx: CensorContext, image: Image, canvas: HTMLCanvasElement) {
    // Update the ring buffer with the new image.
    if (ctx.history.length >= ctx.ring_size) {
        ctx.history[ctx.ring_start] = image;
        ctx.ring_start = (ctx.ring_start + 1) % ctx.ring_size;
    } else {
        ctx.history.push(image);
        ++ctx.ring_start;
    }

    // Find flashing regions. (TODO)

    // Draw onto canvas the regions we wish to censor. (TODO)
}