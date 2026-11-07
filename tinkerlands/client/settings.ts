export interface Settings {
  sensitivity: number;
  volume: number;
  invertY: boolean;
  quality: 'high' | 'low';
}

const KEY = 'tinkerlands.settings';
const DEFAULTS: Settings = { sensitivity: 1, volume: 0.6, invertY: false, quality: 'high' };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Blocked storage or a corrupt value: fall back to the defaults.
  }
  return { ...DEFAULTS };
}

export const settings: Settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Settings then apply to this session only.
  }
}
