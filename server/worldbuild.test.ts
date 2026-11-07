import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dem, decodePng, rgbToElevation } from "./dem";
import { FIX, FeatureStore, IdMap, areaClassOf, assembleRings, latToY, lineAttrsOf, loadFeatures, lonToX } from "./osmfeatures";
import { scanPbf } from "./osmpbf";
import { OsmSource } from "./osmsource";
import { assembleChains, landFromCoast } from "./coast";
import { fillRings, lineCells, linePathThin } from "./rasterize";
import { RAIL_PAIRS, crossingFor, railConnections, railPair, railTile } from "./rail";
import { readPolygons } from "./shapefile";
import * as T from "./terrain";
import {
  cellToLonLat, cellToMeters, elevationToRgb, encodePng, writePbf, writeShp, type TNode, type TWay,
} from "./testutil";
import { BLOCK_M, CELL_M, MERC, Painter, blockRange, lonLatToBlock, slopeLevel, slopeLevels, stationMarkers } from "./worldbuild";
import { BLOCK_SIZE, classId, createDb, writeBlock } from "./worlddb";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "wb-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("座標", () => {
  test("東京駅は z14 のタイル (14552, 6451)", () => {
    expect(lonLatToBlock(139.7671, 35.6812)).toEqual([14552, 6451]);
  });

  test("度 ↔ マス座標", () => {
    const [lon, lat] = cellToLonLat(14552 * 256 + 10.5, 6451 * 256 + 99.25);
    expect(lonToX(lon)).toBeCloseTo(14552 * 256 + 10.5, 4);
    expect(latToY(lat)).toBeCloseTo(6451 * 256 + 99.25, 4);
    expect(BLOCK_M / BLOCK_SIZE).toBeCloseTo(CELL_M, 9);
  });

  test("bbox を覆うブロック", () => {
    const r = blockRange([139.7, 35.6, 139.8, 35.7]);
    const [bx, by] = lonLatToBlock(139.75, 35.65);
    expect(bx >= r.bx0 && bx <= r.bx1 && by >= r.by0 && by <= r.by1).toBe(true);
  });
});

describe("ラスタライズ", () => {
  const win = { x0: 0, y0: 0, x1: 20, y1: 20 };

  test("多角形: 中心が内側のマスだけ。穴は抜ける", () => {
    const cells = new Set<string>();
    const sq = (a: number, b: number) => Float64Array.from([a, a, b, a, b, b, a, b]);
    fillRings([sq(2, 10), sq(4, 8)], win, (y, xa, xb) => { for (let x = xa; x < xb; x++) cells.add(`${x},${y}`); });
    expect(cells.size).toBe(8 * 8 - 4 * 4);
    expect(cells.has("2,2")).toBe(true);
    expect(cells.has("5,5")).toBe(false);
    expect(cells.has("10,5")).toBe(false);
  });

  test("多角形: 窓で切る。三角形の面積はおおむね合う", () => {
    let n = 0;
    fillRings([Float64Array.from([-5, -5, 15, -5, -5, 15])], win, (_y, xa, xb) => { n += xb - xa; });
    expect(n).toBeGreaterThan(40);
    expect(n).toBeLessThan(55);
  });

  test("線: 触れたマスを 4 連結で全部", () => {
    const cells: [number, number][] = [];
    lineCells(0.5, 0.5, 9.5, 4.5, win, (x, y) => cells.push([x, y]));
    expect(cells[0]).toEqual([0, 0]);
    expect(cells[cells.length - 1]).toEqual([9, 4]);
    for (let i = 1; i < cells.length; i++) {
      expect(Math.abs(cells[i][0] - cells[i - 1][0]) + Math.abs(cells[i][1] - cells[i - 1][1])).toBe(1);
    }
    const back: [number, number][] = [];
    lineCells(9.5, 4.5, 0.5, 0.5, win, (x, y) => back.push([x, y]));
    expect(new Set(back.map(String))).toEqual(new Set(cells.map(String)));
  });

  test("線: 窓の外は塗らない", () => {
    const cells: [number, number][] = [];
    lineCells(-100, 5.5, 100, 5.5, win, (x, y) => cells.push([x, y]));
    expect(cells.length).toBe(20);
  });
});

