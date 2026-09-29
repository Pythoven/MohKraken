/* MohKraken renderer – UI state, git plumbing and rendering. */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = Diff.esc;
const basename = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const SEP = '\x1f';
const COMMIT_LIMIT_STEP = 2000;

const state = {
  tabs: [],          // { path, data, selected, limit, search }
  active: -1,
  store: {},
  diffMode: 'inline',
  diffCtx: null,     // { kind, file, sha, ... } for the open diff
  busy: 0,
};

const tab = () => state.tabs[state.active];
const repoPath = () => tab() && tab().path;

/* ---------------------------------------------------------------- git helpers */

class GitError extends Error {}

async function git(args, { input, allowFail = false, cwd } = {}) {
  const res = await window.mk.git(cwd || repoPath(), args, input);
  if (res.code !== 0 && !allowFail) {
    throw new GitError((res.stderr || res.stdout || `git ${args[0]} failed`).trim());
  }
  return allowFail ? res : res.stdout;
}

async function run(label, fn, { refresh = true } = {}) {
  setBusy(+1, label);
  try {
    const out = await fn();
    if (refresh) await loadRepo();
    return out;
  } catch (err) {
    toast(err.message, 'error', label);
  } finally {
    setBusy(-1);
  }
}

function setBusy(delta, label) {
  state.busy += delta;
  document.body.classList.toggle('busy', state.busy > 0);
  $('#status-text').innerHTML = state.busy > 0
    ? `<span class="spinner"></span>${esc(label || 'Working…')}`
    : 'Ready';
}

/* ---------------------------------------------------------------- data loading */

function parseStatus(raw) {
  const parts = raw.split('\0');
  const staged = [];
  const unstaged = [];
  const conflicted = [];
  const CONFLICT = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const X = entry[0];
    const Y = entry[1];
    const file = entry.slice(3);
    let orig = null;
    if (X === 'R' || X === 'C') orig = parts[++i];
    if (CONFLICT.includes(X + Y)) { conflicted.push({ path: file, status: 'U' }); continue; }
    if (X === '?') { unstaged.push({ path: file, status: 'A', untracked: true }); continue; }
    if (X !== ' ') staged.push({ path: file, status: X, orig });
    if (Y !== ' ') unstaged.push({ path: file, status: Y });
  }
  return { staged, unstaged, conflicted };
}

function parseRefs(raw) {
  const local = [];
  const remote = [];
  const tags = [];
  const byCommit = new Map();
  const add = (sha, ref) => {
    if (!byCommit.has(sha)) byCommit.set(sha, []);
    byCommit.get(sha).push(ref);
  };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [full, short, sha, derefSha, upstream, track] = line.split(SEP);
    const target = derefSha || sha;
    if (full.startsWith('refs/heads/')) {
      const ahead = +(track.match(/ahead (\d+)/) || [0, 0])[1];
      const behind = +(track.match(/behind (\d+)/) || [0, 0])[1];
      const ref = { type: 'local', name: short, sha: target, upstream, ahead, behind, gone: track.includes('gone') };
      local.push(ref); add(target, ref);
    } else if (full.startsWith('refs/remotes/')) {
      if (full.endsWith('/HEAD')) continue;
      const rest = full.slice('refs/remotes/'.length);
      const slash = rest.indexOf('/');
      const ref = { type: 'remote', name: short, remote: rest.slice(0, slash), branch: rest.slice(slash + 1), sha: target };
      remote.push(ref); add(target, ref);
    } else if (full.startsWith('refs/tags/')) {
      const ref = { type: 'tag', name: short, sha: target };
      tags.push(ref); add(target, ref);
    }
  }
  return { local, remote, tags, byCommit };
}

function parseLog(raw) {
  return raw.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, parents, author, email, time, subject] = r.split(SEP);
    return { hash, parents: parents ? parents.split(' ') : [], author, email, time: +time, subject };
  });
}

