/**
 * world.sqlite の形式 (doc/tile-conversion-plan.md の 5 章)。
 * 事前ビルド (将来のビルダー) と実行時 (osmsource.ts)、テストの試作 DB が共有する。
 */
import { Database } from "bun:sqlite";
import { deflateSync } from "node:zlib";

export const BLOCK_ZOOM = 18;
export const BLOCK_SIZE = 256;                 // 1 ブロック = z18 の 256x256 マス (= z10 の 1 マス)
export const CELLS = BLOCK_SIZE * BLOCK_SIZE;

export const KIND_AREA = 0, KIND_ROAD = 1, KIND_RAIL = 2;

/** 面の意味。種別ごとにゲームの地形が決まる (osmsource.ts の AREA_TERRAIN)。 */
export type AreaCat =
  | "grass" | "forest" | "urban" | "building" | "sand" | "snow" | "farm"
  | "water" | "wetland" | "rock" | "scree";

export interface ClassDef {
  kind: number;
  key: string;
  value: string;
  rank: number;        // 面: 重なったときの勝ち順 / 道路・線路: 大きいほど幹線
  cat?: AreaCat;       // 面のみ
}

/**
 * OSM 種別の一覧。id は 1 から始まる並び順で振る (0 = なし)。
 * 道路の rank のしきい値は osmsource.ts の ROAD_MIN / RAIL_MIN。
 */
export const CLASSES: ClassDef[] = [
  // 面 (rank 小 → 大の順に塗られ、大きいものが上に来る)
  { kind: KIND_AREA, key: "natural", value: "grass", rank: 1, cat: "grass" },
  { kind: KIND_AREA, key: "landuse", value: "meadow", rank: 2, cat: "farm" },
  { kind: KIND_AREA, key: "landuse", value: "farmland", rank: 2, cat: "farm" },
  { kind: KIND_AREA, key: "landuse", value: "orchard", rank: 2, cat: "farm" },
  { kind: KIND_AREA, key: "landuse", value: "forest", rank: 3, cat: "forest" },
  { kind: KIND_AREA, key: "natural", value: "wood", rank: 3, cat: "forest" },
  { kind: KIND_AREA, key: "natural", value: "beach", rank: 4, cat: "sand" },
  { kind: KIND_AREA, key: "natural", value: "sand", rank: 4, cat: "sand" },
  { kind: KIND_AREA, key: "natural", value: "glacier", rank: 4, cat: "snow" },
  { kind: KIND_AREA, key: "natural", value: "scree", rank: 5, cat: "scree" },
  { kind: KIND_AREA, key: "natural", value: "shingle", rank: 5, cat: "scree" },
  { kind: KIND_AREA, key: "natural", value: "bare_rock", rank: 6, cat: "rock" },
  { kind: KIND_AREA, key: "landuse", value: "residential", rank: 7, cat: "urban" },
  { kind: KIND_AREA, key: "landuse", value: "commercial", rank: 7, cat: "urban" },
  { kind: KIND_AREA, key: "landuse", value: "retail", rank: 7, cat: "urban" },
  { kind: KIND_AREA, key: "landuse", value: "industrial", rank: 7, cat: "urban" },
  { kind: KIND_AREA, key: "natural", value: "wetland", rank: 8, cat: "wetland" },
  { kind: KIND_AREA, key: "natural", value: "water", rank: 9, cat: "water" },
  { kind: KIND_AREA, key: "waterway", value: "riverbank", rank: 9, cat: "water" },
  { kind: KIND_AREA, key: "landuse", value: "reservoir", rank: 9, cat: "water" },
  { kind: KIND_AREA, key: "sea", value: "sea", rank: 9, cat: "water" },
  { kind: KIND_AREA, key: "building", value: "yes", rank: 10, cat: "building" },
  // 道路 (高速道路は byte3 の bit5 で持つので入れない)
  { kind: KIND_ROAD, key: "highway", value: "trunk", rank: 90 },
  { kind: KIND_ROAD, key: "highway", value: "primary", rank: 80 },
  { kind: KIND_ROAD, key: "highway", value: "secondary", rank: 70 },
  { kind: KIND_ROAD, key: "highway", value: "tertiary", rank: 60 },
  { kind: KIND_ROAD, key: "highway", value: "unclassified", rank: 50 },
  { kind: KIND_ROAD, key: "highway", value: "residential", rank: 45 },
  { kind: KIND_ROAD, key: "highway", value: "living_street", rank: 40 },
  { kind: KIND_ROAD, key: "highway", value: "service", rank: 35 },
  { kind: KIND_ROAD, key: "highway", value: "track", rank: 30 },
  { kind: KIND_ROAD, key: "highway", value: "pedestrian", rank: 25 },
  { kind: KIND_ROAD, key: "highway", value: "footway", rank: 20 },
  { kind: KIND_ROAD, key: "highway", value: "path", rank: 20 },
  { kind: KIND_ROAD, key: "highway", value: "steps", rank: 20 },
  // 線路
  { kind: KIND_RAIL, key: "railway", value: "rail", rank: 90 },
  { kind: KIND_RAIL, key: "railway", value: "subway", rank: 70 },
  { kind: KIND_RAIL, key: "railway", value: "light_rail", rank: 60 },
  { kind: KIND_RAIL, key: "railway", value: "tram", rank: 50 },
];

