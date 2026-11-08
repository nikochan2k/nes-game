/**
 * 道路・線路のタイル (罫線スタイル)。マスは、上下左右の隣のうち同じ種類 (道路なら道路、線路なら線路) があるものを見て、
 * 「つながる方向」の組み合わせで決まる。斜めはない (斜めの線は、階段状に 4 方向でつなぐ)。
 * 方向のビット: E=1 S=2 W=4 N=8。
 * 11 種: ─ │ ┌ ┐ ┘ └ ┬ ┤ ┴ ├ ┼。行き止まり (1 方向だけ・0 方向) は、その軸の直線で描く (端は駅になる前提)。
 * gfx/gen_chr.ts (絵) とサーバーが同じ並びを使う。
 */
import { N_SHAPES, T_RAIL, T_ROAD } from "./terrain";

export const ARM_E = 1, ARM_S = 2, ARM_W = 4, ARM_N = 8;
/** 4 方向の隣の位置 (E S W N の順。ビットと同じ並び)。 */
export const ARM_DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** 11 種の形 (つながる方向のビット)。タイル番号 = T_ROAD (または T_RAIL) + このリストでの位置。 */
export const SHAPES: number[] = [
  ARM_E | ARM_W,                      // ─
  ARM_S | ARM_N,                      // │
  ARM_E | ARM_S,                      // ┌
  ARM_S | ARM_W,                      // ┐
  ARM_W | ARM_N,                      // ┘
  ARM_N | ARM_E,                      // └
  ARM_E | ARM_S | ARM_W,              // ┬
  ARM_S | ARM_W | ARM_N,              // ┤
  ARM_W | ARM_N | ARM_E,              // ┴
  ARM_N | ARM_E | ARM_S,              // ├
  ARM_E | ARM_S | ARM_W | ARM_N,      // ┼
];
if (SHAPES.length !== N_SHAPES) throw new Error("SHAPES の数が N_SHAPES と違う");

/** 行き止まり (0 または 1 方向) を、その軸の直線にする。2 方向以上はそのまま。 */
export function normArms(arms: number): number {
  if (arms === 0 || arms === ARM_E || arms === ARM_W) return ARM_E | ARM_W;
  if (arms === ARM_S || arms === ARM_N) return ARM_S | ARM_N;
  return arms;
}

/** つながる方向 (ビット) から、形の番号 (0..10)。 */
export function shapeOf(arms: number): number {
  return SHAPES.indexOf(normArms(arms));
}
export const roadTile = (arms: number) => T_ROAD + shapeOf(arms);
export const railTile = (arms: number) => T_RAIL + shapeOf(arms);

/** 隣のマスの有無 (has(dx, dy)) から、そのマスのつながる方向のビット。 */
export function armsOf(has: (dx: number, dy: number) => boolean): number {
  let arms = 0;
  for (let d = 0; d < 4; d++) {
    if (has(ARM_DIRS[d][0], ARM_DIRS[d][1])) arms |= 1 << d;
  }
  return arms;
}

/** 踏切の種類: 線路が横の直線で道路が縦の直線なら "H"、線路が縦で道路が横なら "V"、それ以外は null (線路だけを描く)。 */
export function crossingFor(railArms: number, roadArms: number): "H" | "V" | null {
  const r = normArms(railArms), o = normArms(roadArms);
  if (r === (ARM_E | ARM_W) && o === (ARM_S | ARM_N)) return "H";
  if (r === (ARM_S | ARM_N) && o === (ARM_E | ARM_W)) return "V";
  return null;
}
