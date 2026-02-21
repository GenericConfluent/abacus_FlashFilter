import cv2
import sys
import numpy as np

# Global variable to store the previous frame
previous_frame = None

def process_frame(frame):
    """Adaptive brightness clamping scaled by optical flow motion."""
    global previous_frame

    # On first call, store the frame and return it
    if previous_frame is None:
        previous_frame = frame.copy()
        return frame

    max_delta = 30
    # Convert frames to int16 for arithmetic
    current = frame.astype(np.int16)
    previous = previous_frame.astype(np.int16)

    # Calculate clamped version with motion-scaled delta
    clamped = np.maximum(current, previous - max_delta)
    clamped = np.minimum(clamped, previous + max_delta)

    result = np.uint8(np.clip(clamped, 0, 255))

    # Store the processed frame for next iteration
    previous_frame = result.copy()

    return result

def main(video_path):
    """Open video file, process frames, and display in window."""
    # Open the video file
    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        print(f"Error: Could not open video file '{video_path}'")
        return

    # Get video properties
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_delay = int(1000 / fps) if fps > 0 else 30  # milliseconds per frame

    # Create window
    window_name = "Video Playback"
    cv2.namedWindow(window_name, cv2.WINDOW_AUTOSIZE)

    print(f"Playing video: {video_path}")
    print("Press 'q' or ESC to quit, SPACE to pause/resume")

    paused = False

    while True:
        if not paused:
            ret, frame = cap.read()

            if not ret:
                # End of video
                print("End of video reached")
                break

            # Process the frame
            processed_frame = process_frame(frame)

            # Display the processed frame
            cv2.imshow(window_name, processed_frame)

        # Handle keyboard input
        key = cv2.waitKey(frame_delay) & 0xFF

        if key == ord('q') or key == 27:  # 'q' or ESC
            break
        elif key == ord(' '):  # SPACE to pause/resume
            paused = not paused

    # Release resources
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python main.py <video_file>")
        print("Example: python main.py video.mp4")
        sys.exit(1)

    video_path = sys.argv[1]
    main(video_path)
