'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, loadName, saveName, saveSession } from '@/lib/client';

const DEMO = [
  { text: 'I once got stuck in a lift with a famous chef.', lie: false },
  { text: 'I can’t swim, but I’ve crossed the Atlantic by boat.', lie: false },
  { text: 'I have never eaten a mango.', lie: true },
];

export default function Home() {
  const router = useRouter();
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    setName(loadName());
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (!name.trim()) return setError('Enter your name first.');
    if (tab === 'join' && code.length !== 4) return setError('Room codes are 4 letters.');
    setBusy(true);
    saveName(name.trim());
    const res = await api(tab === 'create' ? { op: 'create', name } : { op: 'join', code, name });
    if (!res.ok) {
      setBusy(false);
      return setError(res.error);
    }
    saveSession(res.data.code, { pid: res.data.playerId!, token: res.data.token! });
    router.push(`/room/${res.data.code}`);
  }

  return (
    <main className="shell">
      <div className="topbar">
        <span className="brand">Two truths <b>&amp;</b> a lie</span>
      </div>

      <div className="hero">
        <section>
          <h1>Two truths and a lie.</h1>
          <p className="lead">Write three things about yourself. Everyone else finds the one that’s fake.</p>

          <form className="panel stack" onSubmit={submit} style={{ marginTop: 28 }}>
            <div className="tabs" role="tablist" aria-label="Create or join">
              <button type="button" role="tab" aria-selected={tab === 'create'} onClick={() => setTab('create')}>
                Host a game
              </button>
              <button type="button" role="tab" aria-selected={tab === 'join'} onClick={() => setTab('join')}>
                Join with a code
              </button>
            </div>

            <label className="field">
              <span>Your name</span>
              <input
                className="input"
                value={name}
                maxLength={20}
                autoComplete="nickname"
                placeholder="e.g. Priya"
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            {tab === 'join' && (
              <label className="field">
                <span>Room code</span>
                <input
                  className="input code"
                  value={code}
                  maxLength={4}
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="ABCD"
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
                />
              </label>
            )}

            {error && <p className="error" role="alert">{error}</p>}

            <button className="btn big" type="submit" disabled={busy}>
              {busy ? 'One moment…' : tab === 'create' ? 'Create room' : 'Join room'}
            </button>
          </form>
        </section>

        <section aria-label="Try it">
          <p className="muted" style={{ marginBottom: 12, fontWeight: 700 }}>
            Try it: which one is the lie?
          </p>
          <div className="lineup">
            {DEMO.map((d, i) => {
              const revealed = picked !== null;
              const cls = revealed ? (d.lie ? 'lie' : 'truth') : '';
              return (
                <button
                  key={i}
                  type="button"
                  className={`placard ${cls}`}
                  disabled={revealed}
                  onClick={() => setPicked(i)}
                >
                  <span className="tag">{'ABC'[i]}</span>
                  <span className="txt">{d.text}</span>
                  {revealed && <span className="stamp">{d.lie ? 'LIE' : 'TRUE'}</span>}
                </button>
              );
            })}
          </div>
          <p className="muted" style={{ marginTop: 12 }} aria-live="polite">
            {picked === null
              ? 'Tap a statement.'
              : DEMO[picked].lie
                ? 'Spotted it. That’s +1 for you.'
                : 'Fooled. That’s +1 for the person who wrote it.'}
          </p>

          <ol className="how" style={{ marginTop: 22 }}>
            <li>The host picks rounds and timers, then shares the link or 4-letter code.</li>
            <li>Everyone writes two truths and a lie.</li>
            <li>Each set is shown one at a time. Find the lie before time runs out.</li>
          </ol>
        </section>
      </div>
    </main>
  );
}
