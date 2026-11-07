import type { Avatar } from '../shared/avatar.ts';

export interface User {
  id: string;
  username: string;
  guest: boolean;
  coins: number;
  avatar: Avatar;
  ownedHats: string[];
}

export interface WorldSummary {
  id: string;
  name: string;
  description: string;
  template: string;
  ownerId: string | null;
  ownerName: string | null;
  isPublic: boolean;
  buildMode: 'owner' | 'everyone';
  visits: number;
  likes: number;
  featured: boolean;
  online: number;
  updatedAt: number;
}

export interface WorldDetail {
  world: WorldSummary;
  liked: boolean;
  leaderboard: { username: string; ms: number; runs: number }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'tinkerlands.token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token: string | null = readToken();

export function getToken(): string | null {
  return token;
}

export function setToken(next: string | null): void {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be blocked; the session then lasts until the tab closes.
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', 'Can’t reach the server. Check your connection.');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong.');
  }
  return data as T;
}

interface AuthResult {
  token: string;
  user: User;
}

export const api = {
  guest: () => request<AuthResult>('POST', '/api/auth/guest'),
  register: (username: string, password: string) => request<AuthResult>('POST', '/api/auth/register', { username, password }),
  login: (username: string, password: string) => request<AuthResult>('POST', '/api/auth/login', { username, password }),
  logout: () => request<unknown>('POST', '/api/auth/logout'),
  me: () => request<{ user: User }>('GET', '/api/me'),
  saveAvatar: (avatar: Avatar) => request<{ user: User }>('PUT', '/api/me/avatar', { avatar }),
  buy: (itemId: string) => request<{ user: User }>('POST', '/api/shop/buy', { itemId }),
  worlds: (sort: string, q: string) =>
    request<{ worlds: WorldSummary[] }>('GET', `/api/worlds?sort=${encodeURIComponent(sort)}&q=${encodeURIComponent(q)}`),
  myWorlds: () => request<{ worlds: WorldSummary[] }>('GET', '/api/worlds/mine'),
  world: (id: string) => request<WorldDetail>('GET', `/api/worlds/${encodeURIComponent(id)}`),
  createWorld: (input: { name: string; description: string; template: string; buildMode: string; isPublic: boolean }) =>
    request<{ world: WorldSummary }>('POST', '/api/worlds', input),
  updateWorld: (id: string, input: Record<string, unknown>) =>
    request<{ world: WorldSummary }>('PATCH', `/api/worlds/${encodeURIComponent(id)}`, input),
  deleteWorld: (id: string) => request<unknown>('DELETE', `/api/worlds/${encodeURIComponent(id)}`),
  like: (id: string) => request<{ liked: boolean; likes: number }>('POST', `/api/worlds/${encodeURIComponent(id)}/like`),
  report: (input: { worldId?: string; targetUserId?: string; reason: string }) => request<unknown>('POST', '/api/reports', input),
};
