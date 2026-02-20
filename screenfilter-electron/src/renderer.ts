const sharp = require('sharp');

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
  setInterval(() =>  {
    capture.takePhoto().then(blob => {
      // @ts-ignore
      sharp(blob).then((sharpObj) => {
          sharpObj.png()
      })
    })
  }, 33.3);

  // NOTE: This stream object is where you can
  // get the actual frame data 
}).catch(e => console.log(e))