import { app, ipcMain, desktopCapturer, session,  BrowserWindow } from 'electron';

// WARN: The focusable flag that allows input passthrough only works on windows
// and MacOS.
app.on("ready", () => {
    // zwlr_layer_surface_v1::set_keyboard_interactivity is needed to
    // support input passthrough on Linux (Wayland). But even that only
    // works for WRL based Wayland compositors.
    let browserWindow = new BrowserWindow({
        frame: false,
        focusable: false, // Windows, MacOS
        transparent: true,
        // This apparently exists but my LSP complains
        // visibleOnAllWorkspaces: true, // MacOS, Linux
        alwaysOnTop: true,
    });
    browserWindow.setIgnoreMouseEvents(true);

    // we need to make the window take up the entire desktop space
    browserWindow.maximize();

    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        // Grant access to the first screen found.
        callback({ video: sources[0], audio: 'loopback' })
        })
        // If true, use the system picker if available.
        // Note: this is currently experimental. If the system picker
        // is available, it will be used and the media request handler
        // will not be invoked.
    }, { useSystemPicker: true })

    browserWindow.loadFile('index.html');
});