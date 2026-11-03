/**
 * ベクターをマスに塗る。座標は z18 のマス座標 (小数)。マス (x, y) は [x, x+1) x [y, y+1) の正方形。
 *   面   : マスの中心が内側にあれば塗る (リングは全部まとめて偶奇で判定するので、穴もそのまま扱える)
 *   線   : 線が少しでも通ったマスを塗る (上下左右の隣へ 1 マスずつ進むので 4 連結になる)
 * 塗る範囲は窓 [wx0, wx1) x [wy0, wy1) に切り取る。
 */
export interface Window { x0: number; y0: number; x1: number; y1: number }

/** 1 行ぶんの塗り: 行 y のマス xa..xb-1。 */
export type Span = (y: number, xa: number, xb: number) => void;

export function fillRings(rings: Float64Array[], win: Window, span: Span): void {
  // 水平でない辺を集めて、上端の行で並べる
  const ey0: number[] = [], ey1: number[] = [], ex0: number[] = [], slope: number[] = [];
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[i * 2], ay = r[i * 2 + 1], bx = r[j * 2], by = r[j * 2 + 1];
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      // 中心 y+0.5 が lo <= yc < hi となる行
      const ya = Math.ceil(lo - 0.5), yb = Math.ceil(hi - 0.5);       // [ya, yb)
      if (yb <= win.y0 || ya >= win.y1 || ya >= yb) continue;
      ey0.push(ya); ey1.push(yb);
      ex0.push(ax + ((ya + 0.5 - ay) * (bx - ax)) / (by - ay));        // 行 ya の中心での x
      slope.push((bx - ax) / (by - ay));
    }
  }
  const order = ey0.map((_, i) => i).sort((a, b) => ey0[a] - ey0[b]);
  if (order.length === 0) return;
  let next = 0, active: number[] = [];
  const xs: number[] = [];
  for (let y = Math.max(ey0[order[0]], win.y0); y < win.y1; y++) {
    while (next < order.length && ey0[order[next]] <= y) active.push(order[next++]);
    active = active.filter((e) => ey1[e] > y);
    if (active.length === 0) {
      if (next >= order.length) break;
      y = Math.max(y, ey0[order[next]]) - 1;
      continue;
    }
    xs.length = 0;
    for (const e of active) xs.push(ex0[e] + (y - ey0[e]) * slope[e]);
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(Math.ceil(xs[k] - 0.5), win.x0), xb = Math.min(Math.ceil(xs[k + 1] - 0.5), win.x1);
      if (xa < xb) span(y, xa, xb);
    }
  }
}

export type Plot = (x: number, y: number) => void;

/** 線分が触れるマスを順に plot する (Amanatides-Woo)。 */
export function lineCells(ax: number, ay: number, bx: number, by: number, win: Window, plot: Plot): void {
  // 窓の外を延々と歩かないよう、窓 (1 マス広げる) で切る
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!(clip(-dx, ax - (win.x0 - 1)) && clip(dx, win.x1 + 1 - ax)
    && clip(-dy, ay - (win.y0 - 1)) && clip(dy, win.y1 + 1 - ay))) {
    return;
  }
  const sx = ax + dx * t0, sy = ay + dy * t0, tx = ax + dx * t1, ty = ay + dy * t1;
  let cx = Math.floor(sx), cy = Math.floor(sy);
  const ex = Math.floor(tx), ey = Math.floor(ty);
  const ddx = tx - sx, ddy = ty - sy;
  const stepX = ddx > 0 ? 1 : -1, stepY = ddy > 0 ? 1 : -1;
  const dX = ddx !== 0 ? Math.abs(1 / ddx) : Infinity, dY = ddy !== 0 ? Math.abs(1 / ddy) : Infinity;
  let mX = ddx > 0 ? (cx + 1 - sx) / ddx : ddx < 0 ? (sx - cx) / -ddx : Infinity;
  let mY = ddy > 0 ? (cy + 1 - sy) / ddy : ddy < 0 ? (sy - cy) / -ddy : Infinity;
  let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
  for (;;) {
    if (cx >= win.x0 && cx < win.x1 && cy >= win.y0 && cy < win.y1) plot(cx, cy);
    if ((cx === ex && cy === ey) || guard-- <= 0) break;
    if (mX < mY) { cx += stepX; mX += dX; } else { cy += stepY; mY += dY; }
  }
}

export function linePath(path: Float64Array, win: Window, plot: Plot): void {
  for (let i = 0; i + 3 < path.length; i += 2) {
    lineCells(path[i], path[i + 1], path[i + 2], path[i + 3], win, plot);
  }
}