describe("海岸線から陸", () => {
  const win = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const area = (rings: Float64Array[]) => {
    let n = 0;
    fillRings(rings, win, (_y, xa, xb) => { n += xb - xa; });
    return n;
  };
  const chain = (...p: number[]) => Float64Array.from(p);

  test("鎖をつなぐ (向きは変えない)", () => {
    const c = assembleChains([[3, 4, 5], [1, 2, 3], [9, 8]]);
    expect(c.map((x) => x.join()).sort()).toEqual(["1,2,3,4,5", "9,8"]);
    expect(assembleChains([[1, 2], [2, 3], [3, 1]])[0].length).toBe(4);     // 輪
  });

  test("東へ進む海岸線: 北 (y が小さい側) が陸", () => {
    const c = landFromCoast([chain(-20, 50, 120, 50)], win, false);
    expect(area(c.parts)).toBe(100 * 50);
    let north = false, south = false;
    fillRings(c.parts, win, (y) => { if (y === 10) north = true; if (y === 90) south = true; });
    expect([north, south]).toEqual([true, false]);
  });

  test("南へ進む海岸線: 東が陸", () => {
    const c = landFromCoast([chain(50, -10, 50, 110)], win, false);
    let east = false, west = false;
    fillRings(c.parts, win, (_y, xa, xb) => { if (xa <= 80 && xb > 80) east = true; if (xa <= 20 && xb > 20) west = true; });
    expect(area(c.parts)).toBe(50 * 100);
    expect([east, west]).toEqual([true, false]);
  });

  test("斜めの海岸線が角をまたぐ: 左上の三角形が陸", () => {
    const c = landFromCoast([chain(-20, 60, 60, -20)], win, false);        // x+y=40 を北東へ
    expect(c.parts.length).toBe(1);
    expect(area(c.parts)).toBeGreaterThan(700);
    expect(area(c.parts)).toBeLessThan(850);
  });

  test("2 本の海岸線で挟まれた陸 (半島の付け根)", () => {
    const c = landFromCoast([chain(-10, 30, 110, 30), chain(110, 70, -10, 70)], win, false);
    expect(area(c.parts)).toBe(100 * 30 + 100 * 30);
  });

  test("島 (陸を囲む輪) と、陸の中の水の輪", () => {
    const island = chain(60, 40, 40, 40, 40, 60, 60, 60, 60, 40);
    expect(area(landFromCoast([island], win, false).parts)).toBe(400);
    const lake = chain(40, 40, 60, 40, 60, 60, 40, 60, 40, 40);                 // 逆回り = 水が内側
    expect(landFromCoast([lake], win, false).parts.length).toBe(2);
    expect(area(landFromCoast([lake], win, false).parts)).toBe(100 * 100 - 400);
  });

  test("海岸線がなければ、陸の地物があるときだけ陸", () => {
    expect(area(landFromCoast([], win, true).parts)).toBe(100 * 100);
    expect(landFromCoast([], win, false).parts.length).toBe(0);
    expect(landFromCoast([chain(500, 500, 600, 500)], win, false).parts.length).toBe(0);
  });

  test("端が窓の中で途切れた海岸線 (抽出範囲の境) は、向きのまま枠まで延ばして閉じる", () => {
    const c = landFromCoast([chain(-20, 50, 60, 50)], win, false);       // 東へ進んで x=60 で終わる
    expect(c.extended).toBe(1);
    expect(area(c.parts)).toBe(100 * 50);
    const d = landFromCoast([chain(40, 50, 40, 20, 120, 20)], win, false);   // 始点が窓の中: 北へ進んでから東へ
    expect(d.extended).toBe(1);
    expect(d.parts.length).toBe(1);
  });
});

