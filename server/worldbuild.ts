/**
 * world.sqlite を作る事前ビルドの中心部 (doc/tile-conversion-plan.md の 6 章)。
 * 地物 (osmfeatures.ts) を z18 のマスに塗って (rasterize.ts)、ブロックにまとめる。
 */
import { fillRings, linePath, linePathThin, type Window } from "./rasterize";
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

// ---- 細線化 ----
/**
 * 2 値のマス (mask、1 辺 stride、1 = 線路) を、Guo–Hall 法で 1 マス幅の中心線にする。
 * 隣り合う線路 (複線) や、駅のホームの塗りつぶしのように幅のある所が、1 本の鎖にまとまる。
 * つながり (8 連結) と端点は保たれ、本当の分岐点だけが残る。端 (最も外側の 1 マス) は触らない。
 * Zhang–Suen 法は、幅 2 の斜めの帯を丸ごと消してしまうので使わない。
 * 各回の判定は、周囲 8 マスだけで決まる (走査の順序によらない) ので、タイルの境目でも結果が食い違いにくい。
 * mask をその場で書き換え、消したマスの数を返す。
 */
export function thinMask(mask: Uint8Array, stride: number): number {
  let list: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) list.push(i);
  const s = stride;
  let removed = 0, changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del: number[] = [];
      for (const i of list) {
        const x = i % s, y = (i / s) | 0;
        if (x < 1 || y < 1 || x >= s - 1 || y >= s - 1) continue;
        // 北から時計回り: P2=N P3=NE P4=E P5=SE P6=S P7=SW P8=W P9=NW
        const p2 = mask[i - s], p3 = mask[i - s + 1], p4 = mask[i + 1], p5 = mask[i + s + 1];
        const p6 = mask[i + s], p7 = mask[i + s - 1], p8 = mask[i - 1], p9 = mask[i - s - 1];
        const c = (!p2 && (p3 || p4) ? 1 : 0) + (!p4 && (p5 || p6) ? 1 : 0) + (!p6 && (p7 || p8) ? 1 : 0) + (!p8 && (p9 || p2) ? 1 : 0);
        if (c !== 1) continue;                                       // 消すと切れる、または端
        const n1 = (p9 | p2) + (p3 | p4) + (p5 | p6) + (p7 | p8);
        const n2 = (p2 | p3) + (p4 | p5) + (p6 | p7) + (p8 | p9);
        const n = Math.min(n1, n2);
        if (n < 2 || n > 3) continue;
        const blocked = step === 0 ? ((p2 | p3 | (p5 ? 0 : 1)) & p4) : ((p6 | p7 | (p9 ? 0 : 1)) & p8);
        if (blocked !== 0) continue;
        del.push(i);
      }
      for (const i of del) mask[i] = 0;
      if (del.length > 0) { changed = true; removed += del.length; list = list.filter((i) => mask[i]); }
    }
  }
  return removed;
}

// ---- 塗る ----
const GRASS = classId("natural", "grass"), SEA = classId("sea", "sea"), WATER = classId("natural", "water");
const BUILDING = classId("building", "yes"), URBAN = classId("landuse", "residential");
const RAIL = classId("railway", "rail");
// 駅の面。駅のマスは「1 つの駅に 1 マスだけ」(stationMarkers)、面のほかのマスは線路にする。
// 駅舎 (building=train_station)・railway=station・ホーム (railway=platform) の面は線路にする。
// public_transport=station は敷地全体を囲んで大きいので、線路にはせず、駅のマスの位置にだけ使う。
const ST_BUILDING = classId("building", "train_station"), ST_PT = classId("public_transport", "station");
const ST_RAILWAY = classId("railway", "station"), ST_PLATFORM = classId("railway", "platform");
const isStationArea = (id: number) => id === ST_BUILDING || id === ST_PT || id === ST_RAILWAY || id === ST_PLATFORM;
const stationToRail = (id: number) => id === ST_BUILDING || id === ST_RAILWAY || id === ST_PLATFORM;
/** 駅のマスの面種別 (osmsource が駅として出す) */
export const STATION_CELL = ST_BUILDING;

