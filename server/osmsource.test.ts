import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as T from "./terrain";
import { OsmSource } from "./osmsource";
import { ARM_E, ARM_N, ARM_S, ARM_W, SHAPES, railTile, roadTile } from "./rail";
import {
  B3_CLIFF, B3_RAIL_UNDER, B3_ROAD_UNDER, B3_HWY, B3_SLOPE_SHIFT, BLOCK_SIZE, CELLS, classId, createDb, writeBlock,
} from "./worlddb";

const GRASS = classId("natural", "grass"), FOREST = classId("landuse", "forest");
const FARM = classId("landuse", "farmland"), URBAN = classId("landuse", "residential");
const WATER = classId("natural", "water"), SEA = classId("sea", "sea");
const BUILDING = classId("building", "yes"), WETLAND = classId("natural", "wetland");
const SCREE = classId("natural", "scree"), ROCKAREA = classId("natural", "bare_rock");
const RESIDENTIAL = classId("highway", "residential"), TRUNK = classId("highway", "trunk"), TERTIARY = classId("highway", "tertiary");
const FOOTWAY = classId("highway", "footway"), RAIL = classId("railway", "rail");
const STATION = classId("building", "train_station");

/** 全マス area の 256x256 ブロック。 */
function blockOf(area: number): Uint8Array {
  const c = new Uint8Array(CELLS * 4);
  for (let i = 0; i < CELLS; i++) c[i * 4] = area;
  return c;
}
function put(c: Uint8Array, x: number, y: number, b0?: number, b1?: number, b2?: number, b3?: number) {
  const o = (y * BLOCK_SIZE + x) * 4;
  if (b0 !== undefined) c[o] = b0;
  if (b1 !== undefined) c[o + 1] = b1;
  if (b2 !== undefined) c[o + 2] = b2;
  if (b3 !== undefined) c[o + 3] = b3;
}

const BX = 100, BY = 50;                 // 試作ブロック (z18 のマス座標は BX*256+lx)
const X0 = BX * BLOCK_SIZE, Y0 = BY * BLOCK_SIZE;

let dir: string, src: OsmSource;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "osmsource-"));
  const db = createDb(join(dir, "world.sqlite"));

  // ブロック A: 草原に道路・線路・水・建物など
  const a = blockOf(GRASS);
  for (let x = 0; x < 256; x++) put(a, x, 10, undefined, TERTIARY);          // 横の道路 (z16 まで出る)
  for (let y = 0; y < 256; y++) put(a, 20, y, undefined, RESIDENTIAL);       // 縦の道路 (x=20)
  for (let y = 0; y < 256; y++) put(a, 100, y, undefined, undefined, RAIL);  // 縦の線路 (x=100)
  for (let x = 40; x < 50; x++) { put(a, x, 9, WATER); put(a, x, 10, WATER); put(a, x, 11, WATER); }
  put(a, 60, 10, undefined, undefined, undefined, B3_ROAD_UNDER);            // 道路が上の線の下を通って隠れているマス
  put(a, 70, 60, undefined, undefined, undefined, B3_RAIL_UNDER);            // 線路が上の線の下を通って隠れているマス
  for (let x = 0; x < 256; x++) put(a, x, 30, undefined, undefined, undefined, B3_HWY);  // 高速道路
  put(a, 5, 30, undefined, RESIDENTIAL, undefined, B3_HWY);                  // 一般道路の下をくぐる
  put(a, 5, 40, BUILDING);
  put(a, 6, 40, WETLAND);
  put(a, 7, 40, WETLAND, FOOTWAY);                                           // 木道は通れる道路
  put(a, 8, 40, ROCKAREA);
  put(a, 9, 40, GRASS, undefined, undefined, 6 << B3_SLOPE_SHIFT);           // 45° 以上
  put(a, 10, 40, FOREST, undefined, undefined, 4 << B3_SLOPE_SHIFT);         // 25° 以上の森
  put(a, 11, 40, FARM, undefined, undefined, 4 << B3_SLOPE_SHIFT);           // 農地は草と同じで、山にならない
  put(a, 12, 40, SCREE);
  put(a, 13, 40, GRASS, undefined, undefined, B3_CLIFF);
  put(a, 14, 40, URBAN);
  // 線路の曲がり: (150,150) は東と南につながる ┌、(160,160) は西と北につながる ┘
  for (const [x, y] of [[150, 150], [151, 150], [150, 151], [159, 160], [160, 160], [160, 159]]) put(a, x, y, undefined, undefined, RAIL);
  // 階段状の線路 (斜めの線は 4 連結に直してある): (170,170) (171,170) (171,171) (172,171) (172,172)
  for (const [x, y] of [[170, 170], [171, 170], [171, 171], [172, 171], [172, 172]]) put(a, x, y, undefined, undefined, RAIL);
  // 線路の T 字: (180,100) は西・東・南 → 横
  for (const [x, y] of [[179, 100], [180, 100], [181, 100], [180, 101]]) put(a, x, y, undefined, undefined, RAIL);
  // 駅 (面): (200..203, 220..223)
  for (let y = 220; y < 224; y++) for (let x = 200; x < 204; x++) put(a, x, y, STATION);
  // z17 に集約する確認: (200,200) の 2x2 のうち 1 マスだけ道路
  put(a, 201, 200, undefined, TERTIARY);
  put(a, 201, 201, undefined, FOOTWAY);                                      // 歩道は z17 では出ない
  writeBlock(db, BX, BY, a);

  // ブロック B: 森に全面が山 (傾斜 25° 以上)
  const b = blockOf(FOREST);
  for (let i = 0; i < CELLS; i++) b[i * 4 + 3] = 4 << B3_SLOPE_SHIFT;
  writeBlock(db, BX + 1, BY, b);

  // ブロック C: 全マス同じ → data は NULL
  writeBlock(db, BX + 2, BY, blockOf(URBAN));

  // 北のブロック列: 高速でない主要道路が東西に連続 (z10 の代表値の確認用)
  for (let i = 0; i < 3; i++) {
    const c = blockOf(FOREST);
    put(c, 3, 3, undefined, TRUNK, undefined, B3_HWY);    // 一般道路 (z10 以下では出ない) と高速道路
    writeBlock(db, BX + i, BY - 3, c);
  }
  db.close();
  src = new OsmSource(join(dir, "world.sqlite"));
});