describe("細い線 (線路用の 8 連結)", () => {
  const win = { x0: -50, y0: -50, x1: 150, y1: 150 };
  const cellsOf = (path: number[]) => {
    const out = new Set<string>();
    linePathThin(Float64Array.from(path), win, (x, y) => out.add(`${x},${y}`));
    return out;
  };
  /** 8 連結の成分の数 */
  const components = (cells: Set<string>) => {
    const seen = new Set<string>(); let n = 0;
    for (const start of cells) {
      if (seen.has(start)) continue;
      n++;
      const stack = [start]; seen.add(start);
      while (stack.length) {
        const [x, y] = stack.pop()!.split(",").map(Number);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const k = `${x + dx},${y + dy}`;
          if (cells.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
        }
      }
    }
    return n;
  };

  test("45° の線は、1 マスに 1 つの斜めの鎖", () => {
    const c = cellsOf([0.5, 0.5, 10.5, 10.5]);
    expect([...c].sort()).toEqual(Array.from({ length: 11 }, (_, i) => `${i},${i}`).sort());
  });

  test("横の線は、各列に 1 マス。緩やかな角度の線は 8 連結で、横の走りと斜めの 1 歩になる", () => {
    expect(cellsOf([0.5, 5.5, 9.5, 5.5]).size).toBe(10);
    const c = cellsOf([0.5, 0.5, 30.5, 10.5]);                  // 傾き 1/3
    expect(components(c)).toBe(1);
    expect(c.size).toBeLessThanOrEqual(33);                     // 1 列に 1 マス (斜めの歩みを含めて)
    const cols = new Map<number, number>();
    for (const k of c) { const x = Number(k.split(",")[0]); cols.set(x, (cols.get(x) ?? 0) + 1); }
    expect([...cols.values()].every((n) => n === 1)).toBe(true);
  });

  test("円弧は途切れず 1 本につながる (傾き 45° 付近で 1 マス飛ばない)", () => {
    for (const r of [6, 9, 15, 40]) {
      const arc: number[] = [];
      for (let a = 200; a <= 340; a += 2) arc.push(50 + r * Math.cos((a * Math.PI) / 180), 50 + r * Math.sin((a * Math.PI) / 180));
      expect(components(cellsOf(arc))).toBe(1);
    }
  });

  test("折れ線の継ぎ目や、窓の外は塗らない", () => {
    const c = cellsOf([140.5, 10.5, 160.5, 10.5]);               // 窓は x < 150
    expect(Math.max(...[...c].map((k) => Number(k.split(",")[0])))).toBe(149);
  });
});

describe("線路のタイル (server/rail.ts)", () => {
  test("組み合わせは 20 種: 直線 4 + 45° の曲がり 8 + 90° の曲がり 8", () => {
    expect(RAIL_PAIRS.length).toBe(20);
    const sep = (a: number, b: number) => Math.min(b - a, 8 - (b - a));
    expect(RAIL_PAIRS.filter(([a, b]) => sep(a, b) === 4).length).toBe(4);
    expect(RAIL_PAIRS.filter(([a, b]) => sep(a, b) === 3).length).toBe(8);
    expect(RAIL_PAIRS.filter(([a, b]) => sep(a, b) === 2).length).toBe(8);
    expect(new Set(RAIL_PAIRS.map(([a, b]) => railTile(a, b))).size).toBe(20);
  });

  test("通る 2 方向の選び方", () => {
    expect(railPair([])).toEqual([0, 4]);                         // 孤立: 横
    expect(railPair([6])).toEqual([6, 2]);                        // 端: その方向の直線
    expect(railPair([0, 4, 2])).toEqual([0, 4]);                  // T 字: まっすぐな方
    expect(railPair([0, 2])).toEqual([0, 2]);                     // 90° の曲がり
    expect(railPair([0, 1])).toEqual([0, 4]);                     // 鋭い折り返し (45°) は直線にする
    expect(railPair([0, 1, 2, 3, 4, 5, 6, 7])).toEqual([0, 4]);   // 全方向: 横
  });

  test("斜めの隣は、挟む上下左右に線路があれば捨てる (L 字の角を近道しない)", () => {
    const at = (cells: [number, number][]) => (dx: number, dy: number) => cells.some(([x, y]) => x === dx && y === dy);
    expect(railConnections(at([[1, 0], [0, 1], [1, 1]]))).toEqual([0, 2]);   // 東・南は残り、南東は捨てる
    expect(railConnections(at([[1, 1]]))).toEqual([1]);                      // 斜めだけなら残す
  });

  test("踏切の向き: 線路が横寄りなら H、縦寄りなら V", () => {
    expect(crossingFor([0, 4])).toBe("H");
    expect(crossingFor([2, 6])).toBe("V");
    expect(crossingFor([1, 5])).toBe("H");
    expect(crossingFor([0, 2])).toBe("H");
  });
});

