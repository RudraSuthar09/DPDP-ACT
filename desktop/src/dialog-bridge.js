// Native save-dialog bridge (MAIN PROCESS). The Electron-native replacement
// for the browser's <a download> mechanism: the renderer hands over the bytes
// (base64) plus a suggested filename, the user picks a real location via the
// OS save dialog, and the main process writes the file there. Narrow by
// construction — one operation, no arbitrary path exposed to the renderer.
'use strict';

const { ipcMain, dialog, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');

function registerDialogIpc() {
  ipcMain.handle('dialog:save-file', async (_event, { defaultName, base64 }) => {
    try {
      if (typeof base64 !== 'string') return { ok: false, error: 'BAD_REQUEST' };
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const opts = { defaultPath: typeof defaultName === 'string' ? defaultName : undefined };
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      await fsp.writeFile(res.filePath, Buffer.from(base64, 'base64'));
      return { ok: true, canceled: false, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err && typeof err.message === 'string' ? err.message : 'ERROR' };
    }
  });
}

module.exports = { registerDialogIpc };
