/**
 * world.sqlite を作る事前ビルドの中心部 (doc/map-spec.md の 6 章)。
 * 地物 (osmfeatures.ts) を z18 のマスに塗って (rasterize.ts)、ブロックにまとめる。
 */
import { roadMin, railMin } from "./osmsource";
import { fillRings, linePath, linePathThin, type Window } from "./rasterize";
import { FIX, FL_CLIFF, FL_HWY, FL_PRIO_SHIFT, FL_RIVER, type FeatureStore } from "./osmfeatures";
import {
  B3_CLIFF, B3_HWY, B3_RAIL_UNDER, RAIL_NO_E, RAIL_NO_S, B3_ROAD_UNDER, B3_SLOPE_SHIFT, BLOCK_SIZE, CELLS, CLASSES, classId,
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

/**
 * 2 値のマス (mask、1 辺 stride、1 = 線) のうち、線に囲まれた小さな穴 (背景の 4 連結成分で、端に触れず、面積が maxArea 以下) を埋める。
 * 線の細線化の前に使うと、小さな輪 (駐車場の通路、小さなロータリー、並走する線の隙間) が 1 本の線にまとまる。
 * 埋めたマスの数を返す。
 */
export function fillSmallHoles(mask: Uint8Array, stride: number, maxArea: number): number {
  const s = stride, n = s * s, seen = new Uint8Array(n);
  let filled = 0;
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (mask[start] || seen[start]) continue;
    const comp: number[] = [];
    let touches = false;
    stack.push(start); seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % s, y = (i / s) | 0;
      if (x === 0 || y === 0 || x === s - 1 || y === s - 1) { touches = true; continue; }
      for (const j of [i - 1, i + 1, i - s, i + s]) if (!mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
    if (!touches && comp.length <= maxArea) { for (const i of comp) mask[i] = 1; filled += comp.length; }
  }
  return filled;
}

/**
 * 8 連結の線 (斜めにつながる所) を、4 連結 (上下左右だけでつながる) にする。斜めに隣り合う 2 マスの間に、角のマスを 1 つ足す
 * (斜めの線が、└┐ の階段になる)。端 (最も外側の 1 マス) は触らない。足したマスの数を返す。
 */
export function stairify(mask: Uint8Array, stride: number): number {
  const s = stride, add: number[] = [];
  for (let y = 1; y < s - 1; y++) {
    for (let x = 1; x < s - 1; x++) {
      const i = y * s + x;
      if (!mask[i]) continue;
      for (const dx of [1, -1]) {
        if (mask[i + s + dx] && !mask[i + dx] && !mask[i + s]) add.push(i + dx);
      }
    }
  }
  for (const i of add) mask[i] = 1;
  return add.length;
}

/**
 * 2 値のマスを、半径 r マス (円) だけ太らせる。近くに並走する線 (間が 2r マス以下) を、細線化の前につなげるために使う。
 * 新しい 2 値のマスを返す (元は変えない)。
 */
export function dilate(mask: Uint8Array, stride: number, r: number): Uint8Array {
  const s = stride, out = new Uint8Array(mask.length), r2 = r * r + r * 0.5;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % s, y = (i / s) | 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= s) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= s || dx * dx + dy * dy > r2) continue;
        out[yy * s + xx] = 1;
      }
    }
  }
  return out;
}

/** 道路・線路の細線化の前に埋める小さな穴の最大面積 (マス) */
export const MAX_LOOP_AREA = 6;
/**
 * 並走する線を 1 本にまとめる半径 (マス。細線化の前に、この半径で太らせる)。間が 2r マス以下の並走線がつながって 1 本の中心線になる。
 * 線路 (複線・操車場の本線の束): 2 (間が 4 マス = 約 31m 以下)。道路 (上下線の分離帯など): 1 (間が 2 マス以下)。
 */
