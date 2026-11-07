#!/usr/bin/env bun
/**
 * 見栄えの確認ページ (ブラウザ用) を作る。地図の生成 (DB の作り直し) や ROM への反映の前に、これで確認する。
 * 手順と決まりは doc/process-visual-review.md。
 *
 *   make preview                                  data/world.sqlite を、基準の地点で描く
 *   bun server/preview.ts --db data/preview.sqlite --before data/world.sqlite
 *                                                 変更後の DB と、変更前の DB を並べる
 *   bun server/preview.ts --spots "駅:35.482,139.585;海岸:34.92,139.85"   地点を指定する
 *
 * 出力: data/compare/preview.html (data/ は .gitignore。コミットされない) と画像。
 *   - 全タイルのシート (gfx/tiles.chr と src/main.c のパレット = 実機と同じ絵・色)
 *   - 地点ごとに、国土地理院の航空写真 (z17 と z18) と、地図 (z17 と z18) を並べる
 * 地図は、サーバーが返す地形 ID を、ROM と同じ絵・パレットで描いたもの。実機 (Mesen) の画面そのものではない。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseStart } from "../gfx/gen_start";
import { OsmSource } from "./osmsource";
import { lonToX, latToY } from "./osmfeatures";
import { encodePng } from "./png";
import { NES_RGB, UNVERIFIED_COLORS, loadRomTables, terrainName, tileArt } from "./romtables";

const CHR = readFileSync(new URL("../gfx/tiles.chr", import.meta.url));
const { palette, tilePal } = loadRomTables();

// ---- 描画 ----
class Canvas {
  readonly data: Uint8Array;
  constructor(readonly w: number, readonly h: number, bg: [number, number, number] = [40, 40, 40]) {
    this.data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.data.set(bg, i * 3);
  }
  /** 地形 id の 16x16 の絵を、倍率 s で (ox, oy) に描く。 */
  tile(id: number, ox: number, oy: number, s: number) {
    const pal = tilePal[id] ?? 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const rgb = NES_RGB[palette[pal * 4 + tileArt(CHR, id, x, y)]] ?? [255, 0, 255];
        for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) this.data.set(rgb, ((oy + y * s + sy) * this.w + ox + x * s + sx) * 3);
      }
    }
  }
  save(path: string) { writeFileSync(path, encodePng(this.w, this.h, this.data)); }
}

/** 全タイルのシート。 */
export function tileSheet(path: string, cols = 11, scale = 4, gap = 8) {
  const n = tilePal.length, T = 16 * scale, rows = Math.ceil(n / cols);
  const c = new Canvas(cols * (T + gap) + gap, rows * (T + gap) + gap);
  for (let id = 0; id < n; id++) c.tile(id, gap + (id % cols) * (T + gap), gap + Math.floor(id / cols) * (T + gap), scale);
  c.save(path);
}

/** z の地形を、タイル (tx, ty) から n x n タイル (1 タイル = 16 x 16 マス) 描く。 */
export function mapImage(src: OsmSource, z: number, tx: number, ty: number, n: number, scale: number, path: string) {
  const cells = n * 16, c = new Canvas(cells * 16 * scale, cells * 16 * scale);
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) c.tile(src.cell(z, tx * 16 + cx, ty * 16 + cy), cx * 16 * scale, cy * 16 * scale, scale);
  c.save(path);
}

