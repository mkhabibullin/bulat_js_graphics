import { settings } from '../settings.ts';

export type Sound = 'jump' | 'land' | 'coin' | 'checkpoint' | 'finish' | 'die' | 'place' | 'hit' | 'break' | 'chat' | 'bounce' | 'fuse' | 'boom';

interface Note {
  freq: number;
  to?: number;
  at: number;
  len: number;
  type?: OscillatorType;
  gain?: number;
}

const SOUNDS: Record<Sound, Note[]> = {
  jump: [{ freq: 320, to: 560, at: 0, len: 0.12, type: 'triangle', gain: 0.35 }],
  land: [{ freq: 140, to: 70, at: 0, len: 0.07, type: 'triangle', gain: 0.3 }],
  bounce: [{ freq: 220, to: 900, at: 0, len: 0.22, type: 'sine', gain: 0.45 }],
  coin: [
    { freq: 988, at: 0, len: 0.07, type: 'square', gain: 0.14 },
    { freq: 1319, at: 0.07, len: 0.16, type: 'square', gain: 0.14 },
  ],
  checkpoint: [
    { freq: 523, at: 0, len: 0.1, type: 'triangle', gain: 0.4 },
    { freq: 659, at: 0.09, len: 0.1, type: 'triangle', gain: 0.4 },
    { freq: 784, at: 0.18, len: 0.2, type: 'triangle', gain: 0.4 },
  ],
  finish: [
    { freq: 523, at: 0, len: 0.12, type: 'square', gain: 0.16 },
    { freq: 659, at: 0.12, len: 0.12, type: 'square', gain: 0.16 },
    { freq: 784, at: 0.24, len: 0.12, type: 'square', gain: 0.16 },
    { freq: 1047, at: 0.36, len: 0.4, type: 'square', gain: 0.18 },
  ],
  die: [{ freq: 420, to: 90, at: 0, len: 0.3, type: 'sawtooth', gain: 0.16 }],
  place: [{ freq: 240, to: 180, at: 0, len: 0.06, type: 'square', gain: 0.12 }],
  fuse: [
    { freq: 2400, to: 3200, at: 0, len: 0.12, type: 'sawtooth', gain: 0.05 },
    { freq: 2800, to: 2200, at: 0.12, len: 0.2, type: 'sawtooth', gain: 0.04 },
  ],
  boom: [
    { freq: 150, to: 28, at: 0, len: 0.7, type: 'sawtooth', gain: 0.55 },
    { freq: 80, to: 22, at: 0, len: 0.9, type: 'square', gain: 0.35 },
    { freq: 900, to: 90, at: 0, len: 0.2, type: 'sawtooth', gain: 0.18 },
  ],
  hit: [{ freq: 210, to: 130, at: 0, len: 0.05, type: 'square', gain: 0.07 }],
  break: [
    { freq: 190, to: 70, at: 0, len: 0.14, type: 'sawtooth', gain: 0.18 },
    { freq: 420, to: 150, at: 0.01, len: 0.1, type: 'square', gain: 0.08 },
  ],
  chat: [{ freq: 880, at: 0, len: 0.05, type: 'sine', gain: 0.12 }],
};

let context: AudioContext | null = null;

/** Browsers only allow audio after a user gesture, so it starts on first input. */
export function unlockAudio(): void {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
  } catch {
    context = null; // Audio unavailable: the game simply plays silently.
  }
}

export function play(sound: Sound): void {
  if (!context || context.state !== 'running' || settings.volume <= 0) return;
  const now = context.currentTime;
  for (const note of SOUNDS[sound]) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = note.type ?? 'sine';
    osc.frequency.setValueAtTime(note.freq, now + note.at);
    if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, now + note.at + note.len);
    const peak = (note.gain ?? 0.3) * settings.volume;
    gain.gain.setValueAtTime(peak, now + note.at);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.len);
    osc.connect(gain).connect(context.destination);
    osc.start(now + note.at);
    osc.stop(now + note.at + note.len + 0.02);
  }
}
