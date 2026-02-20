import sharp from 'sharp';

// renderer.js
navigator.mediaDevices.getDisplayMedia({
  audio: true,
  video: {
    width: 320,
    height: 240,
    frameRate: 30
  }
}).then(stream => {
  console.log(stream);
  const videoTrack = stream.getVideoTracks()[0];
  const capture = new ImageCapture(videoTrack);

  let lastPngCallTime = 0;
  let intervals: number[] = [];

  setInterval(() =>  {
    capture.takePhoto().then(blob => {

      // @ts-ignore
      sharp(blob).then((sharpObj) => {
          const now = performance.now();
          if (lastPngCallTime > 0) {
            const delta = now - lastPngCallTime;
            intervals.push(delta);
            if (intervals.length % 100 === 0) {
              const average = intervals.reduce((a, b) => a + b, 0) / intervals.length;
              // @ts-ignore
              console.log(`Average time between png() calls: ${average.toFixed(2)}ms (${intervals.length} samples)`);
            }
          }
          lastPngCallTime = now;
          sharpObj.png()
      })
    })
  }, 33.3);

  // NOTE: This stream object is where you can
  // get the actual frame data 
}).catch(e => console.log(e))