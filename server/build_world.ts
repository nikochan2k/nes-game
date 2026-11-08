#!/usr/bin/env bun
/**
 * OSM + 陸地ポリゴン + 標高 から data/world.sqlite を作る (doc/map-spec.md の 6 章)。
 * Bun だけで動く (osmium も GDAL も不要)。
 *
 *   bun server/build_world.ts check
 *   (入力のダウンロードは bun server/download.ts)
 *   bun server/build_world.ts build --bbox w,s,e,n     world.sqlite を作る
 *
 * 入力:
 *   data/osm/<地域>.osm.pbf                           OSM (--pbf)。Geofabrik の地方別ファイルを順に build すると全国になる
 *   (陸地は pbf の海岸線 natural=coastline から作る。--land で land-polygons-split-3857 の .shp を使うこともできる)
 *   data/dem/14/{x}/{y}.png                           標高 (--dem)。--no-dem なら傾斜なし
 *
 * メモリは「地物のジオメトリ + 16x16 ブロックの作業台 (約 70MB)」。広い範囲は bbox を分けて複数回実行する。
 * 同じ DB に追記でき、ブロックの途中で切れない bbox なら重複しても結果は同じ。
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { Dem } from "./dem";
import { landFromCoast } from "./coast";
import { loadFeatures, xToLon, yToLat } from "./osmfeatures";
import { readPolygons } from "./shapefile";
import { allSpots, spotBbox } from "./spots";
import { BLOCK_M, MERC, Painter, blockRange, airportMarkers, stationMarkers, type Land } from "./worldbuild";
import { BLOCK_SIZE, createDb, writeBlock, writeLine17 } from "./worlddb";

const DEFAULTS = {
  pbf: "data/osm/japan-latest.osm.pbf",
  land: "",
  dem: "data/dem",
  out: "data/world.sqlite",
};

function parseBbox(s: string): [number, number, number, number] {
  const v = s.split(",").map(Number);
  if (v.length !== 4 || v.some(Number.isNaN) || v[0] >= v[2] || v[1] >= v[3]) {
    throw new Error(`bbox は w,s,e,n (経度緯度): ${s}`);
  }
  return v as [number, number, number, number];
}

function check(o: typeof DEFAULTS): boolean {
  let ok = true;
  for (const [p, what] of [[o.pbf, "OSM pbf"], [o.dem, "標高 (--no-dem なら不要)"]]) {
    const found = existsSync(p);
    console.log(`${found ? "ok     " : "MISSING"} ${p}  (${what})`);
    ok &&= found;
  }
  return ok;
}

type Bbox = [number, number, number, number];

/**
 * bboxes (離れていてもよい) の範囲を、1 回の読み込みで DB に作る。範囲ごとに陸地と塗りを行う。
 * 全体を作るときは範囲が 1 つ。見栄えの確認 (sample) では、基準地点の周りの小さな範囲が複数になる。
 */