describe("PBF と地物", () => {
  test("タグの意味", () => {
    expect(areaClassOf({ landuse: "forest", building: "no" })).toBe(classId("landuse", "forest"));
    expect(areaClassOf({ building: "house", landuse: "residential" })).toBe(classId("building", "yes"));
    expect(areaClassOf({ natural: "coastline" })).toBe(0);
    expect(lineAttrsOf({ highway: "motorway" })).toMatchObject({ hwy: true, road: 0 });
    expect(lineAttrsOf({ highway: "trunk", motorroad: "yes" })).toMatchObject({ hwy: true, road: 0 });
    expect(lineAttrsOf({ highway: "primary_link" })).toMatchObject({ road: classId("highway", "primary") });
    expect(lineAttrsOf({ highway: "residential", bridge: "yes" })).toMatchObject({ bridge: true });
    expect(lineAttrsOf({ highway: "residential", tunnel: "yes" })).toBeNull();
    expect(lineAttrsOf({ highway: "footway", footway: "sidewalk" })).toBeNull();
    expect(lineAttrsOf({ highway: "footway", footway: "crossing" })).toBeNull();
    expect(lineAttrsOf({ highway: "footway" })).toMatchObject({ road: classId("highway", "footway") });
    expect(lineAttrsOf({ waterway: "stream" })).toBeNull();
    expect(lineAttrsOf({ waterway: "river" })).toMatchObject({ river: true });
    expect(lineAttrsOf({ railway: "abandoned" })).toBeNull();
  });

  test("IdMap", () => {
    const m = new IdMap(4);
    for (let i = 1; i <= 1000; i++) m.set(i * 4294967311, i / 100, -i / 100);
    expect(m.size).toBe(1000);
    const s = m.find(500 * 4294967311);
    expect(m.lat[s]).toBe(5e7);
    expect(m.lon[s]).toBe(-5e7);
    expect(m.find(7)).toBe(-1);
  });

  test("リングをつなぐ", () => {
    const rings = assembleRings([[1, 2, 3], [5, 4, 3], [5, 6, 1], [10, 11, 12, 10], [20, 21]]);
    expect(rings.length).toBe(2);
    expect(rings.map((r) => r.length).sort()).toEqual([4, 7]);
  });

  test("PBF を読み戻す", async () => {
    const path = join(dir, "t.pbf");
    const nodes: TNode[] = [{ id: 10, lat: 35.5, lon: 139.5, tags: { railway: "station", name: "テスト駅" } },
      { id: 4294967400, lat: 35.6, lon: 139.6 }, { id: 4294967500, lat: -10.25, lon: -70.125, tags: { amenity: "cafe" } }];
    await writePbf(path, {
      nodes,
      ways: [{ id: 1, tags: { highway: "residential", name: "x" }, refs: [10, 4294967400, 4294967500] }],
      rels: [{ id: 9, tags: { type: "multipolygon", landuse: "forest" },
        members: [{ type: 1, id: 1, role: "outer" }, { type: 1, id: 5, role: "inner" }] }],
    });
    const got = { n: [] as number[][], t: [] as unknown[], w: [] as unknown[], r: [] as unknown[] };
    await scanPbf(path, {
      node: (id, lat, lon) => got.n.push([id, lat, lon]),
      taggedNode: (id, _lat, _lon, tags) => got.t.push([id, tags]),
      way: (id, tags, refs) => got.w.push([id, tags, refs]),
      relation: (id, tags, m) => got.r.push([id, tags, m]),
    });
    expect(got.n.length).toBe(3);
    expect(got.t).toEqual([[10, { railway: "station", name: "テスト駅" }], [4294967500, { amenity: "cafe" }]]);   // タグのあるノードだけ
    expect(got.n[1][0]).toBe(4294967400);
    expect(got.n[2][1]).toBeCloseTo(-10.25, 6);
    expect(got.n[2][2]).toBeCloseTo(-70.125, 6);
    expect(got.w).toEqual([[1, { highway: "residential", name: "x" }, [10, 4294967400, 4294967500]]]);
    expect(got.r).toEqual([[9, { type: "multipolygon", landuse: "forest" },
      [{ type: 1, id: 1, role: "outer" }, { type: 1, id: 5, role: "inner" }]]]);
  });
});

