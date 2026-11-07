export interface Avatar {
  skin: string;
  shirt: string;
  pants: string;
  face: string;
  hat: string;
}

export const FACES = ['smile', 'grin', 'wink', 'shades', 'robot', 'cat'] as const;

export interface HatDef {
  id: string;
  name: string;
  price: number;
}

export const HATS: HatDef[] = [
  { id: 'none', name: 'No hat', price: 0 },
  { id: 'cap', name: 'Ball cap', price: 25 },
  { id: 'flower', name: 'Daisy', price: 40 },
  { id: 'antenna', name: 'Antenna', price: 60 },
  { id: 'cone', name: 'Traffic cone', price: 90 },
  { id: 'tophat', name: 'Top hat', price: 120 },
  { id: 'propeller', name: 'Propeller', price: 180 },
  { id: 'wizard', name: 'Wizard hat', price: 250 },
  { id: 'halo', name: 'Halo', price: 350 },
  { id: 'crown', name: 'Crown', price: 500 },
];

export const SKIN_COLORS = ['#ffd9b3', '#f2bb8c', '#d9976a', '#a86b45', '#6e4530', '#f7e26b', '#9fe3c5', '#c9b6f2'];

export const CLOTH_COLORS = [
  '#e5484d', '#f5873b', '#f8cf3f', '#46b866', '#2fb5a8', '#3f8cf0', '#4a55c7',
  '#8e5be8', '#f07fb6', '#ffffff', '#8d939a', '#2f3238', '#7a5230',
];

export const DEFAULT_AVATAR: Readonly<Avatar> = {
  skin: '#ffd9b3',
  shirt: '#3f8cf0',
  pants: '#2f3238',
  face: 'smile',
  hat: 'none',
};

const COLOR_RE = /^#[0-9a-f]{6}$/;

/** A random but valid look for a new player, so guests don't all match. */
export function randomAvatar(random: () => number = Math.random): Avatar {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  return {
    skin: pick(SKIN_COLORS),
    shirt: pick(CLOTH_COLORS),
    pants: pick(CLOTH_COLORS),
    face: pick(FACES),
    hat: 'none',
  };
}

/** Returns a valid avatar from untrusted input, or null if any field is invalid. */
export function validateAvatar(value: unknown, ownedHats: readonly string[]): Avatar | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  for (const key of ['skin', 'shirt', 'pants'] as const) {
    if (typeof v[key] !== 'string' || !COLOR_RE.test(v[key])) return null;
  }
  if (typeof v.face !== 'string' || !(FACES as readonly string[]).includes(v.face)) return null;
  if (typeof v.hat !== 'string') return null;
  if (v.hat !== 'none' && !ownedHats.includes(v.hat)) return null;
  return {
    skin: v.skin as string,
    shirt: v.shirt as string,
    pants: v.pants as string,
    face: v.face,
    hat: v.hat,
  };
}
