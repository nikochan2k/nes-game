/**
 * OSM PBF の読み込み (依存パッケージなし)。ファイルを先頭から順に読み、
 * ノード・ウェイ・リレーションごとにコールバックを呼ぶ。コールバックのあるものだけをデコードする。
 *
 * PBF = [BlobHeader 長 (4 バイト BE)][BlobHeader][Blob] の繰り返し。Blob は zlib 圧縮された PrimitiveBlock。
 */
import { open } from "node:fs/promises";
import { inflateSync } from "node:zlib";

export interface Member { type: 0 | 1 | 2; id: number; role: string }   // 0=node 1=way 2=relation

export interface Handlers {
  node?(id: number, lat: number, lon: number): void;
  way?(id: number, tags: Record<string, string>, refs: number[]): void;
  relation?(id: number, tags: Record<string, string>, members: Member[]): void;
}

// ---- protobuf (手書き。pos は読み位置) ----
let buf: Uint8Array, pos = 0;

function varint(): number {
  let r = 0, mul = 1, b: number;
  do {
    b = buf[pos++];
    r += (b & 0x7f) * mul;
    mul *= 128;
  } while (b >= 0x80);
  return r;
}

const zigzag = (v: number) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

/** [start, end) のメッセージの各フィールドを読む。wire 0 は a=値、wire 2 は a=開始, b=終了。 */
function fields(start: number, end: number, cb: (field: number, wire: number, a: number, b: number) => void) {
  pos = start;
  while (pos < end) {
    const tag = varint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (wire === 0) {
      cb(field, wire, varint(), 0);
    } else if (wire === 2) {
      const len = varint(), s = pos;
      pos = s + len;
      const save = pos;
      cb(field, wire, s, s + len);
      pos = save;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`protobuf wire type ${wire}`);
    }
  }
}

function packed(start: number, end: number, signed: boolean, delta: boolean): number[] {
  const out: number[] = [];
  pos = start;
  let acc = 0;
  while (pos < end) {
    let v = varint();
    if (signed) v = zigzag(v);
    if (delta) { acc += v; v = acc; }
    out.push(v);
  }
  return out;
}

const dec = new TextDecoder();

function decodeBlock(data: Uint8Array, h: Handlers) {
  buf = data;
  const strings: string[] = [];
  const groups: [number, number][] = [];
  let gran = 100, latOff = 0, lonOff = 0;
  fields(0, data.length, (f, w, a, b) => {
    if (f === 1) {
      fields(a, b, (f2, _w2, s, e) => { if (f2 === 1) strings.push(dec.decode(data.subarray(s, e))); });
    } else if (f === 2) {
      groups.push([a, b]);
    } else if (f === 17) gran = a;
    else if (f === 19) latOff = a;
    else if (f === 20) lonOff = a;
  });
  const toDeg = (off: number, v: number) => 1e-9 * (off + gran * v);
  const tagsOf = (ks: number[], vs: number[]) => {
    const t: Record<string, string> = {};
    for (let i = 0; i < ks.length; i++) t[strings[ks[i]]] = strings[vs[i]];
    return t;
  };

  for (const [gs, ge] of groups) {
    fields(gs, ge, (f, _w, a, b) => {
      if (f === 1 && h.node) {                        // Node (密でない形式)
        let id = 0, lat = 0, lon = 0;
        fields(a, b, (f2, _w2, x) => {
          if (f2 === 1) id = zigzag(x); else if (f2 === 8) lat = zigzag(x); else if (f2 === 9) lon = zigzag(x);
        });
        h.node(id, toDeg(latOff, lat), toDeg(lonOff, lon));
      } else if (f === 2 && h.node) {                 // DenseNodes
        let ids: number[] = [], lats: number[] = [], lons: number[] = [];
        fields(a, b, (f2, _w2, s, e) => {
          if (f2 === 1) ids = packed(s, e, true, true);
          else if (f2 === 8) lats = packed(s, e, true, true);
          else if (f2 === 9) lons = packed(s, e, true, true);
        });
        for (let i = 0; i < ids.length; i++) h.node(ids[i], toDeg(latOff, lats[i]), toDeg(lonOff, lons[i]));
      } else if (f === 3 && h.way) {
        let id = 0, ks: number[] = [], vs: number[] = [], refs: number[] = [];
        fields(a, b, (f2, w2, s, e) => {
          if (f2 === 1) id = s;
          else if (f2 === 2) ks = packed(s, e, false, false);
          else if (f2 === 3) vs = packed(s, e, false, false);
          else if (f2 === 8 && w2 === 2) refs = packed(s, e, true, true);
        });
        h.way(id, tagsOf(ks, vs), refs);
      } else if (f === 4 && h.relation) {
        let id = 0, ks: number[] = [], vs: number[] = [], roles: number[] = [], mids: number[] = [], types: number[] = [];
        fields(a, b, (f2, _w2, s, e) => {
          if (f2 === 1) id = s;
          else if (f2 === 2) ks = packed(s, e, false, false);
          else if (f2 === 3) vs = packed(s, e, false, false);
          else if (f2 === 8) roles = packed(s, e, false, false);
          else if (f2 === 9) mids = packed(s, e, true, true);
          else if (f2 === 10) types = packed(s, e, false, false);
        });
        h.relation(id, tagsOf(ks, vs), mids.map((m, i) => ({ type: types[i] as 0 | 1 | 2, id: m, role: strings[roles[i]] })));
      }
    });
  }
}

/** ファイル全体を読む。 */
export async function scanPbf(path: string, h: Handlers): Promise<void> {
  const fh = await open(path, "r");
  try {
    let off = 0;
    const read = async (n: number) => {
      const b = new Uint8Array(n);
      const { bytesRead } = await fh.read(b, 0, n, off);
      if (bytesRead !== n) throw new Error("PBF が途中で切れている");
      off += n;
      return b;
    };
    const size = (await fh.stat()).size;
    while (off < size) {
      const hl = await read(4);
      const headLen = ((hl[0] << 24) | (hl[1] << 16) | (hl[2] << 8) | hl[3]) >>> 0;
      const head = await read(headLen);
      let type = "", dataSize = 0;
      buf = head;
      fields(0, head.length, (f, _w, a, b) => {
        if (f === 1) type = dec.decode(head.subarray(a, b));
        else if (f === 3) dataSize = a;
      });
      const blob = await read(dataSize);
      if (type !== "OSMData") continue;
      let raw: Uint8Array | null = null, z: Uint8Array | null = null;
      buf = blob;
      fields(0, blob.length, (f, _w, a, b) => {
        if (f === 1) raw = blob.subarray(a, b);
        else if (f === 3) z = blob.subarray(a, b);
      });
      const data = raw ?? (z ? new Uint8Array(inflateSync(z)) : null);
      if (!data) throw new Error("未対応の Blob 形式 (raw / zlib_data 以外)");
      decodeBlock(data, h);
    }
  } finally {
    await fh.close();
  }
}
