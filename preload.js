const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mk', {
  platform: process.platform,
  git: (cwd, args, input, env) => ipcRenderer.invoke('git', cwd, args, input, env),
  readRepoFile: (repo, rel) => ipcRenderer.invoke('fs:readRepoFile', repo, rel),
  writeRepoFile: (repo, rel, text) => ipcRenderer.invoke('fs:writeRepoFile', repo, rel, text),
  storeGet: () => ipcRenderer.invoke('store:get'),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),
  openDir: (title) => ipcRenderer.invoke('dialog:openDir', title),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openTerminal: (p) => ipcRenderer.invoke('shell:openTerminal', p),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  appendIgnore: (repo, pattern) => ipcRenderer.invoke('fs:appendIgnore', repo, pattern),
  watch: (repo) => ipcRenderer.invoke('watch:start', repo),
  unwatch: (repo) => ipcRenderer.invoke('watch:stop', repo),
  onFocus: (cb) => ipcRenderer.on('window-focus', () => cb()),
  onRepoChanged: (cb) => ipcRenderer.on('repo-changed', (_e, repo) => cb(repo)),
});
