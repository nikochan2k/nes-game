/** RGB (8bit) の PNG を書き出す (CRC つき。ブラウザで開ける)。確認用の画像 (make preview) に使う。 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);   // フィルタ 0
  const chunk = (type: string, body: Uint8Array) => {
    const o = new Uint8Array(12 + body.length), dv = new DataView(o.buffer);
    dv.setUint32(0, body.length);
    o.set(new TextEncoder().encode(type), 4);
    o.set(body, 8);
    dv.setUint32(8 + body.length, crc32(o.subarray(4, 8 + body.length)));
    return o;
  };
  const ihdr = new Uint8Array(13), d = new DataView(ihdr.buffer);
  d.setUint32(0, w); d.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}