// ---- 航空写真 (国土地理院 シームレス空中写真。出典の表示が要る) ----
async function fetchPhoto(z: number, x: number, y: number, path: string): Promise<boolean> {
  if (existsSync(path) && statSync(path).size > 0) return true;
  try {
    const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`);
    if (!res.ok) return false;
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
    await Bun.sleep(60);
    return true;
  } catch { return false; }
}

// ---- 地点 ----
interface Spot { name: string; lat: number; lon: number }
const DEFAULT_SPOTS: Spot[] = [
  { name: "東京駅", lat: 35.6812, lon: 139.7671 }, { name: "豊洲 (海岸)", lat: 35.649, lon: 139.795 },
  { name: "奥多摩 (山)", lat: 35.85, lon: 138.95 }, { name: "房総南端 (海岸と森)", lat: 34.92, lon: 139.85 },
  { name: "熊谷 (平野)", lat: 36.15, lon: 139.39 }, { name: "筑波山", lat: 36.22, lon: 140.1 },
];

function parseSpots(s: string): Spot[] {
  return s.split(";").filter(Boolean).map((p) => {
    const [name, ll] = p.includes(":") ? p.split(":") : [p, p];
    const [lat, lon] = ll.split(",").map(Number);
    if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error(`地点は "名前:緯度,経度": ${p}`);
    return { name, lat, lon };
  });
}

function startSpot(): Spot | null {
  const f = "data/start.json";
  if (!existsSync(f)) return null;
  const s = parseStart(readFileSync(f, "utf8"));
  return { name: "起動位置 (data/start.json)", lat: s.lat, lon: s.lon };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: "string", default: "data/world.sqlite" },
      before: { type: "string" },
      out: { type: "string", default: "data/compare" },
      spots: { type: "string" },
      "no-photo": { type: "boolean", default: false },
      open: { type: "boolean", default: false },
    },
  });
  const out = values.out!;
  mkdirSync(out, { recursive: true });
  if (!existsSync(values.db!)) throw new Error(`DB がない: ${values.db}`);
  const spots = values.spots ? parseSpots(values.spots) : [startSpot(), ...DEFAULT_SPOTS].filter((s): s is Spot => !!s);
  const after = new OsmSource(values.db!), before = values.before ? new OsmSource(values.before) : null;

  tileSheet(join(out, "tiles.png"));
  let body = "";
  for (let i = 0; i < spots.length; i++) {
    const sp = spots[i];
    // 地点を含む z17 のタイル (1 タイル = 16 x 16 マス)。z18 は、その 2 x 2 タイル
    const tx = Math.floor(lonToX(sp.lon) / 2 / 16), ty = Math.floor(latToY(sp.lat) / 2 / 16);
    mapImage(after, 17, tx, ty, 1, 2, join(out, `spot${i}_map17.png`));
    mapImage(after, 18, tx * 2, ty * 2, 2, 1, join(out, `spot${i}_map18.png`));
    if (before) {
      mapImage(before, 17, tx, ty, 1, 2, join(out, `spot${i}_before17.png`));
      mapImage(before, 18, tx * 2, ty * 2, 2, 1, join(out, `spot${i}_before18.png`));
    }
    let photo = !values["no-photo"] && await fetchPhoto(17, tx, ty, join(out, `spot${i}_photo17.jpg`));
    const p18: string[] = [];
    for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const f = `spot${i}_photo18_${dy}${dx}.jpg`;
      if (!values["no-photo"] && await fetchPhoto(18, tx * 2 + dx, ty * 2 + dy, join(out, f))) p18.push(f); else photo = false;
    }
    const fig = (cap: string, img: string, cls = "") => `<figure class="${cls}"><figcaption>${cap}</figcaption><img src="${img}"></figure>`;
    body += `<h2>${i + 1}. ${esc(sp.name)} <small>(緯度 ${sp.lat} / 経度 ${sp.lon}。z17 のタイル ${tx}, ${ty})</small></h2>
<div class="row">${photo ? fig("航空写真 z17", `spot${i}_photo17.jpg`) : ""}${fig("地図 z17" + (before ? " (変更後)" : ""), `spot${i}_map17.png`)}${before ? fig("地図 z17 (変更前)", `spot${i}_before17.png`) : ""}</div>
<div class="row">${p18.length === 4 ? `<figure><figcaption>航空写真 z18</figcaption><div class="grid"><img src="${p18[0]}"><img src="${p18[1]}"><img src="${p18[2]}"><img src="${p18[3]}"></div></figure>` : ""}${fig("地図 z18" + (before ? " (変更後)" : ""), `spot${i}_map18.png`)}${before ? fig("地図 z18 (変更前)", `spot${i}_before18.png`) : ""}</div>\n`;
  }
  const legend = tilePal.map((p, id) => `${id}:${terrainName(id)}(pal${p})`).join(" / ");
  const approx = [...new Set(palette.slice(0, 16))].filter((c) => UNVERIFIED_COLORS.has(c)).map((c) => c.toString(16)).join(" ");
  writeFileSync(join(out, "preview.html"), `<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>見栄えの確認</title>
<style>
  body { font-family: sans-serif; margin: 16px; background: #fafafa; color: #222; max-width: 1600px; }
  h2 { margin: 32px 0 6px; border-bottom: 2px solid #ccc; padding-bottom: 4px; } h2 small { font-weight: normal; color: #666; font-size: 13px; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; margin-bottom: 12px; }
  figure { margin: 0; } figcaption { font-size: 13px; color: #444; margin-bottom: 4px; }
  img { image-rendering: pixelated; display: block; width: 512px; height: 512px; }
  .grid { display: grid; grid-template-columns: 256px 256px; width: 512px; } .grid img { width: 256px; height: 256px; }
  .sheet img { width: auto; height: auto; max-width: 100%; } p, li { font-size: 14px; line-height: 1.6; } .note { color: #555; font-size: 13px; }
</style>
<h1>見栄えの確認 (地図の生成・反映の前に)</h1>
<p class="note">作成: ${new Date().toLocaleString("ja-JP")} / DB: ${esc(values.db!)}${before ? ` (変更前: ${esc(values.before!)})` : ""}。
 地図は、サーバーが返す地形 ID を、ROM と同じ絵・パレットで描いたもので、実機 (Mesen) の画面そのものではありません。
 色 ${approx || "(なし)"} の RGB は近似です。航空写真は国土地理院「シームレス空中写真」、地図データは © OpenStreetMap contributors。</p>
<h2>タイル一覧 (全 ${tilePal.length} 種)</h2>
<p class="note">${esc(legend)}</p>
<div class="sheet"><img src="tiles.png"></div>
${body}</html>`);
  console.log(`${join(out, "preview.html")} を作った (${spots.length} 地点)`);
  if (values.open) Bun.spawn(["open", join(out, "preview.html")]);
}

if (import.meta.main) {
  await main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
