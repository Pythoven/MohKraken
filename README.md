# 🐙 MohKraken

A GitKraken-style desktop Git client built with Electron. It drives your installed `git` CLI, so it behaves exactly like git does.

## Run

```bash
npm install
npm start          # launch the app
npm run install-app  # package and install to /Applications/MohKraken.app
```

## Features

- **Repo tabs**: open several repos at once; tabs and recent repos are remembered. Open, clone, or init from the welcome screen.
- **Commit graph**: colored lanes, merge curves, author avatars, branch/tag pills (local + remote twins merged into one pill), a `// WIP` node, and a virtualized list that handles thousands of commits.
- **Sidebar**: local branches (ahead/behind counts), remotes, stashes, tags, plus a filter. Click to jump to a ref, double-click to checkout, right-click for actions.
- **Staging**: stage or unstage files, or all changes at once; discard; **stage/unstage individual hunks**; add files to `.gitignore`.
- **Commit**: summary with a 72-char counter, description, amend (pre-fills the previous message), ⌘↵ to commit.
- **Diffs**: inline or split view for working changes, staged changes and any commit.
- **Toolbar**: Undo last commit, Pull, Push (sets upstream; offers pull or force-with-lease when rejected), Fetch, Branch, Stash, Pop, Terminal, Finder, Git identity.
- **Context menus**: checkout, merge, rebase, cherry-pick, revert, reset (soft/mixed/hard), create branch/tag, rename/delete branches, delete remote branches, push tags, apply/pop/drop stashes, copy SHA.
- **Conflicts**: a banner for merge/rebase/cherry-pick/revert with Abort / Continue / Skip; per-file Ours / Theirs / Mark resolved.
- **Live refresh** when files change on disk or the window gets focus.

## Shortcuts

| Key | Action |
| --- | --- |
| ⌘O | Open repo |
| ⌘T / ⌘W | New / close tab |
| ⌘F | Search commits (Enter = next match, ⇧Enter = previous) |
| ⌘R | Refresh |
| ↑ / ↓ | Move through commits |
| ⌘↵ | Commit |
| Esc | Close diff |
