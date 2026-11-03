/**
 * OSM PBF から、ラスタライズする地物 (面と線) を取り出す。座標は z18 のマス座標 (小数) にして持つ。
 *
 * PBF を 3 回読む:
 *   1. リレーション (multipolygon) を集める
 *   2. ノード (範囲内か) とウェイ (必要なもの) を集める
 *   3. 必要なノードの座標を集める
 * 範囲 (bbox) の外に頂点しかなくて範囲を覆う大きな面は取りこぼす。margin で外側を広げて対処する。
 */
import { assembleChains } from "./coast";
import { scanPbf, type Member } from "./osmpbf";
import { CLASSES, KIND_AREA, KIND_RAIL, KIND_ROAD, classId } from "./worlddb";

export const WORLD_CELLS = 1 << 22;               // z18 の 1 辺のマス数

export function lonToX(lon: number): number {
  return ((lon + 180) / 360) * WORLD_CELLS;
}
export function xToLon(x: number): number {
  return (x / WORLD_CELLS) * 360 - 180;
}
export function yToLat(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD_CELLS))) * 180) / Math.PI;
}
export function latToY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD_CELLS;
}

// ---- 地物の置き場 ----
// 数百万個の地物を JS のオブジェクトで持つとメモリが膨らむので、列ごとの型付き配列に入れる。
// 座標は 1/64 マスの固定小数点 Int32 にして 1 本の配列 (アリーナ) に並べる。
type TypedCtor<T> = new (n: number) => T;

class Grow<T extends Float64Array | Int32Array | Uint32Array | Uint8Array> {
  a: T;
  n = 0;
  constructor(private ctor: TypedCtor<T>, cap = 1024) { this.a = new ctor(cap); }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new this.ctor(this.a.length * 2);
      b.set(this.a as never);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  view(): T { return this.a.subarray(0, this.n) as T; }
}

export const FIX = 64;                              // 座標の固定小数点 (1/64 マス。2^22 x 64 は Int32 に収まる)

export interface FeatureAttrs {
  rank: number; area?: number; road?: number; rail?: number;
  hwy?: boolean; river?: boolean; bridge?: boolean; cliff?: boolean;
}
export const FL_HWY = 1, FL_RIVER = 2, FL_BRIDGE = 4, FL_CLIFF = 8;

export class FeatureStore {
  rank = new Grow(Uint8Array); area = new Grow(Uint8Array); road = new Grow(Uint8Array);
  rail = new Grow(Uint8Array); flags = new Grow(Uint8Array);
  start = new Grow(Int32Array); rings = new Grow(Int32Array);
  minx = new Grow(Int32Array); miny = new Grow(Int32Array);
  maxx = new Grow(Int32Array); maxy = new Grow(Int32Array);
  private pts = new Grow(Int32Array, 1 << 16);      // 輪ごとに [点の数, x0, y0, x1, y1, ...]

  get count(): number { return this.rank.n; }

