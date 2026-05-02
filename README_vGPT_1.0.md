# Tarcza czasu pracy - vGPT_1.0

This clone is based on a previously developed `v:1.28` version created by another AI.

## Current app state

- Static HTML/CSS/JavaScript PWA.
- Main app file: `index.html`.
- PWA metadata: `manifest.json`.
- Offline/update cache: `sw.js`.
- Image assets: `Photos/`.

## vGPT_1.0 changes

- Visible version label changed from `v:1.28` to `vGPT_1.0`.
- Version label color was made slightly brighter.
- Manifest display mode was adjusted for fullscreen PWA launch, with standalone fallback.
- Service worker cache name was changed so browsers can fetch the new version.

## PWA install notes

Use the GitHub Pages HTTPS URL, not a raw GitHub file URL.

If the browser address bar is visible, the app is most likely opened as a normal browser tab, not from the installed home-screen PWA icon.

On Android Chrome:

1. Open the GitHub Pages URL.
2. Open Chrome menu.
3. Choose `Install app` or `Add to Home screen`.
4. Launch the app from the installed icon, not from the browser tab.

On iPhone Safari:

1. Open the GitHub Pages URL in Safari.
2. Tap Share.
3. Choose `Add to Home Screen`.
4. Launch the app from the home-screen icon.

The in-app install button only appears when the browser fires the `beforeinstallprompt` event. Some browsers, especially iOS Safari, do not show that event, so manual installation from the browser menu is expected.
