import { app, ipcMain, desktopCapturer, session,  BrowserWindow, screen } from 'electron';

const DEBUG = false;

// WARN: The focusable flag that allows input passthrough only works on windows
// and MacOS.
app.on("ready", () => {
    // Set up the media handler BEFORE creating the window
    const { width, height } = screen.getPrimaryDisplay().size;
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        // Grant access to the first screen found.
        callback({ video: sources[0], audio: 'loopback' })
        })
        // If true, use the system picker if available.
        // Note: this is currently experimental. If the system picker
        // is available, it will be used and the media request handler
        // will not be invoked.
    }, { useSystemPicker: false })

    // zwlr_layer_surface_v1::set_keyboard_interactivity is needed to
    // support input passthrough on Linux (Wayland). But even that only
    // works for WRL based Wayland compositors.
    let browserWindow = new BrowserWindow({
        frame: false,
        focusable: false, // Windows, MacOS
        transparent: true,
        movable: false,
        resizable: false,
        alwaysOnTop: true,
        enableLargerThanScreen: true,
        hasShadow: false,

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false // temporarily disable to confirm CSP is the blocker
        }
    });
    browserWindow.setIgnoreMouseEvents(true);
    browserWindow.setAlwaysOnTop(true, 'screen-saver');
    browserWindow.setContentProtection(true)
    browserWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    browserWindow.loadFile('index.html');
    if (DEBUG) {
        browserWindow.webContents.openDevTools({ mode: 'detach' });
    }
    browserWindow.once('ready-to-show', () => {
        setInterval(() => {
            browserWindow.setBounds({ x: 0, y: 0, width: width, height: height });
        }, 1000);
    });
    // Pass screen dimensions to renderer so it doesn't need to import 'screen'
    browserWindow.webContents.once('dom-ready', () => {
        browserWindow.webContents.send('screen-bounds', { width, height });
    });
});