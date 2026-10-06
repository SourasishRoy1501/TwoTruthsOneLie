'use client';
import type { GameView } from './types';

export interface ApiOk {
  view: GameView;
  code: string;
  playerId?: string;
  token?: string;
}
export type ApiResult = { ok: true; data: ApiOk } | { ok: false; status: number; error: string };

export async function api(body: Record<string, unknown>): Promise<ApiResult> {
  try {
    const res = await fetch('/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: json.error ?? 'Something went wrong.' };
    return { ok: true, data: json as ApiOk };
  } catch {
    return { ok: false, status: 0, error: 'Cannot reach the server. Check your connection.' };
  }
}

export interface Session {
  pid: string;
  token: string;
}
// sessionStorage = one seat per browser TAB, so two tabs (or a host testing in a second tab)
// never share the same player. A refresh keeps the seat; rejoining by name works too.
const key = (code: string) => `ttl:session:${code}`;

export function loadSession(code: string): Session | null {
  try {
    const raw = sessionStorage.getItem(key(code));
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && typeof s.pid === 'string' && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
}
export function saveSession(code: string, s: Session) {
  try {
    sessionStorage.setItem(key(code), JSON.stringify(s));
  } catch {}
}
export function clearSession(code: string) {
  try {
    sessionStorage.removeItem(key(code));
  } catch {}
}
export function loadName(): string {
  try {
    return sessionStorage.getItem('ttl:name') ?? '';
  } catch {
    return '';
  }
}
export function saveName(n: string) {
  try {
    sessionStorage.setItem('ttl:name', n);
  } catch {}
}
