/**
 * 線路のタイル。マスは、隣 (8 方向) のうち線路のあるものを見て、「つながる 2 方向」の組み合わせで決まる。
 * 方向: 0=E 1=SE 2=S 3=SW 4=W 5=NW 6=N 7=NE。
 * 使う組み合わせは、角度の差が 90° 以上のもの (差 2〜4) の 20 種: 直線 4 (横・縦・╲・╱)、45° の曲がり 8、90° の曲がり 8。
 * gfx/gen_chr.ts (絵) とサーバーが同じ並びを使う。
 */
import { N_RAIL, T_RAIL } from "./terrain";

export const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** 20 種の組み合わせ (a < b)。タイル番号 = T_RAIL + このリストでの位置。 */
export const RAIL_PAIRS: [number, number][] = [];
for (let a = 0; a < 8; a++) {
  for (let b = a + 1; b < 8; b++) {
    if (Math.min(b - a, 8 - (b - a)) >= 2) RAIL_PAIRS.push([a, b]);
  }
}
if (RAIL_PAIRS.length !== N_RAIL) throw new Error("RAIL_PAIRS の数が N_RAIL と違う");

/** 方向 a と b をつなぐ線路のタイル ID。 */
export function railTile(a: number, b: number): number {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const i = RAIL_PAIRS.findIndex(([x, y]) => x === lo && y === hi);
  if (i < 0) throw new Error(`線路の組み合わせがない: ${a} ${b}`);
  return T_RAIL + i;
}

const sep = (a: number, b: number) => Math.min(Math.abs(a - b), 8 - Math.abs(a - b));

/**
 * つながる方向 (線路のある隣の方向) から、通る 2 方向を選ぶ。
 * 0 個 → 横の直線。1 個 → その方向を通る直線。3 個以上 (分岐) → 角度の差が最も大きい (まっすぐな) 組み合わせ。
 * 鋭い折り返し (差 45°) は、片方を通る直線にする。
 */
export function railPair(conns: number[]): [number, number] {
  if (conns.length === 0) return [0, 4];
  if (conns.length === 1) return [conns[0], (conns[0] + 4) % 8];
  let best: [number, number] = [conns[0], conns[1]], bestSep = -1;
  for (let i = 0; i < conns.length; i++) {
    for (let j = i + 1; j < conns.length; j++) {
      const d = sep(conns[i], conns[j]);
      if (d > bestSep) { bestSep = d; best = [conns[i], conns[j]]; }
    }
  }
  return bestSep < 2 ? [best[0], (best[0] + 4) % 8] : best;
}

/**
 * 隣のマスの線路の有無 (has(dx, dy)) から、そのマスの線路のつながる方向を求める。
 * 斜めの隣は、挟む上下左右のどちらかにも線路があれば、それを経由するので捨てる (L 字の角を斜めに近道しない)。
 */
export function railConnections(has: (dx: number, dy: number) => boolean): number[] {
  const conns: number[] = [];
  for (let d = 0; d < 8; d++) {
    const [dx, dy] = DIRS[d];
    if (!has(dx, dy)) continue;
    if (dx !== 0 && dy !== 0 && (has(dx, 0) || has(0, dy))) continue;
    conns.push(d);
  }
  return conns;
}

/** 踏切の種類: 線路が横 (東西) 寄りなら "H"、縦 (南北) 寄りなら "V" (斜めだけの組み合わせは横)。 */
export function crossingFor(pair: [number, number]): "H" | "V" {
  const [a, b] = pair;
  if (a % 4 === 0 || b % 4 === 0) return "H";     // E (0) / W (4) を通る
  if (a % 4 === 2 || b % 4 === 2) return "V";     // S (2) / N (6) を通る
  return "H";
}