  /** rings は [x0, y0, x1, y1, ...] (マス座標) の配列。点が 2 つ未満の輪は捨てる。 */
  add(at: FeatureAttrs, rings: ArrayLike<number>[]): boolean {
    const startAt = this.pts.n;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, n = 0;
    for (const r of rings) {
      const np = r.length >> 1;
      if (np < 2) continue;
      this.pts.push(np);
      for (let i = 0; i < r.length; i += 2) {
        const x = Math.round(r[i] * FIX), y = Math.round(r[i + 1] * FIX);
        this.pts.push(x); this.pts.push(y);
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      n++;
    }
    if (n === 0) return false;
    this.rank.push(at.rank); this.area.push(at.area ?? 0); this.road.push(at.road ?? 0);
    this.rail.push(at.rail ?? 0);
    this.flags.push((at.hwy ? FL_HWY : 0) | (at.river ? FL_RIVER : 0) | (at.bridge ? FL_BRIDGE : 0) | (at.cliff ? FL_CLIFF : 0));
    this.start.push(startAt); this.rings.push(n);
    this.minx.push(minx); this.miny.push(miny); this.maxx.push(maxx); this.maxy.push(maxy);
    return true;
  }

  /** 窓 (マス座標) に重なるか。 */
  overlaps(i: number, w: { x0: number; y0: number; x1: number; y1: number }): boolean {
    return this.maxx.a[i] >= w.x0 * FIX && this.minx.a[i] < w.x1 * FIX
      && this.maxy.a[i] >= w.y0 * FIX && this.miny.a[i] < w.y1 * FIX;
  }

  /** 地物 i の輪をマス座標に戻す。 */
  partsOf(i: number): Float64Array[] {
    const out: Float64Array[] = [], a = this.pts.a;
    let p = this.start.a[i];
    for (let r = 0; r < this.rings.a[i]; r++) {
      const np = a[p++], xy = new Float64Array(np * 2);
      for (let k = 0; k < np * 2; k++) xy[k] = a[p + k] / FIX;
      out.push(xy);
      p += np * 2;
    }
    return out;
  }

  /** 条件に合う地物の番号を rank の昇順 (同じ rank は追加順) に並べる。 */
  order(pick: (i: number) => boolean): Uint32Array {
    const buckets: number[][] = Array.from({ length: 256 }, () => []);
    for (let i = 0; i < this.count; i++) if (pick(i)) buckets[this.rank.a[i]].push(i);
    return Uint32Array.from(buckets.flat());
  }
  areas(): Uint32Array { return this.order((i) => this.area.a[i] !== 0); }
  lines(): Uint32Array { return this.order((i) => this.area.a[i] === 0); }
}

// ---- タグの読み取り ----
const AREA_DEFS = CLASSES.map((c, i) => ({ ...c, id: i + 1 }))
  .filter((c) => c.kind === KIND_AREA && c.key !== "sea")
  .sort((a, b) => b.rank - a.rank);                // 複数あれば rank の高い方
export function areaClassOf(tags: Record<string, string>): number {
  for (const c of AREA_DEFS) {
    if (c.key === "building" ? tags.building !== undefined && tags.building !== "no" : tags[c.key] === c.value) {
      return c.id;
    }
  }
  return 0;
}

const ROAD_ALIAS: Record<string, string> = {
  trunk_link: "trunk", primary_link: "primary", secondary_link: "secondary", tertiary_link: "tertiary",
  cycleway: "path", bridleway: "path",
};
const RAIL_ALIAS: Record<string, string> = { monorail: "light_rail", narrow_gauge: "light_rail" };

const roadId = (v: string) => CLASSES.some((c) => c.kind === KIND_ROAD && c.value === v) ? classId("highway", v) : 0;
const railId = (v: string) => CLASSES.some((c) => c.kind === KIND_RAIL && c.value === v) ? classId("railway", v) : 0;

export interface LineAttrs { road: number; rail: number; hwy: boolean; river: boolean; bridge: boolean; cliff: boolean }

/** ウェイの線としての意味。tunnel=yes は地上に出ないので無視。何もなければ null。 */
export function lineAttrsOf(tags: Record<string, string>): LineAttrs | null {
  if (tags.tunnel === "yes") return null;
  const hv = tags.highway;
  const hwy = hv === "motorway" || hv === "motorway_link" || (hv !== undefined && tags.motorroad === "yes");
  // 歩道と横断歩道は車道と平行・直交して描かれていて、7.8m のマスでは車道の隣が全部交差点になるので使わない
  const sidewalk = tags.footway === "sidewalk" || tags.footway === "crossing" || tags.cycleway === "crossing";
  const road = hv && !hwy && !sidewalk ? roadId(ROAD_ALIAS[hv] ?? hv) : 0;
  const rv = tags.railway;
  const rail = rv ? railId(RAIL_ALIAS[rv] ?? rv) : 0;
  const river = tags.waterway === "river" || tags.waterway === "canal";
  const cliff = tags.natural === "cliff";
  if (!hwy && !road && !rail && !river && !cliff) return null;
  const bridge = (hwy || road > 0 || rail > 0) && tags.bridge !== undefined && tags.bridge !== "no";
  return { road, rail, hwy, river, bridge, cliff };
}

const rankOf = (id: number) => CLASSES[id - 1]?.rank ?? 0;

// ---- ID → 座標の表 (typed array の開番地法。ノードは数千万個になるので Map は使わない) ----
export class IdMap {
  keys: Float64Array;
  lat: Int32Array;
  lon: Int32Array;
  size = 0;
  private mask: number;

