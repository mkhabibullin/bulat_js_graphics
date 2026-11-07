import * as THREE from 'three';
import { CHUNK_SIZE } from '../../shared/constants.ts';
import { B } from '../../shared/blocks.ts';
import type { VoxelWorld } from '../../shared/world.ts';
import { settings } from '../settings.ts';
import { buildAtlas, type AtlasInfo } from './atlas.ts';
import { BlockParticles, CrackOverlay, TntEffects } from './breaking.ts';
import { meshChunk } from './mesher.ts';

const VIEW_DISTANCE = { high: 190, low: 110 };
const MAX_CHUNK_BUILDS_PER_FRAME = 6;
const HORIZON = 0xcfeafa;

interface ChunkMeshes {
  opaque?: THREE.Mesh;
  transparent?: THREE.Mesh;
  glow?: THREE.Mesh;
}

/** Owns the WebGL renderer, the sky, the world's meshes and the coins. */
export class GameScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
  readonly atlas: AtlasInfo;
  private readonly sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  private readonly materials: { opaque: THREE.Material; transparent: THREE.Material; glow: THREE.MeshBasicMaterial };
  private readonly chunks = new Map<number, ChunkMeshes>();
  private readonly dirty = new Set<number>();
  private readonly world: VoxelWorld;
  private readonly sky: THREE.Mesh;
  private readonly clouds: THREE.InstancedMesh;
  private readonly cloudData: { x: number; y: number; z: number; sx: number; sz: number }[] = [];
  private coinMesh: THREE.InstancedMesh | null = null;
  private coinCells: number[] = [];
  private readonly hiddenCoins = new Set<number>();
  private coinsChanged = true;
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly upAxis = new THREE.Vector3(0, 1, 0);
  readonly highlight: THREE.LineSegments;
  readonly cracks: CrackOverlay;
  readonly particles: BlockParticles;
  readonly tnt: TntEffects;
  private lastRenderTime = 0;
  private readonly chunksX: number;
  private readonly chunksY: number;
  private readonly chunksZ: number;

  constructor(container: HTMLElement, world: VoxelWorld) {
    this.world = world;
    const high = settings.quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ antialias: high, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, high ? 2 : 1));
    this.renderer.shadowMap.enabled = high;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'game-canvas';
    container.append(this.renderer.domElement);

    this.atlas = buildAtlas();
    this.atlas.texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());

    const opaque = new THREE.MeshLambertMaterial({ map: this.atlas.texture, vertexColors: true });
    const transparent = new THREE.MeshLambertMaterial({
      map: this.atlas.texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.MeshBasicMaterial({ map: this.atlas.texture, vertexColors: true });
    this.materials = { opaque, transparent, glow };

    const view = VIEW_DISTANCE[settings.quality];
    this.scene.fog = new THREE.Fog(HORIZON, view * 0.45, view);
    this.scene.background = new THREE.Color(HORIZON);
    this.camera.far = view + 200;

    this.scene.add(new THREE.HemisphereLight(0xdff1ff, 0x8d8370, 1.7));
    this.sun.position.set(40, 80, 30);
    if (high) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      const cam = this.sun.shadow.camera;
      cam.left = -45;
      cam.right = 45;
      cam.top = 45;
      cam.bottom = -45;
      cam.near = 1;
      cam.far = 220;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.03;
    }
    this.scene.add(this.sun, this.sun.target);

    this.sky = this.buildSky(view);
    this.scene.add(this.sky);

    this.clouds = this.buildClouds();
    this.scene.add(this.clouds);

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.005, 1.005, 1.005));
    this.highlight = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.85 }));
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this.cracks = new CrackOverlay(this.scene);
    this.particles = new BlockParticles(this.scene, world);
    this.tnt = new TntEffects(this.scene, world);

    this.chunksX = Math.ceil(world.w / CHUNK_SIZE);
    this.chunksY = Math.ceil(world.h / CHUNK_SIZE);
    this.chunksZ = Math.ceil(world.d / CHUNK_SIZE);
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cz = 0; cz < this.chunksZ; cz++) {
        for (let cx = 0; cx < this.chunksX; cx++) this.dirty.add(this.chunkKey(cx, cy, cz));
      }
    }

    this.scanCoins();
    this.resize();
  }

  private chunkKey(cx: number, cy: number, cz: number): number {
    return cx + cz * this.chunksX + cy * this.chunksX * this.chunksZ;
  }

  private buildSky(view: number): THREE.Mesh {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x3f9be8) },
        bottom: { value: new THREE.Color(HORIZON) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top;
        uniform vec3 bottom;
        varying vec3 vDir;
        void main() {
          float t = clamp(normalize(vDir).y * 1.6, 0.0, 1.0);
          vec3 color = mix(bottom, top, pow(t, 0.75));
          float sun = pow(max(dot(normalize(vDir), normalize(vec3(0.45, 0.75, 0.35))), 0.0), 220.0);
          gl_FragColor = vec4(color + vec3(1.0, 0.95, 0.8) * sun, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(view + 100, 24, 16), material);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    return sky;
  }

  private buildClouds(): THREE.InstancedMesh {
    let seed = 5;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const count = 34;
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.86, fog: false });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, count);
    for (let i = 0; i < count; i++) {
      this.cloudData.push({
        x: -80 + random() * 260,
        y: 54 + random() * 12,
        z: -80 + random() * 260,
        sx: 10 + random() * 22,
        sz: 8 + random() * 16,
      });
    }
    mesh.frustumCulled = false;
    return mesh;
  }

  resize(): void {
    const parent = this.renderer.domElement.parentElement;
    const width = parent?.clientWidth || window.innerWidth;
    const height = parent?.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /** Marks the chunk holding a block, plus neighbours when it's on a boundary. */
  markBlockDirty(x: number, y: number, z: number): void {
    const mark = (bx: number, by: number, bz: number): void => {
      if (!this.world.inBounds(bx, by, bz)) return;
      this.dirty.add(this.chunkKey(Math.floor(bx / CHUNK_SIZE), Math.floor(by / CHUNK_SIZE), Math.floor(bz / CHUNK_SIZE)));
    };
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) mark(x + dx, y + dy, z + dz);
      }
    }
  }

  get pendingChunks(): number {
    return this.dirty.size;
  }

  get totalChunks(): number {
    return this.chunksX * this.chunksY * this.chunksZ;
  }

  /** Rebuilds a few dirty chunks per frame, nearest first, to avoid hitches. */
  updateChunks(focus: THREE.Vector3, budget = MAX_CHUNK_BUILDS_PER_FRAME): void {
    if (this.dirty.size === 0) return;
    const decode = (key: number): [number, number, number] => {
      const cy = Math.floor(key / (this.chunksX * this.chunksZ));
      const rest = key - cy * this.chunksX * this.chunksZ;
      const cz = Math.floor(rest / this.chunksX);
      return [rest - cz * this.chunksX, cy, cz];
    };
    const dist = (key: number): number => {
      const [cx, cy, cz] = decode(key);
      return (
        ((cx + 0.5) * CHUNK_SIZE - focus.x) ** 2 + ((cy + 0.5) * CHUNK_SIZE - focus.y) ** 2 + ((cz + 0.5) * CHUNK_SIZE - focus.z) ** 2
      );
    };
    const ordered = this.dirty.size <= budget ? [...this.dirty] : [...this.dirty].sort((a, b) => dist(a) - dist(b)).slice(0, budget);
    for (const key of ordered) {
      this.dirty.delete(key);
      const [cx, cy, cz] = decode(key);
      this.rebuildChunk(key, cx, cy, cz);
    }
  }

  private rebuildChunk(key: number, cx: number, cy: number, cz: number): void {
    const old = this.chunks.get(key);
    if (old) {
      for (const mesh of [old.opaque, old.transparent, old.glow]) {
        if (mesh) {
          this.scene.remove(mesh);
          mesh.geometry.dispose();
        }
      }
    }
    const built = meshChunk(this.world, cx, cy, cz, this.atlas);
    const next: ChunkMeshes = {};
    if (built.opaque) {
      next.opaque = new THREE.Mesh(built.opaque, this.materials.opaque);
      next.opaque.castShadow = true;
      next.opaque.receiveShadow = true;
      this.scene.add(next.opaque);
    }
    if (built.glow) {
      next.glow = new THREE.Mesh(built.glow, this.materials.glow);
      next.glow.castShadow = true;
      this.scene.add(next.glow);
    }
    if (built.transparent) {
      next.transparent = new THREE.Mesh(built.transparent, this.materials.transparent);
      next.transparent.receiveShadow = true;
      next.transparent.renderOrder = 1;
      this.scene.add(next.transparent);
    }
    this.chunks.set(key, next);
  }

  // --- Coins ---

  scanCoins(): void {
    this.coinCells = [];
    const { data } = this.world;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === B.COIN) this.coinCells.push(i);
    }
    this.coinsChanged = true;
  }

  hideCoin(index: number): void {
    this.hiddenCoins.add(index);
    this.coinsChanged = true;
  }

  private updateCoins(time: number): void {
    if (this.coinsChanged) {
      this.coinsChanged = false;
      this.coinMesh?.removeFromParent();
      this.coinMesh?.dispose();
      this.coinMesh = null;
      const count = this.coinCells.filter((c) => !this.hiddenCoins.has(c)).length;
      if (count > 0) {
        const geometry = new THREE.CylinderGeometry(0.34, 0.34, 0.09, 20);
        geometry.rotateX(Math.PI / 2);
        const material = new THREE.MeshLambertMaterial({ color: 0xffc93c, emissive: 0x8a5a00, emissiveIntensity: 0.9 });
        this.coinMesh = new THREE.InstancedMesh(geometry, material, count);
        this.coinMesh.castShadow = true;
        this.coinMesh.frustumCulled = false;
        this.scene.add(this.coinMesh);
      }
    }
    if (!this.coinMesh) return;
    const { w, d } = this.world;
    this.tmpQuat.setFromAxisAngle(this.upAxis, time * 2.4);
    this.tmpScale.set(1, 1, 1);
    let n = 0;
    for (const cell of this.coinCells) {
      if (this.hiddenCoins.has(cell)) continue;
      const y = Math.floor(cell / (w * d));
      const rest = cell - y * w * d;
      const z = Math.floor(rest / w);
      const x = rest - z * w;
      this.tmpPos.set(x + 0.5, y + 0.5 + Math.sin(time * 2.2 + x + z) * 0.08, z + 0.5);
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.coinMesh.setMatrixAt(n++, this.tmpMatrix);
    }
    this.coinMesh.instanceMatrix.needsUpdate = true;
  }

  render(time: number, focus: THREE.Vector3): void {
    this.updateCoins(time);
    this.particles.update(time - this.lastRenderTime);
    this.tnt.update(time);
    this.lastRenderTime = time;

    // The sky stays centred on the camera so that it never gets closer.
    this.sky.position.copy(this.camera.position);

    // Slow drift, wrapping around the map.
    const span = 260;
    this.tmpQuat.identity();
    this.cloudData.forEach((c, i) => {
      const x = ((c.x + time * 0.7 + 80) % span) - 80;
      this.tmpPos.set(x, c.y, c.z);
      this.tmpScale.set(c.sx, 2.4, c.sz);
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.clouds.setMatrixAt(i, this.tmpMatrix);
    });
    this.clouds.instanceMatrix.needsUpdate = true;

    // Lava and other glowing tiles breathe gently.
    const pulse = 0.92 + Math.sin(time * 2.2) * 0.08;
    this.materials.glow.color.setScalar(pulse);

    // Shadow frustum follows the player, snapped to whole units to stop shimmering.
    const fx = Math.round(focus.x);
    const fy = Math.round(focus.y);
    const fz = Math.round(focus.z);
    this.sun.position.set(fx + 40, fy + 80, fz + 30);
    this.sun.target.position.set(fx, fy, fz);

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) {
      for (const mesh of [chunk.opaque, chunk.transparent, chunk.glow]) mesh?.geometry.dispose();
    }
    this.chunks.clear();
    this.coinMesh?.dispose();
    this.cracks.dispose();
    this.particles.dispose();
    this.tnt.dispose();
    this.clouds.dispose();
    this.atlas.texture.dispose();
    this.materials.opaque.dispose();
    this.materials.transparent.dispose();
    this.materials.glow.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
