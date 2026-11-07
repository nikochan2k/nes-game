/**
 * ROM (src/main.c) の BG パレットと tile_pal[] (地形 ID → パレット番号) を、ソースから読む。
 * 診断ツール (ppu_dump.ts、shot_palette.ts) が、ROM と食い違った期待値を持たないようにするため。
 */
import { readFileSync } from "node:fs";

const MAIN_C = new URL("../src/main.c", import.meta.url);

/** `static const unsigned char <name>[...] = { ... };` の中の数値を、コメントを除いて順に取る。 */
function arrayOf(src: string, name: string): number[] {
  const m = new RegExp(`${name}\\[[^\\]]*\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(src);
  if (!m) throw new Error(`src/main.c に ${name}[] がない`);
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "");
  return (body.match(/0x[0-9a-fA-F]+|\d+/g) ?? []).map((v) => Number(v));
}

export function loadRomTables(): { palette: number[]; tilePal: number[] } {
  const src = readFileSync(MAIN_C, "utf8");
  return { palette: arrayOf(src, "palette"), tilePal: arrayOf(src, "tile_pal") };
}

/** 地形 ID の名前 (server/terrain.ts と同じ並び)。診断の表示用。 */
export function terrainName(id: number): string {
  const fixed = ["草", "森", "山", "岩山", "水", "建物", "砂", "湿地", "道路"];
  if (id < fixed.length) return fixed[id];
  if (id < fixed.length + 20) return `線路${id - fixed.length}`;
  return ["踏切(横)", "踏切(縦)", "駅"][id - fixed.length - 20] ?? `ID${id}`;
}

/**
 * NES のパレット番号 → RGB (Mesen の既定の表示)。スクリーンショットから確かめた値と、確かめていない近似 (UNVERIFIED_COLORS)。
 * 確認用の画像 (make preview) と、スクリーンショットの集計 (shot_palette.ts) が使う。
 */
export const NES_RGB: Record<number, [number, number, number]> = {
  0x1a: [0x0c, 0x93, 0x00], 0x0a: [0x00, 0x52, 0x00], 0x2a: [0x5c, 0xe4, 0x30], 0x17: [0x99, 0x4e, 0x00],
  0x07: [0x56, 0x1d, 0x00], 0x30: [0xff, 0xfe, 0xff], 0x00: [0x66, 0x66, 0x66], 0x10: [0xad, 0xad, 0xad],
  0x11: [0x15, 0x5f, 0xd9], 0x0f: [0x00, 0x00, 0x00],
  0x21: [0x21, 0xa0, 0xff], 0x28: [0xbc, 0xbe, 0x00], 0x38: [0xec, 0xee, 0xa6], 0x16: [0xb5, 0x31, 0x20],   // ※ 近似
};
export const UNVERIFIED_COLORS = new Set([0x21, 0x28, 0x38, 0x16]);

/** gfx/tiles.chr の BG の 16x16 の絵 (地形 id) の画素 (x, y) の色番号 0..3。 */
export function tileArt(chr: Uint8Array, id: number, x: number, y: number): number {
  const t = id * 4 + ((y >> 3) * 2 + (x >> 3)), b = t * 16, r = y & 7, bit = 7 - (x & 7);
  return ((chr[b + r] >> bit) & 1) | (((chr[b + 8 + r] >> bit) & 1) << 1);
}
