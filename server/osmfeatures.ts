/**
 * OSM PBF から、ラスタライズする地物 (面と線) を取り出す。座標は z18 のマス座標 (小数) にして持つ。
 *
 * PBF を 3 回読む:
 *   1. リレーション (multipolygon) を集める
 *   2. ノード (範囲内か) とウェイ (必要なもの) を集める
 *   3. 必要なノードの座標を集める
 * 範囲 (bbox) の外に頂点しかなくて範囲を覆う大きな面は取りこぼす。margin で外側を広げて対処する。
 */
import { scanPbf, type Member } from "./osmpbf";
import { CLASSES, KIND_AREA, KIND_RAIL, KIND_ROAD, classId } from "./worlddb";

export const WORLD_CELLS = 1 << 22;               // z18 の 1 辺のマス数

export function lonToX(lon: number): number {
  return ((lon + 180) / 360) * WORLD_CELLS;
}
export function latToY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD_CELLS;
}

// ---- 地物 ----
export interface Feature {
  rank: number;              // 塗る順 (小さい順に塗る)
  area: number;              // 面の osm_class.id (0 = 面ではない)
  road: number;              // 道路の id
  rail: number;              // 線路の id
  hwy: boolean;              // 高速道路
  river: boolean;            // 川 (線で水を塗る)
  bridge: boolean;
  cliff: boolean;
  parts: Float64Array[];     // [x0, y0, x1, y1, ...]。面は全リングを偶奇で塗る
  minx: number; miny: number; maxx: number; maxy: number;
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
  const road = hv && !hwy ? roadId(ROAD_ALIAS[hv] ?? hv) : 0;
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
}

interface KeptWay { refs: number[]; area: number; line: LineAttrs | null; touches: boolean }

export async function loadFeatures(pbf: string, opt: LoadOptions): Promise<Feature[]> {
  const m = opt.margin ?? 0.05;
  const [w, s, e, n] = [opt.bbox[0] - m, opt.bbox[1] - m, opt.bbox[2] + m, opt.bbox[3] + m];

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

  // 2. ノード (範囲内) とウェイ
  const inBox = new IdMap(1 << 16, false);
  const kept = new Map<number, KeptWay>();
  const need = new IdMap(1 << 16, false);
  await scanPbf(pbf, {
    node(id, lat, lon) {
      if (lon >= w && lon <= e && lat >= s && lat <= n) inBox.set(id);
    },
    way(id, tags, refs) {
      const isMember = memberWays.has(id);
      const closed = refs.length >= 4 && refs[0] === refs[refs.length - 1];
      const area = closed ? areaClassOf(tags) : 0;
      const line = lineAttrsOf(tags);
      if (!isMember && !area && !line) return;
      let touches = false;
      for (let i = 0; i < refs.length && !touches; i++) touches = inBox.has(refs[i]);
      if (!isMember && !touches) return;
      kept.set(id, { refs, area, line, touches });
      for (const r of refs) need.set(r);
    },
  });

  // 3. 必要なノードの座標
  const coords = new IdMap(Math.max(1 << 16, 1 << Math.ceil(Math.log2(need.size * 2 + 1))));
  await scanPbf(pbf, {
    node(id, lat, lon) {
      if (need.has(id)) coords.set(id, lat, lon);
    },
  });

  const out: Feature[] = [];
  const toXY = (refs: number[]): Float64Array => {
    const xy: number[] = [];
    for (const r of refs) {
      const i = coords.find(r);
      if (i >= 0) xy.push(lonToX(coords.lon[i] / 1e7), latToY(coords.lat[i] / 1e7));
    }
    return Float64Array.from(xy);
  };
  const push = (partial: Partial<Feature>, parts: Float64Array[]) => {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const p of parts) {
      for (let i = 0; i < p.length; i += 2) {
        if (p[i] < minx) minx = p[i];
        if (p[i] > maxx) maxx = p[i];
        if (p[i + 1] < miny) miny = p[i + 1];
        if (p[i + 1] > maxy) maxy = p[i + 1];
      }
    }
    if (minx > maxx) return;
    out.push({ rank: 0, area: 0, road: 0, rail: 0, hwy: false, river: false, bridge: false, cliff: false,
      ...partial, parts, minx, miny, maxx, maxy });
  };

  for (const k of kept.values()) {
    if (!k.touches) continue;
    if (k.area) {
      const xy = toXY(k.refs);
      if (xy.length >= 8) push({ area: k.area, rank: rankOf(k.area) }, [xy]);
    }
    if (k.line) {
      const xy = toXY(k.refs);
      if (xy.length >= 4) {
        push({ ...k.line, rank: Math.max(rankOf(k.line.road), rankOf(k.line.rail)) }, [xy]);
      }
    }
  }
  for (const r of rels) {
    const ways = r.ways.map((x) => kept.get(x.id)).filter((x): x is KeptWay => !!x);
    if (!ways.some((x) => x.touches)) continue;
    const parts = assembleRings(ways.map((x) => x.refs)).map(toXY).filter((p) => p.length >= 8);
    if (parts.length > 0) push({ area: r.area, rank: rankOf(r.area) }, parts);
  }
  return out;
}
