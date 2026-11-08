#!/usr/bin/env bun
/**
 * gfx/tiles.chr (8KB) を生成する。
 *
 *   $0000 BG     : 16x16 地形を 8x8 x4 (TL,TR,BL,BR) で 1 メタタイルとして並べる
 *   $1000 スプライト: 16x16 のプレイヤー 6 フレーム x4 タイル
 *
 * 色番号 0..3 の意味はパレットごとに main.c 側で決める。
 */

import { ARM_E, ARM_N, ARM_S, ARM_W, SHAPES } from "../server/rail";

type Grid = number[][];

function grid(fill = 0): Grid {
  return Array.from({ length: 16 }, () => new Array<number>(16).fill(fill));
}

const wrap = (v: number) => ((v % 16) + 16) % 16;

function put(g: Grid, x: number, y: number, c: number) {
  g[wrap(y)][wrap(x)] = c;
}

function fromArt(rows: string[]): Grid {
  if (rows.length !== 16 || !rows.every((r) => r.length === 16)) {
    throw new Error(`art must be 16x16: ${rows}`);
  }
  return rows.map((r) => [...r].map(Number));
}

// ---- BG (pal0: 緑, pal1: 黄/赤, pal2: 黒/灰/白, pal3: 青/黄緑。割り当ては main.c の tile_pal) ----
function grass(): Grid {
  const g = grid();
  for (const [x, y] of [[3, 2], [11, 5], [6, 9], [13, 12], [2, 13]]) {
    put(g, x, y, 2); put(g, x - 1, y + 1, 2); put(g, x + 1, y + 1, 2);
  }
  for (const [x, y] of [[9, 1], [1, 7], [8, 13], [14, 8]]) {
    put(g, x, y, 1);
  }
  return g;
}

const TREE = ["00111100", "01121110", "11211111", "11111121",
  "11111111", "01111110", "00033000", "00033000"];

function forest(): Grid {
  const g = grid();
  for (const [ox, oy] of [[0, 0], [8, 0], [4, 8], [12, 8]]) {
    TREE.forEach((row, ty) => {
      [...row].forEach((ch, tx) => {
        if (ch !== "0") {
          put(g, ox + tx, oy + ty, Number(ch));
        }
      });
    });
  }
  return g;
}

/** 丘 1 つを描く。cx=中心、hw=半幅、h=高さ。縁 edge、面 body、右側に斜めの陰 (edge の市松)。 */
function hill(g: Grid, cx: number, hw: number, h: number, edge: number, body: number) {
  for (let x = Math.max(0, cx - hw); x <= Math.min(15, cx + hw); x++) {
    const t = (x - cx) / hw;
    const top = 15 - Math.round(h * Math.sqrt(Math.max(0, 1 - t * t)));      // 半楕円の稜線
    for (let y = top; y < 16; y++) {
      const rim = y === top || x === cx - hw || x === cx + hw;
      g[y][x] = rim ? edge : (x > cx && y > top + 1 && (x + y) % 2 === 0 ? edge : body);
    }
  }
}

/** 山: 緑の丸い丘が 2 つ重なる (奥の大きい丘と、手前の小さい丘)。パレット 0: 1=濃い緑 2=薄い緑 3=茶 (土の点)。 */
function mountain(): Grid {
  const g = grid();
  hill(g, 5, 7, 12, 1, 2);
  hill(g, 11, 5, 8, 1, 2);
  for (const [x, y] of [[4, 11], [3, 14], [10, 12], [12, 14]]) g[y][x] = 3;
  return g;
}

/**
 * 岩山: 灰色のとがった峰が 2 つ重なる (奥の高い峰と、手前の低い峰)。パレット 2: 1=黒 2=灰 3=白。
 * 縁は黒、左の面は灰に白い粒、右の面は黒と灰の市松、稜線は白。
 */
function rock(): Grid {
  const g = grid();
  const peak = (cx: number, top: number, hwMax: number, slope: number) => {
    for (let y = top; y <= 15; y++) {
      const w = Math.min(hwMax, Math.floor((y - top) * slope));
      for (let x = cx - w; x <= cx + w; x++) {
        let c = 2;
        if (x === cx - w || x === cx + w || y === 15) c = 1;
        else if (x > cx) c = (x + y) % 2 === 0 ? 1 : 2;
        else if (x === cx) c = 3;
        else if ((x + y) % 5 === 0) c = 3;
        g[y][x] = c;
      }
    }
  };
  peak(5, 0, 7, 0.55);
  peak(11, 5, 5, 0.5);
  return g;
}

