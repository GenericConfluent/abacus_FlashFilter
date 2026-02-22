let screenRect = NSScreen.main?.frame ?? .zero

let overlayWindow = NSWindow(
    contentRect: screenRect,
    styleMask: [.borderless, .fullSizeContentView], // No title bar or borders
    backing: .buffered,
    defer: false
)

// 1. Make it transparent
overlayWindow.backgroundColor = .clear
overlayWindow.isOpaque = false
overlayWindow.hasShadow = false

// 2. Set the Level to stay above the Top Bar (Menu Bar)
// .mainMenu + 1 ensures it sits directly on top of the system menu bar
overlayWindow.level = .mainMenu + 1

// 3. Enable Mouse Pass-Through
overlayWindow.ignoresMouseEvents = true

// 4. Ensure it appears on all Spaces/Desktops
overlayWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
overlayWindow.makeKeyAndOrderFront(nil)

// 1. Prevent the user or system from dragging the window
overlayWindow.isMovable = false

// 2. Disable dragging by the background (just in case)
overlayWindow.isMovableByWindowBackground = false

// 3. Hard-lock the dimensions to the screen size
overlayWindow.minSize = screenRect.size
overlayWindow.maxSize = screenRect.size
