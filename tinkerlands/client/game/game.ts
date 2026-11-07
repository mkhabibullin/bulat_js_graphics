import * as THREE from 'three';
import type { Avatar } from '../../shared/avatar.ts';
import { B, BLOCKS, isSolidBlock, PALETTE } from '../../shared/blocks.ts';
import {
  BUILD_REACH,
  CLOSE,
  DT,
  PLAYER_EYE,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL_TICKS,
  TICK_RATE,
} from '../../shared/constants.ts';
import {
  copyPlayerState,
  createPlayerState,
  headingForInput,
  stepPlayer,
  type MoveInput,
  type PlayerState,
} from '../../shared/physics.ts';
import type { ClientMessage, PlayerInfo, SelfState, ServerMessage, WelcomeWorld } from '../../shared/protocol.ts';
import { decodeRLE, VoxelWorld } from '../../shared/world.ts';
import { toast } from '../dom.ts';
import { play, unlockAudio } from './audio.ts';
import { AvatarMesh } from './avatarMesh.ts';
import { GameHud, type HudHost } from './hud.ts';
import { InputController } from './input.ts';
import { GameScene } from './scene.ts';
import { disposeLabel, makeLabel } from './sprites.ts';

const TICK_MS = 1000 / TICK_RATE;
const INTERP_DELAY_TICKS = SNAPSHOT_INTERVAL_TICKS * 2.5;
const MAX_PENDING_INPUTS = 120;
const MAX_FRAME_STEPS = 5;
const MAX_RECONNECTS = 8;
const FATAL_CLOSE_CODES: Set<number> = new Set(Object.values(CLOSE));
const BUILD_SHOULDER_OFFSET = 1.1;
/** Crack slot for this player. Other players' slots are their ids, which start at 1. */
const SELF_CRACK = 0;

interface Sample {
  tick: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  grounded: boolean;
  emote: number;
}

interface RemotePlayer {
  info: PlayerInfo;
  mesh: AvatarMesh;
  tag: THREE.Sprite;
  bubble: THREE.Sprite | null;
  bubbleUntil: number;
  samples: Sample[];
  lastX: number;
  lastZ: number;
  heading: number;
}

export interface GameOptions {
  container: HTMLElement;
  worldId: string;
  token: string;
  username: string;
  uid: string;
  avatar: Avatar;
  coins: number;
  onLeave: () => void;
  onCoins: (coins: number) => void;
  onAuthExpired: () => void;
}

