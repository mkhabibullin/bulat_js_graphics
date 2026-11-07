import * as THREE from 'three';
import { BLOCKS, type BlockDef } from '../../shared/blocks.ts';

export const TILE = 48;
const PAD = 4;
const CELL = TILE + PAD * 2;
const COLUMNS = 8;

export interface AtlasInfo {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  /** UV rect per block id: top, side, bottom faces. Each is [u0, v0, u1, v1]. */
  uv: { top: number[]; side: number[]; bottom: number[] }[];
  /** Canvas pixel position of each block's side tile, for hotbar icons. */
  icon: { x: number; y: number }[];
  size: number;
}

function css(color: number, alpha = 1): string {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function mix(color: number, target: number, t: number): number {
  const ch = (shift: number): number => {
    const a = (color >> shift) & 255;
    const b = (target >> shift) & 255;
    return Math.round(a + (b - a) * t);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Deterministic noise so that the art is identical on every machine. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function speckle(g: CanvasRenderingContext2D, color: number, seed: number, amount = 90, size = 3): void {
  const random = rng(seed);
  for (let i = 0; i < amount; i++) {
    const t = random() * 0.16;
    g.fillStyle = css(mix(color, random() > 0.5 ? 0xffffff : 0x000000, t));
    g.fillRect(Math.floor(random() * TILE), Math.floor(random() * TILE), size, size);
  }
}

function bevel(g: CanvasRenderingContext2D, strength = 0.14): void {
  g.fillStyle = `rgba(255,255,255,${strength})`;
  g.fillRect(0, 0, TILE, 2);
  g.fillRect(0, 0, 2, TILE);
  g.fillStyle = `rgba(0,0,0,${strength})`;
  g.fillRect(0, TILE - 2, TILE, 2);
  g.fillRect(TILE - 2, 0, 2, TILE);
}

function drawPattern(g: CanvasRenderingContext2D, def: BlockDef, face: 'top' | 'side' | 'bottom'): void {
  const color = def.color;
  g.clearRect(0, 0, TILE, TILE);
  switch (def.pattern) {
    case 'grass': {
      if (face === 'top') {
        g.fillStyle = css(color);
        g.fillRect(0, 0, TILE, TILE);
        speckle(g, color, 11, 120, 3);
      } else {
        const dirt = def.sideColor ?? color;
        g.fillStyle = css(dirt);
        g.fillRect(0, 0, TILE, TILE);
        speckle(g, dirt, 12);
        if (face === 'side') {
          g.fillStyle = css(color);
          const random = rng(13);
          for (let x = 0; x < TILE; x += 6) {
            g.fillRect(x, 0, 6, 9 + Math.floor(random() * 8));
          }
        }
      }
      break;
    }
    case 'log': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      if (face === 'side') {
        for (let x = 3; x < TILE; x += 9) {
          g.fillStyle = css(mix(color, 0x000000, 0.2));
          g.fillRect(x, 0, 3, TILE);
        }
      } else {
        g.fillStyle = css(mix(color, 0xffffff, 0.35));
        g.fillRect(6, 6, TILE - 12, TILE - 12);
        g.fillStyle = css(mix(color, 0x000000, 0.1));
        g.fillRect(14, 14, TILE - 28, TILE - 28);
      }
      break;
    }
    case 'planks': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      for (let y = 0; y < TILE; y += 12) {
        g.fillStyle = css(mix(color, 0x000000, 0.28));
        g.fillRect(0, y + 10, TILE, 2);
        g.fillRect(y % 24 === 0 ? 14 : 34, y, 2, 10);
      }
      speckle(g, color, 21, 24, 2);
      break;
    }
    case 'brick': {
      g.fillStyle = css(mix(color, 0xffffff, 0.45));
      g.fillRect(0, 0, TILE, TILE);
      g.fillStyle = css(color);
      for (let row = 0; row < 4; row++) {
        const offset = row % 2 === 0 ? 0 : -12;
        for (let col = 0; col < 3; col++) {
          g.fillRect(offset + col * 24 + 1, row * 12 + 1, 22, 10);
        }
      }
      break;
    }
    case 'leaves': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      speckle(g, color, 31, 170, 4);
      break;
    }
    case 'glass': {
      g.fillStyle = css(color, 0.28);
      g.fillRect(0, 0, TILE, TILE);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 3;
      g.strokeRect(1.5, 1.5, TILE - 3, TILE - 3);
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.beginPath();
      g.moveTo(10, 30);
      g.lineTo(30, 10);
      g.lineTo(36, 10);
      g.lineTo(10, 36);
      g.fill();
      return;
    }
    case 'metal': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      g.fillStyle = css(mix(color, 0x000000, 0.35));
      for (const [x, y] of [[6, 6], [TILE - 10, 6], [6, TILE - 10], [TILE - 10, TILE - 10]]) {
        g.fillRect(x, y, 4, 4);
      }
      bevel(g, 0.25);
      return;
    }
    case 'tile': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fillRect(4, 4, TILE - 8, TILE - 8);
      bevel(g, 0.2);
      return;
    }
    case 'ice': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(4, 12);
      g.lineTo(18, 22);
      g.lineTo(14, 40);
      g.moveTo(18, 22);
      g.lineTo(40, 10);
      g.moveTo(26, 44);
      g.lineTo(44, 28);
      g.stroke();
      bevel(g, 0.2);
      return;
    }
    case 'bounce': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      if (face === 'top') {
        for (let i = 0; i < 2; i++) {
          const y = 8 + i * 15;
          g.beginPath();
          g.moveTo(24, y);
          g.lineTo(40, y + 15);
          g.lineTo(32, y + 15);
          g.lineTo(24, y + 7);
          g.lineTo(16, y + 15);
          g.lineTo(8, y + 15);
          g.fill();
        }
      } else {
        g.fillRect(0, 8, TILE, 4);
        g.fillRect(0, 36, TILE, 4);
      }
      bevel(g, 0.2);
      return;
    }
    case 'lava': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      const random = rng(41);
      for (let i = 0; i < 14; i++) {
        g.fillStyle = css(random() > 0.5 ? 0xffc23c : 0xc9310f, 0.9);
        const w = 5 + random() * 14;
        g.beginPath();
        g.ellipse(random() * TILE, random() * TILE, w, w * 0.55, random() * 3, 0, Math.PI * 2);
        g.fill();
      }
      return;
    }
    case 'checkpoint': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      g.fillStyle = 'rgba(255,255,255,0.95)';
      if (face === 'top') {
        g.fillRect(15, 8, 4, 32);
        g.beginPath();
        g.moveTo(19, 9);
        g.lineTo(37, 16);
        g.lineTo(19, 24);
        g.fill();
      }
      bevel(g, 0.2);
      return;
    }
    case 'goal': {
      const size = 12;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          g.fillStyle = (x + y) % 2 === 0 ? '#2a2c31' : '#fff7d6';
          g.fillRect(x * size, y * size, size, size);
        }
      }
      return;
    }
    case 'tnt': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      if (face === 'side') {
        for (let x = 6; x < TILE; x += 12) {
          g.fillStyle = css(mix(color, 0x000000, 0.22));
          g.fillRect(x, 0, 2, TILE);
        }
        g.fillStyle = '#f5efe0';
        g.fillRect(0, 15, TILE, 18);
        g.fillStyle = '#26262c';
        g.font = '700 16px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('TNT', TILE / 2, 25);
      } else if (face === 'top') {
        g.fillStyle = '#f5efe0';
        g.fillRect(8, 8, TILE - 16, TILE - 16);
        g.fillStyle = '#26262c';
        g.beginPath();
        g.arc(24, 24, 6, 0, Math.PI * 2);
        g.fill();
      }
      bevel(g, 0.18);
      return;
    }
    case 'spawn': {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      g.strokeStyle = '#2fae66';
      g.lineWidth = 4;
      g.beginPath();
      g.arc(24, 24, 13, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#2fae66';
      g.beginPath();
      g.arc(24, 24, 4, 0, Math.PI * 2);
      g.fill();
      bevel(g, 0.12);
      return;
    }
    default: {
      g.fillStyle = css(color);
      g.fillRect(0, 0, TILE, TILE);
      speckle(g, color, def.id * 7 + 3);
      break;
    }
  }
  bevel(g);
}

