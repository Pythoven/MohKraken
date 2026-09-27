const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const STORE_FILE = () => path.join(app.getPath('userData'), 'mohkraken.json');
const watchers = new Map();
let win;

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8')); } catch { return {}; }
}
function writeStore(data) {
  fs.mkdirSync(path.dirname(STORE_FILE()), { recursive: true });
  fs.writeFileSync(STORE_FILE(), JSON.stringify(data, null, 2));
}

// Runs git without a shell. Resolves with { code, stdout, stderr } – never rejects on non-zero exit.
function runGit(cwd, args, input) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input != null) child.stdin.end(input);
  });
}

function createWindow() {
  const state = readStore().window || { width: 1440, height: 900 };
  win = new BrowserWindow({
    ...state,
    minWidth: 1000,
    minHeight: 600,
    title: 'MohKraken',
    backgroundColor: '#1b1e27',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('close', () => {
    const store = readStore();
    store.window = win.getBounds();
    writeStore(store);
  });
  win.on('focus', () => win.webContents.send('window-focus'));
}

ipcMain.handle('git', (_e, cwd, args, input) => runGit(cwd, args, input));

ipcMain.handle('store:get', () => readStore());
ipcMain.handle('store:set', (_e, key, value) => {
  const store = readStore();
  store[key] = value;
  writeStore(store);
});

ipcMain.handle('dialog:openDir', async (_e, title) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Open repository',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:openTerminal', (_e, p) => {
  spawn('open', ['-a', 'Terminal', p], { detached: true });
});
ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));
ipcMain.handle('fs:appendIgnore', (_e, repo, pattern) => {
  const file = path.join(repo, '.gitignore');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${pattern}\n`);
});

// Watch a repo for changes so the UI can refresh itself.
ipcMain.handle('watch:start', (_e, repo) => {
  if (watchers.has(repo)) return;
  let timer = null;
  try {
    const w = fs.watch(repo, { recursive: true }, (_type, file) => {
      if (!file) return;
      const f = file.split(path.sep);
      if (f.includes('node_modules') || (f[0] === '.git' && f[1] === 'objects')) return;
      if (f[0] === '.git' && file.endsWith('.lock')) return;
      clearTimeout(timer);
      timer = setTimeout(() => win && win.webContents.send('repo-changed', repo), 700);
    });
    watchers.set(repo, w);
  } catch { /* watching is best-effort */ }
});
ipcMain.handle('watch:stop', (_e, repo) => {
  const w = watchers.get(repo);
  if (w) { w.close(); watchers.delete(repo); }
});

app.setName('MohKraken');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
