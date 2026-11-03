/**
 * OSM の海岸線 (natural=coastline) から陸の多角形を作る。
 * 海岸線のウェイは「進行方向の左が陸」に向きがそろっている。範囲 (窓) で切った海岸線の端は窓の枠の上に
 * あるので、枠を反時計回り (陸が左) にたどって次の海岸線の始点につなぐと、陸の多角形が閉じる。
 * 座標は z18 のマス座標 (y は南が大きい)。
 */
import type { Window } from "./rasterize";

/** ノード ID 列のウェイを、向きを変えずに端点でつないで鎖にする。閉じた鎖は先頭と末尾が同じ ID。 */
export function assembleChains(ways: number[][]): number[][] {
  const byFirst = new Map<number, number[]>();
  const lastIds = new Set<number>();
  for (const w of ways) {
    if (w.length < 2) continue;
    byFirst.set(w[0], w);
    lastIds.add(w[w.length - 1]);
  }
  const used = new Set<number[]>();
  const out: number[][] = [];
  const follow = (start: number[]) => {
    let chain = start.slice();
    used.add(start);
    for (;;) {
      const next = byFirst.get(chain[chain.length - 1]);
      if (!next || used.has(next)) break;
      used.add(next);
      chain = chain.concat(next.slice(1));
    }
    out.push(chain);
  };
  for (const w of byFirst.values()) {
    if (!used.has(w) && !lastIds.has(w[0])) follow(w);           // 鎖の始まり
  }
  for (const w of byFirst.values()) {
    if (!used.has(w)) follow(w);                                  // 残りは輪
  }
  return out;
}

interface Piece { pts: number[]; startEdge: boolean; endEdge: boolean }