afterAll(() => {
  src.close();
  rmSync(dir, { recursive: true, force: true });
});

const isRoad = (id: number) => id >= T.T_ROAD && id < T.T_ROAD + T.N_SHAPES;
const c18 = (lx: number, ly: number, bx = 0) => src.cell(18, X0 + bx * 256 + lx, Y0 + ly);

describe("OsmSource z18", () => {
  test("道路は、上下左右につながる方向のタイル (罫線スタイル)", () => {
    expect(c18(5, 10)).toBe(roadTile(ARM_E | ARM_W));        // 横の道路 ─
    expect(c18(20, 5)).toBe(roadTile(ARM_S | ARM_N));        // 縦の道路 │
    expect(c18(20, 10)).toBe(roadTile(15));                  // 交差 ┼
    expect(c18(0, 10)).toBe(roadTile(ARM_E | ARM_W));        // 行き止まり (端) は、その軸の直線
    expect(c18(140, 140)).toBe(T.T_GRASS);
  });

  test("橋: 水の上の道路", () => {
    expect(c18(45, 10)).toBe(roadTile(ARM_E | ARM_W));
    expect(c18(60, 10)).toBe(roadTile(ARM_E | ARM_W));
    expect(c18(45, 5)).toBe(T.T_GRASS);
    expect(c18(45, 9)).toBe(T.T_WATER);
  });

  test("線路と踏切 (直交する直線だけ踏切の絵。重なったマスは「道路でもある」)", () => {
    expect(c18(100, 5)).toBe(railTile(ARM_S | ARM_N));       // 縦 (南北)
    expect(c18(100, 10)).toBe(T.T_CROSSING_V);               // 線路が縦、道路が横
    expect(src.flags(18, X0 + 100, Y0 + 10)).toBe(T.F_ROAD_TOO);
    expect(src.flags(18, X0 + 100, Y0 + 5)).toBe(0);         // 線路だけ
    expect(src.flags(18, X0 + 5, Y0 + 10)).toBe(0);          // 道路だけ
    expect(src.flags(18, X0 + 60, Y0 + 10)).toBe(T.F_ROAD_TOO);   // 隠れて通る道路
    expect(src.flags(18, X0 + 70, Y0 + 60)).toBe(T.F_RAIL_TOO);   // 隠れて通る線路
    expect(c18(70, 60)).toBe(T.T_GRASS);                          // 絵は出ない
  });

  test("高速道路も道路と同じ", () => {
    expect(c18(50, 30)).toBe(roadTile(ARM_E | ARM_W));
    expect(c18(5, 30)).toBe(roadTile(ARM_E | ARM_W));
  });

  test("線路は、つながる方向 (上下左右) のタイルで描く。行き止まりは直線、斜めはない", () => {
    expect(c18(150, 150)).toBe(railTile(ARM_E | ARM_S));     // 東・南 (┌)
    expect(c18(151, 150)).toBe(railTile(ARM_E | ARM_W));     // 西だけにつながる端は、横の直線
    expect(c18(150, 151)).toBe(railTile(ARM_S | ARM_N));
    expect(c18(160, 160)).toBe(railTile(ARM_W | ARM_N));     // 西・北 (┘)
    expect(c18(180, 100)).toBe(railTile(ARM_E | ARM_S | ARM_W));   // T 字 (西・東・南) ┬
    expect(c18(179, 100)).toBe(railTile(ARM_E | ARM_W));
  });

  test("階段状の線路: └┐ の連なりになる", () => {
    expect(c18(170, 170)).toBe(railTile(ARM_E | ARM_W));     // 端 (東だけ)
    expect(c18(171, 170)).toBe(railTile(ARM_S | ARM_W));     // ┐
    expect(c18(171, 171)).toBe(railTile(ARM_N | ARM_E));     // └
    expect(c18(172, 171)).toBe(railTile(ARM_S | ARM_W));     // ┐
    expect(c18(172, 172)).toBe(railTile(ARM_S | ARM_N));     // 端 (北だけ)
    expect(SHAPES.length).toBe(T.N_SHAPES);
  });

  test("駅", () => {
    expect(c18(201, 221)).toBe(T.T_STATION);
    expect(c18(199, 221)).toBe(T.T_GRASS);
    // z17 は 2x2 マス。駅が 1/4 以上なら駅になる
    expect(src.cell(17, (X0 + 200) / 2, (Y0 + 220) / 2)).toBe(T.T_STATION);
  });

  test("面と傾斜", () => {
    expect(c18(5, 40)).toBe(T.T_BUILDING);
    expect(c18(6, 40)).toBe(T.T_WETLAND);
    expect(c18(7, 40)).not.toBe(T.T_WETLAND);   // 木道
    expect(c18(8, 40)).toBe(T.T_ROCK);
    expect(c18(9, 40)).toBe(T.T_ROCK);
    expect(c18(10, 40)).toBe(T.T_MOUNTAIN);
    expect(c18(11, 40)).toBe(T.T_GRASS);
    expect(c18(12, 40)).toBe(T.T_MOUNTAIN);
    expect(c18(13, 40)).toBe(T.T_ROCK);
    expect(c18(14, 40)).toBe(T.T_BUILDING);
  });

  test("NULL の data と範囲外", () => {
    expect(c18(10, 10, 2)).toBe(T.T_BUILDING);
    expect(src.cell(18, X0 - 5, Y0)).toBe(T.T_WATER);        // 行がない場所は水
    expect(src.cell(18, X0, -1)).toBe(T.T_ROCK);
  });

  test("ブロックの境目をまたいで向きが決まる", () => {
    // 右端の道路は、隣のブロック (x=256) の道路とつながる
    expect(c18(255, 10)).toBe(roadTile(ARM_E | ARM_W));
  });
});

