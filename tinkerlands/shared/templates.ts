// Procedural starting points for new worlds. Generation is deterministic for a
// given seed. Courses also return the route used by the test autopilot, which
// plays them under the real physics to prove each one can be finished.

import { B } from './blocks.ts';
import { WORLD_D, WORLD_H, WORLD_W } from './constants.ts';
import { VoxelWorld } from './world.ts';

export const TEMPLATES = ['plot', 'island', 'obby', 'tower'] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export const TEMPLATE_INFO: Record<TemplateId, { name: string; blurb: string }> = {
  plot: { name: 'Empty plot', blurb: 'A flat green field. Build whatever you like.' },
  island: { name: 'Floating island', blurb: 'Hills, trees and hidden coins above the clouds.' },
  obby: { name: 'Obstacle course', blurb: 'A long run over a lava sea with checkpoints and a timer.' },
  tower: { name: 'Spiral tower', blurb: 'Climb a winding route up to the goal in the sky.' },
};

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  /** Jump from the previous waypoint to reach this one. */
  leap?: boolean;
  /** A bounce pad: passing over it counts, since nobody can stand on one. */
  pass?: boolean;
}

export interface GeneratedWorld {
  world: VoxelWorld;
  /** Standing positions from spawn to goal. Empty for open worlds. */
  route: Waypoint[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateWorld(template: TemplateId, seed: number): GeneratedWorld {
  switch (template) {
    case 'plot':
      return generatePlot(seed);
    case 'island':
      return generateIsland(seed);
    case 'obby':
      return generateCourse(seed, 'serpentine');
    case 'tower':
      return generateCourse(seed, 'spiral');
  }
}

function plantTree(world: VoxelWorld, x: number, y: number, z: number, height: number): void {
  for (let i = 1; i <= height; i++) world.set(x, y + i, z, B.LOG);
  const top = y + height;
  for (let dy = -1; dy <= 2; dy++) {
    const r = dy >= 1 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && dy !== 0) continue;
        if (world.get(x + dx, top + dy, z + dz) === B.AIR) {
          world.set(x + dx, top + dy, z + dz, B.LEAVES);
        }
      }
    }
  }
}

function generatePlot(seed: number): GeneratedWorld {
  const world = new VoxelWorld(WORLD_W, WORLD_H, WORLD_D);
  const random = mulberry32(seed);
  const ground = 8;
  world.fill(0, 0, 0, WORLD_W - 1, 2, WORLD_D - 1, B.STONE);
  world.fill(0, 3, 0, WORLD_W - 1, ground - 1, WORLD_D - 1, B.DIRT);
  world.fill(0, ground, 0, WORLD_W - 1, ground, WORLD_D - 1, B.GRASS);
  const cx = WORLD_W >> 1;
  const cz = WORLD_D >> 1;
  world.fill(cx - 1, ground, cz - 1, cx + 1, ground, cz + 1, B.SPAWN);
  for (let i = 0; i < 12; i++) {
    const x = 4 + Math.floor(random() * (WORLD_W - 8));
    const z = 4 + Math.floor(random() * (WORLD_D - 8));
    // Keep the middle of the field open to build on.
    if (Math.abs(x - cx) < 30 && Math.abs(z - cz) < 30) continue;
    plantTree(world, x, ground, z, 3 + Math.floor(random() * 3));
  }
  return { world, route: [] };
}

