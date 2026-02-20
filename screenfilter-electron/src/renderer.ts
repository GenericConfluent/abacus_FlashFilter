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
      console.log(blob);
      const url = URL.createObjectURL(blob);
      const img = document.getElementsByTagName("img")[0];

      // Revoke the previous object URL to avoid memory leaks
      if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);

      img.src = url;
    });
  }, 33.3);

  // NOTE: This stream object is where you can
  // get the actual frame data 
}).catch(e => console.log(e))