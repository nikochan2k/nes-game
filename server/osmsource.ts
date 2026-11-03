/**
 * world.sqlite (worlddb.ts) から地形を動的に作る Source。
 * 判定規則は doc/tile-conversion-plan.md の 7〜8 章。
 *
 *   z11〜18 : ブロックの data (z18 のマス) を集約
 *   z6〜10  : ブロックの代表値を集約 (z1〜5 は間引き)
 */
import { Database } from "bun:sqlite";
import { inflateSync } from "node:zlib";
import type { Source } from "./mapserver";
import * as T from "./terrain";
import {
  B3_BRIDGE, B3_CLIFF, B3_HWY, B3_SLOPE_SHIFT, CLASSES, SLOPE_MOUNTAIN, SLOPE_ROCK,
} from "./worlddb";

// ---- 種別の意味 ----
const K_OTHER = 0, K_BUILDING = 1, K_WATER = 2, K_WETLAND = 3, K_ROCK = 4, K_SCREE = 5, K_NATURAL = 6;

const CAT_KIND: Record<string, number> = {
  building: K_BUILDING, water: K_WATER, wetland: K_WETLAND, rock: K_ROCK, scree: K_SCREE,
  grass: K_NATURAL, forest: K_NATURAL,
};
const CAT_TERRAIN: Record<string, number> = {
  grass: T.T_GRASS, forest: T.T_FOREST, urban: T.T_URBAN, building: T.T_BUILDING, sand: T.T_SAND,
  snow: T.T_SNOW, farm: T.T_FARM, water: T.T_WATER, wetland: T.T_WETLAND, rock: T.T_ROCK,
  scree: T.T_MOUNTAIN,
};

// ---- ズームごとのしきい値 (8.3 の表。rank は worlddb.ts の CLASSES) ----
const NONE = 1000;
/** この rank 以上の一般道路を出す。 */
export function roadMin(z: number): number {
  return z >= 18 ? 1 : z >= 15 ? 35 : z >= 12 ? 60 : z >= 9 ? 80 : z >= 6 ? 90 : NONE;
}
/** この rank 以上の線路を出す。 */
export function railMin(z: number): number {
  return z >= 15 ? 1 : z >= 12 ? 70 : z >= 6 ? 90 : NONE;
}
const hwyShown = (z: number) => z >= 6;

const ROCK_PCT = 30, MOUNT_PCT = 40;   // 集約時の割合のしきい値 (案)。8.2

// ---- 1 マスの特徴 (ビットにして Map に入れる) ----
const F_ROAD = 1, F_HWY = 2, F_RAIL = 4, F_BRIDGE = 8, F_CROSS = 16;
const F_BASE_SHIFT = 8;

interface Block {
  cells: Uint8Array | null;   // 256*256*4。null なら全マス (area, 0, 0, 0)
  area: number;
}

interface Rep {
  area: number; areaPct: number; road: number; rail: number; motorway: number;
  mountPct: number; rockPct: number;
}

export class OsmSource implements Source {
  private db: Database;
  private blockQ;
  private repQ;
  private rank = new Uint8Array(256);       // osm_class.id → rank
  private kind = new Uint8Array(256);       // 面の id → K_*
  private terr = new Uint8Array(256);       // 面の id → 地形
  private missing: Rep;                    // 範囲外 (行がない場所) = 海
  private blocks = new Map<number, Block | null>();
  private reps = new Map<number, Rep>();
  private feats = new Map<number, number>();
  private counts = new Uint16Array(256);
  private weights = new Float64Array(256);

  constructor(path: string, readonly blockCache = 48) {
    this.db = new Database(path, { readonly: true });
    this.blockQ = this.db.query("SELECT data, area FROM block WHERE bx = ? AND by = ?");
    this.repQ = this.db.query(
      "SELECT area, area_pct, road, rail, motorway, mount_pct, rock_pct FROM block WHERE bx = ? AND by = ?");
    let water = 0;
    for (const row of this.db.query("SELECT id, kind, key, value, rank FROM osm_class").all() as any[]) {
      this.rank[row.id] = row.rank;
      const def = CLASSES.find((c) => c.key === row.key && c.value === row.value);
      if (def?.cat) {
        this.kind[row.id] = CAT_KIND[def.cat] ?? K_OTHER;
        this.terr[row.id] = CAT_TERRAIN[def.cat];
        if (row.key === "sea") {
          water = row.id;
        }
      }
    }
    if (!water) {
      throw new Error("osm_class に海 (sea=sea) がない");
    }
    this.missing = { area: water, areaPct: 100, road: 0, rail: 0, motorway: 0, mountPct: 0, rockPct: 0 };
  }

