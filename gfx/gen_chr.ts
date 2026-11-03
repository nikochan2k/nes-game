#!/usr/bin/env bun
/**
 * gfx/tiles.chr (8KB) を生成する。
 *
 *   $0000 BG     : 16x16 地形を 8x8 x4 (TL,TR,BL,BR) で 1 メタタイルとして並べる
 *   $1000 スプライト: 16x16 のプレイヤー 6 フレーム x4 タイル
 *
 * 色番号 0..3 の意味はパレットごとに main.c 側で決める。
 */

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

// ---- BG (pal0: 緑, pal1: 茶/白, pal2: 灰, pal3: 青。割り当ては main.c の tile_pal) ----
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

function mountain(): Grid {
  const g = grid();
  for (let r = 1; r < 15; r++) {
    const hw = Math.trunc(r * 0.55) + 1;
    for (let x = Math.max(0, 8 - hw); x < Math.min(16, 8 + hw); x++) {
      let c = x < 8 ? 1 : 2;
      if (r <= 3 || (r === 4 && x % 2 === 0) || (r === 5 && x % 4 === 0)) {
        c = 3;
      }
      g[r][x] = c;
    }
  }
  return g;
}

function rock(): Grid {
  const rnd = new PyRandom(7);
  const g = grid(2);
  for (let k = 0; k < 14; k++) {
    const x = rnd.randrange(16), y = rnd.randrange(16);
    for (const [dx, dy] of [[0, 0], [1, 0], [1, 1]]) {
      put(g, x + dx, y + dy, 1);
    }
  }
  for (let k = 0; k < 9; k++) {
    const x = rnd.randrange(16), y = rnd.randrange(16);
    put(g, x, y, 3);
  }
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

function bridgeH(): Grid {
  const g = water();
  for (let x = 0; x < 16; x++) {
    g[2][x] = 2;
    g[13][x] = 2;
    for (let y = 3; y < 13; y++) {
      g[y][x] = x % 4 === 0 ? 1 : 3;
    }
  }
  return g;
}

function roadH(): Grid {
  const g = grid();
  for (let x = 0; x < 16; x++) {
    g[0][x] = g[15][x] = 2;
    for (let y = 1; y < 15; y++) {
      g[y][x] = 1;
    }
    if ([2, 3, 4, 5].includes(x % 8)) {
      g[7][x] = g[8][x] = 3;
    }
  }
  return g;
}

function roadX(): Grid {
  const g = grid(1);
  for (const [x, y] of [[0, 0], [14, 0], [0, 14], [14, 14]]) {
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        g[y + dy][x + dx] = 2;
      }
    }
  }
  return g;
}

// pal0=緑 (1 濃緑 2 薄緑 3 茶) / pal1=茶/白 (1 茶 2 濃茶 3 白) / pal2=灰 (1 濃灰 2 灰 3 白)
function urban(): Grid {
  const g = grid(2);
  for (let i = 0; i < 16; i++) {
    g[0][i] = g[8][i] = 1;
    g[i][0] = g[i][8] = 1;
  }
  for (const [x, y] of [[3, 3], [11, 3], [3, 11], [11, 11]]) {
    put(g, x, y, 3);
  }
  return g;
}

function building(): Grid {
  const g = grid(1);
  for (let y = 1; y < 15; y++) {
    for (let x = 1; x < 15; x++) {
      g[y][x] = y < 3 ? 3 : 2;
    }
  }
  for (let y = 5; y < 14; y += 3) {
    for (let x = 3; x < 13; x += 3) {
      put(g, x, y, 1); put(g, x + 1, y, 1);
    }
  }
  return g;
}

function sand(): Grid {
  const g = grid(1);
  for (const [x, y] of [[2, 2], [9, 1], [13, 5], [5, 7], [11, 10], [2, 12], [7, 14]]) {
    put(g, x, y, 3); put(g, x + 1, y + 1, 2);
  }
  return g;
}

function snow(): Grid {
  const g = grid(3);
  for (const [x, y] of [[3, 3], [10, 2], [6, 8], [13, 11], [2, 13]]) {
    put(g, x, y, 1); put(g, x + 1, y, 1);
  }
  return g;
}

function farm(): Grid {
  const g = grid(0);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (y % 4 === 1) { g[y][x] = 2; }
      else if (y % 4 === 2) { g[y][x] = 1; }
    }
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

function railH(): Grid {
  const g = grid(2);
  for (let x = 0; x < 16; x++) {
    for (let y = 2; y < 14; y++) {
      if (x % 4 < 2) { g[y][x] = 1; }
    }
    g[5][x] = g[10][x] = 3;
  }
  return g;
}

function railX(): Grid {
  const g = railH();
  const v = transpose(railH());
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (v[y][x] === 3) { g[y][x] = 3; }
    }
  }
  return g;
}

function crossing(): Grid {
  const g = roadH();
  for (let y = 0; y < 16; y++) {
    g[y][5] = g[y][10] = 3;
  }
  return g;
}

function hwyH(): Grid {
  const g = grid(1);
  for (let x = 0; x < 16; x++) {
    g[0][x] = g[15][x] = 3;
    g[1][x] = g[14][x] = 2;
    g[7][x] = g[8][x] = 2;
    if (x % 4 < 2) { g[3][x] = g[12][x] = 3; }
  }
  return g;
}

function hwyX(): Grid {
  const g = grid(1);
  for (const [x, y] of [[0, 0], [14, 0], [0, 14], [14, 14]]) {
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        g[y + dy][x + dx] = 3;
      }
    }
  }
  for (let i = 2; i < 14; i++) {
    g[7][i] = g[8][i] = g[i][7] = g[i][8] = 2;
  }
  return g;
}

// 並び順は src/terrain.h の T_* と一致させる
const BG = [grass(), forest(), mountain(), rock(), water(),
  bridgeH(), transpose(bridgeH()), roadH(), transpose(roadH()), roadX(),
  urban(), building(), sand(), snow(), farm(), wetland(),
  railH(), transpose(railH()), railX(), crossing(),
  hwyH(), transpose(hwyH()), hwyX()];

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
