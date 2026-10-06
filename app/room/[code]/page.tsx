'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, clearSession, loadName, loadSession, saveName, saveSession, type Session } from '@/lib/client';
import type { GameView, PlayerView, Settings } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* Page: figure out whether we already have a seat in this room        */
/* ------------------------------------------------------------------ */

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const code = String(params?.code ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setSession(loadSession(code));
  }, [code]);

  const lost = useCallback(
    (message: string) => {
      clearSession(code);
      setNotice(message);
      setSession(null);
    },
    [code],
  );

  if (code.length !== 4) {
    return (
      <main className="shell">
        <div className="panel stack">
          <h2>That room code doesn’t look right</h2>
          <p className="muted">Room codes are 4 letters.</p>
          <Link className="btn" href="/">Back to home</Link>
        </div>
      </main>
    );
  }
  if (session === undefined) return <main className="shell" />;
  if (session === null) return <JoinGate code={code} notice={notice} onJoined={setSession} />;
  return <Game code={code} session={session} onLost={lost} />;
}

/* ------------------------------------------------------------------ */
/* Join gate (opened an invite link without a seat)                    */
/* ------------------------------------------------------------------ */

function JoinGate({ code, notice, onJoined }: { code: string; notice: string; onJoined: (s: Session) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice);

  useEffect(() => setName(loadName()), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError('Enter your name to join.');
    setBusy(true);
    setError('');
    saveName(name.trim());
    const res = await api({ op: 'join', code, name });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const s = { pid: res.data.playerId!, token: res.data.token! };
    saveSession(code, s);
    onJoined(s);
  }

  return (
    <main className="shell">
      <div className="topbar">
        <Link className="brand" href="/">Two truths <b>&amp;</b> a lie</Link>
      </div>
      <form className="panel stack" onSubmit={submit}>
        <h2>Join room {code}</h2>
        <label className="field">
          <span>Your name</span>
          <input
            className="input"
            value={name}
            maxLength={20}
            autoFocus
            autoComplete="nickname"
            placeholder="e.g. Priya"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="muted small">
          Coming back after a disconnect? Enter the same name you used before and you’ll pick up where you left off.
        </p>
        <button className="btn big" disabled={busy}>{busy ? 'Joining…' : 'Join game'}</button>
      </form>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Game shell: polling, time sync, actions                             */
/* ------------------------------------------------------------------ */

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function Game({ code, session, onLost }: { code: string; session: Session; onLost: (m: string) => void }) {
  const [view, setView] = useState<GameView | null>(null);
  const [conn, setConn] = useState<'ok' | 'retry'>('ok');
  const [fatal, setFatal] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const offset = useRef(0); // serverTime - clientTime
  const seq = useRef(0);
  const applied = useRef(0);
  const inflight = useRef(false);
  const rerun = useRef(false);
  const rtOk = useRef(false);
  const runRef = useRef<(() => void) | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connRef = useRef<'ok' | 'retry'>('ok');

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  }, []);

  /** One request. Responses that arrive out of order are ignored. */
  const send = useCallback(
    async (body: Record<string, unknown>) => {
      const mine = ++seq.current;
      const res = await api({ ...body, code, pid: session.pid, token: session.token });
      if (res.ok) {
        if (connRef.current !== 'ok') {
          connRef.current = 'ok';
          setConn('ok');
        }
        if (mine > applied.current) {
          applied.current = mine;
          offset.current = res.data.view.serverNow - Date.now();
          setView(res.data.view);
        }
      } else if (res.status === 401) {
        onLost('Your seat in this room expired. Enter your name to rejoin.');
      } else if (res.status === 404) {
        setFatal(res.error);
      } else if (res.status === 0 || res.status >= 500) {
        if (connRef.current !== 'retry') {
          connRef.current = 'retry';
          setConn('retry');
        }
      }
      return res;
    },
    [code, session.pid, session.token, onLost],
  );

  /* Polling is the safety net; Realtime pings (below) make updates instant. */
  useEffect(() => {
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(t);
      if (cancelled) return;
      const delay = document.hidden ? 2500 : connRef.current === 'retry' ? 2500 : rtOk.current ? 4000 : 1000;
      t = setTimeout(run, delay);
    };
    const run = async () => {
      if (cancelled) return;
      if (inflight.current) {
        rerun.current = true; // a ping/timer arrived mid-request: fetch again right after
        return;
      }
      inflight.current = true;
      try {
        do {
          rerun.current = false;
          await send({ op: 'state' });
        } while (rerun.current && !cancelled);
      } finally {
        inflight.current = false;
      }
      schedule();
    };
    runRef.current = run;
    run();
    const wake = () => {
      if (!document.hidden) run();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      cancelled = true;
      clearTimeout(t);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [send]);

  /* Instant updates: the server pings this room's Realtime channel after every change.
     The ping carries no data; we simply fetch our own private view right away. */
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    let cancelled = false;
    let cleanup = () => {};
    import('@supabase/supabase-js')
      .then(({ createClient }) => {
        if (cancelled) return;
        const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        const channel = sb
          .channel(`room:${code}`)
          .on('broadcast', { event: 'tick' }, () => runRef.current?.())
          .subscribe((status) => {
            rtOk.current = status === 'SUBSCRIBED';
            if (status === 'SUBSCRIBED') runRef.current?.(); // catch up on anything missed while connecting
          });
        cleanup = () => {
          sb.removeChannel(channel);
        };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      rtOk.current = false;
      cleanup();
    };
  }, [code]);

  /* sync right after each timer expires so the next phase appears immediately */
  useEffect(() => {
    if (!view?.deadline) return;
    const ms = view.deadline - (Date.now() + offset.current);
    const id = setTimeout(() => runRef.current?.(), Math.max(0, ms) + 250);
    return () => clearTimeout(id);
  }, [view?.deadline, view?.phase]);

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      const res = await send(body);
      setBusy(false);
      if (!res.ok && res.status !== 401) {
        showToast(res.error);
        if (res.status === 409) runRef.current?.(); // resync, the phase probably moved on
      }
      return res.ok;
    },
    [send, showToast],
  );

  const now = useNow(250);
  const remaining = view?.deadline != null ? Math.max(0, view.deadline - (now + offset.current)) : null;

  if (fatal) {
    return (
      <main className="shell">
        <div className="panel stack">
          <h2>Room not found</h2>
          <p className="muted">{fatal}</p>
          <Link className="btn" href="/">Back to home</Link>
        </div>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="shell">
        <p className="muted" style={{ paddingTop: 40 }}>Connecting to room {code}…</p>
        {conn === 'retry' && <p className="error">Can’t reach the server. Retrying…</p>}
      </main>
    );
  }

  const isHost = view.hostId === view.youId;
  const playerName = (id: string) => view.players.find((p) => p.id === id)?.name ?? 'Someone';

  return (
    <main className="shell">
      <div className="topbar">
        <Link className="brand" href="/">Two truths <b>&amp;</b> a lie</Link>
        <div className="row">
          {view.round > 0 && view.phase !== 'finished' && (
            <span className="pill">Round {view.round} of {view.totalRounds}</span>
          )}
          <span className="pill" title={conn === 'ok' ? 'Connected' : 'Reconnecting'}>
            <span className={`dot ${conn === 'ok' ? '' : 'off'}`} />
            <span className="code">{view.code}</span>
          </span>
        </div>
      </div>

      {conn === 'retry' && (
        <div className="banner" role="status">
          Connection lost. Reconnecting… The game keeps going, and you’ll rejoin on the current question.
        </div>
      )}

      {view.phase === 'lobby' && <Lobby view={view} isHost={isHost} act={act} busy={busy} setView={setView} />}
      {view.phase === 'writing' && (
        <Writing key={view.round} view={view} remaining={remaining} act={act} busy={busy} isHost={isHost} />
      )}
      {view.phase === 'guessing' && view.turn && (
        <Guessing
          key={`${view.round}-${view.turn.index}`}
          view={view}
          remaining={remaining}
          act={act}
          isHost={isHost}
          authorName={playerName(view.turn.authorId)}
        />
      )}
      {view.phase === 'reveal' && view.turn && view.reveal && (
        <Reveal view={view} remaining={remaining} act={act} isHost={isHost} playerName={playerName} />
      )}
      {view.phase === 'finished' && <Finished view={view} act={act} isHost={isHost} busy={busy} />}

      {toast && <div className="toast" role="alert">{toast}</div>}
    </main>
  );
}