describe("OsmSource 集約", () => {
  test("z17: 子マスのどれかに道路があれば道路。歩道は消える", () => {
    expect(isRoad(src.cell(17, (X0 + 200) / 2, (Y0 + 200) / 2))).toBe(true);
    expect(src.cell(17, (X0 + 202) / 2, (Y0 + 200) / 2)).toBe(T.T_GRASS);
  });

  test("z17: 道路の下が水なら橋", () => {
    expect(isRoad(src.cell(17, (X0 + 44) / 2, (Y0 + 10) / 2))).toBe(true);
  });

  test("z16: 同じ子マスに道路と線路があれば、重なり (線路と直交する直線なら踏切)", () => {
    expect(src.cell(16, (X0 + 100) / 4, Y0 / 4 + 2)).toBe(T.T_CROSSING_V);   // (100,10) を含む
  });

  test("z11: 全マスが山の斜面なら山", () => {
    expect(src.cell(11, (X0 + BLOCK_SIZE) / 128, Y0 / 128)).toBe(T.T_MOUNTAIN);
  });

  test("z10: 代表値。高速道路が東西に続けば横の高速道路。一般道路は出ない", () => {
    expect(isRoad(src.cell(10, BX + 1, BY - 3))).toBe(true);
    expect(src.cell(10, BX + 1, BY)).toBe(T.T_MOUNTAIN);     // mount_pct 100%
    expect(src.cell(10, BX + 2, BY)).toBe(T.T_BUILDING);
  });

  test("z8 以下: 高速道路は、マスの半分以上を横切るときだけ出す", () => {
    // 高速道路のブロックは (BX..BX+2, BY-3) の 3 つ。まわりは範囲外 (海) なので、道路か橋 (水の上) になる
    const road = (z: number, x: number, y: number) => isRoad(src.cell(z, x, y));
    expect(road(9, BX >> 1, (BY - 3) >> 1)).toBe(true);        // 2 ブロック四方 → 1 つあれば
    expect(road(8, BX >> 2, (BY - 3) >> 2)).toBe(true);        // 4 ブロック四方 → 2 つ以上 (3 つある)
    expect(road(7, BX >> 3, (BY - 3) >> 3)).toBe(false);       // 8 ブロック四方 → 4 つ要る (3 つしかない)
  });

  test("z8: 範囲外と、ブロックが少ししかない所は海 (多数決)", () => {
    expect(src.cell(8, 0, 0)).toBe(T.T_WATER);
    expect(src.cell(8, (BX + 1) >> 2, BY >> 2)).toBe(T.T_WATER);
  });

  test("全ズームで ID が範囲内", () => {
    for (let z = 1; z <= 18; z++) {
      const k = 1 << (18 - z);
      for (const dx of [-1, 0, 1]) {
        const t = src.cell(z, Math.floor(X0 / k) + dx, Math.floor(Y0 / k));
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(T.T_STATION);
      }
    }
  });
});

test("海のラベルがあれば sea の id が使われる", () => {
  expect(SEA).toBeGreaterThan(0);
});
