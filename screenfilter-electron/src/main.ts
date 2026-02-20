import { app, ipcMain, desktopCapturer, session,  BrowserWindow, screen } from 'electron';

// WARN: The focusable flag that allows input passthrough only works on windows
// and MacOS.
app.on("ready", () => {
    // Set up the media handler BEFORE creating the window
    const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        // Grant access to the first screen found.
        callback({ video: sources[0], audio: 'loopback' })
        })
        // If true, use the system picker if available.
        // Note: this is currently experimental. If the system picker
        // is available, it will be used and the media request handler
        // will not be invoked.
    }, { useSystemPicker: true })

    // zwlr_layer_surface_v1::set_keyboard_interactivity is needed to
    // support input passthrough on Linux (Wayland). But even that only
    // works for WRL based Wayland compositors.
    let browserWindow = new BrowserWindow({
        frame: false,
        focusable: false, // Windows, MacOS
        transparent: true,
        movable: false,
        resizable: false,
        // This apparently exists but my LSP complains
        // visibleOnAllWorkspaces: true, // MacOS, Linux
        alwaysOnTop: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false // temporarily disable to confirm CSP is the blocker
        }
    });
    //REGION: set cer
    browserWindow.setIgnoreMouseEvents(true);
    browserWindow.setBounds({ x: x, y: y, width, height });
    browserWindow.setAlwaysOnTop(true, 'screen-saver');
    browserWindow.setContentProtection(true)
    //browserWindow.setSimpleFullScreen(true);
    browserWindow.loadFile('index.html');
    browserWindow.webContents.openDevTools({ mode: 'detach' });
});