async function inflate(base64: string): Promise<Uint8Array> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Game implements HudHost {
  private readonly opts: GameOptions;
  private ws: WebSocket | null = null;
  private disposed = false;
  private reconnects = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private rtt = 0;

  private world: VoxelWorld | null = null;
  private scene: GameScene | null = null;
  private input: InputController | null = null;
  hud: GameHud;
  private ready = false;
  private inbox: ServerMessage[] = [];
  private processingWelcome = false;

  private myId = -1;
  private readonly predicted: PlayerState = createPlayerState(0, 0, 0);
  private readonly previous: PlayerState = createPlayerState(0, 0, 0);
  private pending: { seq: number; input: MoveInput }[] = [];
  private seq = 0;
  private accumulator = 0;
  private lastFrame = 0;
  private time = 0;
  private readonly errorOffset = new THREE.Vector3();

  private myMesh: AvatarMesh | null = null;
  private myHeading = 0;
  private myEmote = 0;
  private myBubble: THREE.Sprite | null = null;
  private myBubbleUntil = 0;
  private readonly players = new Map<number, RemotePlayer>();
  private readonly muted = new Set<string>();
  private tickOffset: number | null = null;

  private zoom = 7;
  private cameraDist = 7;
  private shoulder = 0;
  private readonly focus = new THREE.Vector3();
  private readonly lookDir = new THREE.Vector3();

  private canBuild = false;
  private isOwner = false;
  private buildMode = false;
  private selected = 0;
  private hotbar: number[] = [];
  private target: { x: number; y: number; z: number; px: number; py: number; pz: number } | null = null;
  private burstSize = 28;
  private shake = 0;
  private primaryHeld = false;
  private mining: { x: number; y: number; z: number; block: number; elapsed: number; duration: number; nextHit: number } | null = null;
  private miningCooldown = 0;
  private readonly remoteMining = new Map<number, { x: number; y: number; z: number; block: number; started: number; ms: number }>();

  private goalCount = 0;
  private runStart = 0;
  private runFinished = false;
  private bestMs: number | null = null;
  private wasGrounded = true;
  private rafId = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.hud = new GameHud(opts.container, this);
    this.hud.setLoading('Connecting…');
    this.connect();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    (window as unknown as { __tinker?: () => unknown }).__tinker = () => this.debugInfo();
  }

  private debugInfo(): unknown {
    return {
      ready: this.ready,
      x: this.predicted.x,
      y: this.predicted.y,
      z: this.predicted.z,
      grounded: this.predicted.grounded,
      players: this.players.size,
      pendingChunks: this.scene?.pendingChunks ?? -1,
      fps: this.fps,
      rtt: this.rtt,
      canBuild: this.canBuild,
      buildMode: this.buildMode,
    };
  }

  // --- Networking ---

  private connect(): void {
    if (this.disposed) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'join', token: this.opts.token, worldId: this.opts.worldId, v: PROTOCOL_VERSION });
    };
    ws.onmessage = (event) => {
      try {
        this.receive(JSON.parse(event.data as string) as ServerMessage);
      } catch (err) {
        console.error('Bad server message', err);
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws || this.disposed) return;
      this.onDisconnect(event.code, event.reason);
    };
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onDisconnect(code: number, reason: string): void {
    this.ready = false;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (code === CLOSE.AUTH) {
      this.opts.onAuthExpired();
      return;
    }
    if (FATAL_CLOSE_CODES.has(code)) {
      this.hud.showFatal(reason || 'You were disconnected.');
      return;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      this.hud.showFatal('Lost connection to the server.', true);
      return;
    }
    const delay = Math.min(500 * 2 ** this.reconnects, 8000) + Math.random() * 300;
    this.reconnects++;
    this.hud.setLoading(code === 1012 ? 'The server is restarting…' : 'Connection lost. Reconnecting…');
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  retryConnection(): void {
    this.reconnects = 0;
    this.hud.setLoading('Connecting…');
    this.connect();
  }

  private receive(msg: ServerMessage): void {
    if (msg.t === 'w') {
      this.processingWelcome = true;
      this.inbox = [];
      void this.onWelcome(msg);
      return;
    }
    // Hold everything else until the world from the welcome has been unpacked.
    if (this.processingWelcome) {
      this.inbox.push(msg);
      return;
    }
    this.handle(msg);
  }

  private async onWelcome(msg: Extract<ServerMessage, { t: 'w' }>): Promise<void> {
    try {
      this.hud.setLoading('Loading world…');
      const raw = await inflate(msg.world.blocks);
      if (this.disposed) return;
      const expected = msg.world.w * msg.world.h * msg.world.d;
      const world = new VoxelWorld(msg.world.w, msg.world.h, msg.world.d, decodeRLE(raw, expected));
      this.startWorld(world, msg);
      this.processingWelcome = false;
      for (const queued of this.inbox) this.handle(queued);
      this.inbox = [];
      this.reconnects = 0;
    } catch (err) {
      console.error(err);
      this.hud.showFatal(
        err instanceof Error && /WebGL/i.test(err.message)
          ? 'Your browser couldn’t start 3D graphics. Try enabling hardware acceleration or another browser.'
          : 'This world couldn’t be loaded.',
      );
    }
  }

  private startWorld(world: VoxelWorld, msg: Extract<ServerMessage, { t: 'w' }>): void {
    this.teardownWorld();
    this.world = world;
    const scene = new GameScene(this.opts.container, world);
    this.scene = scene;
    const canvas = scene.renderer.domElement;
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      // Tearing down a scene (when reconnecting or leaving) releases its context
      // on purpose, so only the live scene's context being lost is a problem.
      if (!this.disposed && this.scene === scene) {
        this.hud.showFatal('Graphics were interrupted. Reload the page to keep playing.', false, true);
      }
    });

    this.input = new InputController(canvas, {
      onKey: (code, event) => this.onKey(code, event),
      onPrimary: () => this.primaryAction(),
      onPrimaryEnd: () => this.primaryEnd(),
      onSecondary: () => this.secondaryAction(),
      onWheel: (delta) => this.onWheel(delta),
      onLockLost: () => this.hud.openPause(),
    });

    const info: WelcomeWorld = msg.world;
    this.canBuild = info.canBuild;
    this.isOwner = info.isOwner;
    this.buildMode = false;
    this.hotbar = this.defaultHotbar();
    this.selected = 0;
    this.primaryHeld = false;
    this.mining = null;
    this.miningCooldown = 0;
    this.remoteMining.clear();

    this.myId = msg.you;
    this.seq = 0;
    this.pending = [];
    this.accumulator = 0;
    this.tickOffset = null;
    this.applySelf(msg.me);
    copyPlayerState(this.predicted, this.previous);
    this.errorOffset.set(0, 0, 0);

    // Start out looking across the map, with the character facing the same way.
    this.input.yaw = Math.atan2(this.predicted.x - world.w / 2, this.predicted.z - world.d / 2);
    this.myHeading = this.input.yaw + Math.PI;

    this.myMesh = new AvatarMesh(this.opts.avatar);
    this.myMesh.root.rotation.y = this.myHeading;
    scene.scene.add(this.myMesh.root);
    for (const p of msg.players) this.addPlayer(p);

    this.goalCount = 0;
    for (let i = 0; i < world.data.length; i++) if (world.data[i] === B.GOAL) this.goalCount++;
    this.runStart = performance.now();
    this.runFinished = false;
    this.bestMs = msg.best;

    this.hud.onWorldReady(info.name, this.input, scene.atlas);
    this.hud.setCoins(msg.coins);
    this.hud.setBuild(this.canBuild, this.buildMode, this.hotbar, this.selected, this.isOwner);
    this.refreshPlayerList();
    this.hud.setLoading(null);
    for (let i = 0; i + 3 < msg.fuses.length; i += 4) {
      scene.tnt.light(msg.fuses[i], msg.fuses[i + 1], msg.fuses[i + 2], msg.fuses[i + 3]);
    }

    this.ready = true;
    this.lastFrame = performance.now();
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.frame);

    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
  }

  private teardownWorld(): void {
    cancelAnimationFrame(this.rafId);
    for (const p of this.players.values()) this.disposePlayer(p);
    this.players.clear();
    this.myMesh?.dispose();
    this.myMesh = null;
    if (this.myBubble) disposeLabel(this.myBubble);
    this.myBubble = null;
    this.input?.dispose();
    this.input = null;
    this.scene?.dispose();
    this.scene = null;
    this.world = null;
  }

  private defaultHotbar(): number[] {
    const list = this.isOwner
      ? [B.GRASS, B.PLANKS, B.BRICK, B.TNT, B.GLASS, B.BOUNCE, B.LAVA, B.CHECKPOINT, B.GOAL]
      : [B.GRASS, B.PLANKS, B.BRICK, B.STONE, B.GLASS, B.BLUE, B.RED, B.YELLOW, B.TNT];
    return list;
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 's':
        this.onSnapshot(msg);
        break;
      case 'b': {
        // Share the particle budget across big batches, like explosions.
        this.burstSize = Math.max(1, Math.min(28, Math.floor(240 / (msg.b.length / 4))));
        for (let i = 0; i + 3 < msg.b.length; i += 4) this.setBlock(msg.b[i], msg.b[i + 1], msg.b[i + 2], msg.b[i + 3]);
        this.burstSize = 28;
        break;
      }
      case 'tl':
        this.scene?.tnt.light(msg.x, msg.y, msg.z, msg.ms);
        if (this.distanceToPlayer(msg.x, msg.y, msg.z) < 40) play('fuse');
        break;
      case 'boom': {
        this.scene?.tnt.explode(msg.x, msg.y, msg.z);
        this.scene?.particles.blast(msg.x, msg.y, msg.z);
        const dist = this.distanceToPlayer(msg.x, msg.y, msg.z);
        if (dist < 70) play('boom');
        this.shake = Math.max(this.shake, 0.7 * Math.max(0, 1 - dist / 35));
        break;
      }
      case 'br':
        this.setBlock(msg.x, msg.y, msg.z, msg.k);
        if (!msg.quiet) toast(msg.why, 'error', 1800);
        break;
      case 'pj':
        this.addPlayer(msg.p);
        this.refreshPlayerList();
        break;
      case 'pl': {
        const p = this.players.get(msg.id);
        if (p) {
          this.disposePlayer(p);
          this.players.delete(msg.id);
          this.refreshPlayerList();
        }
        this.remoteMining.delete(msg.id);
        this.scene?.cracks.clear(msg.id);
        break;
      }
      case 'mi':
        if (msg.c && this.world) {
          const [x, y, z] = msg.c;
          this.remoteMining.set(msg.id, { x, y, z, block: this.world.get(x, y, z), started: this.time, ms: msg.ms });
        } else {
          this.remoteMining.delete(msg.id);
          this.scene?.cracks.clear(msg.id);
        }
        break;
      case 'c':
        this.onChat(msg.id, msg.name, msg.m);
        break;
      case 'sys':
        this.hud.addChat(null, msg.m);
        break;
      case 'perm':
        this.canBuild = msg.canBuild;
        if (!this.canBuild) this.buildMode = false;
        this.hud.setBuild(this.canBuild, this.buildMode, this.hotbar, this.selected, this.isOwner);
        break;
      case 'died':
        play('die');
        this.hud.flash();
        break;
      case 'checkpoint':
        play('checkpoint');
        this.hud.banner(`Checkpoint ${msg.n}`, 'checkpoint');
        break;
      case 'coin':
        this.scene?.hideCoin(this.world!.index(msg.x, msg.y, msg.z));
        play('coin');
        this.hud.setCoins(msg.coins);
        this.opts.onCoins(msg.coins);
        if (msg.granted === 0 && !this.isOwner) this.hud.addChat(null, 'You’ve reached today’s coin limit.');
        break;
      case 'finish':
        play('finish');
        this.runFinished = true;
        this.bestMs = msg.best;
        this.hud.showFinish(msg.ms, msg.best, msg.isBest, msg.granted);
        this.hud.setCoins(msg.coins);
        this.opts.onCoins(msg.coins);
        break;
      case 'restarted':
        this.runStart = performance.now();
        this.runFinished = false;
        this.hud.hideFinish();
        break;
      case 'pong':
        this.rtt = Math.round(performance.now() - msg.ts);
        break;
      case 'w':
        break;
    }
  }

  private applySelf(s: SelfState): void {
    const p = this.predicted;
    p.x = s.x;
    p.y = s.y;
    p.z = s.z;
    p.vx = s.vx;
    p.vy = s.vy;
    p.vz = s.vz;
    p.grounded = s.g === 1;
    p.coyote = s.c;
  }

  private onSnapshot(msg: Extract<ServerMessage, { t: 's' }>): void {
    if (!this.world) return;

    const offset = msg.k - performance.now() / TICK_MS;
    this.tickOffset = this.tickOffset === null ? offset : this.tickOffset + (offset - this.tickOffset) * 0.05;

    for (const row of msg.p) {
      const [id, x, y, z, heading, grounded, emote] = row;
      if (id === this.myId) {
        this.myEmote = emote;
        continue;
      }
      const player = this.players.get(id);
      if (!player) continue;
      player.samples.push({ tick: msg.k, x, y, z, heading, grounded: grounded === 1, emote });
      if (player.samples.length > 20) player.samples.shift();
    }

    // Rewind to the server's state, then replay the inputs it hasn't seen yet.
    const oldX = this.predicted.x;
    const oldY = this.predicted.y;
    const oldZ = this.predicted.z;
    this.applySelf(msg.me);
    while (this.pending.length > 0 && this.pending[0].seq <= msg.me.s) this.pending.shift();
    for (const entry of this.pending) stepPlayer(this.predicted, entry.input, this.world);

    const ex = oldX - this.predicted.x;
    const ey = oldY - this.predicted.y;
    const ez = oldZ - this.predicted.z;
    if (Math.hypot(ex, ey, ez) > 3) {
      // A teleport (respawn, restart): snap instead of sliding across the map.
      this.errorOffset.set(0, 0, 0);
      copyPlayerState(this.predicted, this.previous);
    } else {
      // Small corrections are blended away so that they aren't visible as a jerk.
      this.errorOffset.x += ex;
      this.errorOffset.y += ey;
      this.errorOffset.z += ez;
      this.previous.x -= ex;
      this.previous.y -= ey;
      this.previous.z -= ez;
    }
  }

  private addPlayer(info: PlayerInfo): void {
    if (!this.scene || info.id === this.myId || this.players.has(info.id)) return;
    const mesh = new AvatarMesh(info.avatar);
    const tag = makeLabel(info.name, { background: 'rgba(30,27,46,0.72)', color: '#ffffff', fontSize: 30 });
    tag.position.y = PLAYER_HEIGHT + 0.42;
    mesh.root.add(tag);
    this.scene.scene.add(mesh.root);
    this.players.set(info.id, { info, mesh, tag, bubble: null, bubbleUntil: 0, samples: [], lastX: 0, lastZ: 0, heading: 0 });
  }

  private disposePlayer(p: RemotePlayer): void {
    disposeLabel(p.tag);
    if (p.bubble) disposeLabel(p.bubble);
    p.mesh.dispose();
  }

  private onChat(id: number, name: string, text: string): void {
    if (id === this.myId) {
      this.hud.addChat(name, text);
      if (this.myMesh) {
        if (this.myBubble) disposeLabel(this.myBubble);
        this.myBubble = this.makeBubble(text);
        this.myMesh.root.add(this.myBubble);
        this.myBubbleUntil = this.time + 5;
      }
      return;
    }
    const p = this.players.get(id);
    if (p && this.muted.has(p.info.uid)) return;
    this.hud.addChat(name, text);
    play('chat');
    if (p) {
      if (p.bubble) disposeLabel(p.bubble);
      p.bubble = this.makeBubble(text);
      p.mesh.root.add(p.bubble);
      p.bubbleUntil = this.time + 5;
    }
  }

  private makeBubble(text: string): THREE.Sprite {
    const bubble = makeLabel(text, { background: 'rgba(255,255,255,0.95)', color: '#27233a', fontSize: 30, maxWidth: 420 });
    bubble.position.y = PLAYER_HEIGHT + 0.85;
    return bubble;
  }

  private setBlock(x: number, y: number, z: number, block: number): void {
    if (!this.world || !this.scene || !this.world.inBounds(x, y, z)) return;
    const previous = this.world.get(x, y, z);
    if (previous === block) return;
    if (previous === B.GOAL) this.goalCount--;
    if (block === B.GOAL) this.goalCount++;
    this.world.set(x, y, z, block);
    this.scene.markBlockDirty(x, y, z);
    // Runs for anyone's break: our own and those arriving from the server.
    if (block === B.AIR && BLOCKS[previous].bucket !== 'none') this.scene.particles.burst(previous, x, y, z, this.burstSize);
    if (previous === B.COIN || block === B.COIN) this.scene.scanCoins();
  }

  // --- Input ---

  private onKey(code: string, event: KeyboardEvent): void {
    if (this.hud.isPaused()) {
      if (code === 'Escape') this.resume();
      return;
    }
    if (this.hud.isPaletteOpen()) {
      if (code === 'KeyE' || code === 'Escape') this.togglePalette();
      return;
    }
    switch (code) {
      case 'Enter':
      case 'Slash':
        event.preventDefault();
        this.primaryHeld = false;
        this.input?.releaseLock();
        this.input?.setEnabled(false);
        this.hud.focusChat();
        return;
      case 'Escape':
        this.hud.openPause();
        return;
      case 'KeyB':
        this.toggleBuild();
        return;
      case 'KeyE':
        if (this.buildMode) this.togglePalette();
        return;
      case 'KeyR':
        this.restartRun();
        return;
      case 'KeyG':
        this.emote(0);
        return;
      case 'KeyH':
        this.emote(1);
        return;
      case 'KeyJ':
        this.emote(2);
        return;
      default:
        break;
    }
    if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (n >= 1 && n <= this.hotbar.length) this.selectSlot(n - 1);
    }
  }

  emote(index: number): void {
    this.send({ t: 'e', e: index });
  }

  restartRun(): void {
    this.send({ t: 'restart' });
  }

  toggleBuild(): void {
    if (!this.canBuild) {
      toast('This world’s owner hasn’t opened it for building.', 'info', 2200);
      return;
    }
    this.buildMode = !this.buildMode;
    this.primaryHeld = false;
    if (!this.buildMode && this.scene) this.scene.highlight.visible = false;
    if (!this.buildMode && this.hud.isPaletteOpen()) this.togglePalette();
    this.hud.setBuild(this.canBuild, this.buildMode, this.hotbar, this.selected, this.isOwner);
  }

  togglePalette(): void {
    const opening = !this.hud.isPaletteOpen();
    this.primaryHeld = false;
    this.hud.setPaletteOpen(opening);
    if (opening) {
      this.input?.releaseLock();
    } else {
      this.input?.requestLock();
    }
  }

  /** Puts a palette block in the selected hotbar slot. */
  chooseBlock(block: number): void {
    const existing = this.hotbar.indexOf(block);
    if (existing >= 0) {
      this.selected = existing;
    } else {
      this.hotbar[this.selected] = block;
    }
    this.hud.setBuild(this.canBuild, this.buildMode, this.hotbar, this.selected, this.isOwner);
    this.togglePalette();
  }

  paletteBlocks(): number[] {
    return PALETTE.filter((id) => this.isOwner || !BLOCKS[id].ownerOnly);
  }

  selectSlot(slot: number): void {
    this.selected = slot;
    this.hud.setBuild(this.canBuild, this.buildMode, this.hotbar, this.selected, this.isOwner);
  }

  private onWheel(delta: number): void {
    if (this.buildMode) {
      const n = this.hotbar.length;
      this.selectSlot((this.selected + delta + n) % n);
    } else {
      this.zoom = Math.max(0, Math.min(16, this.zoom + delta * 1.2));
      if (this.zoom < 1.2) this.zoom = delta < 0 ? 0 : 1.2;
    }
  }

  /** Mining starts here and carries on in updateMining while the button is held. */
  primaryAction(): void {
    if (!this.buildMode) return;
    this.primaryHeld = true;
    if (!this.target) return;
    const existing = this.world!.get(this.target.x, this.target.y, this.target.z);
    if (BLOCKS[existing].ownerOnly && !this.isOwner) {
      toast('Only the world’s owner can remove that block.', 'error', 1800);
    }
  }

  primaryEnd(): void {
    this.primaryHeld = false;
  }

  private cancelMining(): void {
    if (!this.mining) return;
    this.mining = null;
    this.scene?.cracks.clear(SELF_CRACK);
    this.send({ t: 'mx' });
  }

  private updateMining(dt: number): void {
    const world = this.world!;
    const scene = this.scene!;
    if (this.miningCooldown > 0) this.miningCooldown -= dt;

    const t = this.target;
    const block = t ? world.get(t.x, t.y, t.z) : B.AIR;
    const wanted =
      t !== null &&
      this.primaryHeld &&
      this.buildMode &&
      this.miningCooldown <= 0 &&
      block !== B.AIR &&
      (this.isOwner || !BLOCKS[block].ownerOnly);

    const m = this.mining;
    // Looking away, letting go, or the block changing all lose the progress.
    if (m && (!wanted || m.x !== t.x || m.y !== t.y || m.z !== t.z || m.block !== block)) this.cancelMining();
    if (!wanted) return;

    if (!this.mining) {
      this.mining = { x: t.x, y: t.y, z: t.z, block, elapsed: 0, duration: BLOCKS[block].breakTime, nextHit: 0 };
      this.send({ t: 'm', x: t.x, y: t.y, z: t.z });
    }
    const mining = this.mining;
    mining.elapsed += dt;
    if (mining.elapsed >= mining.nextHit) {
      mining.nextHit += 0.22;
      play('hit');
      scene.particles.chip(block, t.x, t.y, t.z);
    }
    if (mining.elapsed < mining.duration) {
      scene.cracks.set(SELF_CRACK, t.x, t.y, t.z, mining.elapsed / mining.duration);
      return;
    }

    this.mining = null;
    scene.cracks.clear(SELF_CRACK);
    this.setBlock(t.x, t.y, t.z, B.AIR);
    this.send({ t: 'b', x: t.x, y: t.y, z: t.z, k: B.AIR });
    play('break');
    // A short pause before the next block, so that holding doesn't dig too fast.
    this.miningCooldown = 0.2;
  }

  private updateRemoteCracks(): void {
    const scene = this.scene!;
    const world = this.world!;
    for (const [id, m] of this.remoteMining) {
      const elapsed = this.time - m.started;
      // Give up if the block changed, or if the miner has gone quiet for too long.
      if (world.get(m.x, m.y, m.z) !== m.block || elapsed > m.ms / 1000 + 1.5) {
        this.remoteMining.delete(id);
        scene.cracks.clear(id);
      } else {
        scene.cracks.set(id, m.x, m.y, m.z, elapsed / (m.ms / 1000));
      }
    }
  }

  private distanceToPlayer(x: number, y: number, z: number): number {
    const s = this.predicted;
    return Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y, z + 0.5 - s.z);
  }

  secondaryAction(): void {
    if (!this.buildMode || !this.target) return;
    const t = this.target;
    if (this.world!.get(t.x, t.y, t.z) === B.TNT) {
      // The server starts the fuse and tells everyone, including this player.
      this.send({ t: 'l', x: t.x, y: t.y, z: t.z });
      return;
    }
    const { px: x, py: y, pz: z } = t;
    const block = this.hotbar[this.selected];
    if (!this.world!.inBounds(x, y, z)) return;
    if (isSolidBlock(block) && this.overlapsSelf(x, y, z)) return;
    this.setBlock(x, y, z, block);
    this.send({ t: 'b', x, y, z, k: block });
    play('place');
  }

  private overlapsSelf(x: number, y: number, z: number): boolean {
    const s = this.predicted;
    return (
      s.x + PLAYER_HALF_WIDTH > x &&
      s.x - PLAYER_HALF_WIDTH < x + 1 &&
      s.z + PLAYER_HALF_WIDTH > z &&
      s.z - PLAYER_HALF_WIDTH < z + 1 &&
      s.y + PLAYER_HEIGHT > y &&
      s.y < y + 1
    );
  }

  resume(): void {
    this.hud.closePause();
    this.input?.setEnabled(true);
    this.input?.requestLock();
  }

  chatClosed(): void {
    this.input?.setEnabled(true);
    this.input?.requestLock();
  }

  sendChat(text: string): void {
    this.send({ t: 'c', m: text });
  }

  setPauseInput(paused: boolean): void {
    this.input?.setEnabled(!paused);
    if (paused) {
      this.primaryHeld = false;
      this.input?.releaseLock();
    }
  }

  setTouchJump(held: boolean): void {
    this.input?.setTouchJump(held);
  }

  leave(): void {
    this.opts.onLeave();
  }

  worldId(): string {
    return this.opts.worldId;
  }

  isWorldOwner(): boolean {
    return this.isOwner;
  }

  listPlayers(): PlayerInfo[] {
    return [...this.players.values()].map((p) => p.info);
  }

  isMuted(uid: string): boolean {
    return this.muted.has(uid);
  }

  toggleMute(uid: string): void {
    if (this.muted.has(uid)) this.muted.delete(uid);
    else this.muted.add(uid);
    this.refreshPlayerList();
  }

  kickPlayer(id: number): void {
    this.send({ t: 'kick', id });
  }

  private refreshPlayerList(): void {
    this.hud.refreshPlayers(this.opts.username);
  }

  // --- Frame ---

  private readonly onResize = (): void => {
    this.scene?.resize();
  };

  private readonly frame = (now: number): void => {
    if (this.disposed || !this.scene || !this.world) return;
    this.rafId = requestAnimationFrame(this.frame);
    const elapsed = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;
    this.time += elapsed;

    this.fpsFrames++;
    this.fpsTime += elapsed;
    if (this.fpsTime >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
      this.hud.setStats(this.fps, this.rtt);
    }

    if (this.ready) {
      this.accumulator += elapsed;
      let steps = 0;
      while (this.accumulator >= DT && steps < MAX_FRAME_STEPS) {
        this.fixedStep();
        this.accumulator -= DT;
        steps++;
      }
      if (steps === MAX_FRAME_STEPS) this.accumulator = 0;
    }

    this.renderFrame(elapsed);
  };

  private fixedStep(): void {
    if (!this.input || !this.world) return;
    const sample = this.input.sample();
    const input: MoveInput = { fwd: sample.fwd, strafe: sample.strafe, yaw: this.input.yaw, jump: sample.jump };
    copyPlayerState(this.predicted, this.previous);
    const vyBefore = this.predicted.vy;
    stepPlayer(this.predicted, input, this.world);

    const heading = headingForInput(input);
    if (heading !== null) this.myHeading = heading;

    if (this.wasGrounded && !this.predicted.grounded && this.predicted.vy > 0) play('jump');
    if (!this.wasGrounded && this.predicted.grounded && vyBefore < -6) play('land');
    if (this.predicted.vy > vyBefore + 12) play('bounce');
    this.wasGrounded = this.predicted.grounded;

    this.seq++;
    this.pending.push({ seq: this.seq, input });
    if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();
    this.send({
      t: 'i',
      s: this.seq,
      f: input.fwd,
      r: input.strafe,
      y: Math.round(input.yaw * 10000) / 10000,
      j: input.jump ? 1 : 0,
    });
  }

  private renderFrame(dt: number): void {
    const scene = this.scene!;
    const input = this.input!;
    const alpha = this.accumulator / DT;

    this.errorOffset.multiplyScalar(Math.exp(-dt * 12));
    const px = this.previous.x + (this.predicted.x - this.previous.x) * alpha + this.errorOffset.x;
    const py = this.previous.y + (this.predicted.y - this.previous.y) * alpha + this.errorOffset.y;
    const pz = this.previous.z + (this.predicted.z - this.previous.z) * alpha + this.errorOffset.z;

    if (this.myMesh) {
      this.myMesh.root.position.set(px, py, pz);
      this.myMesh.root.rotation.y = lerpAngle(this.myMesh.root.rotation.y, this.myHeading, 1 - Math.exp(-dt * 14));
      this.myMesh.animate(dt, {
        speed: Math.hypot(this.predicted.vx, this.predicted.vz),
        grounded: this.predicted.grounded,
        emote: this.myEmote,
        time: this.time,
        swing: this.mining !== null,
      });
      if (this.myBubble && this.time > this.myBubbleUntil) {
        disposeLabel(this.myBubble);
        this.myBubble = null;
      }
    }

    this.updateRemotePlayers(dt);
    this.updateCamera(dt, px, py, pz, input);
    this.updateTarget(px, py, pz);
    this.updateMining(dt);
    this.updateRemoteCracks();

    scene.updateChunks(this.focus, scene.pendingChunks > 12 ? 12 : 4);
    scene.render(this.time, this.focus);

    if (this.goalCount > 0) {
      const elapsed = this.runFinished ? null : performance.now() - this.runStart;
      this.hud.setTimer(elapsed, this.bestMs);
    } else {
      this.hud.setTimer(null, null);
    }
    this.hud.setCompass(`${Math.floor(this.predicted.x)}, ${Math.floor(this.predicted.y)}, ${Math.floor(this.predicted.z)}`);
  }

  private updateRemotePlayers(dt: number): void {
    if (this.tickOffset === null) return;
    const renderTick = performance.now() / TICK_MS + this.tickOffset - INTERP_DELAY_TICKS;
    for (const p of this.players.values()) {
      if (p.bubble && this.time > p.bubbleUntil) {
        disposeLabel(p.bubble);
        p.bubble = null;
      }
      const samples = p.samples;
      if (samples.length === 0) {
        p.mesh.root.visible = false;
        continue;
      }
      p.mesh.root.visible = true;
      while (samples.length >= 3 && samples[1].tick <= renderTick) samples.shift();
      const a = samples[0];
      const b = samples[1] ?? a;
      const span = b.tick - a.tick;
      const t = span > 0 ? Math.max(0, Math.min(1, (renderTick - a.tick) / span)) : 0;
      // A jump this big is a respawn, not movement.
      const teleporting = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 6;
      const x = teleporting ? b.x : a.x + (b.x - a.x) * t;
      const y = teleporting ? b.y : a.y + (b.y - a.y) * t;
      const z = teleporting ? b.z : a.z + (b.z - a.z) * t;
      const root = p.mesh.root;
      const speed = dt > 0 ? Math.hypot(x - p.lastX, z - p.lastZ) / dt : 0;
      p.lastX = x;
      p.lastZ = z;
      root.position.set(x, y, z);
      root.rotation.y = lerpAngle(root.rotation.y, b.heading, 1 - Math.exp(-dt * 14));
      p.mesh.animate(dt, { speed: Math.min(speed, 10), grounded: b.grounded, emote: b.emote, time: this.time, swing: this.remoteMining.has(p.info.id) });
    }
  }

  private updateCamera(dt: number, px: number, py: number, pz: number, input: InputController): void {
    const scene = this.scene!;
    const world = this.world!;
    const cam = scene.camera;
    const yaw = input.yaw;
    const pitch = input.pitch;
    this.lookDir.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));

    const firstPerson = this.zoom === 0;
    this.focus.set(px, py + (firstPerson ? PLAYER_EYE : PLAYER_HEIGHT - 0.1), pz);

    // Building looks over the shoulder, or the character would hide the very
    // block under the crosshair.
    const shoulder = this.buildMode && !firstPerson ? BUILD_SHOULDER_OFFSET : 0;
    this.shoulder += (shoulder - this.shoulder) * (1 - Math.exp(-dt * 8));
    const sideX = this.focus.x + Math.cos(yaw) * this.shoulder;
    const sideZ = this.focus.z - Math.sin(yaw) * this.shoulder;
    if (!world.isSolid(Math.floor(sideX), Math.floor(this.focus.y), Math.floor(sideZ))) {
      this.focus.x = sideX;
      this.focus.z = sideZ;
    }

    let dist = this.zoom;
    if (!firstPerson) {
      // Shorten the boom if a block sits between the player and the camera.
      const step = 0.12;
      for (let d = 0.3; d <= this.zoom; d += step) {
        const cx = this.focus.x - this.lookDir.x * d;
        const cy = this.focus.y - this.lookDir.y * d;
        const cz = this.focus.z - this.lookDir.z * d;
        if (world.isSolid(Math.floor(cx), Math.floor(cy), Math.floor(cz))) {
          dist = Math.max(0.4, d - 0.25);
          break;
        }
      }
    }
    // Pull in immediately to avoid clipping; ease back out.
    this.cameraDist = dist < this.cameraDist ? dist : this.cameraDist + (dist - this.cameraDist) * (1 - Math.exp(-dt * 6));

    cam.position.set(
      this.focus.x - this.lookDir.x * this.cameraDist,
      this.focus.y - this.lookDir.y * this.cameraDist,
      this.focus.z - this.lookDir.z * this.cameraDist,
    );
    cam.lookAt(this.focus.x + this.lookDir.x, this.focus.y + this.lookDir.y, this.focus.z + this.lookDir.z);
    if (this.shake > 0.005) {
      this.shake *= Math.exp(-dt * 7);
      cam.position.x += (Math.random() - 0.5) * this.shake;
      cam.position.y += (Math.random() - 0.5) * this.shake;
      cam.position.z += (Math.random() - 0.5) * this.shake;
    }
    this.myMesh?.setVisible(this.cameraDist > 1);
  }

  /** Finds the block under the crosshair by walking the view ray cell by cell. */
  private updateTarget(px: number, py: number, pz: number): void {
    const scene = this.scene!;
    if (!this.buildMode) {
      this.target = null;
      scene.highlight.visible = false;
      return;
    }
    const world = this.world!;
    const origin = scene.camera.position;
    const dir = this.lookDir;
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);
    const stepX = Math.sign(dir.x);
    const stepY = Math.sign(dir.y);
    const stepZ = Math.sign(dir.z);
    const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;
    let tMaxX = dir.x !== 0 ? (stepX > 0 ? x + 1 - origin.x : origin.x - x) * tDeltaX : Infinity;
    let tMaxY = dir.y !== 0 ? (stepY > 0 ? y + 1 - origin.y : origin.y - y) * tDeltaY : Infinity;
    let tMaxZ = dir.z !== 0 ? (stepZ > 0 ? z + 1 - origin.z : origin.z - z) * tDeltaZ : Infinity;
    let prevX = x;
    let prevY = y;
    let prevZ = z;
    const maxT = BUILD_REACH + this.cameraDist + 1;
    let t = 0;
    this.target = null;
    while (t <= maxT) {
      if (world.get(x, y, z) !== B.AIR) {
        const reach = Math.hypot(x + 0.5 - px, y + 0.5 - (py + PLAYER_EYE), z + 0.5 - pz);
        if (reach <= BUILD_REACH) this.target = { x, y, z, px: prevX, py: prevY, pz: prevZ };
        break;
      }
      prevX = x;
      prevY = y;
      prevZ = z;
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxZ) {
        y += stepY;
        t = tMaxY;
        tMaxY += tDeltaY;
      } else {
        z += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
      }
    }
    scene.highlight.visible = this.target !== null;
    if (this.target) scene.highlight.position.set(this.target.x + 0.5, this.target.y + 0.5, this.target.z + 0.5);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.ws?.close(1000);
    this.teardownWorld();
    this.hud.dispose();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
    delete (window as unknown as { __tinker?: () => unknown }).__tinker;
  }
}