export const MERGE_RADIUS = { road: 1, rail: 1 };
/** 立体交差で、上を通る線の周り (この半径のマス) にある、下の線のマスを消す。MERGE_RADIUS の 2 倍より大きくして (太らせた下の線の端が上の線に届かないように)、細線化で下の線がつながり直らないようにする。 */
export const CUT_RADIUS = { road: 0, rail: 0 };
/** 駅のマスを、この半径 (マス) 以内の最も近い線路のマスへ寄せる (駅は線路の上にある)。 */
export const STATION_SNAP_RADIUS = 12;
/** 駅の面から塗った線路のマスが、近くの線(路線)に加わる半径 (マス)。 */
export const ADOPT_RADIUS = 6;

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
// 空港。ターミナル (aeroway=terminal) の面のマスが空港のマス。空港の敷地 (aeroway=aerodrome) は広いので塗らない。
const ASPHALT = classId("aeroway", "apron");
const AP_TERMINAL = classId("aeroway", "terminal"), AP_AERODROME = classId("aeroway", "aerodrome");
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
/**
 * ターミナルの面がない空港の位置 (マス座標)。空港の敷地 (aeroway=aerodrome) の重心に 1 マス置く。
 * 敷地の中 (外接する四角) にターミナルの面が 1 つでもあれば、そのターミナルが空港のマスになるので、置かない。
 */