describe("shapefile / 標高", () => {
  test("多角形を読み、範囲外は読まない", async () => {
    const path = join(dir, "land.shp");
    const a = 1000.5 * 256, b = 1000.5 * 256 + 100;
    await writeShp(path, [
      [[[a, a], [b, a], [b, b], [a, b], [a, a]]],
      [[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]],
    ]);
    const [x0, y0] = cellToMeters(a - 5, b + 5), [x1, y1] = cellToMeters(b + 5, a - 5);
    const polys = await readPolygons(path, [x0, y0, x1, y1]);
    expect(polys.length).toBe(1);
    expect(polys[0].minx).toBeCloseTo(a, 3);
    expect(polys[0].maxy).toBeCloseTo(b, 3);
    expect(polys[0].parts[0].length).toBe(10);
  });

  test("PNG のフィルタと標高の符号", () => {
    const w = 8, h = 10, rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) & 255;
    const d = decodePng(encodePng(w, h, rgb));
    expect([d.w, d.h]).toEqual([w, h]);
    expect([...d.rgb]).toEqual([...rgb]);
    expect(rgbToElevation(...elevationToRgb(123.45))).toBeCloseTo(123.45, 2);
    expect(rgbToElevation(...elevationToRgb(-12.3))).toBeCloseTo(-12.3, 2);
    expect(rgbToElevation(128, 0, 0)).toBe(0);
  });

  test("傾斜の段階の境目と、斜面の傾斜", () => {
    expect([0, 4.9, 5, 24.9, 25, 44.9, 45, 59.9, 60, 89].map(slopeLevel)).toEqual([0, 0, 1, 3, 4, 5, 6, 6, 7, 7]);
    const w = 4, h = 4, ew = w + 2, ymax = 4.2e6;
    const g = CELL_M / Math.cosh((ymax - 2 * CELL_M) / 6378137);
    const elev = new Float32Array(ew * (h + 2));
    for (let y = 0; y < h + 2; y++) for (let x = 0; x < ew; x++) elev[y * ew + x] = x * g * 1.1;   // 約 48°
    expect([...slopeLevels(elev, w, h, ymax)].every((v) => v === 6)).toBe(true);
  });

  test("DEM: 隣のタイルをまたいで傾斜が連続する", () => {
    const bx = 1000, by = 500;
    const mk = (f: (x: number) => number) => {
      const rgb = new Uint8Array(256 * 256 * 3);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) rgb.set(elevationToRgb(f(x)), (y * 256 + x) * 3);
      return encodePng(256, 256, rgb);
    };
    const put = (x: number, y: number, png: Uint8Array) => {
      mkdirSync(join(dir, "dem", "14", String(x)), { recursive: true });
      writeFileSync(join(dir, "dem", "14", String(x), `${y}.png`), png);
    };
    const ymax = MERC - by * BLOCK_M, g = CELL_M / Math.cosh(ymax / 6378137);
    put(bx, by, mk((x) => x * g * 1.1));                // 東へ急な上り
    put(bx + 1, by, mk((x) => (x + 256) * g * 1.1));    // 続き
    const s = new Dem(join(dir, "dem")).slope(bx, by, ymax)!;
    expect(s[10 * 256 + 255]).toBe(6);                  // 右端 (隣のタイルを使うので連続)
    expect(s[10 * 256 + 128]).toBe(6);
    expect(new Dem(join(dir, "dem")).slope(1, 1, ymax)).toBeNull();
  });
});

describe("駅のマスの位置", () => {
  const sq = (a: number, b: number) => Float64Array.from([a, a, b, a, b, b, a, b]);
  const mk = () => {
    const store = new FeatureStore();
    store.add({ rank: 11, area: classId("public_transport", "station") }, [sq(100, 140)]);     // 重心 (120, 120)
    return store;
  };

  test("点の駅を先に採用し、近くの面の重心は捨てる", () => {
    expect(stationMarkers(mk(), [[110, 110]])).toEqual([[110, 110]]);              // 面の重心から 14 マス
  });

  test("遠ければ両方。点どうしの重複は間引く", () => {
    expect(stationMarkers(mk(), [[400, 400]])).toEqual([[400, 400], [120, 120]]);
    expect(stationMarkers(mk(), [[400, 400], [405, 402]])).toEqual([[400, 400], [120, 120]]);
    expect(stationMarkers(new FeatureStore(), [])).toEqual([]);
  });
});

