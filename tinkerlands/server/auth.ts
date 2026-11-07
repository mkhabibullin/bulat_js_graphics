import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 128 * N * R * 2;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, length, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[5], 'base64url');
  const key = await derive(
    password,
    Buffer.from(parts[4], 'base64url'),
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3]),
    expected.length,
  );
  return timingSafeEqual(key, expected);
}

/** Hash checked when a username doesn't exist, so both cases take the same time. */
export const dummyPasswordHash: Promise<string> = hashPassword(randomBytes(16).toString('hex'));

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Sessions are stored hashed, so a database leak doesn't expose live tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function newId(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