export function classId(key: string, value: string): number {
  const i = CLASSES.findIndex((c) => c.key === key && c.value === value);
  if (i < 0) {
    throw new Error(`unknown class ${key}=${value}`);
  }
  return i + 1;
}

// byte3 のビット
export const B3_BRIDGE = 1, B3_CLIFF = 2, B3_HWY = 32;
export const B3_SLOPE_SHIFT = 2;              // bit2〜4 = 傾斜の段階 0〜7
// 傾斜の段階: 0:<5° 1:<10° 2:<17° 3:<25° 4:<35° 5:<45° 6:<60° 7:60°〜
export const SLOPE_MOUNTAIN = 4;              // 25° 以上
export const SLOPE_ROCK = 6;                  // 45° 以上

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS osm_class (
  id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, rank INTEGER NOT NULL
);
-- data は大きいので最後に置く (代表値だけを読むとき、オーバーフローページをたどらずに済む)
CREATE TABLE IF NOT EXISTS block (
  bx INTEGER NOT NULL, by INTEGER NOT NULL,
  area INTEGER NOT NULL, area_pct INTEGER NOT NULL,
  road INTEGER NOT NULL, rail INTEGER NOT NULL, motorway INTEGER NOT NULL,
  mount_pct INTEGER NOT NULL, rock_pct INTEGER NOT NULL,
  data BLOB,
  PRIMARY KEY (bx, by)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function createDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const ins = db.prepare("INSERT OR REPLACE INTO osm_class VALUES (?, ?, ?, ?, ?)");
  CLASSES.forEach((c, i) => ins.run(i + 1, c.kind, c.key, c.value, c.rank));
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('zoom', ?)").run(String(BLOCK_ZOOM));
  return db;
}

/**
 * 1 ブロックを書く。cells は 256*256*4 バイト (行優先、1 マス b0..b3)。
 * 代表値はここで計算する。全マスが同じ値で b1..b3 が 0 なら data は NULL (= 全マス (area,0,0,0))。
 */
export function writeBlock(db: Database, bx: number, by: number, cells: Uint8Array): void {
  if (cells.length !== CELLS * 4) {
    throw new Error("block must be 256*256*4 bytes");
  }
  const areaOf = new Map<number, number>();
  let road = 0, rail = 0, motorway = 0, mount = 0, rock = 0, uniform = true;
  const catOf = (id: number) => CLASSES[id - 1]?.cat;
  for (let i = 0; i < CELLS; i++) {
    const o = i * 4, a = cells[o], b3 = cells[o + 3];
    areaOf.set(a, (areaOf.get(a) ?? 0) + 1);
    if (cells[o + 1] > road) road = cells[o + 1];
    if (cells[o + 2] > rail) rail = cells[o + 2];
    if (b3 & B3_HWY) motorway = 1;
    const slope = (b3 >> B3_SLOPE_SHIFT) & 7, cat = catOf(a);
    if (cat === "rock" || (b3 & B3_CLIFF) || slope >= SLOPE_ROCK) {
      rock++;
    } else if (cat === "scree" || (slope >= SLOPE_MOUNTAIN && (cat === "forest" || cat === "grass"))) {
      mount++;
    }
    if (uniform && (cells[o + 1] | cells[o + 2] | b3) !== 0) {
      uniform = false;
    }
  }
  let area = 0, best = -1;
  for (const [a, n] of areaOf) {
    if (n > best || (n === best && rankOf(a) > rankOf(area))) {
      area = a; best = n;
    }
  }
  const nullData = uniform && areaOf.size === 1;
  db.prepare("INSERT OR REPLACE INTO block (bx, by, area, area_pct, road, rail, motorway, mount_pct, rock_pct, data)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    bx, by,
    area, Math.round((best * 100) / CELLS),
    topClass(cells, 1), topClass(cells, 2), motorway,
    Math.round((mount * 100) / CELLS), Math.round((rock * 100) / CELLS),
    nullData ? null : deflateSync(cells),
  );
}

function rankOf(id: number): number {
  return CLASSES[id - 1]?.rank ?? 0;
}

/** byte1 (道路) または byte2 (線路) のうち rank が最大の id。なければ 0。 */
function topClass(cells: Uint8Array, byte: 1 | 2): number {
  const seen = new Uint8Array(256);
  for (let i = byte; i < cells.length; i += 4) {
    seen[cells[i]] = 1;
  }
  let top = 0;
  for (let id = 1; id < 256; id++) {
    if (seen[id] && rankOf(id) > rankOf(top)) {
      top = id;
    }
  }
  return top;
}