/** 面 (輪の列) の重心と面積。最大の輪だけを使う。 */
function ringCentroid(rings: Float64Array[]): { x: number; y: number; size: number } {
  let best = { x: 0, y: 0, size: -1 };
  for (const r of rings) {
    const n = r.length / 2;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, cross = r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1];
      a += cross; cx += (r[i * 2] + r[j * 2]) * cross; cy += (r[i * 2 + 1] + r[j * 2 + 1]) * cross;
    }
    let c: { x: number; y: number; size: number };
    if (Math.abs(a) < 1e-9) {
      let mx = 0, my = 0;
      for (let i = 0; i < n; i++) { mx += r[i * 2]; my += r[i * 2 + 1]; }
      c = { x: mx / n, y: my / n, size: 0 };
    } else {
      c = { x: cx / (3 * a), y: cy / (3 * a), size: Math.abs(a) / 2 };
    }
    if (c.size > best.size) best = c;
  }
  return best;
}

/**
 * 駅のマスの位置 (マス座標) を、1 つの駅に 1 つだけ決める。
 * 点だけで登録された駅 (nodes) は位置が正確なので先に採用し、駅の面 (駅舎・railway=station・public_transport=station)
 * の重心は、近く (radius マス以内) に駅がなければ使う (面の重心は敷地の端に寄ることがあるため)。
 * 面は大きい方から。点どうしの重複は nodeRadius マス以内で間引く。
 */
