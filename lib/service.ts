import { clock } from './clock';
import {
  ApiError,
  addPlayer,
  advance,
  authPlayer,
  buildView,
  createRoom,
  restartGame,
  skipPhase,
  skipTurn,
  startGame,
  submitGuess,
  submitStatements,
  updateSettings,
} from './engine';
import { getStore } from './store';
import type { GameView, Player, Room } from './types';

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ'; // no vowels -> no accidental words, no I/O confusion
const MAX_CAS_RETRIES = 12;
const TOUCH_EVERY_MS = 4000;

export function normalizeCode(raw: unknown): string {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 4) throw new ApiError(400, 'Room codes are 4 letters.');
  return code;
}

function randomCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

interface Auth {
  pid: unknown;
  token: unknown;
}

/**
 * Load -> (advance) -> mutate -> (advance) -> save, with optimistic concurrency.
 * If another request wrote first, we reload and re-run, so no update is ever lost.
 */
async function withRoom<T>(
  code: string,
  auth: Auth | null,
  mutate: (room: Room, now: number, actor: Player | null) => { changed: boolean; value: T },
): Promise<{ room: Room; value: T; now: number; actor: Player | null }> {
  const store = getStore();
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const rec = await store.get(code);
    if (!rec) throw new ApiError(404, 'Room not found. Check the code and try again.');
    const room = rec.state;
    const now = clock.now();

    let actor: Player | null = null;
    let prevSeen = 0;
    if (auth) {
      actor = authPlayer(room, auth.pid, auth.token);
      prevSeen = actor.lastSeen;
      actor.lastSeen = now; // in-memory; persisted via touch() or the write below
    }

    let changed = advance(room, now); // finish anything that is overdue first
    const m = mutate(room, now, actor);
    const value = m.value;
    changed = m.changed || changed;
    changed = advance(room, now) || changed; // then apply early-finish rules

    if (changed) {
      const ok = await store.cas(code, rec.version, room);
      if (!ok) continue; // lost the race: reload and redo
    }
    if (actor && now - prevSeen > TOUCH_EVERY_MS && !changed) {
      const ok = await store.touch(code, actor.id, now);
      // fallback: save presence via a normal write (silent: must NOT ping everyone, or polls would loop)
      if (!ok) await store.cas(code, rec.version, room, { silent: true }).catch(() => false);
    }
    return { room, value, now, actor };
  }
  throw new ApiError(503, 'The room is busy. Please try again.');
}

export interface OpResult {
  view: GameView;
  code: string;
  playerId?: string;
  token?: string;
}

function result(room: Room, actor: Player, now: number, extra: Partial<OpResult> = {}): OpResult {
  return { view: buildView(room, actor.id, now), code: room.code, ...extra };
}

export async function handleOp(body: unknown): Promise<OpResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const op = String(b.op ?? '');

  if (op === 'create') {
    const store = getStore();
    for (let i = 0; i < 25; i++) {
      const code = randomCode();
      const now = clock.now();
      const { room, player } = createRoom(code, b.name, now);
      if (await store.create(code, room)) {
        return result(room, player, now, { playerId: player.id, token: player.token });
      }
    }
    throw new ApiError(503, 'Could not create a room. Please try again.');
  }

  const code = normalizeCode(b.code);

  if (op === 'join') {
    const { room, now, value: player } = await withRoom(code, null, (room, now) => ({
      changed: true,
      value: addPlayer(room, b.name, now, b.pid as string | undefined, b.token as string | undefined),
    }));
    return result(room, player, now, { playerId: player.id, token: player.token });
  }

  const auth: Auth = { pid: b.pid, token: b.token };
  const run = async (fn: (room: Room, now: number, actor: Player) => void, changes = true) => {
    const { room, now, actor } = await withRoom(code, auth, (room, now, actor) => {
      fn(room, now, actor!);
      return { changed: changes, value: undefined };
    });
    return result(room, actor!, now);
  };

  switch (op) {
    case 'state':
      return run(() => {}, false);
    case 'settings':
      return run((room, _now, p) => {
        updateSettings(room, p, b.settings);
      });
    case 'start':
      return run((room, now, p) => {
        startGame(room, p, now);
      });
    case 'submit':
      return run((room, _now, p) => {
        submitStatements(room, p, b.statements, b.lieIndex);
      });
    case 'guess':
      return run((room, _now, p) => {
        submitGuess(room, p, b.guess);
      });
    case 'skip':
      return run((room, now, p) => {
        skipPhase(room, p, now);
      });
    case 'skipset':
      return run((room, now, p) => {
        skipTurn(room, p, now);
      });
    case 'restart':
      return run((room, _now, p) => {
        restartGame(room, p);
      });
    default:
      throw new ApiError(400, 'Unknown action.');
  }
}