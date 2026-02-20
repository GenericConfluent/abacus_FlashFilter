import { BrowserWindow } from 'electron';

// WARN: The focusable flag that allows input passthrough only works on windows
// and MacOS.
let browserWindow = new BrowserWindow({
    frame: false,
    focusable: false, // Windows, MacOS
    fullscreen: true,
    transparent: true,
    // This apparently exists but my LSP complains
    // visibleOnAllWorkspaces: true, // MacOS, Linux
    alwaysOnTop: true,
});

browserWindow.setIgnoreMouseEvents(true);