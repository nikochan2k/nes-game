#!/usr/bin/env bun
/**
 * NES 用の地図サーバー (Raspberry Pi 想定、Bun のみで動き依存パッケージなし)。
 *
 * NES から z/x/y のタイル番号とタイル内のマス位置を受け取り、1 行 (または 1 列) ぶんの
 * 地形 ID を返す。地形 ID は src/terrain.h と一致させる。
 *
 * 要求 (9 バイト):
 *   [0]    z (1..20)
 *   [1:4]  タイル x (24bit ビッグエンディアン)
 *   [4:7]  タイル y (同上)
 *   [7]    xo<<4 | yo   タイル内のマス位置 (1 タイル = 16x16 マス)
 *   [8]    vertical<<7 | len   vertical=1 なら y 方向、0 なら x 方向に len マス (1..63)
 * 応答: len バイト (1 マス 1 バイトの地形 ID)
 *
 * マスの世界座標は X = tx*16+xo, Y = ty*16+yo。1 辺は 2**(z+4) マス。
 * X は経度方向なので巻き戻し、Y が範囲外なら T_ROCK (極の外側) を返す。
 */
import { parseArgs } from "node:util";

export const T_GRASS = 0, T_FOREST = 1, T_MOUNTAIN = 2, T_ROCK = 3, T_WATER = 4,
  T_BRIDGE_H = 5, T_BRIDGE_V = 6, T_ROAD_H = 7, T_ROAD_V = 8, T_ROAD_X = 9;

export const Z_MIN = 1, Z_MAX = 20;
export const REQ_LEN = 9;
export const SEED = 88;     // 起動地点 (東京 z=10) が陸になるように選んだ

// 32bit の掛け算は Math.imul で下位 32bit だけ取る (Python 版の & 0xFFFFFFFF と同じ結果)
function hash(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3.0 - 2.0 * t);
}

/** 周期 freq (u 方向は巻き戻し) の値ノイズ。u, v は 0..1。 */
function vnoise(u: number, v: number, freq: number, seed: number): number {
  const fx = u * freq, fy = v * freq;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = smooth(fx - ix), ty = smooth(fy - iy);
  const at = (i: number, j: number) => hash(i % freq, j, seed);
  const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
  const bot = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
  return top * (1 - ty) + bot * ty;
}

function fbm(u: number, v: number, seed: number, octaves: number): number {
  let total = 0.0, amp = 1.0, norm = 0.0;
  for (let k = 0; k < octaves; k++) {
    total += amp * vnoise(u, v, 4 << k, seed + k * 101);
    norm += amp;
    amp *= 0.55;
  }
  return total / norm;
}

export interface Source {
  cell(z: number, x: number, y: number): number;
}

/** ノイズで作った仮の世界。ズームしても同じ場所が同じ地形になる。 */
export class SyntheticSource implements Source {
  static readonly SEA = 0.50;

  constructor(readonly seed = 1) {}

  private moisture(u: number, v: number, w: number, octaves: number, z: number): number {
    let m = fbm(u, v, this.seed + 7, octaves);
    if (z >= 3) {
      m = 0.4 * m + 0.6 * vnoise(u, v, w >> 3, this.seed + 80);
    }
    return m;
  }

  cell(z: number, x: number, y: number): number {
    const w = 1 << (z + 4);
    if (y < 0 || y >= w) {
      return T_ROCK;
    }
    x = ((x % w) + w) % w;
    const u = (x + 0.5) / w, v = (y + 0.5) / w;
    const octaves = Math.min(z + 2, 10);
    // 大域のノイズに、1 マスが粗くなりすぎないよう 16 マス程度の起伏を重ねる
    let e = fbm(u, v, this.seed, octaves);
    if (z >= 3) {
      e = 0.6 * e + 0.4 * vnoise(u, v, w >> 4, this.seed + 50);
    }
    if (v < 0.04 || v > 0.96) {
      e = Math.max(e, 0.9);     // 極冠
    }
    let t: number;
    if (e <= SyntheticSource.SEA) {
      t = T_WATER;
    } else if (e > 0.70) {
      t = T_ROCK;
    } else if (e > 0.62) {
      t = T_MOUNTAIN;
    } else if (this.moisture(u, v, w, octaves, z) > 0.55) {
      t = T_FOREST;
    } else {
      t = T_GRASS;
    }
    if (z >= 9) {               // 拡大すると 32 マスおきに道路が通る
      if (x % 32 === 0 && y % 32 === 0) {
        return T_ROAD_X;
      }
      if (x % 32 === 0) {
        return t === T_WATER ? T_BRIDGE_V : T_ROAD_V;
      }
      if (y % 32 === 0) {
        return t === T_WATER ? T_BRIDGE_H : T_ROAD_H;
      }
    }
    return t;
  }
}

export interface Request {
  z: number;
  x: number;
  y: number;
  vertical: boolean;
  n: number;
}

const u24 = (b: Uint8Array, i: number) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];

export function decodeRequest(req: Uint8Array): Request {
  const xo = req[7] >> 4, yo = req[7] & 15;
  return {
    z: req[0],
    x: u24(req, 1) * 16 + xo,
    y: u24(req, 4) * 16 + yo,
    vertical: (req[8] & 0x80) !== 0,
    n: req[8] & 0x3f,
  };
}

export function answer(source: Source, req: Uint8Array): Uint8Array {
  const { z, x, y, vertical, n } = decodeRequest(req);
  const res = new Uint8Array(n);
  if (!(Z_MIN <= z && z <= Z_MAX)) {
    return res.fill(T_ROCK);
  }
  for (let i = 0; i < n; i++) {
    res[i] = vertical ? source.cell(z, x, y + i) : source.cell(z, x + i, y);
  }
  return res;
}

interface Conn {
  buf: Uint8Array;      // まだ 9 バイトに満たない受信データ
  out: Uint8Array;      // 書き切れなかった応答 (drain で続きを送る)
}

function flush(sock: Bun.Socket<Conn>) {
  const out = sock.data.out;
  if (out.length > 0) {
    sock.data.out = out.subarray(sock.write(out));
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}

/** port に 0 を渡すと空いているポートを使う (実際の番号は戻り値の .port)。 */
export function serve(source: Source, hostname: string, port: number, verbose = false) {
  return Bun.listen<Conn>({
    hostname,
    port,
    socket: {
      open(sock) {
        sock.data = { buf: new Uint8Array(0), out: new Uint8Array(0) };
      },
      data(sock, chunk) {
        // TCP は区切りを保たないので、9 バイトずつ切り出して順に答える
        let buf = concat(sock.data.buf, new Uint8Array(chunk));
        let res = sock.data.out;
        while (buf.length >= REQ_LEN) {
          const req = buf.subarray(0, REQ_LEN);
          res = concat(res, answer(source, req));
          if (verbose) {
            const { z, x, y, vertical, n } = decodeRequest(req);
            console.log(`z=${z} cell=(${x},${y}) ${vertical ? "col" : "row"} n=${n}`);
          }
          buf = buf.subarray(REQ_LEN);
        }
        sock.data.buf = buf.slice();
        sock.data.out = res;
        flush(sock);
      },
      drain(sock) {
        flush(sock);
      },
    },
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "5555" },
      seed: { type: "string", default: String(SEED) },
      verbose: { type: "boolean", short: "v", default: false },
    },
  });
  const seed = Number(values.seed);
  const srv = serve(new SyntheticSource(seed), values.host, Number(values.port), values.verbose);
  console.log(`mapserver listening on ${srv.hostname}:${srv.port} (seed ${seed})`);
}

if (import.meta.main) {
  main();
}
