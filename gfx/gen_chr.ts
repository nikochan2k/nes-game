#!/usr/bin/env bun
/**
 * gfx/tiles.chr (8KB) を生成する。
 *
 *   $0000 BG     : 16x16 地形を 8x8 x4 (TL,TR,BL,BR) で 1 メタタイルとして並べる
 *   $1000 スプライト: 16x16 のプレイヤー 6 フレーム x4 タイル
 *
 * 色番号 0..3 の意味はパレットごとに main.c 側で決める。
 */

import { RAIL_PAIRS } from "../server/rail";

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

function transpose(g: Grid): Grid {
  return g.map((_, y) => g.map((row) => row[y]));
}

/**
 * Python の random.Random(seed).randrange(n) と同じ列を出す (MT19937)。
 * 岩の模様を Python 版と同じにするために使う。
 */
class PyRandom {
  private mt = new Uint32Array(624);
  private i = 624;

  constructor(seed: number) {
    const mt = this.mt;
    mt[0] = 19650218;
    for (let k = 1; k < 624; k++) {
      mt[k] = Math.imul(1812433253, mt[k - 1] ^ (mt[k - 1] >>> 30)) + k;
    }
    // init_by_array([seed])
    let i = 1;
    for (let k = 624; k > 0; k--) {
      mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + seed;
      if (++i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    for (let k = 623; k > 0; k--) {
      mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i;
      if (++i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  private next(): number {
    const mt = this.mt;
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = mt[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  randrange(n: number): number {
    const k = 32 - Math.clz32(n);
    for (;;) {
      const r = this.next() >>> (32 - k);
      if (r < n) {
        return r;
      }
    }
  }
}

// ---- BG (pal0: 緑, pal1: 黄/赤, pal2: 黒/濃い灰/白, pal3: 青。割り当ては main.c の tile_pal) ----
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

/** 丘 1 つを描く。cx=中心、hw=半幅、h=高さ。縁は濃い緑、右側に斜めの陰影 (パレット 0: 1=濃い緑 2=薄い緑 3=茶)。 */
function hill(g: Grid, cx: number, hw: number, h: number) {
  for (let x = Math.max(0, cx - hw); x <= Math.min(15, cx + hw); x++) {
    const t = (x - cx) / hw;
    const top = 15 - Math.round(h * Math.sqrt(Math.max(0, 1 - t * t)));      // 半楕円の稜線
    for (let y = top; y < 16; y++) {
      let c = 2;
      if (y === top) c = 1;                                                    // 稜線
      else if (x > cx && y > top + 1 && (x + y) % 2 === 0) c = 1;              // 右側の陰
      g[y][x] = c;
    }
  }
}

/** 山: なだらかな丘が 2 つ並ぶ。 */
function mountain(): Grid {
  const g = grid();
  hill(g, 4, 8, 9);
  hill(g, 12, 7, 6);
  for (const [x, y] of [[3, 9], [5, 12], [11, 11], [13, 14], [2, 14]]) g[y][x] = 3;   // 土
  return g;
}

/**
 * 岩の峰 1 つ (パレット 2: 1=濃い灰 2=灰 3=白)。cx=中心、top=頂の行、slope=すそ野の広がり方。
 * 左は明るい面、右は暗い面。縁はでこぼこ。snow=頂に白い雪、稜線は白。
 */
function crag(g: Grid, cx: number, top: number, slope: number, seed: number, snow: boolean) {
  const rnd = new PyRandom(seed);
  for (let r = top; r < 16; r++) {
    const hw = Math.min(8, Math.round((r - top) * slope) + 1);
    const jl = rnd.randrange(2), jr = rnd.randrange(2);
    for (let x = Math.max(0, cx - hw + jl); x <= Math.min(15, cx + hw - jr); x++) {
      let c = x < cx ? 2 : 1;
      if (x < cx && (x + r) % 5 === 0) c = 3;                                   // 左 (明るい面) の白い粒
      if (snow && r - top < 4 && x < cx && (x + r) % 3 !== 0) c = 3;
      g[r][x] = c;
    }
    if (r - top < 9) g[r][cx] = 3;                                              // 稜線
  }
  for (let k = 0; k < 5; k++) {                                                 // 割れ目と岩肌
    const x = cx - 4 + rnd.randrange(8), y = top + 4 + rnd.randrange(Math.max(1, 15 - top - 4));
    if (y < 16 && x >= 0 && x < 16 && g[y][x] !== 0) g[y][x] = x < cx ? 1 : 2;
  }
}

/** 岩山: 高い峰と低い峰の 2 つ (パレット 2: 1=黒 2=濃い灰 3=白)。 */
function rock(): Grid {
  const g = grid();
  crag(g, 4, 1, 0.6, 11, true);
  crag(g, 11, 5, 0.55, 23, false);
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

/** 道路 (パレット 2: 1=黒 2=濃い灰 3=白): 向きのない 1 種。濃い灰の舗装に、黒と白の粒だけ。 */
function road(): Grid {
  const g = grid(2);
  for (const [x, y] of [[2, 3], [9, 1], [13, 6], [5, 9], [11, 12], [1, 14], [7, 15], [14, 10]]) g[y][x] = 1;
  for (const [x, y] of [[6, 5], [12, 14], [3, 11]]) g[y][x] = 3;
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

// ---- 線路: 方向 (0=E 1=SE 2=S 3=SW 4=W 5=NW 6=N 7=NE) のつながる 2 方向から描く ----
const PT: [number, number][] = [[16, 8], [16, 16], [8, 16], [0, 16], [0, 8], [0, 0], [8, 0], [16, 0]];   // 各方向の辺・角の位置

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 線路: 方向 a と b をつなぐ太さ 4 画素の線 (パレット 2: 1=黒 3=白)。桃太郎電鉄風に、白と黒が互い違い
 * (横・縦は 4 画素ごと、斜めは (x±y) 8 ごと。タイルをまたいでも交互につながる)。地面は草と同じ緑。
 */
function railArt(a: number, b: number): Grid {
  const g = grid(0);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const px = x + 0.5, py = y + 0.5;
      const da = segDist(px, py, PT[a][0], PT[a][1], 8, 8), db = segDist(px, py, PT[b][0], PT[b][1], 8, 8);
      if (Math.min(da, db) > 2.0) continue;
      const s = da <= db ? a : b;
      let block: number;
      if (s === 0 || s === 4) block = Math.floor(px / 4);
      else if (s === 2 || s === 6) block = Math.floor(py / 4);
      else if (s === 1 || s === 5) block = Math.floor((px + py) / 8);
      else block = Math.floor((px - py + 16) / 8);
      g[y][x] = block % 2 === 0 ? 3 : 1;
    }
  }
  return g;
}

/** 踏切 (線路が横に走り、道路が縦に横切る): 緑の地に灰色の道路 (縦)、その上を白黒の線路が横切る。 */
function crossingH(): Grid {
  const g = grid(0);
  const r = road();
  for (let y = 0; y < 16; y++) for (let x = 4; x <= 11; x++) g[y][x] = r[y][x];
  for (let x = 0; x < 16; x++) for (let y = 6; y <= 9; y++) g[y][x] = (x >> 2) % 2 === 0 ? 3 : 1;
  return g;
}

/**
 * 駅 (パレット 2: 0=緑 1=黒 3=白): 黒い円盤に白い電車の正面 (参照: icooon-mono の「駅」の題材)。
 * 1 つの駅に 1 マスだけ置く。市街地 (赤・黄) とは違う黒白。
 */
function station(): Grid {
  const g = grid(0);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (Math.hypot(x + 0.5 - 8, y + 0.5 - 8) < 7.8) g[y][x] = 1;
  for (let y = 3; y <= 10; y++) for (let x = 4; x <= 11; x++) if (!(y === 3 && (x === 4 || x === 11))) g[y][x] = 3;   // 車体
  for (let x = 6; x <= 9; x++) g[4][x] = 1;                                                                        // 行き先表示
  for (let y = 5; y <= 7; y++) for (const x of [5, 6, 9, 10]) g[y][x] = 1;                                         // 窓
  g[9][5] = g[9][10] = 1;                                                                                          // ライト
  for (let i = 0; i < 3; i++) { g[11 + i][6 - i] = 3; g[11 + i][9 + i] = 3; }                                      // レール
  return g;
}

// 並び順は src/terrain.h の T_* と一致させる
const BG = [grass(), forest(), mountain(), rock(), water(),
  building(), sand(), wetland(),
  road(),
  ...RAIL_PAIRS.map(([a, b]) => railArt(a, b)),              // 線路 20 種 (server/rail.ts の並び)
  crossingH(), transpose(crossingH()),
  station()];

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
