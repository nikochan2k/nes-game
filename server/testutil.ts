/** テスト用の PBF / shapefile / PNG の書き出し。実データなしでビルダーを確認するために使う。 */
import { deflateSync } from "node:zlib";
import { WORLD_CELLS } from "./osmfeatures";

const MERC = 20037508.342789244;

/** マス座標 → 度。osmfeatures.ts の lonToX / latToY の逆。 */
export function cellToLonLat(x: number, y: number): [number, number] {
  const lon = (x / WORLD_CELLS) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD_CELLS))) * 180) / Math.PI;
  return [lon, lat];
}

// ---- protobuf ----
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
};
const zz = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
const cat = (...a: number[][]) => a.flat();
const bytes = (f: number, b: number[] | Uint8Array) => cat(varint(f * 8 + 2), varint(b.length), [...b]);
const num = (f: number, n: number) => cat(varint(f * 8), varint(n));
const packed = (f: number, vs: number[]) => bytes(f, vs.flatMap(varint));
const delta = (vs: number[]) => vs.map((v, i) => zz(v - (i ? vs[i - 1] : 0)));

export interface TNode { id: number; lat: number; lon: number }
export interface TWay { id: number; tags: Record<string, string>; refs: number[] }
export interface TRel { id: number; tags: Record<string, string>; members: { type: 0 | 1 | 2; id: number; role: string }[] }

function strings() {
  const list = [""], idx = new Map<string, number>([["", 0]]);
  const id = (s: string) => {
    if (!idx.has(s)) { idx.set(s, list.length); list.push(s); }
    return idx.get(s)!;
  };
  return { list, id };
}

function blob(type: string, body: number[]): number[] {
  const z = [...deflateSync(Uint8Array.from(body))];
  const b = cat(num(2, body.length), bytes(3, z));
  const head = cat(bytes(1, [...new TextEncoder().encode(type)]), num(3, b.length));
  return cat([head.length >>> 24, (head.length >> 16) & 255, (head.length >> 8) & 255, head.length & 255], head, b);
}

function block(build: (s: ReturnType<typeof strings>) => number[]): number[] {
  const s = strings();
  const group = bytes(2, build(s));
  const table = bytes(1, s.list.flatMap((x) => bytes(1, [...new TextEncoder().encode(x)])));
  return blob("OSMData", cat(table, group));
}

export async function writePbf(path: string, d: { nodes?: TNode[]; ways?: TWay[]; rels?: TRel[] }) {
  const out: number[] = blob("OSMHeader", []);
  if (d.nodes?.length) {
    out.push(...block(() => bytes(2, cat(
      packed(1, delta(d.nodes!.map((n) => n.id).map((id) => id)).map((v) => v)),
      packed(8, delta(d.nodes!.map((n) => Math.round(n.lat * 1e7))).map((v) => v)),
      packed(9, delta(d.nodes!.map((n) => Math.round(n.lon * 1e7))).map((v) => v)),
    ))));
  }
  if (d.ways?.length) {
    out.push(...block((s) => d.ways!.flatMap((w) => bytes(3, cat(
      num(1, w.id),
      packed(2, Object.keys(w.tags).map(s.id)),
      packed(3, Object.values(w.tags).map(s.id)),
      packed(8, delta(w.refs)),
    )))));
  }
  if (d.rels?.length) {
    out.push(...block((s) => d.rels!.flatMap((r) => bytes(4, cat(
      num(1, r.id),
      packed(2, Object.keys(r.tags).map(s.id)),
      packed(3, Object.values(r.tags).map(s.id)),
      packed(8, r.members.map((m) => s.id(m.role))),
      packed(9, delta(r.members.map((m) => m.id))),
      packed(10, r.members.map((m) => m.type)),
    )))));
  }
  await Bun.write(path, Uint8Array.from(out));
}

// ---- shapefile (多角形のみ。座標は 3857 の m) ----
export function cellToMeters(x: number, y: number): [number, number] {
  return [(x / WORLD_CELLS) * 2 * MERC - MERC, MERC - (y / WORLD_CELLS) * 2 * MERC];
}

/** polys: 多角形ごとのリング (マス座標) の配列。 */
export async function writeShp(path: string, polys: [number, number][][][]) {
  const recs: Uint8Array[] = polys.map((rings, n) => {
    const pts = rings.flat().map(([x, y]) => cellToMeters(x, y));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const len = 44 + 4 * rings.length + 16 * pts.length;
    const b = new DataView(new ArrayBuffer(8 + len));
    b.setInt32(0, n + 1, false);
    b.setInt32(4, len / 2, false);
    b.setInt32(8, 5, true);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => b.setFloat64(12 + 8 * i, v, true));
    b.setInt32(44, rings.length, true);
    b.setInt32(48, pts.length, true);
    let start = 0;
    rings.forEach((r, i) => { b.setInt32(52 + 4 * i, start, true); start += r.length; });
    pts.forEach(([x, y], i) => {
      b.setFloat64(52 + 4 * rings.length + 16 * i, x, true);
      b.setFloat64(60 + 4 * rings.length + 16 * i, y, true);
    });
    return new Uint8Array(b.buffer);
  });
  const head = new Uint8Array(100);
  new DataView(head.buffer).setInt32(0, 9994, false);
  await Bun.write(path, Buffer.concat([head, ...recs]));
}

// ---- PNG (RGB 8bit。フィルタは行ごとに 0〜4 を回して使う) ----
export function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const stride = w * 3, raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? rgb[y * stride + i - 3] : 0, b = y ? rgb[(y - 1) * stride + i] : 0;
      const c = i >= 3 && y ? rgb[(y - 1) * stride + i - 3] : 0;
      let pred = 0;
      if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (rgb[y * stride + i] - pred) & 255;
    }
  }
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);                                   // CRC は読み手が見ないので 0 のまま
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

/** 標高 (m) を GSI の RGB 表現にする。 */
export function elevationToRgb(m: number): [number, number, number] {
  let x = Math.round(m * 100);
  if (x < 0) x += 16777216;
  return [x >> 16, (x >> 8) & 255, x & 255];
}