type Act = (body: Record<string, unknown>) => Promise<boolean>;

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

const AVATAR_COLORS = ['#6c4dff', '#ff4f79', '#14b88e', '#ff9f1c', '#2b9cf2', '#c04df0', '#e0475b', '#0fa3b1'];
function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ p, size }: { p: { id: string; name: string }; size?: 'sm' | 'lg' }) {
  return (
    <span className={`avatar ${size ?? ''}`} style={{ background: colorFor(p.id) }} aria-hidden>
      {p.name.trim().charAt(0) || '?'}
    </span>
  );
}

function Ring({ remaining, total, label }: { remaining: number | null; total: number; label?: string }) {
  if (remaining === null) return null;
  const secs = Math.ceil(remaining / 1000);
  const R = 32;
  const C = 2 * Math.PI * R;
  const pct = total > 0 ? Math.min(1, remaining / total) : 0;
  return (
    <div className={`ring ${secs <= 5 ? 'low' : ''}`} role="timer" aria-label={label ?? 'Time left'}>
      <svg width="76" height="76" viewBox="0 0 76 76">
        <circle className="track" cx="38" cy="38" r={R} fill="none" strokeWidth="8" />
        <circle
          className="prog"
          cx="38"
          cy="38"
          r={R}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
        />
      </svg>
      <span className="num">{secs}</span>
    </div>
  );
}