  close() {
    this.db.close();
  }

  // ---- ブロックの読み込み ----
  private block(bx: number, by: number): Block | null {
    const key = bx * 16384 + by;
    let b = this.blocks.get(key);
    if (b !== undefined) {
      this.blocks.delete(key);          // LRU: 末尾に入れ直す
      this.blocks.set(key, b);
      return b;
    }
    const row = this.blockQ.get(bx, by) as { data: Uint8Array | null; area: number } | null;
    b = row ? { cells: row.data ? inflateSync(row.data) : null, area: row.area } : null;
    this.blocks.set(key, b);
    if (this.blocks.size > this.blockCache) {
      this.blocks.delete(this.blocks.keys().next().value!);
    }
    return b;
  }

  private rep(bx: number, by: number): Rep {
    if (bx < 0 || by < 0 || bx >= 16384 || by >= 16384) {
      return this.missing;
    }
    const key = bx * 16384 + by;
    let r = this.reps.get(key);
    if (r === undefined) {
      const row = this.repQ.get(bx, by) as any;
      r = row ? {
        area: row.area, areaPct: row.area_pct, road: row.road, rail: row.rail, motorway: row.motorway,
        mountPct: row.mount_pct, rockPct: row.rock_pct,
      } : this.missing;
      if (this.reps.size > 200000) {
        this.reps.clear();
      }
      this.reps.set(key, r);
    }
    return r;
  }

  // ---- 地形の決め方 (7 章 6〜11) ----
  private base(area: number, rock: boolean, mount: boolean): number {
    const k = this.kind[area];
    if (k === K_BUILDING || k === K_WATER || k === K_WETLAND) {
      return this.terr[area];
    }
    if (rock) return T.T_ROCK;
    if (mount) return T.T_MOUNTAIN;
    return this.terr[area];
  }

  /** 多数決の面。同数なら rank が高い方。counts に集計済みであること。 */
  private majority(src: ArrayLike<number>): number {
    let best = 0, bestN = 0;
    for (let id = 0; id < 256; id++) {
      const n = src[id];
      if (n > bestN || (n === bestN && n > 0 && this.rank[id] > this.rank[best])) {
        best = id; bestN = n;
      }
    }
    return best;
  }

  // ---- 特徴 ----
  private feat(z: number, x: number, y: number): number {
    const key = (z * 4194304 + x) * 4194304 + y;
    let f = this.feats.get(key);
    if (f === undefined) {
      f = z >= 11 ? this.featCells(z, x, y) : this.featReps(z, x, y);
      if (this.feats.size > 300000) {
        this.feats.clear();
      }
      this.feats.set(key, f);
    }
    return f;
  }