async function loadRepo() {
  const t = tab();
  if (!t || !t.path) return;
  const cwd = t.path;
  // Refreshes can overlap (watcher, focus, actions); only the newest one may write results.
  const seq = (t.loadSeq = (t.loadSeq || 0) + 1);

  const [headRes, headShaRes, statusRaw, refsRaw, stashRaw, remotesRaw, gitDir] = await Promise.all([
    git(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true, cwd }),
    git(['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true, cwd }),
    git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall'], { cwd }).catch(() => ''),
    git(['for-each-ref', `--format=%(refname)${SEP}%(refname:short)${SEP}%(objectname)${SEP}%(*objectname)${SEP}%(upstream:short)${SEP}%(upstream:track)`,
      'refs/heads', 'refs/remotes', 'refs/tags'], { cwd }).catch(() => ''),
    git(['stash', 'list', `--format=%gd${SEP}%H${SEP}%s${SEP}%at`], { cwd }).catch(() => ''),
    git(['remote', '-v'], { cwd }).catch(() => ''),
    git(['rev-parse', '--absolute-git-dir'], { cwd }).catch(() => ''),
  ]);

  const headSha = headShaRes.code === 0 ? headShaRes.stdout.trim() : null;
  const logRaw = headSha || refsRaw.trim()
    ? await git(['log', '--exclude=refs/stash', '--all', '--date-order', `-n${t.limit}`,
      `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%s%x1e`], { cwd }).catch(() => '')
    : '';

  if (seq !== t.loadSeq) return;
  const dir = gitDir.trim();
  const [merging, rebasing, picking, reverting] = await Promise.all([
    window.mk.exists(`${dir}/MERGE_HEAD`),
    Promise.all([window.mk.exists(`${dir}/rebase-merge`), window.mk.exists(`${dir}/rebase-apply`)]).then((a) => a.some(Boolean)),
    window.mk.exists(`${dir}/CHERRY_PICK_HEAD`),
    window.mk.exists(`${dir}/REVERT_HEAD`),
  ]);

  const remotes = [...new Set(remotesRaw.split('\n').filter(Boolean).map((l) => l.split('\t')[0]))]
    .map((name) => ({ name, url: (remotesRaw.split('\n').find((l) => l.startsWith(name + '\t')) || '').split('\t')[1]?.split(' ')[0] }));

  const stashes = stashRaw.split('\n').filter(Boolean).map((l) => {
    const [ref, hash, msg, time] = l.split(SEP);
    return { ref, hash, msg, time: +time };
  });

  if (seq !== t.loadSeq) return;
  const commits = parseLog(logRaw);
  const status = parseStatus(statusRaw);
  const refs = parseRefs(refsRaw);
  const dirty = status.staged.length + status.unstaged.length + status.conflicted.length;

  const graphCommits = dirty
    ? [{ hash: 'WIP', parents: headSha ? [headSha] : [], wip: true }, ...commits]
    : commits;

  t.data = {
    branch: headRes.code === 0 ? headRes.stdout.trim() : null,
    headSha, status, refs, stashes, remotes, commits: graphCommits, rows: Graph.layout(graphCommits),
    dirty, gitDir: dir, op: merging ? 'merge' : rebasing ? 'rebase' : picking ? 'cherry-pick' : reverting ? 'revert' : null,
    truncated: commits.length >= t.limit,
  };

  if (!t.selected || (t.selected === 'WIP' && !dirty) || (t.selected !== 'WIP' && !graphCommits.some((c) => c.hash === t.selected))) {
    t.selected = dirty ? 'WIP' : headSha;
  }
  if (t === tab()) renderAll();
}

/* ---------------------------------------------------------------- tabs & welcome */

function renderTabs() {
  $('#tabs').innerHTML = state.tabs.map((t, i) => `
    <div class="tab ${i === state.active ? 'active' : ''}" data-i="${i}" title="${esc(t.path || '')}">
      <span class="tab-name">${esc(t.path ? basename(t.path) : 'New Tab')}</span>
      <button class="tab-close" data-close="${i}">×</button>
    </div>`).join('');
}

function persistTabs() {
  window.mk.storeSet('tabs', state.tabs.filter((t) => t.path).map((t) => t.path));
  window.mk.storeSet('activeTab', state.tabs[state.active]?.path || null);
}

async function openTab(path) {
  const existing = state.tabs.findIndex((t) => t.path === path);
  if (existing !== -1) return activateTab(existing);
  const isRepo = await window.mk.git(path, ['rev-parse', '--show-toplevel']);
  if (isRepo.code !== 0) return toast(`${path} is not a Git repository`, 'error');
  const root = isRepo.stdout.trim();
  const dupe = state.tabs.findIndex((o) => o.path === root);
  if (dupe !== -1) return activateTab(dupe);
  const t = { path: root, data: null, selected: null, limit: COMMIT_LIMIT_STEP, search: '' };
  const cur = tab();
  if (cur && !cur.path) state.tabs[state.active] = t;
  else { state.tabs.push(t); state.active = state.tabs.length - 1; }
  addRecent(root);
  window.mk.watch(root);
  persistTabs();
  await activateTab(state.active);
}

async function activateTab(i) {
  state.active = i;
  closeDiff();
  renderTabs();
  persistTabs();
  const t = tab();
  $('#welcome').hidden = !!t.path;
  $('#workspace').hidden = !t.path;
  $('#toolbar').hidden = !t.path;
  $('#search').value = t.search || '';
  if (!t.path) return renderWelcome();
  if (t.data) renderAll();
  setBusy(+1, 'Loading repository…');
  try { await loadRepo(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(-1); }
}

function closeTab(i) {
  const [t] = state.tabs.splice(i, 1);
  if (t.path && !state.tabs.some((o) => o.path === t.path)) window.mk.unwatch(t.path);
  if (!state.tabs.length) state.tabs.push({ path: null });
  activateTab(Math.min(i === state.active ? i : state.active > i ? state.active - 1 : state.active, state.tabs.length - 1));
}

function newTab() {
  state.tabs.push({ path: null });
  activateTab(state.tabs.length - 1);
}

function addRecent(path) {
  const recent = [path, ...(state.store.recent || []).filter((p) => p !== path)].slice(0, 12);
  state.store.recent = recent;
  window.mk.storeSet('recent', recent);
}

function renderWelcome() {
  const recent = state.store.recent || [];
  $('#recent-list').innerHTML = recent.length
    ? recent.map((p) => `<li data-path="${esc(p)}"><span class="r-name">${esc(basename(p))}</span><span class="r-path">${esc(p)}</span></li>`).join('')
    : '<li class="muted empty">No recent repositories</li>';
}

/* ---------------------------------------------------------------- render: all */

function renderAll() {
  const d = tab()?.data;
  if (!d) return;
  $('#tb-repo-name').textContent = basename(repoPath());
  $('#tb-branch-name').textContent = d.branch || (d.headSha ? `detached @ ${d.headSha.slice(0, 7)}` : 'no commits');
  const cur = d.refs.local.find((b) => b.name === d.branch);
  $('[data-action="pull"]').dataset.badge = cur?.behind || '';
  $('[data-action="push"]').dataset.badge = cur?.ahead || '';
  $('#status-right').textContent = `${d.commits.filter((c) => !c.wip).length}${d.truncated ? '+' : ''} commits · ${d.refs.local.length} branches`;
  // Re-rendering replaces inputs; keep focus and caret where the user was typing.
  const el = document.activeElement;
  const keep = el && el.id && /^(side-filter|commit-summary|commit-body)$/.test(el.id)
    ? { id: el.id, start: el.selectionStart, end: el.selectionEnd } : null;
  renderSidebar();
  renderGraph();
  renderPanel();
  const again = keep && document.getElementById(keep.id);
  if (again) { again.focus(); again.setSelectionRange(keep.start, keep.end); }
}

/* ---------------------------------------------------------------- render: sidebar */

const collapsed = new Set();

function renderSidebar() {
  const d = tab().data;
  const filter = ($('#side-filter')?.value || '').toLowerCase();
  const match = (s) => !filter || s.toLowerCase().includes(filter);

  const section = (id, title, count, body, extra = '') => `
    <div class="side-section ${collapsed.has(id) ? 'collapsed' : ''}" data-section="${id}">
      <div class="side-head"><span class="caret">▾</span>${title}<span class="count">${count}</span>${extra}</div>
      <div class="side-body">${body || '<div class="side-empty">None</div>'}</div>
    </div>`;

  const locals = d.refs.local.filter((b) => match(b.name)).map((b) => `
    <div class="side-item ${b.name === d.branch ? 'current' : ''}" data-ref="local" data-name="${esc(b.name)}" data-sha="${b.sha}">
      <span class="ico">${b.name === d.branch ? '✓' : '⑂'}</span>
      <span class="label">${esc(b.name)}</span>
      ${b.ahead ? `<span class="track up">${b.ahead}↑</span>` : ''}${b.behind ? `<span class="track down">${b.behind}↓</span>` : ''}
    </div>`).join('');

  const remoteGroups = d.remotes.map((r) => {
    const items = d.refs.remote.filter((b) => b.remote === r.name && match(b.name)).map((b) => `
      <div class="side-item nested" data-ref="remote" data-name="${esc(b.name)}" data-sha="${b.sha}">
        <span class="ico">☁</span><span class="label">${esc(b.branch)}</span>
      </div>`).join('');
    return `<div class="side-remote" data-remote="${esc(r.name)}" title="${esc(r.url || '')}">
      <div class="side-item remote-name" data-ref="remote-root" data-name="${esc(r.name)}"><span class="ico">🌐</span><span class="label">${esc(r.name)}</span></div>
      ${items}</div>`;
  }).join('');

  const tags = d.refs.tags.filter((t) => match(t.name)).map((t) => `
    <div class="side-item" data-ref="tag" data-name="${esc(t.name)}" data-sha="${t.sha}">
      <span class="ico">🏷</span><span class="label">${esc(t.name)}</span>
    </div>`).join('');

  const stashes = d.stashes.filter((s) => match(s.msg)).map((s) => `
    <div class="side-item" data-ref="stash" data-name="${esc(s.ref)}" data-sha="${s.hash}" title="${esc(s.ref)}">
      <span class="ico">▤</span><span class="label">${esc(s.msg)}</span>
    </div>`).join('');

  const add = (what) => `<button class="side-add" data-add="${what}" title="Add ${what}">+</button>`;

  $('#sidebar').innerHTML = `
    <div class="side-filter-wrap"><input id="side-filter" type="search" placeholder="Filter" value="${esc(filter)}"></div>
    <div class="side-scroll">
      ${section('local', 'LOCAL', d.refs.local.length, locals, add('branch'))}
      ${section('remote', 'REMOTE', d.remotes.length, remoteGroups, add('remote'))}
      ${section('stash', 'STASHES', d.stashes.length, stashes)}
      ${section('tags', 'TAGS', d.refs.tags.length, tags, add('tag'))}
    </div>`;
}

/* ---------------------------------------------------------------- render: graph */

function refPills(d, sha) {
  const refs = d.refs.byCommit.get(sha) || [];
  const pills = [];
  const usedRemote = new Set();
  for (const r of refs.filter((x) => x.type === 'local')) {
    const twin = refs.find((x) => x.type === 'remote' && x.branch === r.name);
    if (twin) usedRemote.add(twin.name);
    pills.push({ label: r.name, cls: `local ${r.name === d.branch ? 'head' : ''}`, icons: `${r.name === d.branch ? '✓ ' : ''}💻${twin ? ' ☁' : ''}`, ref: 'local', name: r.name });
  }
  for (const r of refs.filter((x) => x.type === 'remote' && !usedRemote.has(x.name))) {
    pills.push({ label: r.name, cls: 'remote', icons: '☁', ref: 'remote', name: r.name });
  }
  for (const r of refs.filter((x) => x.type === 'tag')) {
    pills.push({ label: r.name, cls: 'tag', icons: '🏷', ref: 'tag', name: r.name });
  }
  if (!d.branch && sha === d.headSha) pills.unshift({ label: 'HEAD', cls: 'local head', icons: '⚑', ref: 'head', name: 'HEAD' });
  return pills;
}

function initials(name) {
  return (name || '?').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function relTime(sec) {
  const diff = Date.now() / 1000 - sec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 86400 * 7) {
    const days = Math.floor(diff / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function searchMatches(c, q) {
  if (!q) return true;
  if (c.wip) return false;
  return c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q);
}

function renderGraph() {
  const t = tab();
  const d = t.data;
  const width = Graph.widthFor(d.rows);
  document.documentElement.style.setProperty('--graph-w', `${width}px`);
  const container = $('#graph-rows');
  container.style.height = `${d.commits.length * Graph.ROW_H + (d.truncated ? 48 : 0)}px`;
  container.dataset.width = width;
  renderVisibleRows(true);
}

function renderVisibleRows(force) {
  const t = tab();
  const d = t?.data;
  if (!d) return;
  const scroller = $('#graph-scroll');
  const first = Math.max(0, Math.floor(scroller.scrollTop / Graph.ROW_H) - 10);
  const last = Math.min(d.commits.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / Graph.ROW_H) + 10);
  const container = $('#graph-rows');
  const key = `${first}:${last}:${t.selected}:${t.search}`;
  if (!force && container.dataset.key === key) return;
  container.dataset.key = key;
  const width = +container.dataset.width;
  const q = (t.search || '').toLowerCase();

  let html = '';
  for (let i = first; i < last; i++) {
    const c = d.commits[i];
    const row = d.rows[i];
    const sel = t.selected === c.hash ? 'selected' : '';
    const dim = q && !searchMatches(c, q) ? 'dim' : '';
    const top = i * Graph.ROW_H;
    const lineColor = Graph.COLORS[row.color];
    if (c.wip) {
      const s = d.status;
      html += `<div class="g-row wip ${sel} ${dim}" data-sha="WIP" style="top:${top}px;--lane:${lineColor}">
        <span class="col-refs"></span>
        <span class="col-graph">${Graph.rowSvg(row, width, { wip: true })}</span>
        <span class="col-msg"><em>// WIP</em>
          <span class="wip-stats">${s.unstaged.length + s.staged.length ? `<b class="m">✎ ${s.unstaged.length + s.staged.length}</b>` : ''}${s.conflicted.length ? `<b class="c">⚠ ${s.conflicted.length}</b>` : ''}</span></span>
        <span class="col-author"></span><span class="col-date"></span><span class="col-sha"></span>
      </div>`;
      continue;
    }
    const pills = refPills(d, c.hash);
    const pillHtml = pills.slice(0, 1).map((p) =>
      `<span class="pill ${p.cls}" data-ref="${p.ref}" data-name="${esc(p.name)}" style="--lane:${lineColor}" title="${esc(p.label)}"><span class="pi">${p.icons}</span>${esc(p.label)}</span>`).join('')
      + (pills.length > 1 ? `<span class="pill more" data-sha="${c.hash}" title="${esc(pills.slice(1).map((p) => p.label).join('\n'))}">+${pills.length - 1}</span>` : '');
    html += `<div class="g-row ${sel} ${dim} ${c.parents.length > 1 ? 'merge' : ''}" data-sha="${c.hash}" style="top:${top}px;--lane:${lineColor}">
      <span class="col-refs">${pillHtml}${pills.length ? '<span class="ref-line"></span>' : ''}</span>
      <span class="col-graph">${Graph.rowSvg(row, width, { initials: initials(c.author), head: c.hash === d.headSha })}</span>
      <span class="col-msg">${esc(c.subject)}</span>
      <span class="col-author">${esc(c.author)}</span>
      <span class="col-date" title="${new Date(c.time * 1000).toLocaleString()}">${relTime(c.time)}</span>
      <span class="col-sha">${c.hash.slice(0, 7)}</span>
    </div>`;
  }
  if (d.truncated && last === d.commits.length) {
    html += `<div class="load-more" style="top:${d.commits.length * Graph.ROW_H}px"><button class="btn small" id="load-more">Load more commits</button></div>`;
  }
  container.innerHTML = html;
}

function scrollToSha(sha) {
  const d = tab().data;
  const i = d.commits.findIndex((c) => c.hash === sha);
  if (i === -1) return toast('Commit is not loaded in the graph', 'info');
  const scroller = $('#graph-scroll');
  const y = i * Graph.ROW_H;
  if (y < scroller.scrollTop || y > scroller.scrollTop + scroller.clientHeight - Graph.ROW_H * 2) {
    scroller.scrollTop = y - scroller.clientHeight / 3;
  }
  select(sha);
}

function select(sha) {
  const t = tab();
  if (t.selected === sha && !state.diffCtx) return;
  t.selected = sha;
  closeDiff();
  // Update the highlight in place: re-rendering rows here would swallow double-clicks.
  $$('#graph-rows .g-row').forEach((r) => r.classList.toggle('selected', r.dataset.sha === sha));
  $('#graph-rows').dataset.key = '';
  renderPanel();
}

// Double-click on a graph ref (or a row carrying one) switches to it, like GitKraken.
function checkoutRef(ref, name) {
  if (ref === 'local') return checkoutLocal(name);
  if (ref === 'remote') return checkoutRemote(name);
  if (ref === 'tag') return run(`Checking out ${name}…`, () => git(['checkout', '--detach', name]));
}

/* ---------------------------------------------------------------- render: right panel */

const STATUS_LABEL = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type', U: 'conflict' };

function fileRow(f, actions, kind) {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
  const name = f.path.slice(dir.length);
  const active = state.diffCtx && state.diffCtx.kind === kind && state.diffCtx.file.path === f.path ? 'active' : '';
  return `<div class="file ${active}" data-kind="${kind}" data-path="${esc(f.path)}" title="${esc(f.orig ? `${f.orig} → ${f.path}` : f.path)}">
    <span class="fstatus s-${f.status}" title="${STATUS_LABEL[f.status] || f.status}">${f.status === 'M' ? '✎' : f.status === 'A' ? '+' : f.status === 'D' ? '−' : f.status === 'R' ? '→' : f.status === 'U' ? '!' : f.status}</span>
    <span class="fname"><span class="fdir">${esc(dir)}</span>${esc(name)}</span>
    <span class="factions">${actions}</span>
  </div>`;
}

function renderPanel() {
  const t = tab();
  const d = t.data;
  if (t.selected === 'WIP') return renderWipPanel(d);
  if (!t.selected) {
    $('#panel').innerHTML = '<div class="panel-empty">This repository has no commits yet.<br>Make some changes to get started.</div>';
    return;
  }
  renderCommitPanel(t.selected);
}

function renderWipPanel(d) {
  const s = d.status;
  const draft = tab().draft || { summary: '', body: '', amend: false };
  const opBanner = d.op ? `
    <div class="op-banner">
      <b>${d.op.toUpperCase()} in progress</b>
      <span>${s.conflicted.length ? `${s.conflicted.length} conflicted file(s)` : 'All conflicts resolved'}</span>
      <div class="op-actions">
        <button class="btn small" data-op="abort">Abort</button>
        ${d.op === 'merge' ? '' : `<button class="btn small primary" data-op="continue" ${s.conflicted.length ? 'disabled' : ''}>Continue</button>`}
        ${d.op === 'rebase' ? '<button class="btn small" data-op="skip">Skip</button>' : ''}
      </div>
    </div>` : '';

  const conflicted = s.conflicted.length ? `
    <div class="fsection conflict">
      <div class="fhead"><span>⚠ Conflicted Files (${s.conflicted.length})</span></div>
      <div class="flist">${s.conflicted.map((f) => fileRow(f, `
        <button class="btn tiny" data-file-act="ours" title="Take ours">Ours</button>
        <button class="btn tiny" data-file-act="theirs" title="Take theirs">Theirs</button>
        <button class="btn tiny primary" data-file-act="resolve" title="Mark resolved">✓</button>`, 'conflict')).join('')}</div>
    </div>` : '';

  $('#panel').innerHTML = `
    <div class="panel-head">
      <div class="wip-title">${d.dirty} file change${d.dirty === 1 ? '' : 's'} on <b>${esc(d.branch || 'detached HEAD')}</b></div>
    </div>
    ${opBanner}
    <div class="panel-files">
      ${conflicted}
      <div class="fsection">
        <div class="fhead"><span>Unstaged Files (${s.unstaged.length})</span>
          ${s.unstaged.length ? '<button class="btn tiny success" id="stage-all">Stage all changes</button>' : ''}</div>
        <div class="flist">${s.unstaged.map((f) => fileRow(f, `
          <button class="btn tiny" data-file-act="discard" title="Discard changes">🗑</button>
          <button class="btn tiny success" data-file-act="stage">Stage</button>`, 'unstaged')).join('') || '<div class="side-empty">No unstaged changes</div>'}</div>
      </div>
      <div class="fsection">
        <div class="fhead"><span>Staged Files (${s.staged.length})</span>
          ${s.staged.length ? '<button class="btn tiny danger" id="unstage-all">Unstage all changes</button>' : ''}</div>
        <div class="flist">${s.staged.map((f) => fileRow(f, '<button class="btn tiny danger" data-file-act="unstage">Unstage</button>', 'staged')).join('') || '<div class="side-empty">No staged changes</div>'}</div>
      </div>
    </div>
    <div class="commit-box">
      <div class="commit-head"><span>Commit</span>
        <label class="amend"><input type="checkbox" id="amend" ${draft.amend ? 'checked' : ''} ${d.headSha ? '' : 'disabled'}> Amend</label></div>
      <div class="summary-wrap">
        <input id="commit-summary" placeholder="Summary" maxlength="200" value="${esc(draft.summary)}">
        <span id="summary-count">${72 - draft.summary.length}</span>
      </div>
      <textarea id="commit-body" placeholder="Description">${esc(draft.body)}</textarea>
      <button class="btn primary block" id="commit-btn">${commitLabel(d, draft)}</button>
    </div>`;
}

function commitLabel(d, draft) {
  if (draft.amend) return 'Amend previous commit';
  if (d.op === 'merge') return d.status.conflicted.length ? 'Resolve conflicts to commit merge' : 'Commit and merge';
  const n = d.status.staged.length;
  if (!n) return 'Stage files/changes to commit';
  return `Commit changes to ${n} file${n === 1 ? '' : 's'}`;
}

function syncDraft() {
  const t = tab();
  t.draft = {
    summary: $('#commit-summary')?.value || '',
    body: $('#commit-body')?.value || '',
    amend: $('#amend')?.checked || false,
  };
  $('#summary-count').textContent = 72 - t.draft.summary.length;
  $('#summary-count').classList.toggle('over', t.draft.summary.length > 72);
  $('#commit-btn').textContent = commitLabel(t.data, t.draft);
}

function parseNameStatus(raw) {
  const parts = raw.split('\0').filter((x) => x !== '');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    const s = code[0];
    if (s === 'R' || s === 'C') files.push({ status: s, orig: parts[++i], path: parts[++i] });
    else files.push({ status: s, path: parts[++i] });
  }
  return files;
}

async function renderCommitPanel(sha) {
  const panel = $('#panel');
  const stash = tab().data.stashes.find((s) => s.hash === sha);
  const raw = await git(['show', '-s', `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%cn${SEP}%ct${SEP}%B`, sha]).catch(() => null);
  if (!raw || tab().selected !== sha) return;
  const [hash, parents, author, email, atime, committer, ctime, ...body] = raw.split(SEP);
  const msg = body.join(SEP).trim();
  const [subject, ...rest] = msg.split('\n');
  const parentList = parents ? parents.split(' ') : [];

  const filesRaw = parentList.length
    ? await git(['diff', '--name-status', '-M', '-z', parentList[0], hash])
    : await git(['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', hash]);
  const files = parseNameStatus(filesRaw);
  if (tab().selected !== sha) return;
  tab().commitFiles = { sha, files, parent: parentList[0] || null };

  const counts = { A: 0, M: 0, D: 0, R: 0 };
  files.forEach((f) => { counts[f.status] = (counts[f.status] || 0) + 1; });
  const color = Graph.COLORS[[...author].reduce((a, ch) => a + ch.charCodeAt(0), 0) % Graph.COLORS.length];

  panel.innerHTML = `
    <div class="panel-head commit">
      <div class="commit-sha">${stash ? `<span class="pill tag">${esc(stash.ref)}</span>` : ''}
        commit: <code class="copy" data-copy="${hash}" title="Copy SHA">${hash.slice(0, 7)}</code>
      </div>
      <div class="commit-subject">${esc(subject)}</div>
      ${rest.join('\n').trim() ? `<pre class="commit-body">${esc(rest.join('\n').trim())}</pre>` : ''}
      <div class="commit-meta">
        <div class="avatar" style="background:${color}">${initials(author)}</div>
        <div>
          <div><b>${esc(author)}</b> <span class="muted">&lt;${esc(email)}&gt;</span></div>
          <div class="muted">authored ${new Date(+atime * 1000).toLocaleString()}</div>
          ${committer !== author || atime !== ctime ? `<div class="muted">committed by ${esc(committer)} ${relTime(+ctime)}</div>` : ''}
        </div>
      </div>
      <div class="commit-parents">parent${parentList.length > 1 ? 's' : ''}: ${parentList.map((p) => `<code class="link" data-goto="${p}">${p.slice(0, 7)}</code>`).join(' ') || '<span class="muted">none (root commit)</span>'}</div>
    </div>
    <div class="file-summary">
      ${counts.M ? `<span class="s-M">✎ ${counts.M} modified</span>` : ''}
      ${counts.A ? `<span class="s-A">+ ${counts.A} added</span>` : ''}
      ${counts.D ? `<span class="s-D">− ${counts.D} deleted</span>` : ''}
      ${counts.R ? `<span class="s-R">→ ${counts.R} renamed</span>` : ''}
      ${parentList.length > 1 ? '<span class="muted">(vs first parent)</span>' : ''}
    </div>
    <div class="panel-files"><div class="flist">${files.map((f) => fileRow(f, '', 'commit')).join('') || '<div class="side-empty">No file changes</div>'}</div></div>
    ${stash ? `<div class="commit-box stash-actions">
        <button class="btn primary" data-stash-act="apply">Apply</button>
        <button class="btn" data-stash-act="pop">Pop</button>
        <button class="btn danger" data-stash-act="drop">Delete</button></div>` : ''}`;
}

/* ---------------------------------------------------------------- diff view */

async function openDiff(kind, filePath) {
  const t = tab();
  const d = t.data;
  let file;
  let text;
  let hunkAction = null;
  if (kind === 'unstaged') {
    file = d.status.unstaged.find((f) => f.path === filePath);
    if (!file) return;
    if (file.untracked) {
      text = (await git(['diff', '--no-index', '--', '/dev/null', filePath], { allowFail: true })).stdout;
    } else {
      text = await git(['diff', '--', filePath]);
      hunkAction = 'Stage hunk';
    }
  } else if (kind === 'staged') {
    file = d.status.staged.find((f) => f.path === filePath);
    if (!file) return;
    text = await git(['diff', '--cached', '-M', '--', ...(file.orig ? [file.orig] : []), filePath]);
    hunkAction = 'Unstage hunk';
  } else if (kind === 'conflict') {
    file = d.status.conflicted.find((f) => f.path === filePath);
    text = await git(['diff', '--', filePath], { allowFail: true }).then((r) => r.stdout);
  } else {
    const cf = t.commitFiles;
    file = cf?.files.find((f) => f.path === filePath);
    if (!file) return;
    const paths = ['--', ...(file.orig ? [file.orig] : []), filePath];
    text = cf.parent
      ? await git(['diff', '-M', cf.parent, cf.sha, ...paths])
      : await git(['show', '--format=', '-M', cf.sha, ...paths]);
  }
  if (!file) return;
  state.diffCtx = { kind, file, text, hunkAction };
  renderDiff();
  $$('#panel .file').forEach((el) => el.classList.toggle('active', el.dataset.kind === kind && el.dataset.path === filePath));
}

function renderDiff() {
  const ctx = state.diffCtx;
  if (!ctx) return;
  if (ctx.text.length > 3e6 && !ctx.forceLarge) {
    $('#diff-path').textContent = ctx.file.path;
    $('#diff-body').innerHTML = `<div class="diff-empty">This diff is large (${(ctx.text.length / 1e6).toFixed(1)} MB) and may be slow to show.<br><br><button class="btn small" id="diff-force">Show anyway</button></div>`;
    $('#diff-view').hidden = false;
    return;
  }
  const { html, parsed } = Diff.render(ctx.text, { mode: state.diffMode, hunkAction: ctx.hunkAction });
  ctx.parsed = parsed;
  $('#diff-path').textContent = ctx.file.orig ? `${ctx.file.orig} → ${ctx.file.path}` : ctx.file.path;
  $('#diff-sub').textContent = ` · ${ctx.kind === 'commit' ? tab().commitFiles.sha.slice(0, 7) : ctx.kind}`;
  $('#diff-mode').textContent = state.diffMode === 'split' ? 'Inline view' : 'Split view';
  const fallback = !parsed.hunks.length && ctx.text.trim() && !parsed.binary
    ? `<pre class="raw-diff">${esc(ctx.text)}</pre>` : html;
  $('#diff-body').innerHTML = fallback;
  $('#diff-view').hidden = false;
}

function closeDiff() {
  state.diffCtx = null;
  $('#diff-view').hidden = true;
  $$('#panel .file.active').forEach((el) => el.classList.remove('active'));
}

async function applyHunk(index) {
  const ctx = state.diffCtx;
  const patch = Diff.hunkPatch(ctx.parsed, index);
  const reverse = ctx.kind === 'staged';
  const { kind, file } = ctx;
  await run(reverse ? 'Unstaging hunk…' : 'Staging hunk…', () =>
    git(['apply', '--cached', '--whitespace=nowarn', ...(reverse ? ['-R'] : []), '-'], { input: patch }));
  const list = kind === 'staged' ? tab().data.status.staged : tab().data.status.unstaged;
  if (list.some((f) => f.path === file.path)) openDiff(kind, file.path);
}

/* ---------------------------------------------------------------- actions */

async function stageFile(path) {
  await git(['add', '-A', '--', path]);
}

async function unstageFile(f) {
  const paths = f.orig ? [f.orig, f.path] : [f.path];
  if (tab().data.headSha) await git(['reset', '-q', 'HEAD', '--', ...paths]);
  else await git(['rm', '--cached', '-r', '-q', '--', ...paths]);
}

async function doCommit() {
  const t = tab();
  syncDraft();
  const { summary, body, amend } = t.draft;
  const merging = t.data.op === 'merge';
  if (merging && t.data.status.conflicted.length) return toast('Resolve all conflicts before committing the merge', 'info');
  if (!summary.trim() && !merging) return toast('Please enter a commit summary', 'info');
  if (!amend && !merging && !t.data.status.staged.length) return toast('Stage some changes before committing', 'info');
  const msg = body.trim() ? `${summary.trim()}\n\n${body.trim()}` : summary.trim();
  const ok = await run('Committing…', async () => {
    if (merging && !summary.trim()) await git(['commit', '--no-edit', '--cleanup=strip']);
    else await git(['commit', ...(amend ? ['--amend'] : []), '-F', '-'], { input: msg });
    return true;
  });
  if (ok) {
    t.draft = null;
    toast(amend ? 'Commit amended' : 'Changes committed', 'success');
  }
}

// Checks out a branch; if local changes block it, offers to stash them first (like GitKraken).
async function checkout(args, label) {
  const res = await window.mk.git(repoPath(), ['checkout', ...args]);
  if (res.code === 0) return loadRepo();
  if (!/would be overwritten|commit your changes or stash/i.test(res.stderr)) return toast(res.stderr.trim(), 'error', 'Checkout failed');
  const choice = await modal({
    title: 'Uncommitted changes',
    body: `<p>Your local changes would be overwritten by switching to <b>${esc(label)}</b>.</p>`,
    buttons: [{ label: 'Stash & switch', value: 'stash', cls: 'primary' }],
  });
  if (choice !== 'stash') return;
  await run(`Stashing and switching to ${label}…`, async () => {
    await git(['stash', 'push', '-u', '-m', `WIP before switching to ${label}`]);
    await git(['checkout', ...args]);
  });
  toast('Your changes were stashed – pop them from STASHES when ready', 'success');
}

async function checkoutLocal(name) {
  setBusy(+1, `Checking out ${name}…`);
  try { await checkout([name], name); } finally { setBusy(-1); }
}

async function checkoutRemote(remoteRef) {
  const d = tab().data;
  const r = d.refs.remote.find((x) => x.name === remoteRef);
  const local = d.refs.local.find((b) => b.name === r.branch);
  if (local) {
    if (local.sha === r.sha) return checkoutLocal(local.name);
    const choice = await modal({
      title: `Local branch "${r.branch}" already exists`,
      body: `<p>Your local <b>${esc(r.branch)}</b> differs from <b>${esc(remoteRef)}</b>.</p>`,
      buttons: [{ label: 'Checkout local', value: 'local' }, { label: 'Reset local to remote', value: 'reset', cls: 'danger' }],
    });
    if (choice === 'local') return checkoutLocal(local.name);
    if (choice === 'reset') return checkout(['-B', r.branch, remoteRef], r.branch);
    return;
  }
  setBusy(+1, `Checking out ${remoteRef}…`);
  try { await checkout(['-b', r.branch, '--track', remoteRef], r.branch); } finally { setBusy(-1); }
}

async function pull() {
  const d = tab().data;
  const cur = d.refs.local.find((b) => b.name === d.branch);
  if (!cur || !cur.upstream) return toast('Current branch has no upstream to pull from', 'info');
  // Git >= 2.27 refuses to pull divergent branches without a strategy; default to merge
  // (GitKraken's "fast-forward if possible") unless the user configured one.
  const configured = (await git(['config', '--get', 'pull.rebase'], { allowFail: true })).code === 0;
  const res = await run('Pulling…', () => git(['pull', '--no-edit', ...(configured ? [] : ['--no-rebase'])]));
  if (res !== undefined) toast('Pull complete', 'success');
}

async function push(force = false) {
  const d = tab().data;
  if (!d.branch) return toast('Cannot push from a detached HEAD', 'info');
  if (!d.remotes.length) return toast('No remotes configured. Add one from the REMOTE section.', 'info');
  const cur = d.refs.local.find((b) => b.name === d.branch);
  let args = ['push', ...(force ? ['--force-with-lease'] : [])];
  if (!cur?.upstream) {
    const vals = await modal({
      title: 'Set upstream',
      body: `<p>What remote/branch should <b>${esc(d.branch)}</b> push to and pull from?</p>
        <div class="row"><select name="remote">${d.remotes.map((r) => `<option>${esc(r.name)}</option>`).join('')}</select>
        <span>/</span><input name="branch" value="${esc(d.branch)}"></div>`,
      buttons: [{ label: 'Submit', value: 'ok', cls: 'primary' }],
      form: true,
    });
    if (!vals) return;
    args = [...args, '-u', vals.remote, `${d.branch}:${vals.branch}`];
  }
  const res = await window.mk.git(repoPath(), args);
  if (res.code === 0) {
    await loadRepo();
    return toast('Push complete', 'success');
  }
  if (!force && /rejected|non-fast-forward|fetch first/.test(res.stderr)) {
    const choice = await modal({
      title: 'Push rejected',
      body: '<p>The remote contains work you do not have locally. Pull first, or force push (with lease)?</p>',
      buttons: [{ label: 'Pull', value: 'pull', cls: 'primary' }, { label: 'Force push', value: 'force', cls: 'danger' }],
    });
    if (choice === 'pull') return pull();
    if (choice === 'force') return push(true);
    return;
  }
  toast(res.stderr.trim(), 'error', 'Push failed');
}

async function createBranch(startPoint) {
  const vals = await modal({
    title: 'Create branch',
    body: `<input name="name" placeholder="branch-name" autofocus>
      <label class="check"><input type="checkbox" name="checkout" checked> Checkout after creating</label>
      ${startPoint ? `<p class="muted">from <code>${esc(startPoint.slice(0, 12))}</code></p>` : ''}`,
    buttons: [{ label: 'Create', value: 'ok', cls: 'primary' }],
    form: true,
  });
  if (!vals || !vals.name.trim()) return;
  const name = vals.name.trim().replace(/\s+/g, '-');
  const start = startPoint ? [startPoint] : [];
  await run(`Creating ${name}…`, () => git(vals.checkout ? ['checkout', '-b', name, ...start] : ['branch', name, ...start]));
}

async function createTag(sha) {
  const vals = await modal({
    title: 'Create tag',
    body: `<input name="name" placeholder="v1.0.0" autofocus><textarea name="message" placeholder="Message (optional – makes an annotated tag)"></textarea>`,
    buttons: [{ label: 'Create', value: 'ok', cls: 'primary' }],
    form: true,
  });
  if (!vals || !vals.name.trim()) return;
  const args = vals.message.trim()
    ? ['tag', '-a', vals.name.trim(), '-m', vals.message.trim(), sha || 'HEAD']
    : ['tag', vals.name.trim(), sha || 'HEAD'];
  await run('Creating tag…', () => git(args));
}

async function stash() {
  const vals = await modal({
    title: 'Stash changes',
    body: `<input name="message" placeholder="Stash message (optional)" autofocus>
      <label class="check"><input type="checkbox" name="untracked" checked> Include untracked files</label>`,
    buttons: [{ label: 'Stash', value: 'ok', cls: 'primary' }],
    form: true,
  });
  if (!vals) return;
  await run('Stashing…', () => git(['stash', 'push', ...(vals.untracked ? ['-u'] : []), ...(vals.message.trim() ? ['-m', vals.message.trim()] : [])]));
}

async function stashAction(act, ref) {
  if (act === 'drop' && !(await confirmBox(`Delete ${ref}?`, 'This stash will be permanently deleted.', 'Delete'))) return;
  await run(`Stash ${act}…`, () => git(['stash', act, ref]));
}

async function undoCommit() {
  const d = tab().data;
  if (!d.headSha) return;
  const res = await window.mk.git(repoPath(), ['rev-parse', '-q', '--verify', 'HEAD~1']);
  if (res.code !== 0) return toast('Nothing to undo – this is the first commit', 'info');
  const c = d.commits.find((x) => x.hash === d.headSha);
  if (!(await confirmBox('Undo last commit?', `<p>“${esc(c ? c.subject : d.headSha.slice(0, 7))}” will be undone. Its changes stay staged.</p>`, 'Undo'))) return;
  await run('Undoing…', () => git(['reset', '--soft', 'HEAD~1']));
}

async function addRemote() {
  const vals = await modal({
    title: 'Add remote',
    body: '<input name="name" placeholder="Name (e.g. origin)" autofocus><input name="url" placeholder="URL (https://… or git@…)">',
    buttons: [{ label: 'Add remote', value: 'ok', cls: 'primary' }],
    form: true,
  });
  if (!vals || !vals.name.trim() || !vals.url.trim()) return;
  await run('Adding remote…', async () => {
    await git(['remote', 'add', vals.name.trim(), vals.url.trim()]);
    await git(['fetch', vals.name.trim()]).catch((e) => toast(e.message, 'error', 'Fetch failed'));
  });
}

async function editProfile() {
  const [name, email] = await Promise.all([
    git(['config', 'user.name'], { allowFail: true }),
    git(['config', 'user.email'], { allowFail: true }),
  ]);
  const vals = await modal({
    title: 'Git identity',
    body: `<input name="name" placeholder="Author name" value="${esc(name.stdout.trim())}">
      <input name="email" placeholder="Author email" value="${esc(email.stdout.trim())}">
      <label class="check"><input type="checkbox" name="global"> Apply globally (all repositories)</label>`,
    buttons: [{ label: 'Save', value: 'ok', cls: 'primary' }],
    form: true,
  });
  if (!vals) return;
  const scope = vals.global ? '--global' : '--local';
  const ok = await run('Saving identity…', async () => {
    if (vals.name.trim()) await git(['config', scope, 'user.name', vals.name.trim()]);
    if (vals.email.trim()) await git(['config', scope, 'user.email', vals.email.trim()]);
    return true;
  });
  if (ok) toast('Identity saved', 'success');
}

async function cloneRepo() {
  const vals = await modal({
    title: 'Clone a repository',
    body: `<input name="url" placeholder="Repository URL" autofocus>
      <div class="row"><input name="dir" placeholder="Where to clone to" value="${esc(state.store.cloneDir || '')}"><button type="button" class="btn small" id="browse-dir">Browse</button></div>
      <input name="name" placeholder="Folder name (optional)">`,
    buttons: [{ label: 'Clone the repo!', value: 'ok', cls: 'primary' }],
    form: true,
    onOpen: (root) => $('#browse-dir', root).addEventListener('click', async () => {
      const dir = await window.mk.openDir('Choose a folder to clone into');
      if (dir) $('[name=dir]', root).value = dir;
    }),
  });
  if (!vals || !vals.url.trim() || !vals.dir.trim()) return;
  const url = vals.url.trim();
  const name = vals.name.trim() || basename(url).replace(/\.git$/, '');
  const dest = `${vals.dir.trim().replace(/\/+$/, '')}/${name}`;
  state.store.cloneDir = vals.dir.trim();
  window.mk.storeSet('cloneDir', state.store.cloneDir);
  setBusy(+1, `Cloning ${url}…`);
  const res = await window.mk.git(vals.dir.trim(), ['clone', '--progress', url, name]);
  setBusy(-1);
  if (res.code !== 0) return toast(res.stderr.trim(), 'error', 'Clone failed');
  toast(`Cloned into ${dest}`, 'success');
  openTab(dest);
}

async function initRepo() {
  const dir = await window.mk.openDir('Choose a folder to initialize');
  if (!dir) return;
  const res = await window.mk.git(dir, ['init']);
  if (res.code !== 0) return toast(res.stderr.trim(), 'error', 'Init failed');
  toast(`Initialized repository in ${dir}`, 'success');
  openTab(dir);
}

async function openRepo() {
  const dir = await window.mk.openDir();
  if (dir) openTab(dir);
}

async function resolveOp(action) {
  const op = tab().data.op;
  if (action === 'abort' && !(await confirmBox(`Abort ${op}?`, 'Your repository will return to its state before the operation.', 'Abort'))) return;
  const env = action === 'continue' ? ['-c', 'core.editor=true'] : [];
  await run(`${op} --${action}…`, () => git([...env, op, `--${action}`]));
}

/* ---------------------------------------------------------------- context menus */

function contextMenu(ev, items) {
  ev.preventDefault();
  const menu = $('#ctx-menu');
  menu.innerHTML = items.map((it, i) => it === '-'
    ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}" data-i="${i}">${esc(it.label)}</div>`).join('');
  menu.hidden = false;
  const { innerWidth: W, innerHeight: H } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, W - r.width - 8)}px`;
  menu.style.top = `${Math.min(ev.clientY, H - r.height - 8)}px`;
  menu.onclick = (e) => {
    const el = e.target.closest('.ctx-item');
    if (!el || el.classList.contains('disabled')) return;
    menu.hidden = true;
    items[+el.dataset.i].action();
  };
}

function commitMenu(ev, sha) {
  const d = tab().data;
  const short = sha.slice(0, 7);
  const branch = d.branch;
  const isHead = sha === d.headSha;
  const stash = d.stashes.find((s) => s.hash === sha);
  contextMenu(ev, [
    { label: `Checkout ${short} (detached)`, action: () => run('Checking out…', () => git(['checkout', '--detach', sha])), disabled: isHead && !branch },
    { label: 'Create branch here', action: () => createBranch(sha) },
    { label: 'Create tag here', action: () => createTag(sha) },
    '-',
    { label: `Cherry pick commit`, disabled: isHead, action: () => run('Cherry picking…', () => git(['cherry-pick', sha])) },
    { label: 'Revert commit', action: () => run('Reverting…', () => git(['revert', '--no-edit', sha])) },
    '-',
    ...(['soft', 'mixed', 'hard'].map((mode) => ({
      label: `Reset ${branch || 'HEAD'} to this commit – ${mode}`,
      danger: mode === 'hard',
      disabled: isHead,
      action: async () => {
        if (mode === 'hard' && !(await confirmBox('Hard reset?', 'All uncommitted changes will be lost.', 'Reset'))) return;
        run(`Resetting (${mode})…`, () => git(['reset', `--${mode}`, sha]));
      },
    }))),
    '-',
    ...(stash ? [
      { label: 'Apply stash', action: () => stashAction('apply', stash.ref) },
      { label: 'Pop stash', action: () => stashAction('pop', stash.ref) },
      { label: 'Delete stash', danger: true, action: () => stashAction('drop', stash.ref) },
      '-',
    ] : []),
    { label: 'Copy commit SHA', action: () => copy(sha) },
  ]);
}

function refMenu(ev, type, name) {
  const d = tab().data;
  if (type === 'local') {
    const b = d.refs.local.find((x) => x.name === name);
    const isCur = name === d.branch;
    return contextMenu(ev, [
      { label: `Checkout ${name}`, disabled: isCur, action: () => checkoutLocal(name) },
      '-',
      { label: `Merge ${name} into ${d.branch}`, disabled: isCur || !d.branch, action: () => run('Merging…', () => git(['merge', '--no-edit', name])) },
      { label: `Rebase ${d.branch} onto ${name}`, disabled: isCur || !d.branch, action: () => run('Rebasing…', () => git(['rebase', name])) },
      ...(isCur && b?.upstream ? [
        { label: 'Pull', action: pull },
        { label: 'Push', action: () => push() },
      ] : []),
      ...(isCur && !b?.upstream ? [{ label: 'Push & set upstream', action: () => push() }] : []),
      '-',
      { label: 'Create branch here', action: () => createBranch(name) },
      { label: 'Create tag here', action: () => createTag(name) },
      { label: `Rename ${name}`, action: () => renameBranch(name) },
      { label: `Delete ${name}`, danger: true, disabled: isCur, action: () => deleteBranch(name) },
      '-',
      { label: 'Copy branch name', action: () => copy(name) },
    ]);
  }
  if (type === 'remote') {
    const r = d.refs.remote.find((x) => x.name === name);
    return contextMenu(ev, [
      { label: `Checkout ${name}`, action: () => checkoutRemote(name) },
      { label: `Merge ${name} into ${d.branch}`, disabled: !d.branch, action: () => run('Merging…', () => git(['merge', '--no-edit', name])) },
      { label: `Rebase ${d.branch} onto ${name}`, disabled: !d.branch, action: () => run('Rebasing…', () => git(['rebase', name])) },
      '-',
      { label: `Delete ${name} on remote`, danger: true, action: async () => {
        if (!(await confirmBox(`Delete ${name}?`, `The branch <b>${esc(r.branch)}</b> will be deleted from <b>${esc(r.remote)}</b>.`, 'Delete'))) return;
        run('Deleting remote branch…', () => git(['push', r.remote, '--delete', r.branch]));
      } },
      { label: 'Copy branch name', action: () => copy(name) },
    ]);
  }
  if (type === 'remote-root') {
    return contextMenu(ev, [
      { label: `Fetch ${name}`, action: () => run(`Fetching ${name}…`, () => git(['fetch', '--prune', name])) },
      { label: 'Copy remote URL', action: () => copy(d.remotes.find((r) => r.name === name)?.url || '') },
      { label: `Remove ${name}`, danger: true, action: async () => {
        if (!(await confirmBox(`Remove remote ${name}?`, 'Remote-tracking branches will be removed too.', 'Remove'))) return;
        run('Removing remote…', () => git(['remote', 'remove', name]));
      } },
    ]);
  }
  if (type === 'tag') {
    return contextMenu(ev, [
      { label: `Checkout ${name} (detached)`, action: () => run('Checking out…', () => git(['checkout', '--detach', name])) },
      ...d.remotes.map((r) => ({ label: `Push ${name} to ${r.name}`, action: () => run('Pushing tag…', () => git(['push', r.name, `refs/tags/${name}`])) })),
      { label: `Delete ${name} locally`, danger: true, action: () => run('Deleting tag…', () => git(['tag', '-d', name])) },
      { label: 'Copy tag name', action: () => copy(name) },
    ]);
  }
  if (type === 'stash') {
    return contextMenu(ev, [
      { label: 'Apply stash', action: () => stashAction('apply', name) },
      { label: 'Pop stash', action: () => stashAction('pop', name) },
      { label: 'Delete stash', danger: true, action: () => stashAction('drop', name) },
    ]);
  }
  if (type === 'head') return commitMenu(ev, d.headSha);
}

async function renameBranch(name) {
  const vals = await modal({
    title: `Rename ${name}`,
    body: `<input name="name" value="${esc(name)}" autofocus>`,
    buttons: [{ label: 'Rename', value: 'ok', cls: 'primary' }],
    form: true,
  });
  if (!vals || !vals.name.trim() || vals.name.trim() === name) return;
  await run('Renaming…', () => git(['branch', '-m', name, vals.name.trim()]));
}

async function deleteBranch(name) {
  if (!(await confirmBox(`Delete ${name}?`, `The local branch <b>${esc(name)}</b> will be deleted.`, 'Delete'))) return;
  const res = await window.mk.git(repoPath(), ['branch', '-d', name]);
  if (res.code === 0) return loadRepo();
  if (/not fully merged/.test(res.stderr)) {
    if (await confirmBox('Branch not fully merged', `<b>${esc(name)}</b> contains commits that are not merged. Delete anyway?`, 'Force delete')) {
      await run('Deleting…', () => git(['branch', '-D', name]));
    }
    return;
  }
  toast(res.stderr.trim(), 'error');
}

function copy(text) {
  navigator.clipboard.writeText(text);
  toast(`Copied ${text.length > 40 ? text.slice(0, 40) + '…' : text}`, 'success');
}

/* ---------------------------------------------------------------- modal & toast */

function modal({ title, body, buttons, form = false, onOpen }) {
  return new Promise((resolve) => {
    const bd = $('#modal-backdrop');
    const m = $('#modal');
    m.innerHTML = `<form class="modal-form">
      <h2>${esc(title)}</h2>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button type="button" class="btn" data-v="">Cancel</button>
        ${buttons.map((b, i) => `<button type="${i === 0 ? 'submit' : 'button'}" class="btn ${b.cls || ''}" data-v="${b.value}">${esc(b.label)}</button>`).join('')}
      </div></form>`;
    bd.hidden = false;
    const f = $('form', m);
    const done = (v) => {
      bd.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (!v) return resolve(null);
      if (!form) return resolve(v);
      const out = {};
      $$('input, textarea, select', f).forEach((el) => { if (el.name) out[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
      resolve(out);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    f.onsubmit = (e) => { e.preventDefault(); done(buttons[0].value); };
    $$('button[data-v]', f).forEach((b) => { if (b.type === 'button') b.onclick = () => done(b.dataset.v); });
    bd.onmousedown = (e) => { if (e.target === bd) done(null); };
    onOpen && onOpen(m);
    const focus = $('[autofocus]', m) || $('input, textarea', m) || $('button[type=submit]', m);
    focus && focus.focus();
  });
}

async function confirmBox(title, html, label) {
  const v = await modal({ title, body: `<p>${html}</p>`, buttons: [{ label, value: 'yes', cls: 'danger' }] });
  return v === 'yes';
}

function toast(msg, type = 'info', title) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}<div>${esc(msg).replace(/\n/g, '<br>')}</div>`;
  el.onclick = () => el.remove();
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 9000 : 3500);
}

