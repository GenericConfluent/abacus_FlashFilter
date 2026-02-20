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
  const img = document.querySelector('img');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  let lastPngCallTime = 0;
  let intervals: number[] = [];

  setInterval(() =>  {
    // @ts-ignore
    capture.grabFrame().then((bitmap)=> {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      // @ts-ignore
      ctx.drawImage(bitmap, 0, 0);
      document.getElementsByTagName("img")[0].src = canvas.toDataURL('image/png');
    })
  }, 1);

  // NOTE: This stream object is where you can
  // get the actual frame data 
}).catch(e => console.log(e))