function water(): Grid {
  const g = grid(1);
  for (const [x, y] of [[2, 3], [10, 2], [6, 8], [14, 9], [3, 13], [11, 14]]) {
    for (let dx = 0; dx < 3; dx++) {
      put(g, x + dx, y, 2);
    }
  }
  return g;
}

const fill = (g: Grid, x0: number, y0: number, x1: number, y1: number, c: number) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = c;
};

/** 三角屋根の家を描く (x0..x1、屋根の頂 roofTop、壁の下端 wallBottom)。 */
function roofHouse(g: Grid, x0: number, x1: number, roofTop: number, wallBottom: number, roof: number, wall: number, trim: number) {
  const mid = (x0 + x1) / 2, rows = Math.ceil((x1 - x0) / 2) + 1;
  for (let i = 0; i < rows; i++) {                                              // 三角屋根
    const hw = Math.min((x1 - x0) / 2, 0.5 + i);
    for (let x = Math.ceil(mid - hw); x <= Math.floor(mid + hw); x++) g[roofTop + i][x] = roof;
  }
  const wallTop = roofTop + rows;
  fill(g, x0 + 1, wallTop, x1 - 1, wallBottom, wall);                           // 壁
  g[wallTop - 1][x0] = roof; g[wallTop - 1][x1] = roof;                         // 軒
  g[wallBottom - 1][Math.floor(mid)] = trim; g[wallBottom][Math.floor(mid)] = trim;   // 扉
  g[wallTop + 1][x0 + 2 <= x1 - 2 ? x0 + 2 : x0 + 1] = trim;                    // 窓
}

/**
 * 建物 (パレット 1: 0=緑 1=黄 2=淡い黄 3=赤): ビル 1 棟と、赤い三角屋根の家 1 軒。市街地も同じ絵。
 * 背景は草と同じ緑。ビルは淡い黄の壁に黄色い窓と赤い屋上、家は赤い屋根と煙突。
 */
function building(): Grid {
  const g = grid(0);
  fill(g, 1, 2, 6, 14, 2); fill(g, 1, 1, 6, 2, 3);                              // ビル: 淡い黄の壁、赤い屋上
  g[0][3] = 3; g[0][4] = 3;                                                     // アンテナ
  for (const y of [4, 7, 10]) for (const x of [2, 5]) { g[y][x] = 1; g[y + 1][x] = 1; }   // 黄色い窓
  fill(g, 3, 12, 4, 14, 3);                                                     // 入口
  for (let y = 3; y < 15; y++) g[y][6] = 1;                                     // 右の陰 (黄)
  roofHouse(g, 8, 14, 6, 14, 3, 2, 1);                                          // 家: 赤い屋根
  g[4][13] = 3; g[5][13] = 3;                                                   // 煙突
  return g;
}

/** 砂 (パレット 1: 1=黄 2=淡い黄 3=赤): 淡い黄色の地に、黄色い粒。 */
function sand(): Grid {
  const g = grid(2);
  for (const [x, y] of [[2, 2], [9, 1], [13, 5], [5, 7], [11, 10], [2, 12], [7, 14], [14, 14], [6, 3]]) {
    put(g, x, y, 1); put(g, x + 1, y + 1, 1);
  }
  return g;
}

function wetland(): Grid {
  const g = grid(0);
  for (const [x, y] of [[1, 3], [9, 2], [5, 8], [12, 10], [2, 13]]) {
    for (let dx = 0; dx < 4; dx++) {
      put(g, x + dx, y, 1);
    }
  }
  for (const [x, y] of [[4, 5], [13, 6], [8, 12], [1, 9]]) {
    put(g, x, y, 3); put(g, x, y - 1, 3); put(g, x, y - 2, 3);
  }
  return g;
}

