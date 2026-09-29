// Parsing of conflict markers in a working-tree file, and rebuilding it from per-conflict choices.
const Merge = (() => {
  // A marker is 7 marker chars followed by a space or the end of the line.
  const marker = (line, ch) => {
    const body = line.replace(/\r?\n$/, '');
    return body.startsWith(ch.repeat(7)) && (body.length === 7 || body[7] === ' ');
  };
  const label = (line) => line.replace(/\r?\n$/, '').slice(8).trim();

  // Splits text into [{ type: 'common', lines }, { type: 'conflict', ours, base, theirs, oursLabel, theirsLabel, raw }].
  // Lines keep their own line endings so CRLF files round-trip unchanged.
  function parse(text) {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const segments = [];
    let common = [];
    let cur = null;
    let part = null;
    for (const line of lines) {
      if (!cur && marker(line, '<')) {
        if (common.length) segments.push({ type: 'common', lines: common });
        common = [];
        cur = { type: 'conflict', ours: [], base: [], theirs: [], oursLabel: label(line), theirsLabel: '', raw: [line] };
        part = 'ours';
        continue;
      }
      if (!cur) { common.push(line); continue; }
      cur.raw.push(line);
      if (part === 'ours' && marker(line, '|')) { part = 'base'; continue; }
      if ((part === 'ours' || part === 'base') && marker(line, '=')) { part = 'theirs'; continue; }
      if (part === 'theirs' && marker(line, '>')) {
        cur.theirsLabel = label(line);
        segments.push(cur);
        cur = null;
        continue;
      }
      cur[part].push(line);
    }
    // An unterminated conflict is not a conflict: keep its text as-is.
    if (cur) common.push(...cur.raw);
    if (common.length) segments.push({ type: 'common', lines: common });
    return segments;
  }

  // choices[i] = { ours, theirs, first } for the i-th conflict. A conflict with nothing
  // chosen keeps its original markers, so saving never silently drops unresolved text.
  function build(segments, choices) {
    let i = 0;
    let out = '';
    for (const seg of segments) {
      if (seg.type === 'common') { out += seg.lines.join(''); continue; }
      const c = choices[i++] || {};
      if (!c.ours && !c.theirs) { out += seg.raw.join(''); continue; }
      const order = c.first === 'theirs' ? ['theirs', 'ours'] : ['ours', 'theirs'];
      const blocks = order.filter((side) => c[side]).map((side) => seg[side]);
      blocks.forEach((b, k) => { out += (k < blocks.length - 1 ? fixEnding(b, seg) : b).join(''); });
    }
    return out;
  }

  // When both sides are kept, make sure the first block ends with a newline before the second.
  function fixEnding(lines, seg) {
    if (!lines.length || /\n$/.test(lines[lines.length - 1])) return lines;
    const eol = /\r\n$/.test(seg.raw[0]) ? '\r\n' : '\n';
    return [...lines.slice(0, -1), lines[lines.length - 1] + eol];
  }

  const hasMarkers = (text) => /^(<{7}|>{7})( |\r?$)/m.test(text);

  return { parse, build, hasMarkers };
})();
