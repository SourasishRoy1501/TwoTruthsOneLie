import { randomBytes } from 'crypto';
import type { GameView, Phase, Player, PlayerView, Room, Settings, Submission } from './types';

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/*                                                                     */
/*   lobby -> writing -> [ guessing -> reveal ] x (one per player) -> finished
/*                                                                     */
/*  - Everyone (host included) writes two truths and a lie ONCE.       */
/*  - Then there is one round per player: that player's three          */
/*    statements are shown, everyone else guesses the lie.             */
/*  - Rounds go in join order, so the host's set is round 1.           */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  maxPlayers: 20,
  nameMax: 20,
  statementMax: 160,
  writeSeconds: [20, 600] as const,
  guessSeconds: [10, 180] as const,
};

export const DEFAULT_SETTINGS: Settings = { writeSeconds: 90, guessSeconds: 30 };

/** how long the answer + points + scoreboard are shown after each round */
export const REVEAL_MS = 12000;
/** shown as "online" in the player list */
export const CONNECTED_MS = 12000;
/** only used to hand host controls to someone else when the host has been gone this long */
export const ACTIVE_MS = 150000;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const rid = (bytes: number) => randomBytes(bytes).toString('hex');

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const isConnected = (p: Player, now: number) => now - p.lastSeen < CONNECTED_MS;
export const isActive = (p: Player, now: number) => now - p.lastSeen < ACTIVE_MS;

export const sortedPlayers = (room: Room): Player[] =>
  Object.values(room.players).sort((a, b) => a.order - b.order);

