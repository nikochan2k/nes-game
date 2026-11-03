/**
 * 国土地理院の標高タイル (dem_png) の読み込み。
 *   data/dem/14/{x}/{y}.png  (z14 の 256x256 px。1 px = 1 マス = z18 の 1 マスと同じ格子)
 * PNG の RGB で標高を表す: x = R*65536 + G*256 + B、x=2^23 は無効、x<2^23 なら x*0.01 m、それ以外は (x-2^24)*0.01 m。
 * 0 バイトのファイルは「タイルなし (海など)」の印。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { BLOCK_SIZE } from "./worlddb";
import { slopeLevels } from "./worldbuild";

/** 8bit・非インターレースの RGB / RGBA PNG を RGB に開く。 */
export function decodePng(png: Uint8Array): { w: number; h: number; rgb: Uint8Array } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error("PNG ではない");
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      const b = new DataView(body.buffer, body.byteOffset, len);
      w = b.getUint32(0); h = b.getUint32(4); depth = body[8]; ctype = body[9]; interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace !== 0) {
    throw new Error(`未対応の PNG (depth=${depth} colortype=${ctype} interlace=${interlace})`);
  }
  const bpp = ctype === 2 ? 3 : 4, stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y > 0 ? px[dst - stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + i] = v & 255;
    }
  }
  if (bpp === 3) return { w, h, rgb: px };
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set(px.subarray(i * 4, i * 4 + 3), i * 3);
  return { w, h, rgb };
}

export function rgbToElevation(r: number, g: number, b: number): number {
  const x = r * 65536 + g * 256 + b;
  return x === 8388608 ? 0 : (x < 8388608 ? x : x - 16777216) * 0.01;
}

export class Dem {
  private cache = new Map<number, Float32Array | null>();

  constructor(readonly dir: string) {}

  tilePath(x: number, y: number): string {
    return join(this.dir, "14", String(x), `${y}.png`);
  }

  /** z14 タイル (x, y) の標高 256x256。なければ null。 */
  private tile(x: number, y: number): Float32Array | null {
    const key = x * 16384 + y;
    if (this.cache.has(key)) return this.cache.get(key)!;
    let t: Float32Array | null = null;
    const path = this.tilePath(x, y);
    if (x >= 0 && y >= 0 && existsSync(path) && statSync(path).size > 0) {
      const { w, h, rgb } = decodePng(readFileSync(path));
      if (w !== BLOCK_SIZE || h !== BLOCK_SIZE) throw new Error(`${path}: ${w}x${h}`);
      t = new Float32Array(w * h);
      for (let i = 0; i < t.length; i++) t[i] = rgbToElevation(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    }
    if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, t);
    return t;
  }

  /** ブロック (bx, by) の傾斜の段階 256x256。タイルが 1 枚もなければ null。 */
  slope(bx: number, by: number, ymax: number): Uint8Array | null {
    const n = BLOCK_SIZE, ew = n + 2;
    const elev = new Float32Array(ew * ew);
    let any = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = this.tile(bx + dx, by + dy);
        if (!t) continue;
        any = true;
        // 余白つき配列 (ew x ew) の座標 -1..n に対して、このタイルが覆う範囲
        const x0 = dx < 0 ? -1 : dx > 0 ? n : 0, x1 = dx < 0 ? 0 : dx > 0 ? n + 1 : n;
        const y0 = dy < 0 ? -1 : dy > 0 ? n : 0, y1 = dy < 0 ? 0 : dy > 0 ? n + 1 : n;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const sx = (x + n) % n, sy = (y + n) % n;
            elev[(y + 1) * ew + x + 1] = t[sy * n + sx];
          }
        }
      }
    }
    return any ? slopeLevels(elev, n, n, ymax) : null;
  }
}

/** 標高タイルをダウンロードする (既存はスキップ。404 は 0 バイトの印)。 */
export async function downloadTile(dir: string, x: number, y: number, base: string): Promise<"ok" | "skip" | "none"> {
  const path = join(dir, "14", String(x), `${y}.png`);
  if (existsSync(path)) return "skip";
  const res = await fetch(`${base}/14/${x}/${y}.png`);
  mkdirSync(dirname(path), { recursive: true });
  if (res.status === 404) {
    writeFileSync(path, new Uint8Array(0));
    return "none";
  }
  if (!res.ok) throw new Error(`${res.status} ${res.url}`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
  return "ok";
}