function generateIsland(seed: number): GeneratedWorld {
  const world = new VoxelWorld(WORLD_W, WORLD_H, WORLD_D);
  const random = mulberry32(seed);

  const gridSize = 12;
  const grid = new Float64Array(gridSize * gridSize);
  for (let i = 0; i < grid.length; i++) grid[i] = random();
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const noise = (x: number, z: number): number => {
    const fx = (x / WORLD_W) * (gridSize - 1);
    const fz = (z / WORLD_D) * (gridSize - 1);
    const ix = Math.min(Math.floor(fx), gridSize - 2);
    const iz = Math.min(Math.floor(fz), gridSize - 2);
    const tx = smooth(fx - ix);
    const tz = smooth(fz - iz);
    const a = grid[ix + iz * gridSize];
    const b = grid[ix + 1 + iz * gridSize];
    const c = grid[ix + (iz + 1) * gridSize];
    const d = grid[ix + 1 + (iz + 1) * gridSize];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  };

  const cx = WORLD_W / 2;
  const cz = WORLD_D / 2;
  const base = 12;
  const tops = new Int32Array(WORLD_W * WORLD_D).fill(-1);
  for (let z = 0; z < WORLD_D; z++) {
    for (let x = 0; x < WORLD_W; x++) {
      const dist = Math.hypot(x - cx, z - cz) / (WORLD_W * 0.48);
      const falloff = 1 - dist * dist;
      if (falloff <= 0) continue;
      tops[x + z * WORLD_W] = base + Math.floor(noise(x, z) * 14 * falloff);
    }
  }

  const spawnX = Math.floor(cx);
  const spawnZ = Math.floor(cz);
  const inPad = (x: number, z: number): boolean => Math.abs(x - spawnX) <= 2 && Math.abs(z - spawnZ) <= 2;

  // Players can only jump up one block, so no neighbouring columns may differ by
  // more than that. Two sweeps lower anything too steep, in every direction.
  const relax = (fixPad: boolean): void => {
    const lower = (x: number, z: number, nx: number, nz: number): void => {
      if (fixPad && inPad(x, z)) return;
      const i = x + z * WORLD_W;
      const n = tops[nx + nz * WORLD_W];
      if (tops[i] >= 0 && n >= 0 && tops[i] > n + 1) tops[i] = n + 1;
    };
    for (let z = 1; z < WORLD_D; z++) for (let x = 1; x < WORLD_W; x++) {
      lower(x, z, x - 1, z);
      lower(x, z, x, z - 1);
    }
    for (let z = WORLD_D - 2; z >= 0; z--) for (let x = WORLD_W - 2; x >= 0; x--) {
      lower(x, z, x + 1, z);
      lower(x, z, x, z + 1);
    }
  };
  relax(false);
  // Level the spawn pad at its lowest point, then re-slope the land around it.
  let spawnTop = Infinity;
  for (let z = spawnZ - 2; z <= spawnZ + 2; z++) for (let x = spawnX - 2; x <= spawnX + 2; x++) {
    spawnTop = Math.min(spawnTop, tops[x + z * WORLD_W]);
  }
  for (let z = spawnZ - 2; z <= spawnZ + 2; z++) for (let x = spawnX - 2; x <= spawnX + 2; x++) {
    tops[x + z * WORLD_W] = spawnTop;
  }
  relax(true);

  for (let z = 0; z < WORLD_D; z++) {
    for (let x = 0; x < WORLD_W; x++) {
      const top = tops[x + z * WORLD_W];
      if (top < 0) continue;
      const dist = Math.hypot(x - cx, z - cz) / (WORLD_W * 0.48);
      const bottom = base - Math.floor((1 - dist * dist) * 10 + noise(z, x) * 3);
      for (let y = Math.max(bottom, 0); y <= top; y++) {
        world.set(x, y, z, y === top ? (dist > 0.82 ? B.SAND : B.GRASS) : y > top - 3 ? B.DIRT : B.STONE);
      }
    }
  }

  world.fill(spawnX - 2, spawnTop, spawnZ - 2, spawnX + 2, spawnTop, spawnZ + 2, B.PLANKS);
  world.fill(spawnX - 1, spawnTop, spawnZ - 1, spawnX + 1, spawnTop, spawnZ + 1, B.SPAWN);

  // Small stepped ruins with a coin on top give people something to climb.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + random();
    const r = 18 + random() * 16;
    const x = Math.floor(cx + Math.cos(a) * r);
    const z = Math.floor(cz + Math.sin(a) * r);
    const top = tops[x + z * WORLD_W];
    if (top < 0) continue;
    const height = 2 + Math.floor(random() * 3);
    for (let h = 1; h <= height; h++) {
      const radius = height - h;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          // Fill down to the ground, so that no step hangs out over a slope.
          const ground = tops[x + dx + (z + dz) * WORLD_W];
          for (let y = Math.max(ground + 1, 0); y <= top + h; y++) {
            world.set(x + dx, y, z + dz, h % 2 ? B.BRICK : B.STONE);
          }
        }
      }
    }
    world.set(x, top + height + 2, z, B.COIN);
  }

  /** A grass column away from the spawn with nothing built on it. */
  const pickOpenGround = (): { x: number; z: number; top: number } | null => {
    const x = 3 + Math.floor(random() * (WORLD_W - 6));
    const z = 3 + Math.floor(random() * (WORLD_D - 6));
    const top = tops[x + z * WORLD_W];
    if (top < 0 || Math.hypot(x - cx, z - cz) < 7) return null;
    if (world.get(x, top, z) !== B.GRASS || world.get(x, top + 1, z) !== B.AIR) return null;
    return { x, z, top };
  };

  for (let i = 0; i < 30; i++) {
    const spot = pickOpenGround();
    if (spot) plantTree(world, spot.x, spot.top, spot.z, 3 + Math.floor(random() * 3));
  }

  // Coins go last, and never where a tree could wall them in.
  for (let i = 0; i < 60; i++) {
    const spot = pickOpenGround();
    if (!spot) continue;
    let clear = true;
    for (let y = spot.top + 1; y <= spot.top + 3 && clear; y++) {
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const block = world.get(spot.x + dx, y, spot.z + dz);
        if (block === B.LOG || block === B.LEAVES || block === B.COIN) clear = false;
      }
    }
    if (clear) world.set(spot.x, spot.top + 2, spot.z, B.COIN);
  }

  return { world, route: [] };
}