  constructor(cap = 1 << 16, readonly withValues = true) {
    this.mask = cap - 1;
    this.keys = new Float64Array(cap);
    this.lat = new Int32Array(withValues ? cap : 0);
    this.lon = new Int32Array(withValues ? cap : 0);
  }

  private slot(id: number): number {
    let h = Math.imul((id >>> 0) ^ ((id / 4294967296) | 0), 0x9e3779b1) >>> 0;
    h &= this.mask;
    while (this.keys[h] !== 0 && this.keys[h] !== id) h = (h + 1) & this.mask;
    return h;
  }

  has(id: number): boolean {
    return this.keys[this.slot(id)] === id;
  }

  /** 度を 1e-7 度の整数にして入れる。 */
  set(id: number, lat = 0, lon = 0) {
    if ((this.size + 1) * 2 > this.mask + 1) this.grow();
    const s = this.slot(id);
    if (this.keys[s] === 0) { this.keys[s] = id; this.size++; }
    if (this.withValues) { this.lat[s] = Math.round(lat * 1e7); this.lon[s] = Math.round(lon * 1e7); }
  }

  /** 見つからなければ -1。 */
  find(id: number): number {
    const s = this.slot(id);
    return this.keys[s] === id ? s : -1;
  }

  private grow() {
    const old = { k: this.keys, la: this.lat, lo: this.lon };
    const cap = (this.mask + 1) * 2;
    this.mask = cap - 1;
    this.keys = new Float64Array(cap);
    this.lat = new Int32Array(this.withValues ? cap : 0);
    this.lon = new Int32Array(this.withValues ? cap : 0);
    for (let i = 0; i < old.k.length; i++) {
      if (old.k[i] !== 0) {
        const s = this.slot(old.k[i]);
        this.keys[s] = old.k[i];
        if (this.withValues) { this.lat[s] = old.la[i]; this.lon[s] = old.lo[i]; }
      }
    }
  }
}

// ---- multipolygon のリングを作る ----
/** メンバーのウェイ (ノード ID 列) を端点でつないで閉じたリングにする。閉じないものは捨てる。 */
export function assembleRings(ways: number[][]): number[][] {
  const pool = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings: number[][] = [];
  while (pool.length > 0) {
    let ring = pool.pop()!;
    let grown = true;
    while (grown && ring[0] !== ring[ring.length - 1]) {
      grown = false;
      const head = ring[0], tail = ring[ring.length - 1];
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        if (w[0] === tail) ring = ring.concat(w.slice(1));
        else if (w[w.length - 1] === tail) ring = ring.concat(w.slice(0, -1).reverse());
        else if (w[w.length - 1] === head) ring = w.concat(ring.slice(1));
        else if (w[0] === head) ring = w.slice().reverse().concat(ring.slice(1));
        else continue;
        pool.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

// ---- 読み込み ----
export interface LoadOptions {
  bbox: [number, number, number, number];     // w, s, e, n (度)
  margin?: number;                            // 外側に広げる度数 (既定 0.05)
  log?: (msg: string) => void;                // 進行の表示
}

export interface Loaded {
  store: FeatureStore;
  coast: Float64Array[];                      // 海岸線の鎖 (陸が進行方向の左)。マス座標
}

// ウェイの情報 (4 バイトに詰める): area | road << 8 | rail << 16 | bits << 24
const W_HWY = 1, W_RIVER = 2, W_BRIDGE = 4, W_CLIFF = 8, W_LINE = 16, W_COAST = 32, W_TOUCH = 64, W_MEMBER = 128;

/** id → 整数の表 (キーだけの IdMap と別に、値が必要な所用)。 */
class IdIndex {
  private keys: Float64Array;
  private vals: Int32Array;
  private mask: number;
  constructor(cap: number) {
    cap = 1 << Math.max(4, Math.ceil(Math.log2(cap * 2 + 1)));
    this.mask = cap - 1;
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
  }
  private slot(id: number): number {
    let h = (Math.imul((id >>> 0) ^ ((id / 4294967296) | 0), 0x9e3779b1) >>> 0) & this.mask;
    while (this.keys[h] !== 0 && this.keys[h] !== id) h = (h + 1) & this.mask;
    return h;
  }
  set(id: number, v: number) { const s = this.slot(id); this.keys[s] = id; this.vals[s] = v; }
  get(id: number): number { const s = this.slot(id); return this.keys[s] === id ? this.vals[s] : -1; }
}

/**
 * PBF を 3 回読む。メモリを抑えるため、ウェイと参照は型付き配列に詰め、
 * ノード座標は「必要な ID を整列 → ID 順に並んだノードをマージ結合で読む」で表を持たずに集める。
 */
export async function loadFeatures(pbf: string, opt: LoadOptions): Promise<Loaded> {
  const m = opt.margin ?? 0.05;
  const [w, s, e, n] = [opt.bbox[0] - m, opt.bbox[1] - m, opt.bbox[2] + m, opt.bbox[3] + m];
  const log = opt.log ?? (() => {});
  const mem = () => `rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`;
  const gc = () => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);

  // 1. リレーション
  const rels: { area: number; ways: { id: number; inner: boolean }[] }[] = [];
  const memberWays = new IdMap(1 << 12, false);
  await scanPbf(pbf, {
    relation(_id, tags, members: Member[]) {
      if (tags.type !== "multipolygon") return;
      const area = areaClassOf(tags);
      if (!area) return;
      const ways = members.filter((x) => x.type === 1 && (x.role === "outer" || x.role === "inner" || x.role === ""))
        .map((x) => ({ id: x.id, inner: x.role === "inner" }));
      for (const x of ways) memberWays.set(x.id);
      rels.push({ area, ways });
    },
  });
  log(`リレーション ${rels.length} 件 (${mem()})`);

  // 2. ノード (範囲内か) とウェイ
  let inBox: IdMap | null = new IdMap(1 << 16, false);
  const wId = new Grow(Float64Array), wStart = new Grow(Int32Array), wLen = new Grow(Int32Array);
  const wInfo = new Grow(Uint32Array), refs = new Grow(Float64Array, 1 << 16);
  await scanPbf(pbf, {
    node(id, lat, lon) {
      if (lon >= w && lon <= e && lat >= s && lat <= n) inBox!.set(id);
    },
    way(id, tags, r) {
      const isMember = memberWays.has(id);
      const closed = r.length >= 4 && r[0] === r[r.length - 1];
      const area = closed ? areaClassOf(tags) : 0;
      const line = lineAttrsOf(tags);
      const coast = tags.natural === "coastline";
      if (!isMember && !area && !line && !coast) return;
      let touches = false;
      for (let i = 0; i < r.length && !touches; i++) touches = inBox!.has(r[i]);
      if (!isMember && !touches) return;
      const bits = (line?.hwy ? W_HWY : 0) | (line?.river ? W_RIVER : 0) | (line?.bridge ? W_BRIDGE : 0)
        | (line?.cliff ? W_CLIFF : 0) | (line ? W_LINE : 0) | (coast ? W_COAST : 0)
        | (touches ? W_TOUCH : 0) | (isMember ? W_MEMBER : 0);
      wId.push(id); wStart.push(refs.n); wLen.push(r.length);
      wInfo.push((area | ((line?.road ?? 0) << 8) | ((line?.rail ?? 0) << 16) | (bits << 24)) >>> 0);
      for (const x of r) refs.push(x);
    },
  });
  inBox = null;
  const nWays = wId.n;
  log(`ウェイ ${nWays} 本、参照 ${refs.n} (${mem()})`);

  // 必要なノードの ID を整列して重複を除く
  const sorted = refs.view().slice().sort();
  let nIds = 0;
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[nIds++] = sorted[i];
  const ids = sorted.subarray(0, nIds);
  gc();
  log(`必要ノード ${nIds} (${mem()})`);

  // 3. 必要なノードの座標。PBF のノードは ID 順なので、整列した ID と同時に進める
  const NONE = 2147483647;
  const latI = new Int32Array(nIds).fill(NONE), lonI = new Int32Array(nIds);
  let p = 0, last = 0;
  await scanPbf(pbf, {
    node(id, lat, lon) {
      if (id < last) throw new Error("PBF のノードが ID 順に並んでいない (osmium sort が必要)");
      last = id;
      while (p < nIds && ids[p] < id) p++;
      if (p < nIds && ids[p] === id) { latI[p] = Math.round(lat * 1e7); lonI[p] = Math.round(lon * 1e7); }
    },
  });
  gc();
  log(`ノード座標 (${mem()})`);

  const find = (id: number): number => {
    let lo = 0, hi = nIds - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid] < id) lo = mid + 1; else if (ids[mid] > id) hi = mid - 1; else return mid;
    }
    return -1;
  };
  const toXY = (start: number, len: number): number[] => {
    const xy: number[] = [], a = refs.a;
    for (let k = start; k < start + len; k++) {
      const i = find(a[k]);
      if (i >= 0 && latI[i] !== NONE) xy.push(lonToX(lonI[i] / 1e7), latToY(latI[i] / 1e7));
    }
    return xy;
  };