export function buildAtlas(): AtlasInfo {
  // Most blocks share one tile across all faces; only these differ by face.
  const perFace = (def: BlockDef): boolean => ['grass', 'log', 'bounce', 'checkpoint', 'tnt'].includes(def.pattern);
  let tiles = 0;
  for (const def of BLOCKS) tiles += perFace(def) ? 3 : 1;
  const rows = Math.ceil(tiles / COLUMNS);
  const size = Math.max(COLUMNS, rows) * CELL;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const tile = document.createElement('canvas');
  tile.width = TILE;
  tile.height = TILE;
  const tileCtx = tile.getContext('2d')!;

  let next = 0;
  const place = (def: BlockDef, face: 'top' | 'side' | 'bottom'): { uv: number[]; x: number; y: number } => {
    const col = next % COLUMNS;
    const row = Math.floor(next / COLUMNS);
    next++;
    const x = col * CELL + PAD;
    const y = row * CELL + PAD;
    drawPattern(tileCtx, def, face);
    // Repeat the edge pixels into the padding so mipmaps don't pick up neighbours.
    ctx.clearRect(x - PAD, y - PAD, CELL, CELL);
    ctx.drawImage(tile, 0, 0, TILE, 1, x, y - PAD, TILE, PAD);
    ctx.drawImage(tile, 0, TILE - 1, TILE, 1, x, y + TILE, TILE, PAD);
    ctx.drawImage(tile, 0, 0, 1, TILE, x - PAD, y, PAD, TILE);
    ctx.drawImage(tile, TILE - 1, 0, 1, TILE, x + TILE, y, PAD, TILE);
    ctx.drawImage(tile, x, y);
    return {
      uv: [x / size, 1 - (y + TILE) / size, (x + TILE) / size, 1 - y / size],
      x,
      y,
    };
  };

  const uv: AtlasInfo['uv'] = [];
  const icon: AtlasInfo['icon'] = [];
  for (const def of BLOCKS) {
    if (def.bucket === 'none') {
      const empty = [0, 0, 0, 0];
      uv[def.id] = { top: empty, side: empty, bottom: empty };
      icon[def.id] = { x: -1, y: -1 };
      continue;
    }
    if (perFace(def)) {
      const top = place(def, 'top');
      const side = place(def, 'side');
      const bottom = place(def, 'bottom');
      uv[def.id] = { top: top.uv, side: side.uv, bottom: bottom.uv };
      icon[def.id] = { x: top.x, y: top.y };
    } else {
      const all = place(def, 'side');
      uv[def.id] = { top: all.uv, side: all.uv, bottom: all.uv };
      icon[def.id] = { x: all.x, y: all.y };
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  return { canvas, texture, uv, icon, size };
}