type Layout = 'serpentine' | 'spiral';

/** Walks a cursor through the world, stamping obstacle segments as it goes. */
class CourseBuilder {
  readonly world = new VoxelWorld(WORLD_W, WORLD_H, WORLD_D);
  readonly route: Waypoint[] = [];
  x: number;
  y: number;
  z: number;
  dx = 1;
  dz = 0;
  private readonly palette: number[];
  private colorIndex = 0;

  constructor(x: number, y: number, z: number, palette: number[]) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.palette = palette;
  }

  nextColor(): number {
    return this.palette[this.colorIndex++ % this.palette.length];
  }

  /** Stamps `length` blocks ahead of the cursor, `half` to each side. */
  slab(length: number, half: number, block: number | ((i: number) => number)): void {
    const px = this.dz !== 0 ? 1 : 0;
    const pz = this.dx !== 0 ? 1 : 0;
    for (let i = 0; i < length; i++) {
      const b = typeof block === 'function' ? block(i) : block;
      for (let s = -half; s <= half; s++) {
        this.world.set(this.x + this.dx * i + px * s, this.y, this.z + this.dz * i + pz * s, b);
      }
    }
    this.x += this.dx * length;
    this.z += this.dz * length;
  }

  /** Records the centre of the most recently stamped block. */
  mark(leap = false): void {
    this.markAt(this.x - this.dx, this.z - this.dz, leap);
  }

  markAt(x: number, z: number, leap = false): void {
    this.route.push({ x: x + 0.5, y: this.y + 1, z: z + 0.5, leap });
  }

  skip(n: number): void {
    this.x += this.dx * n;
    this.z += this.dz * n;
  }

  /** Blocks of runway available ahead of the cursor. */
  roomAhead(margin: number): number {
    if (this.dx > 0) return WORLD_W - margin - this.x;
    if (this.dx < 0) return this.x - margin;
    if (this.dz > 0) return WORLD_D - margin - this.z;
    return this.z - margin;
  }

  // --- Segments. Each starts by leaping onto its first piece. ---

  hops(random: () => number): void {
    const count = 3;
    for (let i = 0; i < count; i++) {
      const gap = 2 + Math.floor(random() * 2);
      this.skip(gap);
      const color = this.nextColor();
      this.slab(1, 1, color);
      this.mark(true);
      this.slab(2, 1, color);
      this.mark();
      if (i === 1) this.world.set(this.x - this.dx, this.y + 3, this.z - this.dz, B.COIN);
    }
  }

  beam(): void {
    this.skip(2);
    const color = this.nextColor();
    this.slab(1, 0, color);
    this.mark(true);
    this.slab(7, 0, color);
    this.mark();
    this.world.set(this.x - this.dx * 4, this.y + 2, this.z - this.dz * 4, B.COIN);
  }

  lavaStrip(): void {
    const pad = (): void => {
      this.slab(1, 1, B.METAL);
      this.mark(true);
      this.slab(2, 1, B.METAL);
      this.mark();
    };
    this.skip(2);
    pad();
    for (let i = 0; i < 3; i++) {
      this.slab(2, 1, B.LAVA);
      pad();
    }
  }

  stairs(): void {
    this.skip(2);
    const color = this.nextColor();
    this.slab(1, 1, color);
    this.mark(true);
    this.slab(1, 1, color);
    this.mark();
    for (let i = 0; i < 4; i++) {
      this.y += 1;
      this.slab(1, 1, color);
      this.mark(true);
      this.slab(1, 1, color);
      this.mark();
    }
  }

  bounce(): void {
    this.skip(2);
    this.slab(3, 1, B.BOUNCE);
    this.mark(true);
    this.route[this.route.length - 1].pass = true;
    // The gap lets players rise past the platform's underside before reaching
    // it, even if they keep running off the pad.
    this.skip(3);
    this.y += 4;
    this.slab(3, 1, this.nextColor());
    this.mark();
    this.world.set(this.x - this.dx * 2, this.y + 3, this.z - this.dz * 2, B.COIN);
  }

  ice(): void {
    this.skip(2);
    this.slab(1, 1, B.ICE);
    this.mark(true);
    this.slab(7, 1, B.ICE);
    this.mark();
  }

  checkpoint(): void {
    this.skip(2);
    this.slab(1, 2, B.WHITE);
    this.mark(true);
    this.slab(3, 2, (i) => (i === 1 ? B.CHECKPOINT : B.WHITE));
    this.mark();
  }

  /** A 5-wide platform used to change direction; the cursor ends at its centre line. */
  corner(newDx: number, newDz: number): void {
    this.skip(2);
    const color = B.STONE;
    const cx = this.x + this.dx * 2;
    const cz = this.z + this.dz * 2;
    this.world.fill(cx - 2, this.y, cz - 2, cx + 2, this.y, cz + 2, color);
    this.markAt(this.x, this.z, true);
    this.markAt(cx, cz);
    this.dx = newDx;
    this.dz = newDz;
    this.x = cx + newDx * 3;
    this.z = cz + newDz * 3;
    this.markAt(this.x - newDx, this.z - newDz);
  }
}