  /** z11〜18。1 マス = z18 の s*s マス (必ず 1 ブロックに収まる)。8.1 */
  private featCells(z: number, x: number, y: number): number {
    const s = 1 << (18 - z);
    const x0 = x * s, y0 = y * s;
    const blk = this.block(x0 >> 8, y0 >> 8);
    if (!blk) {
      return T.T_WATER << F_BASE_SHIFT;
    }
    const cells = blk.cells;
    if (!cells) {
      return this.base(blk.area, false, false) << F_BASE_SHIFT;
    }
    const rmin = roadMin(z), tmin = railMin(z), hwy = hwyShown(z);
    const { rank, kind, counts } = this;
    counts.fill(0);
    let road = false, rail = false, hw = false, bridge = false, cross = false, waterN = 0;
    let rockN = 0, mountN = 0;
    for (let yy = y0; yy < y0 + s; yy++) {
      for (let xx = x0; xx < x0 + s; xx++) {
        const o = (((yy & 255) << 8) | (xx & 255)) * 4;
        const a = cells[o], b3 = cells[o + 3];
        counts[a]++;
        const k = kind[a];
        const r = cells[o + 1] !== 0 && rank[cells[o + 1]] >= rmin;
        const t = cells[o + 2] !== 0 && rank[cells[o + 2]] >= tmin;
        if (r) {
          road = true;
          if (b3 & B3_BRIDGE) bridge = true;
          if (t) cross = true;
        }
        if (t) rail = true;
        if (hwy && (b3 & B3_HWY)) hw = true;
        if (k === K_WATER) waterN++;
        if (k !== K_BUILDING && k !== K_WATER && k !== K_WETLAND) {
          const slope = (b3 >> B3_SLOPE_SHIFT) & 7;
          if (k === K_ROCK || (b3 & B3_CLIFF) || slope >= SLOPE_ROCK) {
            rockN++;
          } else if (k === K_SCREE || (k === K_NATURAL && slope >= SLOPE_MOUNTAIN)) {
            mountN++;
          }
        }
      }
    }
    const total = s * s, area = this.majority(counts);
    const rock = s <= 2 ? rockN > 0 : rockN * 100 >= ROCK_PCT * total;
    const mount = mountN * 100 >= MOUNT_PCT * total;
    if (road && waterN > 0) bridge = true;
    return (this.base(area, rock, mount) << F_BASE_SHIFT)
      | (road ? F_ROAD : 0) | (hw ? F_HWY : 0) | (rail ? F_RAIL : 0)
      | (road && bridge ? F_BRIDGE : 0) | (cross ? F_CROSS | F_ROAD | F_RAIL : 0);
  }

  /** z1〜10。1 マス = 2^(10-z) ブロック四方。代表値から作る (橋と踏切は出さない)。8.2 */
  private featReps(z: number, x: number, y: number): number {
    const nb = 1 << (10 - z), bx0 = x * nb, by0 = y * nb;
    const count = Math.min(nb, 16), step = nb / count;   // z5 以下は 16x16 だけ読む
    const rmin = roadMin(z), tmin = railMin(z), hwy = hwyShown(z);
    const { rank, weights } = this;
    weights.fill(0);
    let road = false, rail = false, hw = false, rockSum = 0, mountSum = 0;
    for (let j = 0; j < count; j++) {
      for (let i = 0; i < count; i++) {
        const r = this.rep(bx0 + i * step, by0 + j * step);
        weights[r.area] += r.areaPct;
        if (r.road !== 0 && rank[r.road] >= rmin) road = true;
        if (r.rail !== 0 && rank[r.rail] >= tmin) rail = true;
        if (hwy && r.motorway) hw = true;
        rockSum += r.rockPct;
        mountSum += r.mountPct;
      }
    }
    const n = count * count, area = this.majority(weights);
    const rock = rockSum >= ROCK_PCT * n, mount = mountSum >= MOUNT_PCT * n;
    return (this.base(area, rock, mount) << F_BASE_SHIFT)
      | (road ? F_ROAD : 0) | (hw ? F_HWY : 0) | (rail ? F_RAIL : 0);
  }

  // ---- 向き (7.1) ----
  /** mask のビットを持つ上下左右の隣から、0=横 1=縦 2=交差 を決める。 */
  private dir(z: number, w: number, x: number, y: number, mask: number): number {
    const has = (xx: number, yy: number) =>
      yy >= 0 && yy < w && (this.feat(z, ((xx % w) + w) % w, yy) & mask) !== 0;
    const h = has(x - 1, y) || has(x + 1, y), v = has(x, y - 1) || has(x, y + 1);
    return h && v ? 2 : v ? 1 : 0;
  }

  cell(z: number, x: number, y: number): number {
    const w = 1 << (z + 4);
    if (y < 0 || y >= w) {
      return T.T_ROCK;
    }
    x = ((x % w) + w) % w;
    const f = this.feat(z, x, y);
    if (f & F_CROSS) {
      return T.T_CROSSING;
    }
    if (f & F_ROAD) {
      const d = this.dir(z, w, x, y, F_ROAD);
      if (f & F_BRIDGE) {
        return d === 1 ? T.T_BRIDGE_V : d === 0 ? T.T_BRIDGE_H : T.T_ROAD_X;
      }
      return T.T_ROAD_H + d;
    }
    if (f & F_HWY) {
      return T.T_HWY_H + this.dir(z, w, x, y, F_HWY);
    }
    if (f & F_RAIL) {
      return T.T_RAIL_H + this.dir(z, w, x, y, F_RAIL);
    }
    return f >> F_BASE_SHIFT;
  }
}