/* ---------------------------------------------------------------- events */

function bindEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) return closeTab(+close.dataset.close);
    const t = e.target.closest('.tab');
    if (t) activateTab(+t.dataset.i);
  });
  $('#tab-add').onclick = newTab;

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctx-menu')) $('#ctx-menu').hidden = true;
    const act = e.target.closest('[data-action]');
    if (act) handleAction(act.dataset.action);
  });

  $('#recent-list').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-path]');
    if (!li) return;
    if (!(await window.mk.exists(li.dataset.path))) {
      state.store.recent = state.store.recent.filter((p) => p !== li.dataset.path);
      window.mk.storeSet('recent', state.store.recent);
      renderWelcome();
      return toast('That folder no longer exists', 'error');
    }
    openTab(li.dataset.path);
  });

  // Graph
  const scroller = $('#graph-scroll');
  scroller.addEventListener('scroll', () => requestAnimationFrame(() => renderVisibleRows(false)));
  $('#graph-rows').addEventListener('click', (e) => {
    if (e.target.id === 'load-more') {
      tab().limit += COMMIT_LIMIT_STEP;
      return run('Loading more commits…', async () => {}, { refresh: true });
    }
    const more = e.target.closest('.pill.more');
    if (more) {
      e.stopPropagation();
      const d = tab().data;
      return contextMenu(e, refPills(d, more.dataset.sha).slice(1).map((p) => ({
        label: `Checkout ${p.label}`, disabled: p.ref === 'local' && p.name === d.branch, action: () => checkoutRef(p.ref, p.name),
      })));
    }
    const row = e.target.closest('.g-row');
    if (row) select(row.dataset.sha);
  });
  $('#graph-rows').addEventListener('dblclick', (e) => {
    const pill = e.target.closest('.pill[data-ref]');
    if (pill) return checkoutRef(pill.dataset.ref, pill.dataset.name);
    const row = e.target.closest('.g-row');
    if (!row || row.dataset.sha === 'WIP' || e.target.closest('.pill.more')) return;
    const d = tab().data;
    const pills = refPills(d, row.dataset.sha).filter((p) => p.ref === 'local' || p.ref === 'remote');
    if (pills.length && !(pills[0].ref === 'local' && pills[0].name === d.branch)) checkoutRef(pills[0].ref, pills[0].name);
  });
  $('#graph-rows').addEventListener('contextmenu', (e) => {
    const pill = e.target.closest('.pill[data-ref]');
    if (pill) return refMenu(e, pill.dataset.ref, pill.dataset.name);
    const row = e.target.closest('.g-row');
    if (row && row.dataset.sha !== 'WIP') { select(row.dataset.sha); commitMenu(e, row.dataset.sha); }
    else if (row) contextMenu(e, [
      { label: 'Stash all changes', action: stash },
      { label: 'Discard all changes', danger: true, action: discardAll },
    ]);
  });

  // Sidebar
  $('#sidebar').addEventListener('input', (e) => {
    if (e.target.id !== 'side-filter') return;
    const pos = e.target.selectionStart;
    renderSidebar();
    const input = $('#side-filter');
    input.focus();
    input.setSelectionRange(pos, pos);
  });
  $('#sidebar').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      e.stopPropagation();
      return ({ branch: () => createBranch(), remote: addRemote, tag: () => createTag() })[add.dataset.add]();
    }
    const head = e.target.closest('.side-head');
    if (head) {
      const id = head.parentElement.dataset.section;
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      head.parentElement.classList.toggle('collapsed');
      return;
    }
    const item = e.target.closest('.side-item[data-sha]');
    if (item) scrollToSha(item.dataset.sha);
  });
  $('#sidebar').addEventListener('dblclick', (e) => {
    const item = e.target.closest('.side-item');
    if (!item) return;
    if (item.dataset.ref === 'local') checkoutLocal(item.dataset.name);
    if (item.dataset.ref === 'remote') checkoutRemote(item.dataset.name);
    if (item.dataset.ref === 'stash') stashAction('apply', item.dataset.name);
  });
  $('#sidebar').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.side-item');
    if (item) refMenu(e, item.dataset.ref, item.dataset.name);
  });

  // Right panel
  $('#panel').addEventListener('click', async (e) => {
    const d = tab().data;
    const fileAct = e.target.closest('[data-file-act]');
    const fileEl = e.target.closest('.file');
    if (fileAct && fileEl) {
      e.stopPropagation();
      const p = fileEl.dataset.path;
      const act = fileAct.dataset.fileAct;
      if (act === 'stage') return run('Staging…', () => stageFile(p));
      if (act === 'unstage') return run('Unstaging…', () => unstageFile(d.status.staged.find((f) => f.path === p)));
      if (act === 'resolve') return run('Marking resolved…', () => git(['add', '--', p]));
      if (act === 'ours' || act === 'theirs') return run(`Taking ${act}…`, async () => { await git(['checkout', `--${act}`, '--', p]); await git(['add', '--', p]); });
      if (act === 'discard') return discardFile(d.status.unstaged.find((f) => f.path === p));
    }
    if (fileEl) return openDiff(fileEl.dataset.kind, fileEl.dataset.path);
    if (e.target.id === 'stage-all') return run('Staging all…', () => git(['add', '-A']));
    if (e.target.id === 'unstage-all') return run('Unstaging all…', () => (d.headSha ? git(['reset', '-q']) : git(['rm', '--cached', '-r', '-q', '.'])));
    if (e.target.id === 'commit-btn') return doCommit();
    const goto = e.target.closest('[data-goto]');
    if (goto) return scrollToSha(goto.dataset.goto);
    const cp = e.target.closest('[data-copy]');
    if (cp) return copy(cp.dataset.copy);
    const op = e.target.closest('[data-op]');
    if (op) return resolveOp(op.dataset.op);
    const st = e.target.closest('[data-stash-act]');
    if (st) return stashAction(st.dataset.stashAct, d.stashes.find((s) => s.hash === tab().selected).ref);
  });
  $('#panel').addEventListener('input', (e) => { if (['commit-summary', 'commit-body'].includes(e.target.id)) syncDraft(); });
  $('#panel').addEventListener('change', (e) => {
    if (e.target.id !== 'amend') return;
    syncDraft();
    const t = tab();
    if (t.draft.amend && !t.draft.summary && t.data.headSha) {
      git(['log', '-1', '--format=%B']).then((msg) => {
        const [s, ...b] = msg.trim().split('\n');
        $('#commit-summary').value = s;
        $('#commit-body').value = b.join('\n').trim();
        syncDraft();
      });
    }
  });
  $('#panel').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doCommit();
  });
  $('#panel').addEventListener('contextmenu', (e) => {
    const f = e.target.closest('.file');
    if (!f) return;
    const full = `${repoPath()}/${f.dataset.path}`;
    contextMenu(e, [
      { label: 'Open file', action: () => window.mk.openPath(full) },
      { label: 'Copy file path', action: () => copy(f.dataset.path) },
      ...(f.dataset.kind === 'unstaged' ? [{ label: 'Ignore file (.gitignore)', action: () => ignoreFile(f.dataset.path) }] : []),
    ]);
  });

  // Diff
  $('#diff-close').onclick = closeDiff;
  $('#diff-mode').onclick = () => {
    state.diffMode = state.diffMode === 'split' ? 'inline' : 'split';
    window.mk.storeSet('diffMode', state.diffMode);
    renderDiff();
  };
  $('#diff-body').addEventListener('click', (e) => {
    const b = e.target.closest('.hunk-btn');
    if (b) applyHunk(+b.dataset.hunk);
    if (e.target.id === 'diff-force') { state.diffCtx.forceLarge = true; renderDiff(); }
  });

  // Search
  $('#search').addEventListener('input', (e) => {
    tab().search = e.target.value.trim();
    renderVisibleRows(true);
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = tab();
    const q = t.search.toLowerCase();
    const list = t.data.commits;
    const start = list.findIndex((c) => c.hash === t.selected);
    for (let k = 1; k <= list.length; k++) {
      const c = list[(start + k * (e.shiftKey ? -1 : 1) + list.length) % list.length];
      if (searchMatches(c, q)) return scrollToSha(c.hash);
    }
  });

  // Resizers
  $$('.resizer').forEach((r) => r.addEventListener('mousedown', (e) => {
    const target = $(`#${r.dataset.target}`);
    const startX = e.clientX;
    const startW = target.getBoundingClientRect().width;
    const sign = r.dataset.target === 'panel' ? -1 : 1;
    const move = (ev) => { target.style.width = `${Math.max(180, Math.min(700, startW + sign * (ev.clientX - startX)))}px`; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      window.mk.storeSet(`${r.dataset.target}Width`, target.style.width);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }));

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') { $('#ctx-menu').hidden = true; if (state.diffCtx) closeDiff(); }
    if (mod && e.key === 'r') { e.preventDefault(); if (repoPath()) run('Refreshing…', async () => {}); }
    if (mod && e.key === 'f' && repoPath()) { e.preventDefault(); $('#search').focus(); $('#search').select(); }
    if (mod && e.key === 't') { e.preventDefault(); newTab(); }
    if (mod && e.key === 'w') { e.preventDefault(); closeTab(state.active); }
    if (mod && e.key === 'o') { e.preventDefault(); openRepo(); }
    if (!mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && tab()?.data && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      const list = tab().data.commits;
      const i = list.findIndex((c) => c.hash === tab().selected);
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) scrollToSha(next.hash);
    }
  });

  window.mk.onFocus(() => { if (repoPath() && !state.busy) loadRepo(); });
  window.mk.onRepoChanged((repo) => { if (repo === repoPath() && !state.busy) loadRepo(); });
}

