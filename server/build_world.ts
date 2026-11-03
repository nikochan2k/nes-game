#!/usr/bin/env bun
/**
 * OSM + 陸地ポリゴン + 標高 から data/world.sqlite を作る (doc/tile-conversion-plan.md の 6 章)。
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
import { existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { Dem } from "./dem";
import { landFromCoast } from "./coast";
import { loadFeatures, xToLon, yToLat } from "./osmfeatures";
import { readPolygons } from "./shapefile";
import { BLOCK_M, MERC, Painter, blockRange, type Land } from "./worldbuild";
import { BLOCK_SIZE, createDb, writeBlock } from "./worlddb";

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

async function build(o: typeof DEFAULTS & { bbox: [number, number, number, number]; tile: number; margin: number; noDem: boolean }) {
  const { bx0, by0, bx1, by1 } = blockRange(o.bbox);
  console.log(`ブロック x ${bx0}..${bx1}, y ${by0}..${by1} (${(bx1 - bx0 + 1) * (by1 - by0 + 1)} 個)`);
  const t0 = Date.now();
  const lap = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);

  const win = { x0: bx0 * BLOCK_SIZE, y0: by0 * BLOCK_SIZE, x1: (bx1 + 1) * BLOCK_SIZE, y1: (by1 + 1) * BLOCK_SIZE };
  // 地物はブロックの範囲全体 (+margin) を読む
  const bbox: [number, number, number, number] = [xToLon(win.x0), yToLat(win.y1), xToLon(win.x1), yToLat(win.y0)];
  const { features, coast } = await loadFeatures(o.pbf, { bbox, margin: o.margin });
  const areas = features.filter((f) => f.area).sort((a, b) => a.rank - b.rank);
  const lines = features.filter((f) => !f.area).sort((a, b) => a.rank - b.rank);
  lap(`地物 面 ${areas.length} 線 ${lines.length} 海岸線 ${coast.length} 本`);

  let land: Land[];
  if (o.land) {
    const mx0 = -MERC + (bx0 - 1) * BLOCK_M, mx1 = -MERC + (bx1 + 2) * BLOCK_M;
    const my1 = MERC - (by0 - 1) * BLOCK_M, my0 = MERC - (by1 + 2) * BLOCK_M;
    land = await readPolygons(o.land, [mx0, my0, mx1, my1]);
    lap(`陸地ポリゴン ${land.length} 件 (${o.land})`);
  } else {
    const c = landFromCoast(coast, win, features.length > 0);
    land = [{ parts: c.parts, minx: win.x0, miny: win.y0, maxx: win.x1, maxy: win.y1 }];
    lap(`海岸線から陸の輪 ${c.parts.length} 個${c.open ? ` (端が窓の中で途切れた海岸線 ${c.open} 本は無視)` : ""}`);
  }

  mkdirSync("data", { recursive: true });
  const db = createDb(o.out);
  const dem = o.noDem ? null : new Dem(o.dem);
  const painter = new Painter(o.tile);
  let blocks = 0;
  for (let ty = by0; ty <= by1; ty += o.tile) {
    for (let tx = bx0; tx <= bx1; tx += o.tile) {
      painter.paint(tx, ty, land, areas, lines);
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
      lap(`タイル (${tx},${ty}) まで。計 ${blocks} ブロック`);
    }
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
  const cmd = positionals[0];
  if (cmd === "check") {
    process.exit(check(o) ? 0 : 1);
  } else if (cmd === "build") {
    await build({ ...o, bbox: parseBbox(values.bbox!), tile: Number(values.tile), margin: Number(values.margin),
      noDem: values["no-dem"]! });
  } else {
    console.log("usage: bun server/build_world.ts check | build --bbox w,s,e,n"
      + " [--pbf f] [--land f] [--dem dir] [--out f] [--tile 16] [--margin 0.05] [--no-dem]");
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
