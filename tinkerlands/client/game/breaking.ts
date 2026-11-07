import * as THREE from 'three';
import { B, BLOCKS } from '../../shared/blocks.ts';
import { TNT_RADIUS } from '../../shared/constants.ts';
import type { VoxelWorld } from '../../shared/world.ts';

export const CRACK_STAGES = 10;
const CRACK_SIZE = 32;
const MAX_PARTICLES = 400;
const PARTICLE_GRAVITY = 16;

/** Crack art for each stage. Each stage adds to the last, so cracks grow outward. */
function buildCrackTextures(): THREE.CanvasTexture[] {
  let seed = 9;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Random walks from near the centre, stored in the order they should appear.
  const pixels: [number, number][] = [];
  const branches = 9;
  for (let b = 0; b < branches; b++) {
    let x = CRACK_SIZE / 2 + (random() - 0.5) * 8;
    let y = CRACK_SIZE / 2 + (random() - 0.5) * 8;
    let angle = (b / branches) * Math.PI * 2 + random() * 0.5;
    const length = 15 + Math.floor(random() * 14);
    for (let i = 0; i < length; i++) {
      pixels.push([Math.floor(x), Math.floor(y)]);
      angle += (random() - 0.5) * 0.9;
      x += Math.cos(angle);
      y += Math.sin(angle);
    }
  }
  // Interleaving by distance from the centre makes all branches grow together.
  const centre = CRACK_SIZE / 2;
  pixels.sort((a, b) => Math.hypot(a[0] - centre, a[1] - centre) - Math.hypot(b[0] - centre, b[1] - centre));

  const textures: THREE.CanvasTexture[] = [];
  for (let stage = 0; stage < CRACK_STAGES; stage++) {
    const canvas = document.createElement('canvas');
    canvas.width = CRACK_SIZE;
    canvas.height = CRACK_SIZE;
    const g = canvas.getContext('2d')!;
    const count = Math.ceil((pixels.length * (stage + 1)) / CRACK_STAGES);
    g.fillStyle = 'rgba(0,0,0,0.82)';
    for (let i = 0; i < count; i++) g.fillRect(pixels[i][0], pixels[i][1], 1, 1);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    textures.push(texture);
  }
  return textures;
}

/** Draws cracks over blocks being mined. One slot per miner. */
export class CrackOverlay {
  private readonly scene: THREE.Scene;
  private readonly geometry = new THREE.BoxGeometry(1.004, 1.004, 1.004);
  private readonly textures = buildCrackTextures();
  private readonly materials = this.textures.map(
    (map) =>
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
  );
  private readonly meshes = new Map<number, THREE.Mesh>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  set(slot: number, x: number, y: number, z: number, progress: number): void {
    const stage = Math.max(0, Math.min(CRACK_STAGES - 1, Math.floor(progress * CRACK_STAGES)));
    let mesh = this.meshes.get(slot);
    if (!mesh) {
      mesh = new THREE.Mesh(this.geometry, this.materials[stage]);
      mesh.renderOrder = 2;
      this.meshes.set(slot, mesh);
      this.scene.add(mesh);
    }
    mesh.material = this.materials[stage];
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
  }

