#!/usr/bin/env bun
/**
 * Mesen のスクリーンショット (256x240) を、ROM の絵 (gfx/tiles.chr) とパレット (src/main.c) と突き合わせて、
 * 「地形ごとに、どのパレットで表示されているか」を集計する。マスごとのパレットがずれる件 (doc/memo-palette-glitch.md) の診断用。
 *
 *   bun server/shot_palette.ts "$HOME/Library/Application Support/Mesen2/Screenshots/field_001.png"
 *
 * 16x16 マスの区切りの位置 (スクロールのずれ) を総当たりで探し、各マスが「どの地形の絵 × どのパレット」に
 * 完全一致するかを調べる。地形ごとの期待のパレット (tile_pal) と比べて、ばらつきがあれば属性 (パレット) の問題。
 * 一致しないマスは、2 つの地形にまたがる (スクロールの途中) か、スプライト (プレイヤー) が重なっている。
 */
import { readFileSync } from "node:fs";
import { decodePng } from "./dem";
import { NES_RGB, UNVERIFIED_COLORS, loadRomTables, terrainName, tileArt } from "./romtables";

const RGB = Object.fromEntries(Object.entries(NES_RGB).map(([k, v]) => [k, v.map((x) => x.toString(16).padStart(2, "0")).join("")])) as Record<number, string>;
const UNVERIFIED = UNVERIFIED_COLORS;

const path = process.argv[2];
if (!path) { console.error("usage: bun server/shot_palette.ts <スクリーンショット.png>"); process.exit(2); }
const shot = decodePng(readFileSync(path));
if (shot.w !== 256 || shot.h !== 240) console.warn(`256x240 ではない (${shot.w}x${shot.h})`);

const { palette, tilePal } = loadRomTables();
const chr = readFileSync(new URL("../gfx/tiles.chr", import.meta.url));
const art = (id: number, x: number, y: number) => tileArt(chr, id, x, y);

const used = new Set(palette.slice(0, 16));
const unknown = [...used].filter((c) => !RGB[c]);
if (unknown.length) { console.error("RGB が分からないパレット番号:", unknown.map((c) => c.toString(16)).join(" ")); process.exit(1); }
const approx = [...used].filter((c) => UNVERIFIED.has(c));
if (approx.length) console.warn(`注意: 色 ${approx.map((c) => c.toString(16)).join(" ")} の RGB は近似。一致が少なければ、PPU ダンプ (server/ppu_dump.ts) で確かめる`);

// すべての (地形の絵, パレット) の期待画像を文字列にして索引にする
const index = new Map<string, [number, number]>();
for (let id = 0; id < tilePal.length; id++) {
  for (let p = 0; p < 4; p++) {
    let s = "";
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += RGB[palette[p * 4 + art(id, x, y)]] + ",";
    if (!index.has(s)) index.set(s, [id, p]);
  }
}
const col = (x: number, y: number) => { const o = (y * 256 + x) * 3; return [0, 1, 2].map((i) => shot.rgb[o + i].toString(16).padStart(2, "0")).join(""); };
const cellAt = (X: number, Y: number) => { let s = ""; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += col(X + x, Y + y) + ","; return s; };

let best = { n: -1, dx: 0, dy: 0 };
for (let dy = 0; dy < 16; dy++) for (let dx = 0; dx < 16; dx++) {
  let n = 0;
  for (let Y = dy; Y + 16 <= 240; Y += 16) for (let X = dx; X + 16 <= 256; X += 16) if (index.has(cellAt(X, Y))) n++;
  if (n > best.n) best = { n, dx, dy };
}
console.log(`マスの区切りのずれ dx=${best.dx} dy=${best.dy}: 完全一致 ${best.n} マス`);

const per = new Map<number, Map<number, number>>();
let total = 0, unmatched = 0;
for (let Y = best.dy; Y + 16 <= 240; Y += 16) for (let X = best.dx; X + 16 <= 256; X += 16) {
  total++;
  const m = index.get(cellAt(X, Y));
  if (!m) { unmatched++; continue; }
  const row = per.get(m[0]) ?? new Map<number, number>();
  row.set(m[1], (row.get(m[1]) ?? 0) + 1);
  per.set(m[0], row);
}
console.log(`区切りの中のマス ${total}、一致しなかったマス ${unmatched}`);
let bad = 0;
for (const [id, row] of [...per].sort((a, b) => a[0] - b[0])) {
  const want = tilePal[id];
  const wrong = [...row].filter(([p]) => p !== want).reduce((s, [, n]) => s + n, 0);
  bad += wrong;
  console.log(`  ${String(id).padStart(2)} ${terrainName(id).padEnd(8)} 期待 pal${want}  実際 ${[...row].map(([p, n]) => `pal${p}×${n}`).join(" ")}${wrong ? "   ← パレットがずれている" : ""}`);
}
console.log(bad === 0 ? "パレットのずれなし (一致したマスはすべて期待どおり)" : `パレットがずれているマス ${bad} 個`);
