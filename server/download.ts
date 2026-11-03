#!/usr/bin/env bun
/**
 * build_world.ts の入力データをダウンロードする。
 *
 *   bun server/download.ts osm kanto            Geofabrik の地方別 pbf → data/osm/kanto-latest.osm.pbf
 *   bun server/download.ts osm japan            日本全体 (約 2GB) → data/osm/japan-latest.osm.pbf
 *   bun server/download.ts land                 (任意) 陸地ポリゴン (zip 約 520MB)。通常は pbf の海岸線を使うので不要
 *   bun server/download.ts dem --bbox w,s,e,n   国土地理院の標高タイル (z14) → data/dem/14/
 *   bun server/download.ts all kanto --bbox ... osm と dem をまとめて
 *
 * 既にあるファイルは取り直さない (--force で取り直す)。zip の展開に unzip コマンドを使う。
 * 出典: © OpenStreetMap contributors (ODbL) / 陸地ポリゴンは osmdata.openstreetmap.de /
 *       標高は国土地理院。サーバーに負荷をかけないよう、必要な範囲だけを取ること。
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { downloadTile } from "./dem";
import { blockRange } from "./worldbuild";

export const REGIONS = ["hokkaido", "tohoku", "kanto", "chubu", "kansai", "chugoku", "shikoku", "kyushu", "japan"];
const GEOFABRIK = "https://download.geofabrik.de/asia";
const LAND_URL = "https://osmdata.openstreetmap.de/download/land-polygons-split-3857.zip";
const DEM_BASE = "https://cyberjapandata.gsi.go.jp/xyz/dem_png";

export const osmUrl = (region: string) =>
  region === "japan" ? `${GEOFABRIK}/japan-latest.osm.pbf` : `${GEOFABRIK}/japan/${region}-latest.osm.pbf`;

const mb = (n: number) => `${(n / 1048576).toFixed(0)}MB`;

/** url を dest に保存する。途中で切れても dest は壊れない (.part に書いてから移す)。 */
export async function downloadFile(url: string, dest: string, force = false): Promise<void> {
  if (existsSync(dest) && !force) {
    console.log(`済み: ${dest}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`取得: ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const part = `${dest}.part`;
  const out = Bun.file(part).writer();
  let got = 0, shown = 0;
  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      got += chunk.length;
      if (got - shown >= 50 * 1048576) {
        shown = got;
        console.log(`  ${mb(got)}${total ? ` / ${mb(total)}` : ""}`);
      }
    }
    await out.end();
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  renameSync(part, dest);
  console.log(`保存: ${dest} (${mb(got)})`);
}

export async function downloadLand(force = false): Promise<void> {
  const shp = "data/osm/land-polygons-split-3857/land_polygons.shp";
  if (existsSync(shp) && !force) {
    console.log(`済み: ${shp}`);
    return;
  }
  const zip = "data/osm/land-polygons-split-3857.zip";
  await downloadFile(LAND_URL, zip, force);
  const p = Bun.spawn(["unzip", "-o", zip, "-d", "data/osm"], { stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error("unzip が失敗 (unzip コマンドが必要)");
  if (!existsSync(shp)) throw new Error(`${shp} が展開されなかった`);
  rmSync(zip);
}

export async function downloadDem(bbox: [number, number, number, number], dir = "data/dem", delay = 50): Promise<void> {
  const { bx0, by0, bx1, by1 } = blockRange(bbox);
  const tiles: [number, number][] = [];
  for (let y = by0 - 1; y <= by1 + 1; y++) for (let x = bx0 - 1; x <= bx1 + 1; x++) tiles.push([x, y]);
  console.log(`標高タイル ${tiles.length} 枚 (国土地理院)`);
  let n = 0, got = 0, none = 0;
  for (const [x, y] of tiles) {
    const r = await downloadTile(dir, x, y, DEM_BASE);
    if (r === "ok") got++;
    else if (r === "none") none++;
    if (r !== "skip") await Bun.sleep(delay);
    if (++n % 100 === 0 || n === tiles.length) console.log(`  ${n}/${tiles.length} (取得 ${got}, なし ${none})`);
  }
}

function parseBbox(s: string | undefined): [number, number, number, number] {
  const v = (s ?? "").split(",").map(Number);
  if (v.length !== 4 || v.some(Number.isNaN) || v[0] >= v[2] || v[1] >= v[3]) {
    throw new Error("--bbox w,s,e,n (経度緯度) が必要");
  }
  return v as [number, number, number, number];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      bbox: { type: "string" },
      force: { type: "boolean", default: false },
      delay: { type: "string", default: "50" },
    },
  });
  const [cmd, region] = positionals;
  const needRegion = () => {
    if (!region || !REGIONS.includes(region)) throw new Error(`地域は ${REGIONS.join(" | ")}`);
    return region;
  };
  const osm = () => downloadFile(osmUrl(needRegion()), `data/osm/${region}-latest.osm.pbf`, values.force);
  if (cmd === "osm") {
    await osm();
  } else if (cmd === "land") {
    await downloadLand(values.force);
  } else if (cmd === "dem") {
    await downloadDem(parseBbox(values.bbox), "data/dem", Number(values.delay));
  } else if (cmd === "all") {
    const bbox = parseBbox(values.bbox);
    await osm();
    await downloadDem(bbox, "data/dem", Number(values.delay));
    console.log(`\nbun server/build_world.ts build --bbox ${bbox.join(",")} --pbf data/osm/${region}-latest.osm.pbf`);
  } else {
    console.log("usage: bun server/download.ts osm <地域> | land | dem --bbox w,s,e,n | all <地域> --bbox w,s,e,n [--force]");
    console.log(`地域: ${REGIONS.join(" ")}`);
    process.exit(2);
  }
}

if (import.meta.main) {
  await main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
