export type Phase = 'lobby' | 'writing' | 'guessing' | 'reveal' | 'finished';

export interface Settings {
  writeSeconds: number;
  guessSeconds: number;
}

export interface Player {
  id: string; // public
  token: string; // secret, never sent to other players
  name: string;
  joinedAt: number;
  /** 0 = room creator (host), then 1, 2, ... in the order people joined. Never changes. */
  order: number;
  lastSeen: number;
  score: number;
}

export interface Submission {
  statements: string[]; // in the order the author typed them
  lieIndex: number;
}

export interface Turn {
  authorId: string;
  statements: string[]; // already shuffled for display
  lieIndex: number; // index within the shuffled statements
}

export interface RevealResult {
  playerId: string;
  guess: number | null; // null = did not answer
  correct: boolean;
}

export interface Reveal {
  results: RevealResult[];
  deltas: Record<string, number>;
}

/** Full authoritative room state. Stored server-side only. */
export interface Room {
  code: string;
  settings: Settings;
  phase: Phase;
  deadline: number | null; // epoch ms
  phaseMs: number; // length of the current timed phase
  hostId: string;
  players: Record<string, Player>;
  submissions: Record<string, Submission>;
  /** One turn (= one round) per player who submitted, in join order (host first). */
  turns: Turn[];
  turnIndex: number;
  guesses: Record<string, number>;
  reveal: Reveal | null;
  createdAt: number;
}

/* ---------- What clients are allowed to see ---------- */

export interface PlayerView {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  isHost: boolean;
  isYou: boolean;
  /** writing: submitted? guessing: voted? null when not applicable */
  done: boolean | null;
}

export interface TurnView {
  index: number;
  total: number;
  authorId: string;
  statements: string[];
  /** Only set for the author while guessing, or for everyone during the reveal */
  lieIndex: number | null;
}

export interface GameView {
  code: string;
  serverNow: number;
  youId: string;
  phase: Phase;
  /** 1-based number of the round being played (0 before guessing starts) */
  round: number;
  /** total rounds = one per player */
  totalRounds: number;
  deadline: number | null;
  phaseMs: number;
  settings: Settings;
  hostId: string;
  players: PlayerView[];
  mySubmission: Submission | null;
  turn: TurnView | null;
  myGuess: number | null;
  reveal: Reveal | null;
  winners: string[];
}