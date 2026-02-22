import { FlashingDissolver } from './flashing-dissolver';
import { FlashingDissolverNaive } from "./flashing-dissolver-naive"

// renderer.js
const { ipcRenderer } = require('electron');

let screenWidth = window.innerWidth;
let screenHeight = window.innerHeight;
let flashingDissolver: FlashingDissolver;
let flashingDissolverNaive: FlashingDissolverNaive;

// Get accurate dimensions from main process (handles Retina/HiDPI correctly)
// @ts-ignore
ipcRenderer.once('screen-bounds', (_event, bounds) => {
  screenWidth = bounds.width;
  screenHeight = bounds.height;

  const canvas = document.querySelector('#dissolver1')! as HTMLCanvasElement;
  flashingDissolver = new FlashingDissolver(canvas, screenWidth, screenHeight);
  const canvasNaive = document.querySelector('#dissolver2')! as HTMLCanvasElement;
  canvasNaive.width = screenWidth;
  canvasNaive.height = screenHeight;
  flashingDissolverNaive = new FlashingDissolverNaive(canvasNaive, screenWidth, screenHeight);
  startCapture();
});

// @ts-ignore
function startCapture() {
  navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: {
      width: screenWidth,
      height: screenHeight,
      frameRate: 30
    }
  }).then(stream => {
    const videoTrack = stream.getVideoTracks()[0];
    const capture = new ImageCapture(videoTrack);

    setInterval(() => {
      // @ts-ignore
      capture.grabFrame().then((bitmap: ImageBitmap) => {
        flashingDissolver.feedFrame(bitmap);
        flashingDissolverNaive.analyzeFrame(bitmap);
        bitmap.close();
      }).catch((e: Error) => {
        // Frame grab can fail transiently, ignore
      });
    }, 8.3);
  }).catch(e => console.log(e));
}