  const store = new FeatureStore();
  const coastWays: number[][] = [];
  const memberIdx = new IdIndex(memberWays.size);
  for (let i = 0; i < nWays; i++) {
    const info = wInfo.a[i], bits = info >>> 24, area = info & 255, road = (info >> 8) & 255, rail = (info >> 16) & 255;
    if (bits & W_MEMBER) memberIdx.set(wId.a[i], i);
    if (!(bits & W_TOUCH)) continue;
    if (bits & W_COAST) coastWays.push(Array.from(refs.a.subarray(wStart.a[i], wStart.a[i] + wLen.a[i])));
    if (area) {
      const xy = toXY(wStart.a[i], wLen.a[i]);
      if (xy.length >= 8) store.add({ rank: rankOf(area), area }, [xy]);
    }
    if (bits & W_LINE) {
      const xy = toXY(wStart.a[i], wLen.a[i]);
      if (xy.length >= 4) {
        store.add({ rank: Math.max(rankOf(road), rankOf(rail)), road, rail, hwy: !!(bits & W_HWY),
          river: !!(bits & W_RIVER), bridge: !!(bits & W_BRIDGE), cliff: !!(bits & W_CLIFF) }, [xy]);
      }
    }
  }
  for (const r of rels) {
    const idx = r.ways.map((x) => memberIdx.get(x.id)).filter((i) => i >= 0);
    if (!idx.some((i) => (wInfo.a[i] >>> 24) & W_TOUCH)) continue;
    const rings = assembleRings(idx.map((i) => Array.from(refs.a.subarray(wStart.a[i], wStart.a[i] + wLen.a[i]))));
    // 輪はノード ID 列。座標に直すには ID → 座標が要るので、一時的な ID 列を介さず直接引く
    const parts = rings.map((ring) => {
      const xy: number[] = [];
      for (const id of ring) {
        const k = find(id);
        if (k >= 0 && latI[k] !== NONE) xy.push(lonToX(lonI[k] / 1e7), latToY(latI[k] / 1e7));
      }
      return xy;
    }).filter((xy) => xy.length >= 8);
    if (parts.length > 0) store.add({ rank: rankOf(r.area), area: r.area }, parts);
  }
  const coast = assembleChains(coastWays).map((c) => {
    const xy: number[] = [];
    for (const id of c) {
      const k = find(id);
      if (k >= 0 && latI[k] !== NONE) xy.push(lonToX(lonI[k] / 1e7), latToY(latI[k] / 1e7));
    }
    return Float64Array.from(xy);
  }).filter((c) => c.length >= 4);
  gc();
  log(`地物 ${store.count} (${mem()})`);
  return { store, coast };
}