function intIn(v: unknown, [min, max]: readonly [number, number], label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, `${label} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

export function parseSettings(input: unknown): Settings {
  const s = (input ?? {}) as Record<string, unknown>;
  return {
    writeSeconds: intIn(s.writeSeconds, LIMITS.writeSeconds, 'Writing time'),
    guessSeconds: intIn(s.guessSeconds, LIMITS.guessSeconds, 'Guessing time'),
  };
}

export function cleanName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.nameMax);
  if (!name) throw new ApiError(400, 'Enter your name to join.');
  return name;
}

function setTimer(room: Room, now: number, ms: number) {
  room.deadline = now + ms;
  room.phaseMs = ms;
}

function clearTimer(room: Room) {
  room.deadline = null;
  room.phaseMs = 0;
}

function newPlayer(name: string, now: number, order: number): Player {
  return { id: rid(4), token: rid(24), name, joinedAt: now, order, lastSeen: now, score: 0 };
}

/* ------------------------------------------------------------------ */
/* Room lifecycle                                                      */
/* ------------------------------------------------------------------ */

export function createRoom(code: string, rawName: unknown, now: number): { room: Room; player: Player } {
  const player = newPlayer(cleanName(rawName), now, 0);
  const room: Room = {
    code,
    settings: { ...DEFAULT_SETTINGS },
    phase: 'lobby',
    deadline: null,
    phaseMs: 0,
    hostId: player.id,
    players: { [player.id]: player },
    submissions: {},
    turns: [],
    turnIndex: 0,
    guesses: {},
    reveal: null,
    createdAt: now,
  };
  return { room, player };
}

/**
 * Join (or re-join) a room.
 *  - valid pid+token  -> resumes the same player
 *  - same name as a player who is currently offline -> reclaims that player
 */
export function addPlayer(room: Room, rawName: unknown, now: number, pid?: string, token?: string): Player {
  if (pid && token) {
    const existing = room.players[pid];
    if (existing && existing.token === token) {
      existing.lastSeen = now;
      return existing;
    }
  }
  const name = cleanName(rawName);
  const sameName = sortedPlayers(room).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (sameName) {
    if (isConnected(sameName, now)) {
      throw new ApiError(409, 'That name is already taken in this room. Pick a different name.');
    }
    sameName.lastSeen = now;
    return sameName;
  }
  if (Object.keys(room.players).length >= LIMITS.maxPlayers) {
    throw new ApiError(409, 'This room is full.');
  }
  const p = newPlayer(name, now, Object.keys(room.players).length); // players are never removed, so this is unique
  room.players[p.id] = p;
  return p;
}

export function authPlayer(room: Room, pid: unknown, token: unknown): Player {
  const p = typeof pid === 'string' ? room.players[pid] : undefined;
  if (!p || typeof token !== 'string' || p.token !== token) {
    throw new ApiError(401, 'Your session for this room was not found. Please rejoin.');
  }
  return p;
}

function requireHost(room: Room, p: Player) {
  if (room.hostId !== p.id) throw new ApiError(403, 'Only the host can do that.');
}

/* ------------------------------------------------------------------ */
/* Phase transitions                                                   */
/* ------------------------------------------------------------------ */

function startWriting(room: Room, now: number) {
  room.phase = 'writing';
  room.submissions = {};
  room.turns = [];
  room.turnIndex = 0;
  room.guesses = {};
  room.reveal = null;
  setTimer(room, now, room.settings.writeSeconds * 1000);
}

function startTurn(room: Room, now: number, index: number) {
  room.phase = 'guessing';
  room.turnIndex = index;
  room.guesses = {};
  room.reveal = null;
  setTimer(room, now, room.settings.guessSeconds * 1000);
}

function finishGame(room: Room) {
  room.phase = 'finished';
  room.reveal = null;
  room.guesses = {};
  clearTimer(room);
}

/** Writing is over: build one round per player who submitted (join order, host first). */
function beginRounds(room: Room, now: number) {
  room.turns = sortedPlayers(room)
    .filter((p) => room.submissions[p.id])
    .map((p) => {
      const s = room.submissions[p.id];
      const order = shuffle([0, 1, 2]); // shuffle the three statements so the lie isn't always in the same slot
      return {
        authorId: p.id,
        statements: order.map((i) => s.statements[i]),
        lieIndex: order.indexOf(s.lieIndex),
      };
    });
  if (room.turns.length === 0) finishGame(room);
  else startTurn(room, now, 0);
}

function resolveTurn(room: Room, now: number) {
  const turn = room.turns[room.turnIndex];
  const author = room.players[turn.authorId];
  const deltas: Record<string, number> = {};
  const results = [] as { playerId: string; guess: number | null; correct: boolean }[];

  for (const p of sortedPlayers(room)) {
    if (p.id === turn.authorId) continue;
    const g = room.guesses[p.id];
    if (g === undefined) {
      results.push({ playerId: p.id, guess: null, correct: false });
      continue;
    }
    const correct = g === turn.lieIndex;
    if (correct) {
      p.score += 1; // +1 for spotting the lie
      deltas[p.id] = (deltas[p.id] ?? 0) + 1;
    } else {
      author.score += 1; // +1 to the author for every player fooled
      deltas[author.id] = (deltas[author.id] ?? 0) + 1;
    }
    results.push({ playerId: p.id, guess: g, correct });
  }
  room.reveal = { results, deltas };
  room.phase = 'reveal';
  setTimer(room, now, REVEAL_MS);
}

function nextTurnOrFinish(room: Room, now: number) {
  if (room.turnIndex + 1 < room.turns.length) startTurn(room, now, room.turnIndex + 1);
  else finishGame(room);
}

/**
 * Moves the game forward if it is due. Called on EVERY request (lazy clock), so
 * the game keeps going no matter who is or isn't connected, and any single
 * client can drive it. Does at most one transition and is safe to call twice.
 * Returns true if the room was modified.
 */
export function advance(room: Room, now: number): boolean {
  let changed = false;

  // Host gone for a long time? Hand the controls to the longest-standing active player.
  const host = room.players[room.hostId];
  if (!host || !isActive(host, now)) {
    const next = sortedPlayers(room).find((p) => isActive(p, now));
    if (next && next.id !== room.hostId) {
      room.hostId = next.id;
      changed = true;
    }
  }

  const expired = room.deadline !== null && now >= room.deadline;

  switch (room.phase) {
    case 'writing': {
      // starts as soon as EVERY player has submitted (or the timer / host ends writing)
      const everyone = sortedPlayers(room);
      const allIn = everyone.length > 0 && everyone.every((p) => room.submissions[p.id]);
      if (expired || allIn) {
        beginRounds(room, now);
        changed = true;
      }
      break;
    }
    case 'guessing': {
      // ends as soon as EVERY player except the author has voted (or the timer / host ends voting)
      const turn = room.turns[room.turnIndex];
      const voters = sortedPlayers(room).filter((p) => p.id !== turn.authorId);
      const allVoted = voters.length > 0 && voters.every((p) => room.guesses[p.id] !== undefined);
      if (expired || allVoted) {
        resolveTurn(room, now);
        changed = true;
      }
      break;
    }
    case 'reveal': {
      if (expired) {
        nextTurnOrFinish(room, now);
        changed = true;
      }
      break;
    }
    default:
      break;
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* Player actions                                                      */
/* ------------------------------------------------------------------ */

export function startGame(room: Room, p: Player, now: number) {
  requireHost(room, p);
  if (room.phase !== 'lobby') throw new ApiError(409, 'The game has already started.');
  if (Object.keys(room.players).length < 2) throw new ApiError(409, 'You need at least 2 players to start.');
  for (const pl of Object.values(room.players)) pl.score = 0;
  startWriting(room, now);
}

export function updateSettings(room: Room, p: Player, input: unknown) {
  requireHost(room, p);
  if (room.phase !== 'lobby') throw new ApiError(409, 'Settings can only be changed before the game starts.');
  room.settings = parseSettings(input);
}

export function submitStatements(room: Room, p: Player, rawStatements: unknown, rawLie: unknown) {
  if (room.phase !== 'writing') throw new ApiError(409, 'Writing time is over.');
  if (!Array.isArray(rawStatements) || rawStatements.length !== 3) {
    throw new ApiError(400, 'Write exactly three statements.');
  }
  const statements = rawStatements.map((s) => String(s ?? '').replace(/\s+/g, ' ').trim());
  if (statements.some((s) => s.length === 0)) throw new ApiError(400, 'Fill in all three statements.');
  if (statements.some((s) => s.length > LIMITS.statementMax)) {
    throw new ApiError(400, `Each statement can be at most ${LIMITS.statementMax} characters.`);
  }
  if (new Set(statements.map((s) => s.toLowerCase())).size !== 3) {
    throw new ApiError(400, 'Your three statements must be different from each other.');
  }
  const lieIndex = Number(rawLie);
  if (![0, 1, 2].includes(lieIndex)) throw new ApiError(400, 'Mark which statement is the lie.');
  const sub: Submission = { statements, lieIndex };
  room.submissions[p.id] = sub;
}

export function submitGuess(room: Room, p: Player, rawGuess: unknown) {
  if (room.phase !== 'guessing') throw new ApiError(409, 'Voting is closed for this round.');
  const turn = room.turns[room.turnIndex];
  if (turn.authorId === p.id) throw new ApiError(403, "You can't vote on your own statements.");
  const guess = Number(rawGuess);
  if (![0, 1, 2].includes(guess)) throw new ApiError(400, 'Pick one of the three statements.');
  if (room.guesses[p.id] !== undefined) throw new ApiError(409, 'You already locked in your answer.');
  room.guesses[p.id] = guess;
}

/** Host-only: end the current timed phase now. */
export function skipPhase(room: Room, p: Player, now: number) {
  requireHost(room, p);
  const skippable: Phase[] = ['writing', 'guessing', 'reveal'];
  if (!skippable.includes(room.phase)) throw new ApiError(409, 'Nothing to skip right now.');
  room.deadline = now; // advance() performs the transition
}

/** Host-only: throw away the current round (no points, no reveal) and move on. */
export function skipTurn(room: Room, p: Player, now: number) {
  requireHost(room, p);
  if (room.phase !== 'guessing') throw new ApiError(409, 'You can only skip a round while people are voting.');
  nextTurnOrFinish(room, now);
}

export function restartGame(room: Room, p: Player) {
  requireHost(room, p);
  if (room.phase !== 'finished') throw new ApiError(409, 'The game is not finished yet.');
  for (const pl of Object.values(room.players)) pl.score = 0;
  room.phase = 'lobby';
  room.submissions = {};
  room.turns = [];
  room.turnIndex = 0;
  room.guesses = {};
  room.reveal = null;
  clearTimer(room);
}

/* ------------------------------------------------------------------ */
/* View (what each client may see)                                     */
/* ------------------------------------------------------------------ */

export function buildView(room: Room, youId: string, now: number): GameView {
  const inTurns = room.phase === 'guessing' || room.phase === 'reveal';
  const players: PlayerView[] = sortedPlayers(room).map((p) => {
    let done: boolean | null = null;
    if (room.phase === 'writing') done = !!room.submissions[p.id];
    else if (room.phase === 'guessing') {
      const turn = room.turns[room.turnIndex];
      done = p.id === turn?.authorId ? null : room.guesses[p.id] !== undefined;
    }
    return {
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.id === youId || isConnected(p, now),
      isHost: p.id === room.hostId,
      isYou: p.id === youId,
      done,
    };
  });

  let turn: GameView['turn'] = null;
  if (inTurns && room.turns[room.turnIndex]) {
    const t = room.turns[room.turnIndex];
    turn = {
      index: room.turnIndex,
      total: room.turns.length,
      authorId: t.authorId,
      statements: t.statements,
      lieIndex: room.phase === 'reveal' || t.authorId === youId ? t.lieIndex : null,
    };
  }

  let winners: string[] = [];
  if (room.phase === 'finished') {
    const max = Math.max(...players.map((p) => p.score));
    winners = players.filter((p) => p.score === max).map((p) => p.id);
  }

  const mine = room.submissions[youId];
  const g = room.guesses[youId];
  return {
    code: room.code,
    serverNow: now,
    youId,
    phase: room.phase,
    round: inTurns ? room.turnIndex + 1 : 0,
    totalRounds: room.turns.length > 0 ? room.turns.length : players.length,
    deadline: room.deadline,
    phaseMs: room.phaseMs,
    settings: room.settings,
    hostId: room.hostId,
    players,
    mySubmission: room.phase === 'writing' && mine ? { statements: mine.statements, lieIndex: mine.lieIndex } : null,
    turn,
    myGuess: room.phase === 'guessing' && g !== undefined ? g : null,
    reveal: room.phase === 'reveal' ? room.reveal : null,
    winners,
  };
}