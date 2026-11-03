/**
 * world.sqlite を作る事前ビルドの中心部 (doc/tile-conversion-plan.md の 6 章)。
 * 地物 (osmfeatures.ts) を z18 のマスに塗って (rasterize.ts)、ブロックにまとめる。
 */
import { fillRings, linePath, type Window } from "./rasterize";
import { FL_BRIDGE, FL_CLIFF, FL_HWY, FL_RIVER, type FeatureStore } from "./osmfeatures";
import {
  B3_BRIDGE, B3_CLIFF, B3_HWY, B3_SLOPE_SHIFT, BLOCK_SIZE, CELLS, CLASSES, classId,
} from "./worlddb";

// ---- 座標 (EPSG:3857) ----
export const MERC = 20037508.342789244;          // 世界の半幅 (m)
const EARTH_R = 6378137;
const BLOCKS = 1 << 14;                           // 1 辺のブロック数 (= z14 のタイル数)
export const BLOCK_M = (2 * MERC) / BLOCKS;       // 1 ブロックの辺 (m)
export const CELL_M = BLOCK_M / BLOCK_SIZE;       // z18 の 1 マスの辺 (3857 上の m)

export function lonLatToBlock(lon: number, lat: number): [number, number] {
  const x = Math.floor(((lon + 180) / 360) * BLOCKS);
  const s = Math.sin((lat * Math.PI) / 180);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * BLOCKS);
  return [Math.min(BLOCKS - 1, Math.max(0, x)), Math.min(BLOCKS - 1, Math.max(0, y))];
}

/** bbox (w, s, e, n 度) を覆うブロックの範囲 (両端を含む)。 */
export function blockRange(bbox: [number, number, number, number]) {
  const [bx0, by1] = lonLatToBlock(bbox[0], bbox[1]);
  const [bx1, by0] = lonLatToBlock(bbox[2], bbox[3]);
  return { bx0, by0, bx1, by1 };
}

// ---- 傾斜 ----
const SLOPE_DEG = [5, 10, 17, 25, 35, 45, 60];    // worlddb.ts の段階 0〜7 の境目

export function slopeLevel(deg: number): number {
  let l = 0;
  while (l < SLOPE_DEG.length && deg >= SLOPE_DEG[l]) l++;
  return l;
}

/**
 * 標高 (周囲 1 マスの余白つき (w+2)x(h+2)) から w x h の傾斜の段階を作る。
 * ymax は余白を除いた範囲の上端 (3857 の m)。緯度で 3857 の長さが伸びるので補正する。
 */
export function slopeLevels(elev: Float32Array, w: number, h: number, ymax: number): Uint8Array {
  const out = new Uint8Array(w * h), ew = w + 2;
  for (let y = 0; y < h; y++) {
    const my = ymax - (y + 0.5) * CELL_M;
    const g = CELL_M / Math.cosh(my / EARTH_R);            // 実距離 = 3857 の長さ x cos(緯度)
    for (let x = 0; x < w; x++) {
      const i = (y + 1) * ew + x + 1;
      const dx = (elev[i + 1] - elev[i - 1]) / (2 * g), dy = (elev[i + ew] - elev[i - ew]) / (2 * g);
      out[y * w + x] = slopeLevel((Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI);
    }
  }
  return out;
}

// ---- 塗る ----
const GRASS = classId("natural", "grass"), SEA = classId("sea", "sea"), WATER = classId("natural", "water");
const LAND = 64;                                  // 作業用: byte3 の bit6 = 陸地ポリゴンの内側
const waterRank = CLASSES[WATER - 1].rank;
const rankOf = (id: number) => CLASSES[id - 1]?.rank ?? 0;

export interface Land { parts: Float64Array[]; minx: number; miny: number; maxx: number; maxy: number }

const overlaps = (f: { minx: number; miny: number; maxx: number; maxy: number }, w: Window) =>
  f.maxx >= w.x0 && f.minx < w.x1 && f.maxy >= w.y0 && f.miny < w.y1;

/**
 * n x n ブロックの領域を塗る作業台。cells は領域全体を行優先で 1 マス 4 バイト。
 * areas / lines は rank の昇順に並べておく (後から塗ったものが勝つ)。
 */
export class Painter {
  readonly w: number;
  readonly cells: Uint8Array;
  private win: Window = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(readonly n: number) {
    this.w = n * BLOCK_SIZE;
    this.cells = new Uint8Array(this.w * this.w * 4);
  }

  /** areas / lines は store.areas() / store.lines() (rank の昇順の番号)。 */
  paint(bx0: number, by0: number, land: Land[], store: FeatureStore, areas: Uint32Array, lines: Uint32Array): void {
    const { w, cells } = this;
    cells.fill(0);
    const ox = bx0 * BLOCK_SIZE, oy = by0 * BLOCK_SIZE;
    const win = this.win = { x0: ox, y0: oy, x1: ox + w, y1: oy + w };
    const at = (x: number, y: number) => ((y - oy) * w + (x - ox)) * 4;

    for (const l of land) {
      if (overlaps(l, win)) {
        fillRings(l.parts, win, (y, xa, xb) => { for (let x = xa; x < xb; x++) cells[at(x, y) + 3] |= LAND; });
      }
    }
    for (const i of areas) {
      if (!store.overlaps(i, win)) continue;
      const id = store.area.a[i];
      fillRings(store.partsOf(i), win, (y, xa, xb) => { for (let x = xa; x < xb; x++) cells[at(x, y)] = id; });
    }
    for (const i of lines) {
      if (!store.overlaps(i, win)) continue;
      const road = store.road.a[i], rail = store.rail.a[i], fl = store.flags.a[i];
      const b3 = (fl & FL_HWY ? B3_HWY : 0) | (fl & FL_BRIDGE ? B3_BRIDGE : 0) | (fl & FL_CLIFF ? B3_CLIFF : 0);
      for (const p of store.partsOf(i)) {
        linePath(p, win, (x, y) => {
          const o = at(x, y);
          if (fl & FL_RIVER && (cells[o] === 0 || rankOf(cells[o]) < waterRank)) cells[o] = WATER;
          if (road) cells[o + 1] = road;
          if (rail) cells[o + 2] = rail;
          cells[o + 3] |= b3;
        });
      }
    }
  }

  /**
   * ブロック (i, j) (領域内の位置) を 4 バイトのマスにまとめる。何もない所は陸なら草原、海なら海。
   * 海だけのブロックは null (= 行を作らない)。slope は 256x256 の傾斜の段階。
   */
  block(i: number, j: number, slope?: Uint8Array | null): Uint8Array | null {
    const out = new Uint8Array(CELLS * 4);
    let allSea = true;
    for (let ly = 0; ly < BLOCK_SIZE; ly++) {
      const src = ((j * BLOCK_SIZE + ly) * this.w + i * BLOCK_SIZE) * 4, dst = ly * BLOCK_SIZE * 4;
      for (let lx = 0; lx < BLOCK_SIZE; lx++) {
        const s = src + lx * 4, d = dst + lx * 4;
        const b3 = this.cells[s + 3];
        let a = this.cells[s];
        if (a === 0) a = b3 & LAND ? GRASS : SEA;
        const sl = slope ? slope[ly * BLOCK_SIZE + lx] : 0;
        const flags = (b3 & ~LAND) | (sl << B3_SLOPE_SHIFT);
        out[d] = a; out[d + 1] = this.cells[s + 1]; out[d + 2] = this.cells[s + 2]; out[d + 3] = flags;
        if (a !== SEA || out[d + 1] || out[d + 2] || flags) allSea = false;
      }
    }
    return allSea ? null : out;
  }
}
