// Unified diff parsing and rendering (inline + split views).
const Diff = (() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Parses the output of `git diff` for a single file into { header, hunks, binary }.
  function parse(text) {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const header = [];
    const hunks = [];
    let hunk = null;
    let binary = false;
    let oldNo = 0;
    let newNo = 0;
    for (const line of lines) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (m) {
        hunk = { header: line, raw: [line], lines: [] };
        hunks.push(hunk);
        oldNo = +m[1];
        newNo = +m[2];
        continue;
      }
      if (!hunk) {
        if (/^Binary files/.test(line)) binary = true;
        header.push(line);
        continue;
      }
      hunk.raw.push(line);
      const t = line[0];
      if (t === '+') hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
      else if (t === '-') hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
      else if (t === '\\') hunk.lines.push({ type: 'meta', text: line });
      else hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    return { header, hunks, binary };
  }

  // A patch containing only one hunk, suitable for `git apply --cached`.
  function hunkPatch(parsed, index) {
    return [...parsed.header, ...parsed.hunks[index].raw].join('\n') + '\n';
  }

  function inline(parsed, hunkAction) {
    return parsed.hunks.map((h, hi) => {
      const rows = h.lines.map((l) => `
        <tr class="dl ${l.type}">
          <td class="ln">${l.oldNo ?? ''}</td><td class="ln">${l.newNo ?? ''}</td>
          <td class="sign">${l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
          <td class="code">${esc(l.text) || ' '}</td>
        </tr>`).join('');
      return hunkBlock(h, hi, hunkAction, `<table class="diff-table">${rows}</table>`);
    }).join('');
  }

  function split(parsed, hunkAction) {
    return parsed.hunks.map((h, hi) => {
      const rows = [];
      let dels = [];
      let adds = [];
      const flush = () => {
        const n = Math.max(dels.length, adds.length);
        for (let i = 0; i < n; i++) rows.push([dels[i], adds[i]]);
        dels = []; adds = [];
      };
      for (const l of h.lines) {
        if (l.type === 'del') dels.push(l);
        else if (l.type === 'add') adds.push(l);
        else { flush(); if (l.type === 'ctx') rows.push([l, l]); }
      }
      flush();
      const cell = (l, side) => l
        ? `<td class="ln">${side === 'old' ? l.oldNo : l.newNo}</td><td class="code ${l.type}">${esc(l.text) || ' '}</td>`
        : '<td class="ln empty"></td><td class="code empty"></td>';
      const html = rows.map(([a, b]) => `<tr class="dl">${cell(a, 'old')}${cell(b, 'new')}</tr>`).join('');
      return hunkBlock(h, hi, hunkAction, `<table class="diff-table split">${html}</table>`);
    }).join('');
  }

  function hunkBlock(h, hi, hunkAction, body) {
    const btn = hunkAction ? `<button class="btn tiny hunk-btn" data-hunk="${hi}">${hunkAction}</button>` : '';
    return `<div class="hunk"><div class="hunk-head"><code>${esc(h.header)}</code>${btn}</div>${body}</div>`;
  }

  function render(text, { mode = 'inline', hunkAction } = {}) {
    const parsed = parse(text);
    if (parsed.binary) return { parsed, html: '<div class="diff-empty">Binary file – no preview available</div>' };
    if (!parsed.hunks.length) return { parsed, html: '<div class="diff-empty">No textual changes</div>' };
    const html = mode === 'split' ? split(parsed, hunkAction) : inline(parsed, hunkAction);
    return { parsed, html };
  }

  return { parse, render, hunkPatch, esc };
})();
