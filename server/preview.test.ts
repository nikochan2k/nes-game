import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng } from "./dem";
import { encodePng } from "./png";
import { tileSheet } from "./preview";
import { loadRomTables } from "./romtables";

test("PNG の書き出しと読み込みが往復する (CRC つき)", () => {
  const rgb = new Uint8Array(5 * 4 * 3).map((_, i) => (i * 37) & 255);
  const d = decodePng(encodePng(5, 4, rgb));
  expect([d.w, d.h]).toEqual([5, 4]);
  expect([...d.rgb]).toEqual([...rgb]);
});

test("タイルシート: 全タイルが描かれ、PNG になる", () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-"));
  try {
    const path = join(dir, "tiles.png");
    tileSheet(path);
    expect(existsSync(path)).toBe(true);
    const { w, h, rgb } = decodePng(readFileSync(path));
    const n = loadRomTables().tilePal.length, cols = 11, T = 64, gap = 8;
    expect([w, h]).toEqual([cols * (T + gap) + gap, Math.ceil(n / cols) * (T + gap) + gap]);
    expect(new Set([...rgb]).size).toBeGreaterThan(8);          // 地面の灰色だけではなく、色がついている
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
