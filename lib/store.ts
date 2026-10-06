import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Room } from './types';

export interface Stored {
  state: Room;
  version: number;
}

export interface Store {
  get(code: string): Promise<Stored | null>;
  /** false if a live room with this code already exists */
  create(code: string, state: Room): Promise<boolean>;
  /**
   * compare-and-set on version; false if someone else wrote first.
   * On success every client in the room is pinged (instant refresh) unless `silent`.
   */
  cas(code: string, expectedVersion: number, state: Room, opts?: { silent?: boolean }): Promise<boolean>;
  /** cheap presence heartbeat; never bumps the version, never throws */
  touch(code: string, pid: string, ts: number): Promise<boolean>;
}

const STALE_ROOM_MS = 12 * 60 * 60 * 1000; // rooms idle for 12h can be recycled

/* ------------------------------ in-memory ------------------------------ */
/* Local development only. Does NOT work across serverless instances.       */

class MemoryStore implements Store {
  private rooms: Map<string, { state: string; version: number; updatedAt: number }>;
  constructor() {
    const g = globalThis as unknown as { __ttlRooms?: MemoryStore['rooms'] };
    this.rooms = g.__ttlRooms ??= new Map();
  }
  async get(code: string) {
    const r = this.rooms.get(code);
    return r ? { state: JSON.parse(r.state) as Room, version: r.version } : null;
  }
  async create(code: string, state: Room) {
    const r = this.rooms.get(code);
    if (r && Date.now() - r.updatedAt < STALE_ROOM_MS) return false;
    this.rooms.set(code, { state: JSON.stringify(state), version: 1, updatedAt: Date.now() });
    return true;
  }
  async cas(code: string, expected: number, state: Room, _opts?: { silent?: boolean }) {
    const r = this.rooms.get(code);
    if (!r || r.version !== expected) return false;
    this.rooms.set(code, { state: JSON.stringify(state), version: expected + 1, updatedAt: Date.now() });
    return true;
  }
  async touch(code: string, pid: string, ts: number) {
    const r = this.rooms.get(code);
    if (!r) return false;
    const s = JSON.parse(r.state) as Room;
    if (s.players[pid]) {
      s.players[pid].lastSeen = Math.max(s.players[pid].lastSeen, ts);
      r.state = JSON.stringify(s);
      r.updatedAt = Date.now();
    }
    return true;
  }
}

/* ------------------------------- Supabase ------------------------------- */

/**
 * Tell every browser in the room "something changed, fetch the latest state".
 * Uses the Supabase Realtime REST broadcast endpoint. The message carries NO game data
 * (clients still fetch their own private view from our API). Failures are harmless:
 * clients also poll, this only makes updates instant.
 */
async function pingRoom(url: string, key: string, code: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: key };
    if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [{ topic: `room:${code}`, event: 'tick', payload: { t: Date.now() }, private: false }] }),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) console.warn('[ttl] realtime ping failed:', res.status);
  } catch {
    /* ignore: polling is the fallback */
  } finally {
    clearTimeout(timer);
  }
}

class SupabaseStore implements Store {
  constructor(private sb: SupabaseClient, private url: string, private key: string) {}

  async get(code: string) {
    const { data, error } = await this.sb.from('rooms').select('state, version').eq('code', code).maybeSingle();
    if (error) throw error;
    return data ? { state: data.state as Room, version: data.version as number } : null;
  }

  async create(code: string, state: Room) {
    const ins = await this.sb.from('rooms').insert({ code, state, version: 1 });
    if (!ins.error) return true;
    if (ins.error.code !== '23505') throw ins.error; // not a duplicate-key error
    // Code already used: recycle it only if the old room is stale.
    const cutoff = new Date(Date.now() - STALE_ROOM_MS).toISOString();
    const del = await this.sb.from('rooms').delete().eq('code', code).lt('updated_at', cutoff).select('code');
    if (del.error) throw del.error;
    if (!del.data || del.data.length === 0) return false;
    const again = await this.sb.from('rooms').insert({ code, state, version: 1 });
    return !again.error;
  }

  async cas(code: string, expected: number, state: Room, opts?: { silent?: boolean }) {
    const { data, error } = await this.sb
      .from('rooms')
      .update({ state, version: expected + 1, updated_at: new Date().toISOString() })
      .eq('code', code)
      .eq('version', expected)
      .select('code');
    if (error) throw error;
    const ok = !!data && data.length === 1;
    if (ok && !opts?.silent) await pingRoom(this.url, this.key, code);
    return ok;
  }

  async touch(code: string, pid: string, ts: number): Promise<boolean> {
    try {
      const { error } = await this.sb.rpc('touch_player', { p_code: code, p_pid: pid, p_ts: ts });
      if (error) {
        console.error('touch_player failed:', error.message);
        return false;
      }
      return true;
    } catch (e) {
      console.error('touch_player threw:', e);
      return false;
    }
  }
}

/* -------------------------------- factory -------------------------------- */

let singleton: Store | null = null;

export function getStore(): Store {
  if (singleton) return singleton;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Never let Next.js cache database reads.
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
    });
    singleton = new SupabaseStore(sb, url, key);
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in production.');
    }
    console.warn('[ttl] Supabase env vars not set - using in-memory store (local dev only).');
    singleton = new MemoryStore();
  }
  return singleton;
}

/** For tests */
export function useStore(store: Store) {
  singleton = store;
}
export { MemoryStore };