// renderer.js
console.log("Renderer Started");

const startButton = document.getElementById('startButton')
const stopButton = document.getElementById('stopButton')
const video = document.querySelector('video')

if (video === null ) {
    throw new Error('Video element not found')
} 

if (startButton === null) {
    throw new Error('Start button not found')
}

startButton?.addEventListener('click', () => {
  navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: {
      width: 320,
      height: 240,
      frameRate: 30
    }
  }).then(stream => {
    video.srcObject = stream
    video.onloadedmetadata = (e) => video.play()
  }).catch(e => console.log(e))
})

// stopButton.addEventListener('click', () => {
//   video.pause()
// })