// ---- 道路・線路: 4 方向 (E=1 S=2 W=4 N=8) のつながる方向から描く (罫線スタイル) ----
const ARM_END: [number, number][] = [[16, 8], [8, 16], [0, 8], [8, 0]];      // 各腕の、タイルの辺の中点
const ARM_COLOR = [1, 1, 0, 0];                                              // 端の色: 東・南=黒 西・北=白。向かい合う端は逆色

/** 点 (px, py) から腕 arm (辺の中点 → 中心) までの距離 d と、辺からの道のり s (0..8)。 */
function armInfo(px: number, py: number, arm: number): { d: number; s: number } {
  const [ex, ey] = ARM_END[arm], dx = 8 - ex, dy = 8 - ey;
  const t = Math.max(0, Math.min(1, ((px - ex) * dx + (py - ey) * dy) / (dx * dx + dy * dy)));
  return { d: Math.hypot(px - (ex + t * dx), py - (ey + t * dy)), s: t * 8 };
}

/**
 * 道路・線路のタイル (パレット 2: 1=黒 2=灰 3=白。地面は緑の背景色)。
 * 線路: 太さ 4 画素の、白と黒が互い違いの線 (腕ごとに、辺から 4 画素ずつ交互。端の色が固定なので、タイルをまたいでも交互につながる)。
 * 道路: 太さ約 5 画素の灰色の舗装に、黒い縁。
 */
function pathArt(arms: number, kind: "rail" | "road"): Grid {
  const g = grid(0);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let best = { d: 99, s: 0, a: -1 };
      for (let a = 0; a < 4; a++) {
        if (!(arms & (1 << a))) continue;
        const r = armInfo(x + 0.5, y + 0.5, a);
        if (r.d < best.d - 1e-9 || (Math.abs(r.d - best.d) < 1e-9 && r.s > best.s)) best = { ...r, a };
      }
      if (best.a < 0) continue;
      if (kind === "rail") {
        if (best.d <= 2.0) {
          const blk = Math.floor(best.s / 4) % 2 === 0 ? ARM_COLOR[best.a] : 1 - ARM_COLOR[best.a];
          g[y][x] = blk === 0 ? 3 : 1;
        }
      } else if (best.d <= 2.4) {
        g[y][x] = 2;
      } else if (best.d <= 3.4) {
        g[y][x] = 1;
      }
    }
  }
  return g;
}

/** 踏切: 道路の上を、線路 (白黒) が横切る。railArms は線路の向き (横 = E|W、縦 = S|N)。道路は直交する向き。 */
function crossing(railArms: number): Grid {
  const road = pathArt(railArms === (ARM_E | ARM_W) ? ARM_S | ARM_N : ARM_E | ARM_W, "road");
  const rail = pathArt(railArms, "rail");
  return road.map((row, y) => row.map((c, x) => (rail[y][x] !== 0 ? rail[y][x] : c)));
}

/**
 * 駅 (パレット 2: 1=黒 3=白): タイル全面の黒い四角に、白い電車の正面 (車体 10x10 画素)。
 * 1 つの駅に 1 マスだけ置く。市街地 (赤・黄) とは違う黒白。
 */
function station(): Grid {
  const g = grid(1);
  for (let y = 2; y <= 11; y++) for (let x = 3; x <= 12; x++) if (!(y === 2 && (x === 3 || x === 12))) g[y][x] = 3;   // 車体
  for (let x = 5; x <= 10; x++) g[3][x] = 1;                                                                        // 行き先表示
  for (let y = 5; y <= 7; y++) for (const x of [4, 5, 6, 9, 10, 11]) g[y][x] = 1;                                   // 窓
  g[9][4] = g[9][11] = 1;                                                                                           // ライト
  for (let i = 0; i < 3; i++) { g[12 + i][5 - i] = 3; g[12 + i][10 + i] = 3; }                                      // レール
  return g;
}

/** 空港 (パレット 2): 駅と同じ、タイル全面の黒い四角に、上から見た白い飛行機。 */
function airport(): Grid {
  const rows = ["1111111331111111", "1111111331111111", "1111111331111111", "1111111331111111", "1111113333111111",
    "1113333333333111", "3333333333333333", "1113333333333111", "1111113333111111", "1111113333111111",
    "1111113333111111", "1113333333333111", "1113331331333111", "1111111331111111", "1111111111111111", "1111111111111111"];
  return rows.map((r) => [...r].map(Number));
}