  clear(slot: number): void {
    const mesh = this.meshes.get(slot);
    if (!mesh) return;
    mesh.removeFromParent();
    this.meshes.delete(slot);
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.meshes.clear();
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

/** Flashing lit TNT, and the fireballs when it goes off. */
export class TntEffects {
  private readonly scene: THREE.Scene;
  private readonly world: VoxelWorld;
  private readonly fuseGeometry = new THREE.BoxGeometry(1.03, 1.03, 1.03);
  private readonly blastGeometry = new THREE.SphereGeometry(1, 18, 12);
  private readonly fuses = new Map<number, { mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>; explodeAt: number; x: number; y: number; z: number }>();
  private readonly blasts: { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; started: number }[] = [];
  private now = 0;

  constructor(scene: THREE.Scene, world: VoxelWorld) {
    this.scene = scene;
    this.world = world;
  }

  light(x: number, y: number, z: number, ms: number): void {
    const key = this.world.index(x, y, z);
    if (this.fuses.has(key)) return;
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(this.fuseGeometry, material);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.fuses.set(key, { mesh, explodeAt: this.now + ms / 1000, x, y, z });
  }

  explode(x: number, y: number, z: number): void {
    const material = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
    const mesh = new THREE.Mesh(this.blastGeometry, material);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    mesh.renderOrder = 3;
    this.scene.add(mesh);
    this.blasts.push({ mesh, started: this.now });
  }

  update(time: number): void {
    this.now = time;
    for (const [key, f] of this.fuses) {
      // Blown up or defused. The small grace period covers a late network message.
      if (this.world.get(f.x, f.y, f.z) !== B.TNT || time > f.explodeAt + 2) {
        f.mesh.removeFromParent();
        f.mesh.material.dispose();
        this.fuses.delete(key);
        continue;
      }
      const left = Math.max(0, f.explodeAt - time);
      // Flashes faster, and swells a little, as the fuse runs out.
      const speed = left < 1 ? 26 : 9;
      f.mesh.material.opacity = Math.sin(time * speed) > 0 ? 0.72 : 0;
      f.mesh.scale.setScalar(left < 0.5 ? 1 + (0.5 - left) * 0.25 : 1);
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const blast = this.blasts[i];
      const t = (time - blast.started) / 0.35;
      if (t >= 1) {
        blast.mesh.removeFromParent();
        blast.mesh.material.dispose();
        this.blasts.splice(i, 1);
        continue;
      }
      blast.mesh.scale.setScalar(0.5 + t * (TNT_RADIUS + 0.8));
      blast.mesh.material.opacity = 0.9 * (1 - t);
    }
  }

  dispose(): void {
    for (const f of this.fuses.values()) {
      f.mesh.removeFromParent();
      f.mesh.material.dispose();
    }
    for (const b of this.blasts) {
      b.mesh.removeFromParent();
      b.mesh.material.dispose();
    }
    this.fuses.clear();
    this.blasts.length = 0;
    this.fuseGeometry.dispose();
    this.blastGeometry.dispose();
  }
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
  color: THREE.Color;
}

/** Small block fragments that fly out, fall and settle on the ground. */
export class BlockParticles {
  private readonly world: VoxelWorld;
  private readonly mesh: THREE.InstancedMesh;
  private readonly items: Particle[] = [];
  private readonly matrix = new THREE.Matrix4();

  constructor(scene: THREE.Scene, world: VoxelWorld) {
    this.world = world;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      MAX_PARTICLES,
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Instance colours need to exist before the first draw.
    this.mesh.setColorAt(0, new THREE.Color(0xffffff));
    scene.add(this.mesh);
  }

  private spawn(block: number, x: number, y: number, z: number, speed: number, size: number): void {
    const def = BLOCKS[block];
    this.spawnColored(Math.random() < 0.25 && def.sideColor ? def.sideColor : def.color, x, y, z, speed, size);
  }

  private spawnColored(hex: number, x: number, y: number, z: number, speed: number, size: number): void {
    if (this.items.length >= MAX_PARTICLES) this.items.shift();
    const color = new THREE.Color(hex);
    color.multiplyScalar(0.8 + Math.random() * 0.3);
    const angle = Math.random() * Math.PI * 2;
    const out = Math.random() * speed;
    this.items.push({
      x,
      y,
      z,
      vx: Math.cos(angle) * out,
      vy: 1 + Math.random() * speed,
      vz: Math.sin(angle) * out,
      age: 0,
      life: 0.5 + Math.random() * 0.5,
      size: size * (0.7 + Math.random() * 0.6),
      color,
    });
  }

  /** The block has just been destroyed. */
  burst(block: number, x: number, y: number, z: number, count = 28): void {
    for (let i = 0; i < count; i++) {
      this.spawn(block, x + Math.random(), y + Math.random(), z + Math.random(), 3, 0.13);
    }
  }

  /** Sparks and smoke thrown out by an explosion. */
  blast(x: number, y: number, z: number): void {
    const colors = [0xffc23c, 0xff7a1f, 0x55555c, 0x3a3a40];
    for (let i = 0; i < 90; i++) {
      this.spawnColored(colors[i % colors.length], x + 0.5, y + 0.5, z + 0.5, 11, 0.22);
    }
  }

  /** A few chips knocked off a block that's being mined. */
  chip(block: number, x: number, y: number, z: number): void {
    for (let i = 0; i < 3; i++) {
      this.spawn(block, x + Math.random(), y + 0.6 + Math.random() * 0.45, z + Math.random(), 1.6, 0.08);
    }
  }

  update(dt: number): void {
    const items = this.items;
    let write = 0;
    for (const p of items) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy -= PARTICLE_GRAVITY * dt;
      const nextY = p.y + p.vy * dt;
      if (this.world.isSolid(Math.floor(p.x), Math.floor(nextY), Math.floor(p.z))) {
        p.vy = 0;
        p.vx *= 0.6;
        p.vz *= 0.6;
      } else {
        p.y = nextY;
      }
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      items[write++] = p;
    }
    items.length = write;

    this.mesh.count = write;
    if (write === 0) return;
    for (let i = 0; i < write; i++) {
      const p = items[i];
      const s = p.size * Math.min(1, ((p.life - p.age) / p.life) * 2.5);
      this.matrix.makeScale(s, s, s);
      this.matrix.setPosition(p.x, p.y, p.z);
      this.mesh.setMatrixAt(i, this.matrix);
      this.mesh.setColorAt(i, p.color);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
