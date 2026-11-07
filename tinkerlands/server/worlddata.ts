import { deflateSync, inflateSync } from 'node:zlib';
import { B, BLOCKS } from '../shared/blocks.ts';
import { decodeRLE, encodeRLE, VoxelWorld } from '../shared/world.ts';

export function packWorld(world: VoxelWorld): Uint8Array {
  return deflateSync(encodeRLE(world.data), { level: 6 });
}

export function unpackWorld(packed: Uint8Array, w: number, h: number, d: number): VoxelWorld {
  const size = w * h * d;
  // The output cap guards against a corrupt blob inflating without limit.
  const raw = inflateSync(packed, { maxOutputLength: size * 6 + 1024 });
  return new VoxelWorld(w, h, d, decodeRLE(raw, size));
}

// --- Thumbnails: an isometric pixel-art view of the actual world, as a PNG. ---

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

export function renderThumbnail(world: VoxelWorld): Uint8Array {
  const tile = 2;
  const width = (world.w + world.d) * tile + 4;
  const height = world.w + world.d + world.h * 2 + 6;
  const rgb = new Uint8Array(width * height * 3);

  for (let y = 0; y < height; y++) {
    const t = y / height;
    const r = 118 + t * 90;
    const g = 192 + t * 45;
    const b = 244 + t * 8;
    for (let x = 0; x < width; x++) {
      const i = (x + y * width) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }

  const plot = (px: number, py: number, w: number, h: number, color: number, shade: number): void => {
    const r = ((color >> 16) & 255) * shade;
    const g = ((color >> 8) & 255) * shade;
    const b = (color & 255) * shade;
    for (let y = py; y < py + h; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = px; x < px + w; x++) {
        if (x < 0 || x >= width) continue;
        const i = (x + y * width) * 3;
        rgb[i] = r;
        rgb[i + 1] = g;
        rgb[i + 2] = b;
      }
    }
  };

  // Back to front: anything that can occlude a voxel has coordinates >= its own.
  for (let x = 0; x < world.w; x++) {
    for (let z = 0; z < world.d; z++) {
      for (let y = 0; y < world.h; y++) {
        const id = world.get(x, y, z);
        if (id === B.AIR) continue;
        const showTop = world.get(x, y + 1, z) === B.AIR || y === world.h - 1;
        const showLeft = world.get(x, y, z + 1) === B.AIR;
        const showRight = world.get(x + 1, y, z) === B.AIR;
        if (!showTop && !showLeft && !showRight) continue;
        const def = BLOCKS[id];
        const sx = (x - z + world.d) * tile;
        const sy = (x + z) + (world.h - y) * 2 + 2;
        if (showTop) plot(sx, sy, tile * 2, 2, def.color, 1);
        const side = def.sideColor ?? def.color;
        if (showLeft) plot(sx, sy + 2, tile, 2, side, 0.72);
        if (showRight) plot(sx + tile, sy + 2, tile, 2, side, 0.55);
      }
    }
  }

  return encodePng(width, height, rgb);
}
