import cv2
import sys
from dataclasses import dataclass
import numpy as np

# Quick reminder: HSL != HSV

@dataclass
class PixelGroup: 
    center: np.ndarray # Average position of our pixels (2 channel YX)
    color: np.ndarray # Average color of our pixels (3 channel HSL)
    count: int # Number of pixels in group (used for averaging)
    

# Global variable to store the previous frame
previous_frame = None

def update_average(current: np.ndarray, sample: np.ndarray, count: int) -> np.ndarray:
    """Update the average color of a group with a new pixel."""
    return current + (sample - current) / count

def segment_frame(frame_hsl: np.ndarray, distance: int) -> list:
    """
    Imagine fuzzy selecting every distinct block of color in a frame.
    This function will return a list of groups of pixels each group has the following info:
    """
    groups = []
    for y in range(frame_hsl.shape[0]):
        for x in range(frame_hsl.shape[1]):
            pos = np.array([y, x])
            pixel = frame_hsl[y, x]
            assigned = False
            for group in groups:
                if np.linalg.norm(pixel - group.color) < distance:
                    group.center = update_average(group.center, pos, group.count)
                    group.color = update_average(group.color, pixel, group.count)
                    group.count += 1
                    assigned = True
                    break
            if not assigned:
                groups.append(PixelGroup(center=pos, color=pixel, count=1))
    return groups


# We expect frame format to be BGR
def process_frame(frame):
    """Pixel delta clamping based on where in the color space we move from/to."""
    global previous_frame

    # First we want to move to a color space where we can more nicely understand
    # the relationships of channel changes
    frame = cv2.cvtColor(frame, cv2.COLOR_BGR2HLS)

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

    frame_uint8 = np.uint8(np.clip(clamped, 0, 255))

    # Segment the frame and create visualization with distinct colors
    groups = segment_frame(frame_uint8, distance=30)
    result = np.zeros_like(frame_uint8)

    for group_idx, group in enumerate(groups):
        # Assign distinct colors by cycling through hue values
        distinct_color = np.array([
            (group_idx * 30) % 180,  # Hue cycling through color wheel
            200,                       # High saturation
            128                        # Medium lightness
        ], dtype=np.uint8)

        # Find all pixels belonging to this group and color them
        for y in range(frame_uint8.shape[0]):
            for x in range(frame_uint8.shape[1]):
                pixel = frame_uint8[y, x]
                if np.linalg.norm(pixel - group.color) < 30:
                    result[y, x] = distinct_color

    # Store the processed frame for next iteration
    previous_frame = frame_uint8.copy()

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