function generateCourse(seed: number, layout: Layout): GeneratedWorld {
  const random = mulberry32(seed);
  const palettes = [
    [B.BLUE, B.PURPLE, B.PINK, B.YELLOW],
    [B.GREEN, B.YELLOW, B.ORANGE, B.RED],
    [B.PINK, B.ORANGE, B.BLUE, B.WHITE],
  ];
  const palette = palettes[Math.floor(random() * palettes.length)];

  const startY = layout === 'spiral' ? 6 : 12;
  const c = new CourseBuilder(10, startY, 10, palette);
  const world = c.world;

  // Lava sea: falling means going back to the last checkpoint.
  world.fill(0, 0, 0, WORLD_W - 1, 0, WORLD_D - 1, B.STONE);
  world.fill(0, 1, 0, WORLD_W - 1, 1, WORLD_D - 1, B.LAVA);

  // Start platform.
  world.fill(c.x - 3, c.y, c.z - 3, c.x + 3, c.y, c.z + 3, B.WHITE);
  world.fill(c.x - 1, c.y, c.z - 1, c.x + 1, c.y, c.z + 1, B.SPAWN);
  c.markAt(c.x, c.z);
  c.x += 4;
  c.markAt(c.x - 1, c.z);

  type Segment = { room: number; rise: number; build: () => void };
  const segments: Segment[] = [
    { room: 15, rise: 0, build: () => c.hops(random) },
    { room: 11, rise: 0, build: () => c.beam() },
    { room: 20, rise: 0, build: () => c.lavaStrip() },
    { room: 13, rise: 4, build: () => c.stairs() },
    { room: 11, rise: 4, build: () => c.bounce() },
    { room: 11, rise: 0, build: () => c.ice() },
  ];

  const inset = layout === 'spiral' ? 5 : 10;
  const margin = 6;
  // Spiral rows close in on the middle; serpentine rows step across the map.
  let spiralInset = inset;
  let turns = 0;
  const maxY = WORLD_H - 12;
  let sinceCheckpoint = 0;
  let lastSegment = -1;
  const maxTurns = layout === 'spiral' ? 14 : 5;

  const turn = (): boolean => {
    if (turns >= maxTurns) return false;
    turns++;
    if (layout === 'serpentine') {
      // Across, one row over, and back.
      const reverse = c.dx;
      c.corner(0, 1);
      const rowGap = 13;
      c.skip(2);
      c.slab(1, 1, c.nextColor());
      c.mark(true);
      c.slab(rowGap - 3, 1, c.nextColor());
      c.mark();
      if (c.z + 12 >= WORLD_D - 4) return false;
      c.corner(-reverse, 0);
      return true;
    }
    // Spiral: turn right, climbing as the loop tightens.
    const nextDx = -c.dz;
    const nextDz = c.dx;
    c.corner(nextDx, nextDz);
    if (turns % 4 === 0) spiralInset += 9;
    return spiralInset < WORLD_W / 2 - 12;
  };

  const roomLimit = (): number => {
    if (layout === 'serpentine') return c.roomAhead(margin);
    return c.roomAhead(spiralInset);
  };

  // Every segment must leave room for the corner that follows it.
  const reserve = 8;
  let running = true;
  let guard = 0;
  while (running && guard++ < 200) {
    const room = roomLimit() - reserve;
    const options = segments
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s.room <= room && i !== lastSegment && c.y + s.rise < maxY);
    if (options.length === 0) {
      running = turn();
      continue;
    }
    const choice = options[Math.floor(random() * options.length)];
    lastSegment = choice.i;
    choice.s.build();
    sinceCheckpoint++;
    if (sinceCheckpoint >= 2 && roomLimit() - reserve >= 6) {
      c.checkpoint();
      sinceCheckpoint = 0;
    }
  }

  // Finish platform.
  c.skip(2);
  const gx = c.x + c.dx * 3;
  const gz = c.z + c.dz * 3;
  world.fill(gx - 3, c.y, gz - 3, gx + 3, c.y, gz + 3, B.WHITE);
  world.fill(gx - 1, c.y, gz - 1, gx + 1, c.y, gz + 1, B.GOAL);
  c.markAt(c.x, c.z, true);
  c.markAt(gx, gz);

  return { world, route: c.route };
}
