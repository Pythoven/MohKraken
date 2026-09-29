const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const STORE_FILE = () => path.join(app.getPath('userData'), 'mohkraken.json');
const watchers = new Map();
let win;

// Apps launched from Finder get a minimal PATH; make sure Homebrew/MacPorts git is found.
if (process.platform !== 'win32') {
  process.env.PATH = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin',
    ...(process.env.PATH || '').split(path.delimiter), '/usr/bin', '/bin'])].filter(Boolean).join(path.delimiter);
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8')); } catch { return {}; }
}
function writeStore(data) {
  fs.mkdirSync(path.dirname(STORE_FILE()), { recursive: true });
  fs.writeFileSync(STORE_FILE(), JSON.stringify(data, null, 2));
}

// Runs git without a shell. Resolves with { code, stdout, stderr } – never rejects on non-zero exit.
// `extraEnv` adds/overrides environment variables for this call only.
async function runGit(cwd, args, input, extraEnv = {}) {
  const { MK_SSH_BATCH, ...env } = extraEnv;
  if (MK_SSH_BATCH) Object.assign(env, await batchSshEnv(cwd));
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      // Never block on a prompt or an editor: there is no terminal to answer it.
      // On Windows, Git Credential Manager shows its own sign-in window, so leave prompting on there.
      env: {
        ...process.env,
        ...(process.platform === 'win32' ? {} : { GIT_TERMINAL_PROMPT: '0' }),
        GIT_EDITOR: 'true',
        LC_ALL: 'C',
        ...env,
      },
    });
    // Collect raw bytes and decode once, so multi-byte characters split across chunks survive.
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const text = (bufs) => Buffer.concat(bufs).toString('utf8');
    child.on('error', (e) => resolve({ code: -1, stdout: text(out), stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout: text(out), stderr: text(err) }));
    child.stdin.on('error', () => {});
    child.stdin.end(input != null ? input : undefined);
  });
}

// For background fetches: make ssh fail instead of prompting (for a passphrase or an unknown
// host key), while keeping whatever ssh command the user configured (e.g. `ssh -i ~/.ssh/work`).
async function batchSshEnv(cwd) {
  if (process.env.GIT_SSH && !process.env.GIT_SSH_COMMAND) return {}; // a wrapper program we can't extend
  const configured = process.env.GIT_SSH_COMMAND
    || (await runGit(cwd, ['config', '--get', 'core.sshCommand'])).stdout.trim()
    || 'ssh';
  const program = configured.trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
  if (!/(^|[\\/])ssh(\.exe)?$/i.test(program)) return {}; // e.g. plink: options differ, leave it alone
  return { GIT_SSH_COMMAND: `${configured} -o BatchMode=yes` };
}

function createWindow() {
  const state = { width: 1440, height: 900, ...readStore().window };
  // Drop a saved position that is no longer on any connected display.
  const onScreen = state.x != null && screen.getAllDisplays().some(({ workArea: a }) =>
    state.x < a.x + a.width && state.x + state.width > a.x && state.y < a.y + a.height && state.y + state.height > a.y);
  if (!onScreen) { delete state.x; delete state.y; }
  win = new BrowserWindow({
    ...state,
    minWidth: 1000,
    minHeight: 600,
    title: 'MohKraken',
    backgroundColor: '#1b1e27',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#13151c', symbolColor: '#d8dde6', height: 38 } }),
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

ipcMain.handle('git', (_e, cwd, args, input, extraEnv) => runGit(cwd, args, input, extraEnv));

// Resolves a repo-relative path, refusing anything that escapes the repository.
function repoFile(repo, rel) {
  const root = path.resolve(repo);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path is outside the repository: ${rel}`);
  return full;
}
ipcMain.handle('fs:readRepoFile', (_e, repo, rel) => {
  const buf = fs.readFileSync(repoFile(repo, rel));
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, text: '' };
  try {
    return { binary: false, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { binary: false, notUtf8: true, text: '' };
  }
});
ipcMain.handle('fs:writeRepoFile', (_e, repo, rel, text) => {
  fs.writeFileSync(repoFile(repo, rel), text, 'utf8');
});

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
  const opts = { cwd: p, detached: true, stdio: 'ignore' };
  if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', p], opts);
  else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe'], opts);
  else spawn('x-terminal-emulator', [], opts);
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

// Custom menu: the default one binds CmdOrCtrl+W/R to close-window/reload, which would
// swallow the app's own close-tab/refresh shortcuts.
function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [mac ? { role: 'close', accelerator: 'Shift+CmdOrCtrl+W' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

app.setName('MohKraken');
app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on('window-all-closed', () => app.quit());