function Chips({ players }: { players: PlayerView[] }) {
  return (
    <div className="chips">
      {players.map((p) => (
        <span key={p.id} className={`chip ${p.connected ? '' : 'away'}`}>
          <Avatar p={p} size="sm" />
          {p.name}
          {p.isYou && <span className="tagx">you</span>}
          {p.isHost && <span className="tagx">host</span>}
        </span>
      ))}
    </div>
  );
}

function WhoCell({ p }: { p: PlayerView }) {
  return (
    <div className="who">
      <Avatar p={p} />
      <span className="nm">{p.name}</span>
      {p.isYou && <span className="tagx">you</span>}
      {p.isHost && <span className="tagx">host</span>}
    </div>
  );
}

/**
 * Live status of everyone. The HOST sees a full table (name + status).
 * Other players see a progress bar so they know how long the wait is.
 */
function StatusPanel({
  view,
  mode,
  isHost,
  authorId,
}: {
  view: GameView;
  mode: 'write' | 'guess';
  isHost: boolean;
  authorId?: string;
}) {
  const rows = mode === 'guess' ? view.players.filter((p) => p.id !== authorId) : view.players;
  const done = rows.filter((p) => p.done).length;
  const pct = rows.length ? (done / rows.length) * 100 : 0;
  const noun = mode === 'write' ? 'submitted' : 'voted';

  const status = (p: PlayerView) => {
    if (mode === 'guess' && p.id === authorId) return <span className="badge live">Presenting</span>;
    if (p.done) return <span className="badge ok">{mode === 'write' ? 'Submitted ✓' : 'Voted ✓'}</span>;
    if (!p.connected) return <span className="badge away">Away</span>;
    return <span className="badge wait">{mode === 'write' ? 'Writing…' : 'Thinking…'}</span>;
  };

  return (
    <section className="panel stack">
      <div className="between">
        <h3>{mode === 'write' ? 'Submissions' : 'Votes'}</h3>
        <span className="badge">
          {done} of {rows.length} {noun}
        </span>
      </div>
      <div className="progress" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </div>
      {isHost ? (
        <table className="table">
          <tbody>
            {view.players.map((p) => (
              <tr key={p.id}>
                <td><WhoCell p={p} /></td>
                <td>{mode === 'guess' && p.id === authorId ? <span className="badge live">Presenting</span> : status(p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Chips players={rows} />
      )}
    </section>
  );
}

function HostControls({ isHost, children }: { isHost: boolean; children: React.ReactNode }) {
  if (!isHost) return null;
  return (
    <section className="panel flat">
      <div className="hostbar stack">
        <h3>Host controls</h3>
        <div className="row">{children}</div>
      </div>
    </section>
  );
}

function Scoreboard({
  players,
  deltas,
  highlightWinners,
  winners,
}: {
  players: PlayerView[];
  deltas?: (p: PlayerView) => number;
  highlightWinners?: boolean;
  winners?: string[];
}) {
  const sorted = useMemo(() => [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)), [players]);
  const max = Math.max(1, ...sorted.map((p) => p.score));
  return (
    <div className="board">
      {sorted.map((p) => {
        const rank = 1 + sorted.filter((o) => o.score > p.score).length;
        const d = deltas ? deltas(p) : 0;
        const win = highlightWinners && winners?.includes(p.id);
        return (
          <div key={p.id} className={`board-row ${p.isYou ? 'me' : ''} ${win ? 'win' : ''}`}>
            <i className="fill" style={{ width: `${(p.score / max) * 100}%` }} />
            <span className="rank">{win ? '👑' : rank}</span>
            <Avatar p={p} size="sm" />
            <span className="nm">
              {p.name}
              {p.isYou ? ' (you)' : ''}
            </span>
            {d > 0 ? <span className="delta">+{d}</span> : <span />}
            <span className="pts">{p.score}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lobby                                                               */
/* ------------------------------------------------------------------ */

const WRITE_OPTS = [30, 45, 60, 90, 120, 180, 300];
const GUESS_OPTS = [10, 15, 20, 30, 45, 60, 90];
const fmtSecs = (s: number) => (s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} sec`);

function Lobby({
  view,
  isHost,
  act,
  busy,
  setView,
}: {
  view: GameView;
  isHost: boolean;
  act: Act;
  busy: boolean;
  setView: (fn: (v: GameView | null) => GameView | null) => void;
}) {
  const link = typeof window !== 'undefined' ? `${window.location.origin}/room/${view.code}` : '';
  const [copied, setCopied] = useState<'' | 'link' | 'code'>('');

  async function copy(text: string, what: 'link' | 'code') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch {}
      el.remove();
    }
    setCopied(what);
    setTimeout(() => setCopied(''), 1800);
  }

  function change(patch: Partial<Settings>) {
    const next = { ...view.settings, ...patch };
    setView((v) => (v ? { ...v, settings: next } : v));
    act({ op: 'settings', settings: next });
  }

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div className="split">
      <div>
        <section className="panel stack">
          <h2>Invite your friends</h2>
          <p className="muted">Send them the link, or have them type this code on the home page.</p>
          <div><span className="codebox">{view.code}</span></div>
          <div className="row">
            <button className="btn small violet" onClick={() => copy(link, 'link')}>{copied === 'link' ? 'Link copied' : 'Copy invite link'}</button>
            <button className="btn small ghost" onClick={() => copy(view.code, 'code')}>{copied === 'code' ? 'Copied' : 'Copy code'}</button>
            {canShare && (
              <button
                className="btn small ghost"
                onClick={() => navigator.share({ title: 'Two truths & a lie', text: 'Join my game!', url: link }).catch(() => {})}
              >
                Share…
              </button>
            )}
          </div>
        </section>

        <section className="panel stack">
          <h3>Game settings {!isHost && <span className="tagx">host only</span>}</h3>
          <div className="settings" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <label className="field">
              <span>Time to write</span>
              <select className="select" disabled={!isHost} value={view.settings.writeSeconds} onChange={(e) => change({ writeSeconds: Number(e.target.value) })}>
                {WRITE_OPTS.map((n) => <option key={n} value={n}>{fmtSecs(n)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Time to guess</span>
              <select className="select" disabled={!isHost} value={view.settings.guessSeconds} onChange={(e) => change({ guessSeconds: Number(e.target.value) })}>
                {GUESS_OPTS.map((n) => <option key={n} value={n}>{fmtSecs(n)}</option>)}
              </select>
            </label>
          </div>
          <p className="muted small">
            How it works: first everyone (host included) writes two truths and a lie. Then there is one round per player ({view.players.length} {view.players.length === 1 ? 'round' : 'rounds'} right now), starting with the host. In each round that player's three statements are shown and everyone else guesses the lie. +1 for spotting the lie, +1 to the author for every player fooled.
          </p>
        </section>
      </div>

      <div>
        <section className="panel stack">
          <div className="between">
            <h3>Players</h3>
            <span className="badge">{view.players.length} in the room</span>
          </div>
          <table className="table">
            <tbody>
              {view.players.map((p) => (
                <tr key={p.id}>
                  <td><WhoCell p={p} /></td>
                  <td>{p.connected ? <span className="badge ok">Here</span> : <span className="badge away">Away</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {isHost ? (
            <div className="stack">
              <button className="btn big" style={{ width: '100%' }} disabled={busy || view.players.length < 2} onClick={() => act({ op: 'start' })}>
                Start game
              </button>
              {view.players.length < 2 && <p className="muted small">Waiting for at least one more player to join.</p>}
            </div>
          ) : (
            <p className="muted">Waiting for the host to start…</p>
          )}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

function Writing({
  view,
  remaining,
  act,
  busy,
  isHost,
}: {
  view: GameView;
  remaining: number | null;
  act: Act;
  busy: boolean;
  isHost: boolean;
}) {
  const saved = view.mySubmission;
  const [texts, setTexts] = useState<string[]>(saved?.statements ?? ['', '', '']);
  const [lie, setLie] = useState<number | null>(saved?.lieIndex ?? null);

  const clean = texts.map((t) => t.replace(/\s+/g, ' ').trim());
  const filled = clean.every((t) => t.length > 0);
  const distinct = new Set(clean.map((t) => t.toLowerCase())).size === 3;
  const dirty = !saved || saved.lieIndex !== lie || saved.statements.some((s, i) => s !== clean[i]);
  const ready = filled && distinct && lie !== null;

  return (
    <div className="split">
      <section className="panel stack">
        <div className="between">
          <div>
            <p className="kicker">Everyone writes first, then {view.totalRounds} {view.totalRounds === 1 ? 'round' : 'rounds'} of guessing</p>
            <h2>Write two truths and a lie</h2>
          </div>
          <Ring remaining={remaining} total={view.phaseMs} label="Time left to write" />
        </div>
        <p className="muted">Make the truths believable and the lie sneaky, then tick which one is the lie.</p>

        <div className="stack">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`write-card ${lie === i ? 'lie-on' : ''}`}>
              <div className="head">
                <b>Statement {i + 1}</b>
                <label className={`lie-toggle ${lie === i ? 'on' : ''}`}>
                  <input type="radio" name="lie" checked={lie === i} onChange={() => setLie(i)} />
                  {lie === i ? 'This is the lie' : 'Mark as the lie'}
                </label>
              </div>
              <input
                className="input"
                value={texts[i]}
                maxLength={160}
                aria-label={`Statement ${i + 1}`}
                placeholder={['Something true…', 'Something else true…', 'Something that sounds true…'][i]}
                onChange={(e) => setTexts((t) => t.map((x, j) => (j === i ? e.target.value : x)))}
              />
            </div>
          ))}
        </div>

        {filled && !distinct && <p className="error">Your three statements need to be different.</p>}
        <div className="row">
          <button
            className="btn big"
            disabled={busy || !ready || !dirty}
            onClick={() => act({ op: 'submit', statements: clean, lieIndex: lie })}
          >
            {saved ? 'Update statements' : 'Submit statements'}
          </button>
          {saved && !dirty && <span className="badge ok">Submitted ✓ Waiting for the others</span>}
          {!saved && !ready && <span className="muted small">Fill in all three and mark the lie.</span>}
        </div>
      </section>

      <div>
        <StatusPanel view={view} mode="write" isHost={isHost} />
        <HostControls isHost={isHost}>
          <button className="btn small" onClick={() => act({ op: 'skip' })}>End writing &amp; start round 1</button>
        </HostControls>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Guessing                                                            */
/* ------------------------------------------------------------------ */

function Guessing({
  view,
  remaining,
  act,
  isHost,
  authorName,
}: {
  view: GameView;
  remaining: number | null;
  act: Act;
  isHost: boolean;
  authorName: string;
}) {
  const turn = view.turn!;
  const iAmAuthor = turn.authorId === view.youId;
  const author = view.players.find((p) => p.id === turn.authorId);
  const [pending, setPending] = useState<number | null>(null);
  const chosen = view.myGuess ?? pending;
  const locked = chosen !== null;

  async function pick(i: number) {
    if (locked || iAmAuthor) return;
    setPending(i);
    const ok = await act({ op: 'guess', guess: i });
    if (!ok) setPending(null);
  }

  return (
    <div className="split">
      <div>
        <div className="between" style={{ marginTop: 16 }}>
          <div className="row">
            {author && <Avatar p={author} size="lg" />}
            <div>
              <p style={{ color: 'var(--gold)', fontWeight: 800 }}>
                Round {turn.index + 1} of {turn.total}
              </p>
              <h2>{iAmAuthor ? 'Your statements' : `${authorName}’s statements`}</h2>
            </div>
          </div>
          <div className="panel flat" style={{ marginTop: 0, padding: 8, borderRadius: 50 }}>
            <Ring remaining={remaining} total={view.phaseMs} label="Time left to guess" />
          </div>
        </div>
        <p className="muted" style={{ margin: '12px 0 16px', fontWeight: 600 }}>
          {iAmAuthor ? 'The group is hunting for your lie. Keep a straight face.' : 'Which one is the lie? Tap to lock in your answer.'}
        </p>
        <div className="lineup">
          {turn.statements.map((s, i) => {
            const mineLie = iAmAuthor && turn.lieIndex === i;
            const cls = mineLie ? 'lie' : chosen === i ? 'picked' : locked && !iAmAuthor ? 'faded' : '';
            const inner = (
              <>
                <span className="tag">{'ABC'[i]}</span>
                <span className="txt">{s}</span>
                {mineLie && <span className="stamp">YOUR LIE</span>}
                {chosen === i && <span className="tagx">your pick</span>}
              </>
            );
            return iAmAuthor ? (
              <div key={i} className={`placard ${cls}`}>{inner}</div>
            ) : (
              <button key={i} className={`placard ${cls}`} disabled={locked} onClick={() => pick(i)}>
                {inner}
              </button>
            );
          })}
        </div>
        <p className="muted" style={{ marginTop: 14, fontWeight: 600 }} aria-live="polite">
          {iAmAuthor
            ? 'You can’t vote on your own set.'
            : locked
              ? 'Locked in. Waiting for the others…'
              : ''}
        </p>
      </div>

      <div>
        <StatusPanel view={view} mode="guess" isHost={isHost} authorId={turn.authorId} />
        <HostControls isHost={isHost}>
          <button className="btn small" onClick={() => act({ op: 'skip' })}>End voting &amp; reveal</button>
          <button
            className="btn small ghost"
            onClick={() => {
              if (window.confirm('Skip this round? No points will be awarded for it.')) act({ op: 'skipset' });
            }}
          >
            Skip this round
          </button>
        </HostControls>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reveal                                                              */
/* ------------------------------------------------------------------ */

function Reveal({
  view,
  remaining,
  act,
  isHost,
  playerName,
}: {
  view: GameView;
  remaining: number | null;
  act: Act;
  isHost: boolean;
  playerName: (id: string) => string;
}) {
  const turn = view.turn!;
  const reveal = view.reveal!;
  const author = view.players.find((p) => p.id === turn.authorId);
  const authorName = playerName(turn.authorId);
  const byId = (id: string) => view.players.find((p) => p.id === id);

  return (
    <div className="split">
      <div>
        <div className="between" style={{ marginTop: 16 }}>
          <div className="row">
            {author && <Avatar p={author} size="lg" />}
            <div>
              <p style={{ color: 'var(--gold)', fontWeight: 800 }}>
                Round {turn.index + 1} of {turn.total}
              </p>
              <h2>{authorName}’s lie was…</h2>
            </div>
          </div>
          <div className="panel flat" style={{ marginTop: 0, padding: 8, borderRadius: 50 }}>
            <Ring remaining={remaining} total={view.phaseMs} label="Next up in" />
          </div>
        </div>
        <div className="lineup" style={{ marginTop: 16 }}>
          {turn.statements.map((s, i) => {
            const isLie = turn.lieIndex === i;
            const pickers = reveal.results.filter((r) => r.guess === i).map((r) => playerName(r.playerId));
            return (
              <div key={i}>
                <div className={`placard ${isLie ? 'lie' : 'truth'}`}>
                  <span className="tag">{'ABC'[i]}</span>
                  <span className="txt">{s}</span>
                  <span className="stamp">{isLie ? 'LIE' : 'TRUE'}</span>
                </div>
                <p className="pickers">{pickers.length ? `Picked by ${pickers.join(', ')}` : ''}</p>
              </div>
            );
          })}
        </div>

        <section className="panel stack">
          <h3>What happened</h3>
          <div className="results">
            {reveal.results.map((r) => {
              const pl = byId(r.playerId);
              return (
                <p key={r.playerId} className="res">
                  {pl && <Avatar p={pl} size="sm" />}
                  <b>{playerName(r.playerId)}</b>
                  {r.guess === null ? (
                    <span className="skip">didn’t answer</span>
                  ) : r.correct ? (
                    <span className="ok">spotted the lie +1</span>
                  ) : (
                    <span className="no">fooled, {authorName} +1</span>
                  )}
                </p>
              );
            })}
            {reveal.results.length === 0 && <p className="muted">Nobody else was in the room to guess.</p>}
          </div>
        </section>
      </div>

      <div>
        <section className="panel stack">
          <h3>Scores</h3>
          <Scoreboard players={view.players} deltas={(p) => reveal.deltas[p.id] ?? 0} />
        </section>
        <HostControls isHost={isHost}>
          <button className="btn small" onClick={() => act({ op: 'skip' })}>
            {turn.index + 1 >= turn.total ? 'See final results' : 'Next round'}
          </button>
        </HostControls>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Final                                                               */
/* ------------------------------------------------------------------ */

const CONFETTI = ['#6c4dff', '#ff4f79', '#14b88e', '#ffffff', '#2b9cf2', '#ff9f1c'];

function Finished({ view, act, isHost, busy }: { view: GameView; act: Act; isHost: boolean; busy: boolean }) {
  const sorted = [...view.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const winners = sorted.filter((p) => view.winners.includes(p.id));
  const names = winners.map((p) => p.name);
  const top = winners[0]?.score ?? 0;
  const tie = names.length > 1;
  const list = names.length <= 2 ? names.join(' & ') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;

  const podium = sorted.slice(0, 3).map((p, i) => ({ p, rank: i + 1 }));
  const order = podium.length === 3 ? [podium[1], podium[0], podium[2]] : podium.length === 2 ? [podium[1], podium[0]] : podium;

  return (
    <>
      <div className="winner" role="status">
        {Array.from({ length: 26 }).map((_, i) => (
          <span
            key={i}
            className="confetti"
            style={{
              left: `${(i * 37) % 100}%`,
              background: CONFETTI[i % CONFETTI.length],
              animationDuration: `${2.6 + ((i * 7) % 10) / 4}s`,
              animationDelay: `${((i * 13) % 20) / 10}s`,
            }}
          />
        ))}
        <div className="crown" aria-hidden>👑</div>
        <p>{tie ? 'It’s a tie!' : 'And the winner is'}</p>
        <h2>{list}</h2>
        <p>{top} {top === 1 ? 'point' : 'points'}</p>
      </div>

      <section className="panel stack">
        <h3>Final scores</h3>
        {order.length >= 2 && (
          <div className="podium">
            {order.map(({ p, rank }) => (
              <div key={p.id} className={`step p${rank}`}>
                <Avatar p={p} size="lg" />
                <div className="nm">{p.name}</div>
                <div className="pt">{p.score} pts</div>
                <div className="block">{rank}</div>
              </div>
            ))}
          </div>
        )}
        <Scoreboard players={view.players} highlightWinners winners={view.winners} />
        {isHost ? (
          <div className="row">
            <button className="btn big" disabled={busy} onClick={() => act({ op: 'restart' })}>Play again</button>
            <Link className="btn ghost" href="/">Leave</Link>
          </div>
        ) : (
          <div className="row">
            <p className="muted grow">Waiting for the host to start another game…</p>
            <Link className="btn ghost" href="/">Leave</Link>
          </div>
        )}
      </section>
    </>
  );
}