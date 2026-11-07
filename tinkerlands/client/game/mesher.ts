import * as THREE from 'three';
import { BLOCKS } from '../../shared/blocks.ts';
import { CHUNK_SIZE } from '../../shared/constants.ts';
import type { VoxelWorld } from '../../shared/world.ts';
import type { AtlasInfo } from './atlas.ts';

interface Face {
  normal: [number, number, number];
  /** Corner offsets in counter-clockwise order, viewed from outside. */
  corners: [number, number, number][];
  /** The UV coordinates for each corner. */
  uv: [number, number][];
  kind: 'top' | 'side' | 'bottom';
  /** Fixed shading gives each direction its own tone, even in shadow. */
  shade: number;
}

const FACES: Face[] = [
  { normal: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], kind: 'top', shade: 1 },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], kind: 'bottom', shade: 0.62 },
  { normal: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], kind: 'side', shade: 0.86 },
  { normal: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], kind: 'side', shade: 0.8 },
  { normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], kind: 'side', shade: 0.92 },
  { normal: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]], kind: 'side', shade: 0.74 },
];

const AO_LEVELS = [0.5, 0.68, 0.84, 1];

class Buffers {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  get vertexCount(): number {
    return this.positions.length / 3;
  }
  toGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function occludes(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const def = BLOCKS[world.get(x, y, z)];
  return def.solid && def.bucket !== 'transparent';
}

function vertexAO(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - (Number(side1) + Number(side2) + Number(corner));
}

export type ChunkBuckets = Partial<Record<'opaque' | 'transparent' | 'glow', THREE.BufferGeometry>>;

export function meshChunk(world: VoxelWorld, cx: number, cy: number, cz: number, atlas: AtlasInfo): ChunkBuckets {
  const opaque = new Buffers();
  const transparent = new Buffers();
  const glow = new Buffers();

  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;

  for (let y = y0; y < Math.min(y0 + CHUNK_SIZE, world.h); y++) {
    for (let z = z0; z < Math.min(z0 + CHUNK_SIZE, world.d); z++) {
      for (let x = x0; x < Math.min(x0 + CHUNK_SIZE, world.w); x++) {
        const id = world.get(x, y, z);
        const def = BLOCKS[id];
        if (def.bucket === 'none') continue;
        const out = def.bucket === 'transparent' ? transparent : def.bucket === 'glow' ? glow : opaque;

        for (const face of FACES) {
          const [nx, ny, nz] = face.normal;
          const neighbor = world.get(x + nx, y + ny, z + nz);
          const nDef = BLOCKS[neighbor];
          // Show the face unless it's fully covered. Glass hides only glass.
          if (nDef.solid && (nDef.bucket !== 'transparent' || neighbor === id)) continue;

          const rect = atlas.uv[id][face.kind];
          const base = out.vertexCount;
          const ao: number[] = [];
          for (let i = 0; i < 4; i++) {
            const [ox, oy, oz] = face.corners[i];
            const [u, v] = face.uv[i];
            out.positions.push(x + ox, y + oy, z + oz);
            out.normals.push(nx, ny, nz);
            out.uvs.push(rect[0] + (rect[2] - rect[0]) * u, rect[1] + (rect[3] - rect[1]) * v);

            // Sample the three blocks around this corner on the outer side of the face.
            const sx = ox === 0 ? -1 : 1;
            const sy = oy === 0 ? -1 : 1;
            const sz = oz === 0 ? -1 : 1;
            let a: boolean;
            let b: boolean;
            let c: boolean;
            if (ny !== 0) {
              a = occludes(world, x + sx, y + ny, z);
              b = occludes(world, x, y + ny, z + sz);
              c = occludes(world, x + sx, y + ny, z + sz);
            } else if (nx !== 0) {
              a = occludes(world, x + nx, y + sy, z);
              b = occludes(world, x + nx, y, z + sz);
              c = occludes(world, x + nx, y + sy, z + sz);
            } else {
              a = occludes(world, x + sx, y, z + nz);
              b = occludes(world, x, y + sy, z + nz);
              c = occludes(world, x + sx, y + sy, z + nz);
            }
            const level = vertexAO(a, b, c);
            ao.push(level);
            const light = def.bucket === 'glow' ? 1 : AO_LEVELS[level] * face.shade;
            out.colors.push(light, light, light);
          }
          // Flip the diagonal where needed so AO interpolates evenly across the quad.
          if (ao[0] + ao[2] >= ao[1] + ao[3]) {
            out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          } else {
            out.indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
          }
        }
      }
    }
  }

  const buckets: ChunkBuckets = {};
  if (opaque.indices.length > 0) buckets.opaque = opaque.toGeometry();
  if (transparent.indices.length > 0) buckets.transparent = transparent.toGeometry();
  if (glow.indices.length > 0) buckets.glow = glow.toGeometry();
  return buckets;
}