async function discardFile(f) {
  if (!(await confirmBox('Discard changes?', `Changes to <b>${esc(f.path)}</b> will be permanently lost.`, 'Discard'))) return;
  await run('Discarding…', () => (f.untracked ? git(['clean', '-f', '--', f.path]) : git(['checkout', '--', f.path])));
  if (state.diffCtx?.file.path === f.path) closeDiff();
}

async function discardAll() {
  if (!(await confirmBox('Discard all changes?', 'All uncommitted changes, including untracked files, will be permanently lost.', 'Discard all'))) return;
  await run('Discarding all…', async () => {
    if (tab().data.headSha) await git(['reset', '--hard', '-q']);
    await git(['clean', '-fd']);
  });
}

async function ignoreFile(path) {
  await run('Updating .gitignore…', () => window.mk.appendIgnore(repoPath(), `/${path}`));
}

function handleAction(action) {
  const map = {
    open: openRepo,
    clone: cloneRepo,
    init: initRepo,
    pull,
    push: () => push(),
    fetch: () => run('Fetching…', () => git(['fetch', '--all', '--prune'])).then((res) => res !== undefined && toast('Fetch complete', 'success')),
    branch: () => createBranch(),
    stash,
    pop: () => (tab().data.stashes.length ? stashAction('pop', 'stash@{0}') : toast('No stashes to pop', 'info')),
    undo: undoCommit,
    terminal: () => window.mk.openTerminal(repoPath()),
    finder: () => window.mk.openPath(repoPath()),
    profile: editProfile,
    refresh: () => run('Refreshing…', async () => {}),
  };
  map[action] && map[action]();
}

/* ---------------------------------------------------------------- boot */

(async function boot() {
  document.body.classList.add(`platform-${window.mk.platform}`);
  if (window.mk.platform !== 'darwin') $$('[placeholder*="⌘"], [title*="⌘"]').forEach((el) => {
    if (el.placeholder) el.placeholder = el.placeholder.replace('⌘', 'Ctrl+');
    if (el.title) el.title = el.title.replace('⌘', 'Ctrl+');
  });
  state.store = await window.mk.storeGet();
  state.diffMode = state.store.diffMode || 'inline';
  if (state.store.sidebarWidth) $('#sidebar').style.width = state.store.sidebarWidth;
  if (state.store.panelWidth) $('#panel').style.width = state.store.panelWidth;
  bindEvents();
  const saved = [];
  for (const p of state.store.tabs || []) if (await window.mk.exists(p)) saved.push(p);
  if (!saved.length) {
    state.tabs = [{ path: null }];
    return activateTab(0);
  }
  state.tabs = saved.map((p) => ({ path: p, data: null, selected: null, limit: COMMIT_LIMIT_STEP, search: '' }));
  saved.forEach((p) => window.mk.watch(p));
  await activateTab(Math.max(0, saved.indexOf(state.store.activeTab)));
})();