async function build(o: typeof DEFAULTS & { bboxes: Bbox[]; tile: number; margin: number; noDem: boolean }) {
  const t0 = Date.now();
  const lap = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);
  const gc = () => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);

  const regions = o.bboxes.map((b) => {
    const r = blockRange(b);
    const win = { x0: r.bx0 * BLOCK_SIZE, y0: r.by0 * BLOCK_SIZE, x1: (r.bx1 + 1) * BLOCK_SIZE, y1: (r.by1 + 1) * BLOCK_SIZE };
    return { ...r, win, box: [xToLon(win.x0), yToLat(win.y1), xToLon(win.x1), yToLat(win.y0)] as Bbox };
  });
  for (const r of regions) console.log(`ブロック x ${r.bx0}..${r.bx1}, y ${r.by0}..${r.by1} (${(r.bx1 - r.bx0 + 1) * (r.by1 - r.by0 + 1)} 個)`);

  // 地物は各範囲のブロック全体 (+margin) を読む
  const { store, coast, stationNodes } = await loadFeatures(o.pbf, { bbox: regions[0].box, bboxes: regions.map((r) => r.box), margin: o.margin, log: lap });
  const areas = store.areas(), lines = store.lines();
  const stations = stationMarkers(store, stationNodes);
  const airports = airportMarkers(store);
  gc();
  lap(`地物 面 ${areas.length} 線 ${lines.length} 海岸線 ${coast.length} 本、駅 ${stations.length} 個`);

  mkdirSync("data", { recursive: true });
  const db = createDb(o.out);
  const dem = o.noDem ? null : new Dem(o.dem);
  const painter = new Painter(o.tile);
  let blocks = 0;
  for (const { bx0, by0, bx1, by1, win } of regions) {
    let land: Land[];
    if (o.land) {
      const mx0 = -MERC + (bx0 - 1) * BLOCK_M, mx1 = -MERC + (bx1 + 2) * BLOCK_M;
      const my1 = MERC - (by0 - 1) * BLOCK_M, my0 = MERC - (by1 + 2) * BLOCK_M;
      land = await readPolygons(o.land, [mx0, my0, mx1, my1]);
      lap(`陸地ポリゴン ${land.length} 件 (${o.land})`);
    } else {
      const c = landFromCoast(coast, win, store.count > 0);
      land = [{ parts: c.parts, minx: win.x0, miny: win.y0, maxx: win.x1, maxy: win.y1 }];
      lap(`海岸線から陸の輪 ${c.parts.length} 個${c.extended ? ` (抽出範囲の境で途切れた海岸線の端 ${c.extended} 個を枠まで延長)` : ""}`);
    }
    for (let ty = by0; ty <= by1; ty += o.tile) {
      for (let tx = bx0; tx <= bx1; tx += o.tile) {
        painter.paint(tx, ty, land, store, areas, lines, stations, airports);
        db.transaction(() => {
          for (let j = 0; j < o.tile; j++) {
            for (let i = 0; i < o.tile; i++) {
              const bx = tx + i, by = ty + j;
              if (bx > bx1 || by > by1) continue;
              const cells = painter.block(i, j, dem?.slope(bx, by, MERC - by * BLOCK_M));
              if (cells) { writeBlock(db, bx, by, cells); blocks++; }
            }
          }
        })();
        gc();                   // 輪や座標の一時配列が溜まって RSS が膨らむので、タイルごとに回収する
        lap(`タイル (${tx},${ty}) まで。計 ${blocks} ブロック (rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB)`);
      }
    }
  }
  // z17 の道路・線路: 地物から z17 の格子で作り直す (z18 のマスを集めると、線が太り、梯子や短い線が出る)
  const painter17 = new Painter(Math.max(1, o.tile >> 1));
  const t17 = Math.max(1, o.tile >> 1);
  let blocks17 = 0;
  for (const { bx0, by0, bx1, by1 } of regions) {
    for (let ty = by0 >> 1; ty <= by1 >> 1; ty += t17) {
      for (let tx = bx0 >> 1; tx <= bx1 >> 1; tx += t17) {
        painter17.paintLines17(tx, ty, store, lines);
        db.transaction(() => {
          for (let j = 0; j < t17; j++) for (let i = 0; i < t17; i++) {
            if (tx + i > bx1 >> 1 || ty + j > by1 >> 1) continue;
            writeLine17(db, tx + i, ty + j, painter17.line17Block(i, j)); blocks17++;
          }
        })();
        gc();
      }
    }
    lap(`z17 の線 ${blocks17} ブロックまで`);
  }
  const meta = db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)");
  meta.run("built_at", new Date().toISOString());
  meta.run("license", "Contains OpenStreetMap data (ODbL) and GSI Japan elevation data. See README.");
  db.exec("VACUUM");
  db.close();
  lap(`完了 ${blocks} ブロック → ${o.out}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      bbox: { type: "string", default: "122,20,154,46" },
      pbf: { type: "string", default: DEFAULTS.pbf },
      land: { type: "string", default: DEFAULTS.land },
      dem: { type: "string", default: DEFAULTS.dem },
      out: { type: "string", default: DEFAULTS.out },
      tile: { type: "string", default: "16" },
      margin: { type: "string", default: "0.05" },
      "no-dem": { type: "boolean", default: false },
    },
  });
  const o = { ...DEFAULTS, pbf: values.pbf!, land: values.land!, dem: values.dem!, out: values.out! };
  if (values.pbf === DEFAULTS.pbf && !existsSync(o.pbf) && existsSync("data/osm")) {
    // 既定の日本全体がなければ、data/osm にある (地方別の) pbf を使う
    const found = readdirSync("data/osm").filter((f) => f.endsWith(".osm.pbf")).sort();
    if (found.length > 0) o.pbf = `data/osm/${found[0]}`;
  }
  const cmd = positionals[0];
  if (cmd === "check") {
    process.exit(check(o) ? 0 : 1);
  } else if (cmd === "build") {
    await build({ ...o, bboxes: [parseBbox(values.bbox!)], tile: Number(values.tile), margin: Number(values.margin),
      noDem: values["no-dem"]! });
  } else if (cmd === "sample") {
    // 見栄えの確認用: 基準地点 (server/spots.ts) の周りだけの小さな DB を作る。全体 (約 6 分) の前に、これで確認する (約 1〜2 分)
    const out = values.out === DEFAULTS.out ? "data/sample.sqlite" : values.out!;
    await build({ ...o, out, bboxes: allSpots().map(spotBbox), tile: 4, margin: 0.01, noDem: values["no-dem"]! });
  } else {
    console.log("usage: bun server/build_world.ts check | build --bbox w,s,e,n | sample [--out data/sample.sqlite]"
      + " [--pbf f] [--land f] [--dem dir] [--out f] [--tile 16] [--margin 0.05] [--no-dem]");
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
