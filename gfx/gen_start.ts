#!/usr/bin/env bun
/**
 * 起動位置 (緯度経度) から build/start.h を作る。
 *
 *   bun gfx/gen_start.ts data/start.json build/start.h
 *
 * data/start.json (data/ は .gitignore。コミットされない):
 *   { "lat": 35.69, "lon": 139.69, "z": 14 }      z は省略可 (既定 10。1..18)
 * ファイルがなければ既定 (東京 z=10) になる。マス座標は src/main.c と同じ世界で、
 * z のとき 1 辺は 2^(z+4) マス。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const Z_MIN = 1, Z_MAX = 18;
export const DEFAULT_START = { lat: 35.69, lon: 139.69, z: 10 };

export interface Start { lat: number; lon: number; z: number }

/** 緯度経度 → z でのマス座標 (Web メルカトル。北が y=0)。 */
export function startCell(lat: number, lon: number, z: number): [number, number] {
  const n = 2 ** (z + 4);
  const s = Math.sin((lat * Math.PI) / 180);
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

export function parseStart(text: string): Start {
  const j = JSON.parse(text) as Partial<Start>;
  const lat = j.lat, lon = j.lon, z = j.z ?? DEFAULT_START.z;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('"lat" と "lon" は数値 (度) で指定する');
  }
  if (Math.abs(lat) > 85.05) throw new Error(`lat は -85.05〜85.05: ${lat}`);
  if (lon < -180 || lon > 180) throw new Error(`lon は -180〜180: ${lon}`);
  if (!Number.isInteger(z) || z < Z_MIN || z > Z_MAX) throw new Error(`z は ${Z_MIN}〜${Z_MAX} の整数: ${z}`);
  return { lat, lon, z };
}

export function header(s: Start): string {
  const [x, y] = startCell(s.lat, s.lon, s.z);
  return `/* 自動生成 (gfx/gen_start.ts)。コミットしない。起動位置は data/start.json (無ければ既定) */\n`
    + `#define START_Z ${s.z}\n#define START_X ${x}UL\n#define START_Y ${y}UL\n`;
}

if (import.meta.main) {
  const [cfg, out] = process.argv.slice(2);
  if (!cfg || !out) {
    console.error("usage: bun gfx/gen_start.ts <data/start.json> <build/start.h>");
    process.exit(2);
  }
  try {
    const s = existsSync(cfg) ? parseStart(readFileSync(cfg, "utf8")) : DEFAULT_START;
    const [x, y] = startCell(s.lat, s.lon, s.z);
    mkdirSync(dirname(out), { recursive: true });
    const text = header(s);
    // 内容が同じなら書き換えない (更新時刻が変わると ROM を再ビルドしてしまう)
    if (!existsSync(out) || readFileSync(out, "utf8") !== text) {
      writeFileSync(out, text);
      console.log(`start: ${existsSync(cfg) ? cfg : "既定 (東京)"} → z=${s.z} マス (${x}, ${y})`);
    }
  } catch (e) {
    console.error(`${cfg}: ${(e as Error).message}`);
    process.exit(1);
  }
}
