// Commit graph lane layout and per-row SVG rendering.
const Graph = (() => {
  const COLORS = [
    '#15a0bf', '#0669f7', '#8e00c2', '#c517b6', '#d90171', '#cd0101',
    '#f25d2e', '#f2ca33', '#7bd938', '#2ece9d', '#48a9e6', '#b86bff',
  ];
  const LANE_W = 16;
  const ROW_H = 30;

  // commits: [{ hash, parents: [] }] in topo order (children before parents).
  // Returns rows: [{ lane, color, before: [hash|null], after: [hash|null], parentLanes: [] }]
  function layout(commits) {
    let lanes = [];      // lanes[i] = hash expected in that lane
    let laneColor = [];  // color index for each lane
    let nextColor = 0;
    const rows = [];

    const freeSlot = () => {
      const i = lanes.indexOf(null);
      return i === -1 ? lanes.length : i;
    };

    for (const c of commits) {
      const before = lanes.slice();
      const beforeColors = laneColor.slice();

      let lane = lanes.indexOf(c.hash);
      if (lane === -1) {
        lane = freeSlot();
        laneColor[lane] = nextColor++ % COLORS.length;
      }
      const color = laneColor[lane];

      // All lanes that pointed at this commit converge into its node.
      const merging = [];
      lanes.forEach((h, i) => { if (h === c.hash) { merging.push(i); lanes[i] = null; } });

      const parentLanes = [];
      c.parents.forEach((p, pi) => {
        const existing = lanes.indexOf(p);
        if (pi === 0 && existing === -1) {
          lanes[lane] = p;
          laneColor[lane] = color;
          parentLanes.push(lane);
        } else if (existing !== -1) {
          parentLanes.push(existing);
        } else {
          const slot = freeSlot();
          lanes[slot] = p;
          laneColor[slot] = nextColor++ % COLORS.length;
          parentLanes.push(slot);
        }
      });

      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

      rows.push({
        lane, color, merging, parentLanes,
        before, beforeColors,
        after: lanes.slice(), afterColors: laneColor.slice(),
        isMerge: c.parents.length > 1,
      });
    }
    return rows;
  }

  const x = (i) => i * LANE_W + LANE_W / 2 + 4;

  function curve(x1, y1, x2, y2) {
    if (x1 === x2) return `M${x1} ${y1} L${x2} ${y2}`;
    const my = (y1 + y2) / 2;
    return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
  }

  function rowSvg(row, width, opts = {}) {
    const mid = ROW_H / 2;
    const parts = [];
    const stroke = (d, ci, dashed) =>
      parts.push(`<path d="${d}" stroke="${COLORS[ci]}" stroke-width="2" fill="none"${dashed ? ' stroke-dasharray="3 3"' : ''}/>`);

    // Top half: lines entering the row.
    row.before.forEach((h, i) => {
      if (h == null) return;
      if (row.merging.includes(i)) stroke(curve(x(i), 0, x(row.lane), mid), row.beforeColors[i]);
      else stroke(`M${x(i)} 0 L${x(i)} ${mid}`, row.beforeColors[i]);
    });
    // Bottom half: lines leaving the row.
    row.after.forEach((h, i) => {
      if (h == null) return;
      const passThrough = row.before[i] === h;
      if (passThrough || !row.parentLanes.includes(i)) stroke(`M${x(i)} ${mid} L${x(i)} ${ROW_H}`, row.afterColors[i]);
      if (row.parentLanes.includes(i) && i !== row.lane) stroke(curve(x(row.lane), mid, x(i), ROW_H), row.afterColors[i]);
      else if (row.parentLanes.includes(i) && !passThrough) stroke(`M${x(i)} ${mid} L${x(i)} ${ROW_H}`, row.afterColors[i]);
    });

    const cx = x(row.lane);
    const col = COLORS[row.color];
    if (opts.wip) {
      parts.push(`<circle cx="${cx}" cy="${mid}" r="7" fill="#1b1e27" stroke="${col}" stroke-width="2" stroke-dasharray="3 2"/>`);
    } else if (row.isMerge) {
      parts.push(`<circle cx="${cx}" cy="${mid}" r="5" fill="${col}"/>`);
    } else {
      parts.push(`<circle cx="${cx}" cy="${mid}" r="8" fill="${col}"/>`);
      if (opts.initials) {
        parts.push(`<text x="${cx}" y="${mid + 3.5}" text-anchor="middle" font-size="8.5" font-weight="700" fill="#fff">${opts.initials}</text>`);
      }
      if (opts.head) parts.push(`<circle cx="${cx}" cy="${mid}" r="10.5" fill="none" stroke="#fff" stroke-width="1.5"/>`);
    }
    return `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}">${parts.join('')}</svg>`;
  }

  const widthFor = (rows) => {
    let max = 1;
    for (const r of rows) max = Math.max(max, r.before.length, r.after.length, r.lane + 1);
    return Math.min(max, 24) * LANE_W + 8;
  };

  return { layout, rowSvg, widthFor, COLORS, ROW_H };
})();
