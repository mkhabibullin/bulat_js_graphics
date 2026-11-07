import { B, isSolidBlock } from './blocks.ts';

export class VoxelWorld {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly data: Uint8Array;

  constructor(w: number, h: number, d: number, data?: Uint8Array) {
    this.w = w;
    this.h = h;
    this.d = d;
    const size = w * h * d;
    if (data && data.length !== size) {
      throw new Error(`world data has ${data.length} bytes, expected ${size}`);
    }
    this.data = data ?? new Uint8Array(size);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.w && y < this.h && z < this.d;
  }

  index(x: number, y: number, z: number): number {
    return x + z * this.w + y * this.w * this.d;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return B.AIR;
    return this.data[this.index(x, y, z)];
  }

  set(x: number, y: number, z: number, block: number): void {
    if (!this.inBounds(x, y, z)) return;
    this.data[this.index(x, y, z)] = block;
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, block: number): void {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) this.set(x, y, z, block);
      }
    }
  }

  isSolid(x: number, y: number, z: number): boolean {
    return isSolidBlock(this.get(x, y, z));
  }

  /** Height of the highest solid block in a column, or -1 if the column is empty. */
  topSolid(x: number, z: number): number {
    for (let y = this.h - 1; y >= 0; y--) {
      if (this.isSolid(x, y, z)) return y;
    }
    return -1;
  }
}

/** Run-length encodes as (varint run length, block byte) pairs. */
export function encodeRLE(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const value = data[i];
    let run = 1;
    while (i + run < data.length && data[i + run] === value) run++;
    i += run;
    let n = run;
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
    out.push(value);
  }
  return Uint8Array.from(out);
}

/** Throws on any malformed input rather than returning a partial world. */
export function decodeRLE(buf: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let i = 0;
  let pos = 0;
  while (i < buf.length) {
    let run = 0;
    let scale = 1;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated world data');
      const byte = buf[i++];
      run += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 128;
      if (scale > 2 ** 35) throw new Error('invalid run length');
    }
    if (i >= buf.length) throw new Error('truncated world data');
    if (run === 0 || pos + run > expectedLength) throw new Error('world data overflows its bounds');
    out.fill(buf[i++], pos, pos + run);
    pos += run;
  }
  if (pos !== expectedLength) throw new Error('world data is too short');
  return out;
}