export function stationMarkers(store: FeatureStore, nodes: [number, number][] = [], radius = 40,
  nodeRadius = 25): [number, number][] {
  const kept: { x: number; y: number }[] = [];
  const near = (x: number, y: number, r: number) => kept.some((k) => Math.hypot(k.x - x, k.y - y) < r);
  for (const [x, y] of nodes) {
    if (!near(x, y, nodeRadius)) kept.push({ x, y });
  }
  const cand: { x: number; y: number; size: number }[] = [];
  for (const i of store.areas()) {
    const id = store.area.a[i];
    if (id !== ST_BUILDING && id !== ST_PT && id !== ST_RAILWAY) continue;
    const c = ringCentroid(store.partsOf(i));
    if (c.size >= 0) cand.push(c);
  }
  cand.sort((a, b) => b.size - a.size);
  for (const c of cand) {
    if (!near(c.x, c.y, radius)) kept.push(c);
  }
  return kept.map((k) => [Math.floor(k.x), Math.floor(k.y)]);
}
/** 建物からこのマス数以内の「何もない陸」は草ではなく市街地にする (OSM は建物の隙間や庭を塗っていないため) */
export const URBAN_RADIUS = 3;
/** 作業台の余白 (マス)。市街地の判定 (URBAN_RADIUS) と、線路の細線化がタイルの境目で途切れないようにする */
export const PAINT_MARGIN = 8;
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
  readonly w: number;            // 領域の 1 辺 (マス)
  readonly stride: number;       // 余白つきの 1 辺。余白は市街地の判定がタイルの境目で途切れないようにする
  readonly cells: Uint8Array;
  private win: Window = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(readonly n: number, readonly margin = PAINT_MARGIN) {
    this.w = n * BLOCK_SIZE;
    this.stride = this.w + 2 * margin;
    this.cells = new Uint8Array(this.stride * this.stride * 4);
  }

  /** areas / lines は store.areas() / store.lines() (rank の昇順の番号)。 */
  paint(bx0: number, by0: number, land: Land[], store: FeatureStore, areas: Uint32Array, lines: Uint32Array,
    stations: [number, number][] = []): void {
    const { w, cells, margin, stride } = this;
    cells.fill(0);
    const ox = bx0 * BLOCK_SIZE - margin, oy = by0 * BLOCK_SIZE - margin;       // 余白の左上
    const win = this.win = { x0: ox, y0: oy, x1: ox + stride, y1: oy + stride };
    const at = (x: number, y: number) => ((y - oy) * stride + (x - ox)) * 4;
    void w;

    for (const l of land) {
      if (overlaps(l, win)) {
        fillRings(l.parts, win, (y, xa, xb) => { for (let x = xa; x < xb; x++) cells[at(x, y) + 3] |= LAND; });
      }
    }
    for (const i of areas) {
      if (!store.overlaps(i, win)) continue;
      const id = store.area.a[i];
      if (isStationArea(id)) {
        // 駅の面は面としては塗らず、線路にする (駅のマスは下で 1 つだけ置く)
        if (stationToRail(id)) {
          fillRings(store.partsOf(i), win, (y, xa, xb) => {
            for (let x = xa; x < xb; x++) { const o = at(x, y) + 2; if (cells[o] === 0) cells[o] = RAIL; }
          });
        }
        continue;
      }
      fillRings(store.partsOf(i), win, (y, xa, xb) => { for (let x = xa; x < xb; x++) cells[at(x, y)] = id; });
    }
    for (const i of lines) {
      if (!store.overlaps(i, win)) continue;
      const road = store.road.a[i], rail = store.rail.a[i], fl = store.flags.a[i];
      const b3 = (fl & FL_HWY ? B3_HWY : 0) | (fl & FL_BRIDGE ? B3_BRIDGE : 0) | (fl & FL_CLIFF ? B3_CLIFF : 0);
      for (const p of store.partsOf(i)) {
        const plot = (x: number, y: number) => {
          const o = at(x, y);
          if (fl & FL_RIVER && (cells[o] === 0 || rankOf(cells[o]) < waterRank)) cells[o] = WATER;
          if (road) cells[o + 1] = road;
          if (rail) cells[o + 2] = rail;
          cells[o + 3] |= b3;
        };
        // 線路は 1 マスに 1 つの細い線 (8 連結) で塗る。斜めの線路が階段状にならず、斜めのタイルでつなげられる
        if (rail) linePathThin(p, win, plot); else linePath(p, win, plot);
      }
    }
    for (const [sx, sy] of stations) {                // 駅のマス (1 つの駅に 1 つ)
      if (sx >= win.x0 && sx < win.x1 && sy >= win.y0 && sy < win.y1) cells[at(sx, sy)] = STATION_CELL;
    }
    this.thinRails();
    this.urbanize();
  }

  /** 線路のマスを 1 マス幅の中心線にする (複線やホームの塗りつぶしを 1 本の鎖にまとめる)。 */
  private thinRails(): void {
    const { stride: s, cells } = this;
    const mask = new Uint8Array(s * s);
    for (let i = 0; i < mask.length; i++) mask[i] = cells[i * 4 + 2] !== 0 ? 1 : 0;
    thinMask(mask, s);
    for (let i = 0; i < mask.length; i++) if (!mask[i]) cells[i * 4 + 2] = 0;
  }

  /** 建物から URBAN_RADIUS マス以内で、面が何も塗られていない陸のマスを市街地にする。 */
  private urbanize(): void {
    const { stride: s, cells } = this;
    const r = URBAN_RADIUS;
    const n = s * s;
    const near = new Uint8Array(n);                // 横方向に r マス以内に建物がある
    for (let y = 0; y < s; y++) {
      let cnt = 0;
      for (let x = 0; x < Math.min(r, s); x++) if (cells[(y * s + x) * 4] === BUILDING) cnt++;
      for (let x = 0; x < s; x++) {
        const add = x + r, del = x - r - 1;
        if (add < s && cells[(y * s + add) * 4] === BUILDING) cnt++;
        if (del >= 0 && cells[(y * s + del) * 4] === BUILDING) cnt--;
        near[y * s + x] = cnt > 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < s; x++) {
      let cnt = 0;
      for (let y = 0; y < Math.min(r, s); y++) cnt += near[y * s + x];
      for (let y = 0; y < s; y++) {                // 縦方向にも r マス以内 (= 正方形 (2r+1) の範囲)
        const add = y + r, del = y - r - 1;
        if (add < s) cnt += near[add * s + x];
        if (del >= 0) cnt -= near[del * s + x];
        const o = (y * s + x) * 4;
        if (cnt > 0 && cells[o] === 0 && cells[o + 3] & LAND) cells[o] = URBAN;
      }
    }
  }

  /**
   * ブロック (i, j) (領域内の位置) を 4 バイトのマスにまとめる。何もない所は陸なら草原 (建物の近くは市街地)、海なら海。
   * 海だけのブロックは null (= 行を作らない)。slope は 256x256 の傾斜の段階。
   */
  block(i: number, j: number, slope?: Uint8Array | null): Uint8Array | null {
    const out = new Uint8Array(CELLS * 4);
    let allSea = true;
    for (let ly = 0; ly < BLOCK_SIZE; ly++) {
      const m = this.margin;
      const src = ((j * BLOCK_SIZE + ly + m) * this.stride + i * BLOCK_SIZE + m) * 4, dst = ly * BLOCK_SIZE * 4;
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
