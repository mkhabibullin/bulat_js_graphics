export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  LOG: 5,
  PLANKS: 6,
  BRICK: 7,
  LEAVES: 8,
  GLASS: 9,
  SNOW: 10,
  METAL: 11,
  RED: 12,
  ORANGE: 13,
  YELLOW: 14,
  GREEN: 15,
  BLUE: 16,
  PURPLE: 17,
  PINK: 18,
  WHITE: 19,
  BLACK: 20,
  ICE: 21,
  BOUNCE: 22,
  LAVA: 23,
  CHECKPOINT: 24,
  GOAL: 25,
  SPAWN: 26,
  COIN: 27,
  TNT: 28,
} as const;

export type Pattern =
  | 'speckle'
  | 'grass'
  | 'log'
  | 'planks'
  | 'brick'
  | 'leaves'
  | 'glass'
  | 'metal'
  | 'tile'
  | 'ice'
  | 'bounce'
  | 'lava'
  | 'checkpoint'
  | 'goal'
  | 'spawn'
  | 'tnt'
  | 'none';

export type RenderBucket = 'opaque' | 'transparent' | 'glow' | 'none';

export interface BlockDef {
  id: number;
  name: string;
  /** Representative colour, also used in the world thumbnails. */
  color: number;
  /** Used on the side faces when different from the top. */
  sideColor?: number;
  pattern: Pattern;
  solid: boolean;
  bucket: RenderBucket;
  /** Gameplay blocks are owner-only, so visitors can't grief or farm a world. */
  ownerOnly: boolean;
  /** Seconds of mining needed to break it. */
  breakTime: number;
  description?: string;
}

function def(
  id: number,
  name: string,
  color: number,
  pattern: Pattern,
  extra: Partial<BlockDef> = {},
): BlockDef {
  return { id, name, color, pattern, solid: true, bucket: 'opaque', ownerOnly: false, breakTime: 0.6, ...extra };
}

export const BLOCKS: BlockDef[] = [
  def(B.AIR, 'Air', 0, 'none', { solid: false, bucket: 'none' }),
  def(B.GRASS, 'Grass', 0x6cc04a, 'grass', { sideColor: 0x8a6240, breakTime: 0.45 }),
  def(B.DIRT, 'Dirt', 0x8a6240, 'speckle', { breakTime: 0.4 }),
  def(B.STONE, 'Stone', 0x8d939a, 'speckle', { breakTime: 1 }),
  def(B.SAND, 'Sand', 0xeed9a0, 'speckle', { breakTime: 0.35 }),
  def(B.LOG, 'Log', 0x7a5230, 'log', { breakTime: 0.8 }),
  def(B.PLANKS, 'Planks', 0xc08f55, 'planks', { breakTime: 0.7 }),
  def(B.BRICK, 'Brick', 0xb5533c, 'brick', { breakTime: 1.1 }),
  def(B.LEAVES, 'Leaves', 0x3f9a4a, 'leaves', { breakTime: 0.2 }),
  def(B.GLASS, 'Glass', 0xbfe8f5, 'glass', { bucket: 'transparent', breakTime: 0.25 }),
  def(B.SNOW, 'Snow', 0xf3f8fc, 'speckle', { breakTime: 0.2 }),
  def(B.METAL, 'Metal', 0xb4bcc6, 'metal', { breakTime: 1.5 }),
  def(B.RED, 'Red', 0xe5484d, 'tile'),
  def(B.ORANGE, 'Orange', 0xf5873b, 'tile'),
  def(B.YELLOW, 'Yellow', 0xf8cf3f, 'tile'),
  def(B.GREEN, 'Green', 0x46b866, 'tile'),
  def(B.BLUE, 'Blue', 0x3f8cf0, 'tile'),
  def(B.PURPLE, 'Purple', 0x8e5be8, 'tile'),
  def(B.PINK, 'Pink', 0xf07fb6, 'tile'),
  def(B.WHITE, 'White', 0xe9edf0, 'tile'),
  def(B.BLACK, 'Black', 0x2f3238, 'tile'),
  def(B.ICE, 'Ice', 0xa4dcf7, 'ice', { description: 'Slippery underfoot', ownerOnly: true, breakTime: 0.3 }),
  def(B.BOUNCE, 'Bounce pad', 0x38e0a8, 'bounce', {
    bucket: 'glow',
    ownerOnly: true,
    description: 'Launches players upward',
  }),
  def(B.LAVA, 'Lava', 0xff5a1f, 'lava', {
    bucket: 'glow',
    ownerOnly: true,
    description: 'Sends players back to their checkpoint',
  }),
  def(B.CHECKPOINT, 'Checkpoint', 0x4fb6ff, 'checkpoint', {
    bucket: 'glow',
    ownerOnly: true,
    description: 'Saves the respawn point',
  }),
  def(B.GOAL, 'Goal', 0xfff1a8, 'goal', {
    bucket: 'glow',
    ownerOnly: true,
    description: 'Ends the run and records the time',
  }),
  def(B.SPAWN, 'Spawn', 0xd9f7e0, 'spawn', {
    bucket: 'glow',
    ownerOnly: true,
    description: 'Players start here',
  }),
  def(B.COIN, 'Coin', 0xffc93c, 'none', {
    solid: false,
    bucket: 'none',
    ownerOnly: true,
    breakTime: 0.05,
    description: 'Collectable coin',
  }),
  def(B.TNT, 'TNT', 0xd8392f, 'tnt', {
    breakTime: 0.15,
    description: 'Right-click to light it. Breaking it first defuses it.',
  }),
];

export const BLOCK_COUNT = BLOCKS.length;

const SOLID = new Uint8Array(256);
for (const b of BLOCKS) SOLID[b.id] = b.solid ? 1 : 0;

export function isSolidBlock(id: number): boolean {
  return SOLID[id] === 1;
}

export function isValidBlockId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < BLOCK_COUNT;
}

/** Blocks shown in the build palette, in display order. */
export const PALETTE: number[] = BLOCKS.filter((b) => b.id !== B.AIR).map((b) => b.id);