/** 空港のアスファルト (パレット 2): 灰色に、黒い点が少しだけ。道路の灰色と同じ。 */
function asphalt(): Grid {
  const g = grid(2);
  for (const [x, y] of [[3, 4], [11, 9], [6, 13], [13, 2]]) g[y][x] = 1;
  return g;
}

// 並び順は src/terrain.h の T_* と一致させる
const BG = [grass(), forest(), mountain(), rock(), water(),
  building(), sand(), wetland(),
  ...SHAPES.map((arms) => pathArt(arms, "road")),            // 道路 11 種 (server/rail.ts の SHAPES の並び)
  ...SHAPES.map((arms) => pathArt(arms, "rail")),            // 線路 11 種
  crossing(ARM_E | ARM_W), crossing(ARM_S | ARM_N),          // 踏切 (線路が横 / 縦)
  station(), airport(), asphalt()];

// ---- プレイヤー (上半身 pal0: 1=髪 2=肌 3=赤キャップ / 下半身 pal1: 1=白 2=ジーンズ 3=肌) ----
const LEGS_STAND = ["0000022222200000", "0000022222200000", "0000022002200000", "0000011001100000"];
const LEGS_WALK  = ["0000022222200000", "0000022222200000", "0000022001100000", "0000011000000000"];
const BODY_FRONT = ["0000111111110000", "0001111111111000", "0001111111111000", "0003011111103000"];

const HEAD_FRONT = ["0000000000000000", "0000033333300000", "0000333333330000", "0000112222110000",
  "0000121221210000", "0000022222200000", "0000002222000000", "0000002222000000"];
const HEAD_BACK  = ["0000000000000000", "0000033333300000", "0000333333330000", "0000333333330000",
  "0000111111110000", "0000011111100000", "0000002222000000", "0000002222000000"];
const HEAD_SIDE  = ["0000000000000000", "0000003333000000", "0000033333300000", "0000011333333000",
  "0000011221220000", "0000001222200000", "0000000222000000", "0000000220000000"];
const BODY_SIDE  = ["0000001111000000", "0000011111100000", "0000011111100000", "0000011111300000"];
const SIDE_STAND = ["0000002222000000", "0000002222000000", "0000002222000000", "0000001111000000"];
const SIDE_STRIDE = ["0000002222000000", "0000022002200000", "0000220000220000", "0000110000110000"];

const SPR = [
  fromArt([...HEAD_FRONT, ...BODY_FRONT, ...LEGS_STAND]),   // 0 down stand
  fromArt([...HEAD_FRONT, ...BODY_FRONT, ...LEGS_WALK]),    // 1 down walk
  fromArt([...HEAD_BACK, ...BODY_FRONT, ...LEGS_STAND]),    // 2 up stand
  fromArt([...HEAD_BACK, ...BODY_FRONT, ...LEGS_WALK]),     // 3 up walk
  fromArt([...HEAD_SIDE, ...BODY_SIDE, ...SIDE_STAND]),     // 4 side stand
  fromArt([...HEAD_SIDE, ...BODY_SIDE, ...SIDE_STRIDE]),    // 5 side stride
];

function tileBytes(g: Grid, tx: number, ty: number): number[] {
  const p0: number[] = [], p1: number[] = [];
  for (let y = 0; y < 8; y++) {
    let b0 = 0, b1 = 0;
    for (let x = 0; x < 8; x++) {
      const c = g[ty * 8 + y][tx * 8 + x];
      b0 = (b0 << 1) | (c & 1);
      b1 = (b1 << 1) | (c >> 1);
    }
    p0.push(b0); p1.push(b1);
  }
  return [...p0, ...p1];
}

function bank(images: Grid[]): Uint8Array {
  const out = new Uint8Array(0x1000);
  let pos = 0;
  for (const g of images) {
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        out.set(tileBytes(g, tx, ty), pos);
        pos += 16;
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const data = new Uint8Array(0x2000);
  data.set(bank(BG));
  data.set(bank(SPR), 0x1000);
  await Bun.write(process.argv[2] ?? "gfx/tiles.chr", data);
}