export function airportMarkers(store: FeatureStore): [number, number][] {
  const terminals: { x: number; y: number; i: number }[] = [];
  const sites: { x: number; y: number; i: number }[] = [];
  for (const i of store.areas()) {
    const id = store.area.a[i];
    if (id !== AP_TERMINAL && id !== AP_AERODROME) continue;
    const c = ringCentroid(store.partsOf(i));
    if (c.size < 0) continue;
    (id === AP_TERMINAL ? terminals : sites).push({ x: c.x, y: c.y, i });
  }
  const out: [number, number][] = [];
  for (const s of sites) {
    const inside = terminals.some((t) => t.x * FIX >= store.minx.a[s.i] && t.x * FIX <= store.maxx.a[s.i]
      && t.y * FIX >= store.miny.a[s.i] && t.y * FIX <= store.maxy.a[s.i]);
    if (!inside) out.push([Math.floor(s.x), Math.floor(s.y)]);
  }
  return out;
}
/** 建物からこのマス数以内の「何もない陸」は草ではなく市街地にする (OSM は建物の隙間や庭を塗っていないため) */
export const URBAN_RADIUS = 3;
/** 作業台の余白 (マス)。市街地の判定 (URBAN_RADIUS)、線の細線化、立体交差の切断、駅のマスを線路へ寄せる処理が、タイルの境目で食い違わないようにする */
export const PAINT_MARGIN = 16;
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
  private prio: Uint8Array[];        // 道路 (0) と線路 (1) の、各マスを塗った線の最も高い優先度 (立体交差)
  private noLink: Uint8Array;         // 線路のマスの、東 (RAIL_NO_E)・南 (RAIL_NO_S) の隣の線路とつながっていない印
  private areaRail: Uint8Array;       // 線路のマスのうち、駅の面から塗って、線に属さないもの
  private grp: Uint32Array[];         // 同、そのマスを塗った線のまとまり (道路 = 優先度、線路 = 路線。名前のない線路は優先度)。同じまとまりの並走だけ 1 本にする
  private win: Window = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(readonly n: number, readonly margin = PAINT_MARGIN) {
    this.w = n * BLOCK_SIZE;
    this.stride = this.w + 2 * margin;
    this.cells = new Uint8Array(this.stride * this.stride * 4);
    this.prio = [new Uint8Array(this.stride * this.stride), new Uint8Array(this.stride * this.stride)];
    this.areaRail = new Uint8Array(this.stride * this.stride);
    this.noLink = new Uint8Array(this.stride * this.stride);
    this.grp = [new Uint32Array(this.stride * this.stride), new Uint32Array(this.stride * this.stride)];
  }

  /** areas / lines は store.areas() / store.lines() (rank の昇順の番号)。 */
  paint(bx0: number, by0: number, land: Land[], store: FeatureStore, areas: Uint32Array, lines: Uint32Array,
    stations: [number, number][] = [], airports: [number, number][] = []): void {
    const { w, cells, margin, stride } = this;
    cells.fill(0);
    this.prio[0].fill(0); this.prio[1].fill(0); this.grp[0].fill(0); this.grp[1].fill(0); this.areaRail.fill(0);
    const ox = bx0 * BLOCK_SIZE - margin, oy = by0 * BLOCK_SIZE - margin;       // 余白の左上
    const win = this.win = { x0: ox, y0: oy, x1: ox + stride, y1: oy + stride };
    const at = (x: number, y: number) => ((y - oy) * stride + (x - ox)) * 4;
    void w;

    for (const l of land) {
      if (overlaps(l, win)) {
        fillRings(l.parts, win, (y, xa, xb) => { for (let x = xa; x < xb; x++) cells[at(x, y) + 3] |= LAND; });
      }
    }
    const inAero = new Uint8Array(stride * stride);     // 空港の敷地の内側
    for (const i of areas) {                           // 空港の敷地 (aeroway=aerodrome): 全体をアスファルトで塗る。ほかの面 (建物・水・森など) が上に塗られる
      if (store.area.a[i] !== AP_AERODROME || !store.overlaps(i, win)) continue;
      fillRings(store.partsOf(i), win, (y, xa, xb) => { for (let x = xa; x < xb; x++) { const o = at(x, y); inAero[(y - oy) * stride + (x - ox)] = 1; if (cells[o] === 0) cells[o] = ASPHALT; } });
    }
    const foot = new Uint8Array(stride * stride);       // 駅舎・駅の面 (railway=station) の内側
    for (const i of areas) {
      if (!store.overlaps(i, win)) continue;
      const id = store.area.a[i];
      if (id === AP_AERODROME) continue;               // 敷地は塗らない (広い)
      if (isStationArea(id)) {
        if (id === ST_BUILDING || id === ST_RAILWAY) {
          fillRings(store.partsOf(i), win, (y, xa, xb) => { for (let x = xa; x < xb; x++) foot[(y - oy) * stride + (x - ox)] = 1; });
        }
        // 駅の面は面としては塗らず、線路にする (駅のマスは下で 1 つだけ置く)
        if (stationToRail(id)) {
          fillRings(store.partsOf(i), win, (y, xa, xb) => {
            for (let x = xa; x < xb; x++) { const o = at(x, y) + 2; if (cells[o] === 0) { cells[o] = RAIL; this.areaRail[o >> 2] = 1; } }
          });
        }
        continue;
      }
      fillRings(store.partsOf(i), win, (y, xa, xb) => { for (let x = xa; x < xb; x++) cells[at(x, y)] = id; });
    }
    {                                                  // 敷地の中の草・農地・森・砂などは、アスファルトにする (滑走路の間の草地が緑に見えないように)
      const asphaltRank = rankOf(ASPHALT);
      for (let c = 0; c < inAero.length; c++) if (inAero[c] && rankOf(cells[c * 4]) < asphaltRank) cells[c * 4] = ASPHALT;
    }
    for (const i of lines) {
      if (!store.overlaps(i, win)) continue;
      const road = store.road.a[i], rail = store.rail.a[i], fl = store.flags.a[i];
      const b3 = (fl & FL_HWY ? B3_HWY : 0) | (fl & FL_CLIFF ? B3_CLIFF : 0);
      const pr = fl >> FL_PRIO_SHIFT, gr = store.grp.a[i], wide = store.wide.a[i];
      if (wide) {                                      // 空港の滑走路・誘導路など: 幅をつけてアスファルトで塗る (建物・水・ターミナルは上書きしない)
        const rad = Math.round(wide / 2 / (CELL_M * 0.82)), r2 = rad * rad + rad, asphaltRank = rankOf(ASPHALT);
        for (const p of store.partsOf(i)) {
          linePath(p, win, (x, y) => {
            for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
              const px = x + dx, py = y + dy;
              if (px < win.x0 || px >= win.x1 || py < win.y0 || py >= win.y1 || dx * dx + dy * dy > r2) continue;
              const o = at(px, py);
              if (cells[o] === 0 || rankOf(cells[o]) < asphaltRank) cells[o] = ASPHALT;
            }
          });
        }
        continue;
      }
      for (const p of store.partsOf(i)) {
        const plot = (x: number, y: number) => {
          const o = at(x, y), c = o >> 2;
          if (road && pr >= this.prio[0][c]) { this.prio[0][c] = pr; this.grp[0][c] = pr; }
          if (rail) this.areaRail[c] = 0;
          if (rail && pr >= this.prio[1][c]) { this.prio[1][c] = pr; this.grp[1][c] = gr ? gr << 4 : pr; }
          if (fl & FL_RIVER && (cells[o] === 0 || rankOf(cells[o]) < waterRank)) cells[o] = WATER;
          if (road) cells[o + 1] = road;
          if (rail) cells[o + 2] = rail;
          cells[o + 3] |= b3;
        };
        // 道路・線路は 1 マスに 1 つの細い線 (8 連結) で塗り、後で 1 マス幅の中心線にして 4 連結に直す (thinLines)
        if (road || rail) linePathThin(p, win, plot); else linePath(p, win, plot);
      }
    }
    this.thinLines();
    for (let c = 0; c < inAero.length; c++) if (inAero[c] && cells[c * 4] === ASPHALT) cells[c * 4 + 1] = 0;      // 空港の敷地の中の道路は、アスファルトのままにする (灰色の線を描かない)
    // 駅舎の分だけ駅のマスを増やす: 駅舎のすぐ近く (1 マス以内) の線路のマスを、駅のマスにする (東京駅のような大きな駅は複数マス)
    const near = dilate(foot, stride, 1);
    for (let i = 0; i < near.length; i++) if (near[i] && cells[i * 4 + 2]) cells[i * 4] = STATION_CELL;
    for (const [sx, sy] of stations) {                // 駅のマス (1 つの駅に 1 つ)。線路の上に置く
      if (sx < win.x0 || sx >= win.x1 || sy < win.y0 || sy >= win.y1) continue;
      const [tx, ty] = this.snapToRail(sx - ox, sy - oy);
      cells[(ty * stride + tx) * 4] = STATION_CELL;
    }
    for (const [ax, ay] of airports) {                // ターミナルがない空港: 敷地の重心に 1 マス
      if (ax < win.x0 || ax >= win.x1 || ay < win.y0 || ay >= win.y1) continue;
      cells[((ay - oy) * stride + (ax - ox)) * 4] = AP_TERMINAL;
    }
    this.urbanize();
  }

  /**
   * z17 の道路・線路だけを塗る (面・駅・市街地は塗らない)。窓は z17 のマス座標 (bx0, by0 は z17 のブロック)。
   * 地物の座標 (z18 のマス) を半分にして、同じ手順 (まとめる・細線化・4 連結化・立体交差) で z17 の格子の上に作る。
   * z17 で出さない細い道・線路は、細線化の前に除く (細線化のあとに除くと、つなぎ目の短い線が残る)。
   */
  paintLines17(bx0: number, by0: number, store: FeatureStore, lines: Uint32Array): void {
    const { cells, margin, stride } = this;
    cells.fill(0);
    this.prio[0].fill(0); this.prio[1].fill(0); this.grp[0].fill(0); this.grp[1].fill(0); this.areaRail.fill(0);
    const ox = bx0 * BLOCK_SIZE - margin, oy = by0 * BLOCK_SIZE - margin;
    const win = this.win = { x0: ox, y0: oy, x1: ox + stride, y1: oy + stride };
    const w2 = { x0: ox * 2, y0: oy * 2, x1: (ox + stride) * 2, y1: (oy + stride) * 2 };
    const at = (x: number, y: number) => ((y - oy) * stride + (x - ox)) * 4;
    const rmin = roadMin(17), tmin = railMin(17);
    for (const i of lines) {
      if (!store.overlaps(i, w2)) continue;
      const road = store.road.a[i], rail = store.rail.a[i], fl = store.flags.a[i];
      const hwy = (fl & FL_HWY) !== 0;
      const useRoad = road !== 0 && rankOf(road) >= rmin, useRail = rail !== 0 && rankOf(rail) >= tmin;
      if (!hwy && !useRoad && !useRail) continue;
      const pr = fl >> FL_PRIO_SHIFT, gr = store.grp.a[i];
      for (const p0 of store.partsOf(i)) {
        const p = p0.map((v) => v / 2);
        const plot = (x: number, y: number) => {
          const o = at(x, y), c = o >> 2;
          if (useRoad && pr >= this.prio[0][c]) { this.prio[0][c] = pr; this.grp[0][c] = pr; }
          if (useRail) { this.areaRail[c] = 0; if (pr >= this.prio[1][c]) { this.prio[1][c] = pr; this.grp[1][c] = gr ? gr << 4 : pr; } }
          if (useRoad) cells[o + 1] = road;
          if (useRail) cells[o + 2] = rail;
          if (hwy) cells[o + 3] |= B3_HWY;
        };
        linePathThin(p, win, plot);
      }
    }
    this.thinLines();
  }

  /** z17 のブロック (i, j) の線: 256*256*3 バイト (道路、線路、byte3 のうち高速道路・隠れた道路・隠れた線路)。 */
  line17Block(i: number, j: number): Uint8Array {
    const out = new Uint8Array(CELLS * 3), m = this.margin;
    for (let ly = 0; ly < BLOCK_SIZE; ly++) {
      for (let lx = 0; lx < BLOCK_SIZE; lx++) {
        const s = ((j * BLOCK_SIZE + ly + m) * this.stride + i * BLOCK_SIZE + lx + m) * 4, d = (ly * BLOCK_SIZE + lx) * 3;
        out[d] = this.cells[s + 1]; out[d + 1] = this.cells[s + 2] | this.noLink[s >> 2];
        out[d + 2] = this.cells[s + 3] & (B3_HWY | B3_ROAD_UNDER | B3_RAIL_UNDER);
      }
    }
    return out;
  }

  /**
   * 道路・線路のマスを、1 マス幅の中心線にして、4 連結 (上下左右だけでつながる) に直す。
   * 小さな輪を埋め、複線や駅のホームの塗りつぶし、並走する道路を 1 本の鎖にまとめてから、斜めの所に角のマスを足す。
   * まとめるのは、同じまとまり (線路 = 同じ路線、道路 = 同じ優先度) の線だけ。違う路線は別々に細線化する
   * (東京駅のように違う路線が並ぶ所は、並んだまま)。
   * 立体交差: 優先度の高い線の周り (半径 CUT_RADIUS) にある、低い線のマスは絵から消す (消したマスには「通っている」印を付ける)。
   * 細線化の後に消すので、消した所もつながった鎖のまま、印が続く。
   * 足したマスや埋めたマスの種別 (道路・線路の分類、高速道路・橋のビット) は、同じまとまりの隣の最も rank の高いマスから引き継ぐ。
   */
  private thinLines(): void {
    const { stride: s, cells } = this;
    const n = s * s;
    for (const layer of [1, 2]) {                    // 1 = 道路 (byte1)、2 = 線路 (byte2)
      const r = layer === 1 ? MERGE_RADIUS.road : MERGE_RADIUS.rail;
      const cut = layer === 1 ? CUT_RADIUS.road : CUT_RADIUS.rail;
      const pr = this.prio[layer - 1], gp = this.grp[layer - 1];
      if (layer === 2) this.adoptAreaRails();
      const keys = new Set<number>();
      for (let i = 0; i < n; i++) if (cells[i * 4 + layer]) keys.add(gp[i]);
      // まとまりごとの細線化の結果: 中心線のマス、その種別、優先度
      const keyList = [...keys];
      const parts: { cls: Uint8Array; pri: Uint8Array; hwy: Uint8Array; hidden: Uint8Array }[] = [];
      for (const key of keys) {
        const orig = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (cells[i * 4 + layer] && gp[i] === key) orig[i] = 1;
        const mask = dilate(orig, s, r);
        fillSmallHoles(mask, s, MAX_LOOP_AREA);
        thinMask(mask, s);
        stairify(mask, s);
        const cls = new Uint8Array(n), pri = new Uint8Array(n), hwy = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          if (!mask[i]) continue;
          // 元のマスならそのまま。中心線のマスは、近く (r + 1 マス以内) の同じまとまりの元のマスのうち、最も近く rank の高いものを引き継ぐ
          let best = -1, bestD = 1e9, bestRank = -1;
          const x = i % s, y = (i / s) | 0, R = r + 1;
          for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
            const j = ny * s + nx;
            if (!orig[j]) continue;
            const d = dx * dx + dy * dy, rk = rankOf(cells[j * 4 + layer]);
            if (d < bestD || (d === bestD && rk > bestRank)) { bestD = d; bestRank = rk; best = j; }
          }
          if (best < 0) continue;
          cls[i] = cells[best * 4 + layer]; pri[i] = pr[best];
          if (layer === 1) hwy[i] = cells[best * 4 + 3] & B3_HWY ? 1 : 0;
        }
        parts.push({ cls, pri, hwy, hidden: new Uint8Array(n) });
      }
      // 立体交差: 各マスの周りにある、他のまとまりの最も高い優先度 (自分より高ければ、自分は消える)
      const above = new Int32Array(n).fill(-1), aboveKey = new Int32Array(n).fill(-1);
      // 線路は、同じ優先度でも路線で上下を決める (違う路線は交差でも並走でも混じらない。道路は同じ優先度なら交差点のまま)
      const val = (k: number, i: number) => layer === 2 ? parts[k].pri[i] * 2097152 + keyList[k] : parts[k].pri[i];
      const R2 = cut;
      const reach = cut * cut + cut;
      parts.forEach((p, k) => {
        for (let i = 0; i < n; i++) {
          if (!p.cls[i]) continue;
          const x = i % s, y = (i / s) | 0;
          for (let dy = -R2; dy <= R2; dy++) for (let dx = -R2; dx <= R2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= s || ny >= s || dx * dx + dy * dy > reach) continue;
            const j = ny * s + nx, v = val(k, i);
            if (v > above[j]) { above[j] = v; aboveKey[j] = k; }
          }
        }
      });
      const under = layer === 1 ? B3_ROAD_UNDER : B3_RAIL_UNDER;
      const outCls = new Uint8Array(n), outPri = new Int16Array(n).fill(-1), outHwy = new Uint8Array(n), hid = new Uint8Array(n);
      parts.forEach((p, k) => {
        for (let i = 0; i < n; i++) {
          if (!p.cls[i]) continue;
          if (above[i] > val(k, i) && aboveKey[i] !== k) { hid[i] = 1; p.hidden[i] = 1; continue; }
          if (p.pri[i] > outPri[i]) { outPri[i] = p.pri[i]; outCls[i] = p.cls[i]; outHwy[i] = p.hwy[i]; }
        }
      });
      if (layer === 2) {
        // 隣り合う線路のマスのうち、同じ路線の鎖でつながっていないもの (別の路線が並走して隣り合っただけ) に印を付ける
        const nl = this.noLink;
        nl.fill(0);
        const linked = (i: number, j: number) => parts.some((p) => p.cls[i] && !p.hidden[i] && p.cls[j] && !p.hidden[j]);
        for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) {
          const i = y * s + x;
          if (!outCls[i]) continue;
          if (outCls[i + 1] && !linked(i, i + 1)) nl[i] |= RAIL_NO_E;
          if (outCls[i + s] && !linked(i, i + s)) nl[i] |= RAIL_NO_S;
        }
      }
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const had = cells[o + layer] !== 0;
        cells[o + layer] = outCls[i];
        // 高速道路のビットは、道路の種別を持つ線のマスだけ扱う (高速道路そのものは種別なしで、ビットだけで塗られている)
        if (layer === 1 && (had || outCls[i])) cells[o + 3] = (cells[o + 3] & ~B3_HWY) | (outHwy[i] ? B3_HWY : 0);
        if (hid[i]) cells[o + 3] |= under;
      }
    }
  }

  /**
   * 駅のホーム・駅舎の面から塗った線路のマスには、路線がない (線のまとまりが 0)。そのまま別のまとまりにすると、
   * 同じ駅の線路と並んで梯子のようになるので、近く (ADOPT_RADIUS マス以内) の最も近い線のマスの、まとまりと優先度を引き継ぐ。
   */
  private adoptAreaRails(): void {
    const { stride: s, cells } = this, gp = this.grp[1], pr = this.prio[1], R = ADOPT_RADIUS;
    const n = s * s, set: [number, number, number][] = [];
    const ar = this.areaRail, isLine = (i: number) => cells[i * 4 + 2] !== 0 && !ar[i];
    for (let i = 0; i < n; i++) {
      if (!ar[i]) continue;
      const x = i % s, y = (i / s) | 0;
      let bestD = 1e9, bg = 0, bp = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
        const j = ny * s + nx, d = dx * dx + dy * dy;
        if (d < bestD && isLine(j)) { bestD = d; bg = gp[j]; bp = pr[j]; }
      }
      if (bestD < 1e9) set.push([i, bg, bp]);
    }
    for (const [i, g, p] of set) { gp[i] = g; pr[i] = p; }
  }

  /** 作業台の座標 (x, y) (余白込み) に最も近い線路のマス (半径 STATION_SNAP_RADIUS 以内)。なければそのまま。 */
  private snapToRail(x: number, y: number): [number, number] {
    const { stride: s, cells } = this, R = STATION_SNAP_RADIUS;
    let best: [number, number] = [x, y], bestD = Infinity;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
        const d = dx * dx + dy * dy;
        if (d > R * R || d >= bestD || !cells[(ny * s + nx) * 4 + 2]) continue;
        bestD = d; best = [nx, ny];
      }
    }
    return best;
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
        out[d] = a; out[d + 1] = this.cells[s + 1]; out[d + 2] = this.cells[s + 2] | this.noLink[s >> 2]; out[d + 3] = flags;
        if (a !== SEA || out[d + 1] || out[d + 2] || flags) allSea = false;
      }
    }
    return allSea ? null : out;
  }
}