/** 折れ線を窓で切る。窓の中に入っている部分を、枠で切れた端かどうかの印つきで返す。 */
function clipChain(xy: Float64Array, win: Window): Piece[] {
  const pieces: Piece[] = [];
  let cur: Piece | null = null;
  const inside = (x: number, y: number) => x >= win.x0 && x <= win.x1 && y >= win.y0 && y <= win.y1;
  if (inside(xy[0], xy[1])) cur = { pts: [xy[0], xy[1]], startEdge: false, endEdge: false };
  for (let i = 0; i + 3 < xy.length; i += 2) {
    const ax = xy[i], ay = xy[i + 1], bx = xy[i + 2], by = xy[i + 3];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    const clip = (p: number, q: number) => {
      if (p === 0) { if (q < 0) ok = false; return; }
      const r = q / p;
      if (p < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; }
      else { if (r < t0) ok = false; else if (r < t1) t1 = r; }
    };
    clip(-dx, ax - win.x0); clip(dx, win.x1 - ax); clip(-dy, ay - win.y0); clip(dy, win.y1 - ay);
    if (!ok) {
      if (cur) { cur.endEdge = false; pieces.push(cur); cur = null; }
      continue;
    }
    if (!cur) cur = { pts: [ax + dx * t0, ay + dy * t0], startEdge: true, endEdge: false };
    else if (t0 > 0) {                                  // 外に出て戻ってきた (起こらないはずだが安全のため)
      pieces.push(cur);
      cur = { pts: [ax + dx * t0, ay + dy * t0], startEdge: true, endEdge: false };
    }
    cur.pts.push(ax + dx * t1, ay + dy * t1);
    if (t1 < 1) { cur.endEdge = true; pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/** 枠の上の位置を、反時計回りに増える長さで表す。起点は右上の角。 */
function perimeter(x: number, y: number, win: Window): number {
  const w = win.x1 - win.x0, h = win.y1 - win.y0;
  const eps = 1e-6;
  if (Math.abs(y - win.y0) < eps) return win.x1 - x;                 // 上の辺 (西へ)
  if (Math.abs(x - win.x0) < eps) return w + (y - win.y0);           // 左の辺 (南へ)
  if (Math.abs(y - win.y1) < eps) return w + h + (x - win.x0);       // 下の辺 (東へ)
  return 2 * w + h + (win.y1 - y);                                   // 右の辺 (北へ)
}

/** 枠の角 (反時計回りの順)。 */
function corners(win: Window): { s: number; p: [number, number] }[] {
  const w = win.x1 - win.x0, h = win.y1 - win.y0;
  return [
    { s: 0, p: [win.x1, win.y0] }, { s: w, p: [win.x0, win.y0] },
    { s: w + h, p: [win.x0, win.y1] }, { s: 2 * w + h, p: [win.x1, win.y1] },
  ];
}

export interface Coast {
  parts: Float64Array[];     // 陸の輪 (偶奇で塗る)
  open: number;              // 窓の中で端が宙に浮いている海岸線 (無視した数)
}

/**
 * 海岸線の鎖 (座標列) から窓の中の陸の輪を作る。
 * hasLandHint: 海岸線が窓にかからないとき、窓全体を陸とみなすか (陸の地物があるか)。
 */
export function landFromCoast(chains: Float64Array[], win: Window, hasLandHint: boolean): Coast {
  const rings: number[][] = [];
  const edgePieces: Piece[] = [];
  let open = 0, touched = false;
  const holes: number[][] = [];
  for (const xy of chains) {
    if (xy.length < 4) continue;
    const closed = xy[0] === xy[xy.length - 2] && xy[1] === xy[xy.length - 1];
    let pieces = clipChain(xy, win);
    if (pieces.length === 0) continue;
    touched = true;
    if (closed && pieces.length >= 2 && !pieces[0].startEdge && !pieces[pieces.length - 1].endEdge) {
      const last = pieces.pop()!;                       // 輪の継ぎ目が窓の中にあった
      pieces[0] = { pts: last.pts.concat(pieces[0].pts.slice(2)), startEdge: last.startEdge, endEdge: pieces[0].endEdge };
    }
    for (const p of pieces) {
      if (p.startEdge && p.endEdge) edgePieces.push(p);
      else if (closed && !p.startEdge && !p.endEdge) {
        let s = 0;
        for (let i = 0; i + 3 < p.pts.length; i += 2) s += p.pts[i] * p.pts[i + 3] - p.pts[i + 2] * p.pts[i + 1];
        if (s < 0) rings.push(p.pts); else holes.push(p.pts);   // y が下向きなので s<0 が陸を囲む輪
      } else open++;
    }
  }
  if (edgePieces.length > 0) {
    const per = 2 * ((win.x1 - win.x0) + (win.y1 - win.y0));
    const starts = edgePieces.map((p) => perimeter(p.pts[0], p.pts[1], win));
    const ends = edgePieces.map((p) => perimeter(p.pts[p.pts.length - 2], p.pts[p.pts.length - 1], win));
    const used = new Array<boolean>(edgePieces.length).fill(false);
    const cs = corners(win);
    for (let first = 0; first < edgePieces.length; first++) {
      if (used[first]) continue;
      const ring: number[] = [];
      let i = first;
      for (;;) {
        used[i] = true;
        ring.push(...edgePieces[i].pts);
        // 終点から反時計回りに、次の始点 (まだ使っていないもの、または最初の輪の始点) まで枠を歩く
        let best = -1, bestD = Infinity;
        for (let j = 0; j < edgePieces.length; j++) {
          if (used[j] && j !== first) continue;
          const d = (starts[j] - ends[i] + per) % per;
          if (d < bestD) { bestD = d; best = j; }
        }
        cs.map((c) => ({ d: (c.s - ends[i] + per) % per, p: c.p }))      // 通り道にある角を順に足す
          .filter((c) => c.d > 1e-9 && c.d < bestD)
          .sort((a, b) => a.d - b.d)
          .forEach((c) => ring.push(...c.p));
        if (best === first || best < 0) break;
        i = best;
      }
      rings.push(ring);
    }
    rings.push(...holes);                                // 陸の中の水の輪は穴になる
  } else if (holes.length > 0 || (!touched && hasLandHint)) {
    // 窓全体が陸 (水の輪は穴) / 海岸線がなく陸ばかり
    rings.push([win.x0, win.y0, win.x1, win.y0, win.x1, win.y1, win.x0, win.y1], ...holes);
  }
  return { parts: rings.map((r) => Float64Array.from(r)), open };
}