describe("ビルド全体 (合成データ → world.sqlite → OsmSource)", () => {
  const bx = 14552, by = 6451, X0 = bx * 256, Y0 = by * 256;
  let src: OsmSource;
  const ll = (dx: number, dy: number) => cellToLonLat(X0 + dx, Y0 + dy);

  beforeAll(async () => {
    // 地物はすべてこの 1 ブロック (256x256) の中。西半分 (x<128) が陸。
    const nodes: TNode[] = [], ways: TWay[] = [];
    let nid = 1, wid = 100;
    const nodeAt = (dx: number, dy: number) => {
      const [lon, lat] = ll(dx, dy);
      nodes.push({ id: nid, lat, lon });
      return nid++;
    };
    const line = (tags: Record<string, string>, pts: [number, number][], closed = false) => {
      const refs = pts.map(([x, y]) => nodeAt(x, y));
      if (closed) refs.push(refs[0]);
      ways.push({ id: wid, tags, refs });
      return wid++;
    };
    const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] =>
      [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

    line({ landuse: "forest" }, box(10, 10, 50, 50), true);
    line({ building: "yes" }, box(20, 20, 24, 24), true);                      // 森の中の建物
    line({ building: "yes" }, box(100, 200, 104, 204), true);                  // 何もない陸の建物 (周囲 3 マスが市街地になる)
    {                                                                          // 点だけの駅 (x=150 は海。駅のマスは海の上でも出る)
      const [lon, lat] = ll(150.5, 100.5);
      nodes.push({ id: nid, lat, lon, tags: { railway: "station", name: "点の駅" } });
      nid++;
    }
    line({ building: "train_station" }, box(200, 220, 204, 224), true);        // 駅舎 (4x4 マス)
    line({ public_transport: "station" }, box(190, 210, 214, 234), true);      // 駅の敷地 (同じ駅 → 駅のマスは 1 つだけ)
    line({ highway: "residential" }, [[0.5, 80.5], [100.5, 80.5]]);               // 横の道路
    line({ highway: "residential" }, [[60.5, 60.5], [60.5, 110.5]]);              // 縦の道路 (60,80 で交差)
    line({ highway: "motorway" }, [[0.5, 120.5], [100.5, 120.5]]);
    line({ railway: "rail" }, [[30.5, 60.5], [30.5, 110.5]]);                      // 縦の線路 (30,80 は踏切)
    line({ waterway: "river" }, [[80.5, 0.5], [80.5, 200.5]]);                     // 縦の川
    line({ highway: "residential", bridge: "yes" }, [[75.5, 140.5], [85.5, 140.5]]);
    // 湖 (外側と内側の穴をそれぞれ 2 本のウェイに分ける)
    const o1 = [nodeAt(90, 150), nodeAt(110, 150), nodeAt(110, 190)];
    const o2 = [o1[2], nodeAt(90, 190), o1[0]];
    const i1 = [nodeAt(95, 165), nodeAt(105, 165), nodeAt(105, 175)];
    const i2 = [i1[2], nodeAt(95, 175), i1[0]];
    const wo1 = wid++, wo2 = wid++, wi1 = wid++, wi2 = wid++;
    ways.push({ id: wo1, tags: {}, refs: o1 }, { id: wo2, tags: {}, refs: o2 },
      { id: wi1, tags: {}, refs: i1 }, { id: wi2, tags: {}, refs: i2 });
    // 範囲外の遠いウェイ (読まれないこと)
    ways.push({ id: wid, tags: { highway: "residential" }, refs: [nodeAt(5000, 5000), nodeAt(5100, 5000)] });

    const pbf = join(dir, "e2e.pbf");
    await writePbf(pbf, {
      nodes, ways,
      rels: [{ id: 1, tags: { type: "multipolygon", natural: "water" }, members: [
        { type: 1, id: wo1, role: "outer" }, { type: 1, id: wo2, role: "outer" },
        { type: 1, id: wi1, role: "inner" }, { type: 1, id: wi2, role: "inner" }] }],
    });
    const shp = join(dir, "e2e.shp");
    await writeShp(shp, [[[[X0 - 500, Y0 - 500], [X0 + 128, Y0 - 500], [X0 + 128, Y0 + 700], [X0 - 500, Y0 + 700]]]]);

    const [w, n] = ll(10, 10), [e, s] = ll(250, 250);
    const { store, stationNodes } = await loadFeatures(pbf, { bbox: [w, s, e, n], margin: 0.001 });
    expect(stationNodes.length).toBe(1);
    let far = false;
    for (let i = 0; i < store.count; i++) if (store.minx.a[i] > (X0 + 1000) * FIX) far = true;
    expect(far).toBe(false);          // 範囲外の遠いウェイは読まれない
    expect(store.count).toBe(12);
    const [mx0, my1] = cellToMeters(X0 - 300, Y0 - 300), [mx1, my0] = cellToMeters(X0 + 600, Y0 + 600);
    const land = await readPolygons(shp, [mx0, my0, mx1, my1]);

    const p = new Painter(1);
    expect(stationMarkers(store, stationNodes)).toEqual([[X0 + 150, Y0 + 100], [X0 + 202, Y0 + 222]]);   // 点の駅が先、面の駅が後
    p.paint(bx, by, land, store, store.areas(), store.lines(), stationMarkers(store, stationNodes));
    const cells = p.block(0, 0)!;
    const db = createDb(join(dir, "e2e.sqlite"));
    writeBlock(db, bx, by, cells);
    db.close();
    src = new OsmSource(join(dir, "e2e.sqlite"));
  });
  afterAll(() => src?.close());

  const c = (dx: number, dy: number) => src.cell(18, X0 + dx, Y0 + dy);

  test("面: 森・建物・草原・海", () => {
    expect(c(15, 15)).toBe(T.T_FOREST);
    expect(c(22, 22)).toBe(T.T_BUILDING);
    expect(c(100, 15)).toBe(T.T_GRASS);          // 陸 (x<128) で何もない
    expect(c(200, 15)).toBe(T.T_WATER);          // 陸地ポリゴンの外 = 海
  });

  test("建物の近くの「何もない陸」は市街地、遠くは草原", () => {
    expect(c(101, 202)).toBe(T.T_BUILDING);
    expect(c(97, 202)).toBe(T.T_BUILDING);          // 建物 (x=100) から 3 マス
    expect(c(96, 202)).toBe(T.T_GRASS);          // 4 マス
    expect(c(101, 197)).toBe(T.T_BUILDING);         // 上にも 3 マス
    expect(c(101, 196)).toBe(T.T_GRASS);
  });

  test("駅は 1 つの駅に 1 マスだけ。駅舎のほかのマスは線路", () => {
    expect(c(202, 222)).toBe(T.T_STATION);           // 駅舎の重心
    expect(c(200, 220)).toBe(railTile(0, 2));        // 駅舎のほかのマスは線路 (隣の線路で向きが決まる)
    expect(c(203, 223)).toBe(railTile(4, 6));
    expect(c(201, 221)).toBe(railTile(0, 4));        // 内側は、まっすぐな横
    expect(c(150, 100)).toBe(T.T_STATION);           // 点だけの駅
    expect(c(195, 215)).not.toBe(T.T_STATION);       // 敷地 (public_transport) は線路にしない
    expect(c(195, 215)).not.toBe(railTile(0, 4));
    let stations = 0;
    for (let y = 205; y < 240; y++) for (let x = 185; x < 220; x++) if (c(x, y) === T.T_STATION) stations++;
    expect(stations).toBe(1);
  });

  test("道路・交差・踏切・高速道路", () => {
    expect(c(45, 80)).toBe(T.T_ROAD);
    expect(c(60, 70)).toBe(T.T_ROAD);
    expect(c(60, 80)).toBe(T.T_ROAD);
    expect(c(30, 70)).toBe(railTile(2, 6));
    expect(c(30, 80)).toBe(T.T_CROSSING_V);
    expect(c(50, 120)).toBe(T.T_ROAD);
  });

  test("川と橋", () => {
    expect(c(80, 30)).toBe(T.T_WATER);
    expect(c(80, 140)).toBe(T.T_ROAD);       // 川の上の道路
  });

  test("湖: multipolygon の穴は水にならない", () => {
    expect(c(92, 155)).toBe(T.T_WATER);
    expect(c(100, 170)).toBe(T.T_GRASS);         // 内側の島
  });
});
