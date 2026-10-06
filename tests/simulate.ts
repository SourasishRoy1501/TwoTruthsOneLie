import assert from 'node:assert/strict';
import { clock } from '../lib/clock';
import { MemoryStore, getStore, useStore } from '../lib/store';
import { handleOp } from '../lib/service';
import { ApiError } from '../lib/engine';
import type { GameView } from '../lib/types';

useStore(new MemoryStore());
let T = 1_700_000_000_000;
clock.now = () => T;

type P = { name: string; pid: string; token: string };

async function create(name: string) {
  const r = await handleOp({ op: 'create', name });
  return { code: r.code, p: { name, pid: r.playerId!, token: r.token! } as P };
}
async function join(code: string, name: string, extra: object = {}) {
  const r = await handleOp({ op: 'join', code, name, ...extra });
  return { p: { name, pid: r.playerId!, token: r.token! } as P, view: r.view };
}
const call = (code: string, p: P, op: string, extra: object = {}) =>
  handleOp({ op, code, pid: p.pid, token: p.token, ...extra });
const poll = async (code: string, p: P): Promise<GameView> => (await call(code, p, 'state')).view;
async function fails(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof ApiError, 'expected ApiError, got ' + e);
    assert.equal((e as ApiError).status, status, (e as Error).message);
    return;
  }
  assert.fail('expected failure with status ' + status);
}
/** advance fake time in 2s steps; everyone in `online` keeps polling (heartbeat) */
async function elapse(code: string, ms: number, online: P[]) {
  for (let t = 0; t < ms; t += 2000) {
    T += Math.min(2000, ms - t);
    for (const p of online) await poll(code, p);
  }
}
const raw = async (code: string) => (await getStore().get(code))!.state;
const sts = (n: string) => [`${n} one`, `${n} two`, `${n} three`];
const SETTINGS = { writeSeconds: 30, guessSeconds: 15 };

/* ------------------------------------------------------------------ */

async function testExactFlowAsDescribed() {
  // A (host), B, C. Everyone writes once. Round 1 = A's set, round 2 = B's, round 3 = C's. Then the game ends.
  const { code, p: A } = await create('A');
  const { p: B } = await join(code, 'B');
  const { p: C } = await join(code, 'C');
  const all = [A, B, C];

  await fails(call(code, B, 'start'), 403);
  await call(code, A, 'settings', { settings: SETTINGS });
  // no "rounds" setting any more: it is ignored, number of rounds = number of players
  const lobby = (await poll(code, A));
  assert.deepEqual(Object.keys(lobby.settings).sort(), ['guessSeconds', 'writeSeconds']);

  let v = (await call(code, A, 'start')).view;
  assert.equal(v.phase, 'writing');
  assert.equal(v.deadline, T + 30_000, 'host-chosen writing time');
  assert.equal(v.totalRounds, 3);

  // host submits first: the round must NOT start while B and C are still writing
  await call(code, A, 'submit', { statements: sts('A'), lieIndex: 0 });
  assert.equal((await poll(code, B)).phase, 'writing');
  await call(code, B, 'submit', { statements: sts('B'), lieIndex: 1 });
  assert.equal((await poll(code, A)).phase, 'writing', 'still waiting for C');
  // everyone sees each other's progress
  const prog = (await poll(code, A)).players.map((p) => [p.name, p.done]);
  assert.deepEqual(prog, [['A', true], ['B', true], ['C', false]]);
  v = (await call(code, C, 'submit', { statements: sts('C'), lieIndex: 2 })).view;

  // starts as soon as the LAST player submits
  assert.equal(v.phase, 'guessing');
  assert.equal(v.round, 1);
  assert.equal(v.totalRounds, 3);
  assert.equal(v.turn!.authorId, A.pid, 'round 1 is the host (A)');

  const expectedAuthors = [A, B, C];
  for (let r = 0; r < 3; r++) {
    const author = expectedAuthors[r];
    const guessers = all.filter((p) => p.pid !== author.pid);
    v = await poll(code, A);
    assert.equal(v.phase, 'guessing');
    assert.equal(v.round, r + 1);
    assert.equal(v.turn!.authorId, author.pid);
    const room = await raw(code);
    const lie = room.turns[r].lieIndex;
    const before = Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.score]));

    for (const p of all) {
      const view = await poll(code, p);
      assert.equal(view.turn!.lieIndex, p.pid === author.pid ? lie : null, 'lie only visible to its author');
      assert.ok(!JSON.stringify(view).includes(p.token));
    }
    // the author can't vote
    await fails(call(code, author, 'guess', { guess: 0 }), 403);

    // first guesser right, second wrong
    await call(code, guessers[0], 'guess', { guess: lie });
    assert.equal((await poll(code, A)).phase, 'guessing', 'waits for the other voter');
    await call(code, guessers[1], 'guess', { guess: (lie + 1) % 3 });

    v = await poll(code, A);
    assert.equal(v.phase, 'reveal', 'ends when everyone except the author has voted');
    assert.equal(v.turn!.lieIndex, lie);
    const after = await raw(code);
    assert.equal(after.players[guessers[0].pid].score, before[guessers[0].pid] + 1, 'right guess +1');
    assert.equal(after.players[guessers[1].pid].score, before[guessers[1].pid], 'wrong guess +0');
    assert.equal(after.players[author.pid].score, before[author.pid] + 1, 'author +1 for the one fooled');

    await elapse(code, 12_000, all); // reveal screen time
  }

  v = await poll(code, A);
  assert.equal(v.phase, 'finished', 'game ends after exactly one round per player');
  assert.equal(v.deadline, null);
  const total = v.players.reduce((s, p) => s + p.score, 0);
  assert.equal(total, 6, '3 rounds x 2 votes = 6 points handed out');
  const max = Math.max(...v.players.map((p) => p.score));
  assert.deepEqual(new Set(v.winners), new Set(v.players.filter((p) => p.score === max).map((p) => p.id)));

  await elapse(code, 60_000, all);
  assert.equal((await poll(code, A)).phase, 'finished');
  await fails(call(code, B, 'restart'), 403);
  v = (await call(code, A, 'restart')).view;
  assert.equal(v.phase, 'lobby');
  assert.ok(v.players.every((p) => p.score === 0));
  console.log('ok  exact flow: write once -> round 1 (A), 2 (B), 3 (C) -> finished; scoring; restart');
}

async function testWritingNeverStartsEarly() {
  const { code, p: H } = await create('Hh');
  const { p: B } = await join(code, 'Bb');
  const { p: C } = await join(code, 'Cc');
  await call(code, H, 'settings', { settings: { writeSeconds: 600, guessSeconds: 15 } });
  await call(code, H, 'start');
  // B and C stop polling (background tabs); host submits and keeps polling for 100s
  await call(code, H, 'submit', { statements: sts('H'), lieIndex: 0 });
  await elapse(code, 100_000, [H]);
  assert.equal((await poll(code, H)).phase, 'writing', 'must not start while others are still writing');
  console.log('ok  host submitting never starts the round while others are still writing');
}

async function testTimerEndsWritingAndSkipsNonWriters() {
  const { code, p: A } = await create('A1');
  const { p: B } = await join(code, 'B1');
  const { p: C } = await join(code, 'C1');
  await call(code, A, 'settings', { settings: SETTINGS });
  await call(code, A, 'start');
  await call(code, A, 'submit', { statements: sts('A'), lieIndex: 0 });
  await call(code, C, 'submit', { statements: sts('C'), lieIndex: 0 });
  await elapse(code, 30_000, [A, B, C]); // B never writes
  const v = await poll(code, A);
  assert.equal(v.phase, 'guessing');
  assert.equal(v.totalRounds, 2, 'only players with statements get a round');
  assert.equal(v.turn!.authorId, A.pid);
  console.log('ok  writing timer ends writing; non-writers get no round');
}

async function testDisconnectAndRejoin() {
  const { code, p: A } = await create('Ann');
  const { p: B } = await join(code, 'Bob');
  const { p: C } = await join(code, 'Cat');
  await call(code, A, 'settings', { settings: SETTINGS });
  await call(code, A, 'start');
  for (const p of [A, B, C]) await call(code, p, 'submit', { statements: sts(p.name), lieIndex: 0 });
  // Cat closes her tab during round 1. Game must keep going on timers.
  await elapse(code, 15_000, [A, B]); // guess timer runs out, nobody voted yet
  let v = await poll(code, A);
  assert.equal(v.phase, 'reveal');
  await elapse(code, 12_000, [A, B]);
  v = await poll(code, A);
  assert.equal(v.phase, 'guessing');
  assert.equal(v.round, 2);
  // Cat comes back with her saved seat: lands exactly on the current round
  const back = await join(code, 'Cat', { pid: C.pid, token: C.token });
  assert.equal(back.p.pid, C.pid);
  assert.equal(back.view.phase, 'guessing');
  assert.equal(back.view.round, 2);
  assert.equal(back.view.myGuess, null);
  // ... and can still vote in this round
  const room = await raw(code);
  await call(code, C, 'guess', { guess: room.turns[1].lieIndex });
  console.log('ok  disconnect keeps game going; rejoin lands on the current round and can vote');
}

async function testHostControls() {
  const { code, p: H } = await create('Host');
  const { p: B } = await join(code, 'Bee');
  const { p: C } = await join(code, 'Cee');
  await call(code, H, 'settings', { settings: SETTINGS });
  await call(code, H, 'start');
  await call(code, H, 'submit', { statements: sts('H'), lieIndex: 0 });
  await call(code, B, 'submit', { statements: sts('B'), lieIndex: 0 });
  await fails(call(code, B, 'skip'), 403);
  // host ends writing early (C never wrote): 2 rounds
  let v = (await call(code, H, 'skip')).view;
  assert.equal(v.phase, 'guessing');
  assert.equal(v.totalRounds, 2);
  assert.equal(v.turn!.authorId, H.pid);
  // host ends voting early with one vote in
  const room = await raw(code);
  await call(code, B, 'guess', { guess: room.turns[0].lieIndex });
  v = (await call(code, H, 'skip')).view;
  assert.equal(v.phase, 'reveal');
  assert.equal(v.reveal!.results.filter((r) => r.guess !== null).length, 1);
  // host moves on from the reveal ("Next round")
  v = (await call(code, H, 'skip')).view;
  assert.equal(v.phase, 'guessing');
  assert.equal(v.round, 2);
  // host skips round 2 entirely: no points, game finishes (it was the last round)
  const before = JSON.stringify(v.players.map((p) => p.score));
  await fails(call(code, B, 'skipset'), 403);
  v = (await call(code, H, 'skipset')).view;
  assert.equal(v.phase, 'finished');
  assert.equal(JSON.stringify(v.players.map((p) => p.score)), before);
  await fails(call(code, H, 'skipset'), 409);
  console.log('ok  host controls: end writing / end voting / next round / skip round');
}

async function testEveryoneGoneThenReturns() {
  const { code, p: A } = await create('S1');
  const { p: B } = await join(code, 'S2');
  await call(code, A, 'settings', { settings: SETTINGS });
  await call(code, A, 'start');
  await call(code, A, 'submit', { statements: sts('x'), lieIndex: 0 });
  await call(code, B, 'submit', { statements: sts('y'), lieIndex: 0 });
  T += 3_600_000; // everyone vanishes for an hour
  const v = await poll(code, B);
  assert.ok(v.phase === 'guessing' || v.phase === 'reveal');
  assert.notEqual(v.phase, 'finished', 'must not fast-forward through the whole game');
  assert.ok(v.deadline! > T);
  assert.equal(v.round, 1);
  console.log('ok  long absence resumes at the current round, no fast-forward');
}

async function testHostHandoverAndNameReclaim() {
  const { code, p: A } = await create('Hosty');
  const { p: B } = await join(code, 'Second');
  await elapse(code, 160_000, [B]);
  let v = await poll(code, B);
  assert.equal(v.hostId, B.pid);
  const re = await join(code, 'hosty'); // new device, same name, old seat is offline
  assert.equal(re.p.pid, A.pid);
  await fails(join(code, 'second'), 409); // cannot take over someone who is online
  v = await poll(code, B);
  assert.equal(v.players.length, 2);
  console.log('ok  host handover + reclaim by name');
}

async function testConcurrency() {
  const { code, p: A } = await create('R1');
  const ps = [A];
  for (let i = 2; i <= 8; i++) ps.push((await join(code, 'R' + i)).p);
  await call(code, A, 'settings', { settings: SETTINGS });
  await call(code, A, 'start');
  await Promise.all([
    ...ps.map((p) => call(code, p, 'submit', { statements: sts(p.name), lieIndex: 1 })),
    ...ps.map((p) => poll(code, p)),
    ...ps.map((p) => poll(code, p)),
  ]);
  let r = await raw(code);
  assert.equal(r.phase, 'guessing');
  assert.equal(r.turns.length, 8, 'no submission may be lost to a race');
  assert.equal(r.turns[0].authorId, A.pid);
  const t = r.turns[0];
  await Promise.all(ps.filter((p) => p.pid !== t.authorId).map((p) => call(code, p, 'guess', { guess: t.lieIndex })));
  r = await raw(code);
  assert.equal(r.phase, 'reveal');
  assert.equal(r.reveal!.results.length, 7);
  assert.ok(r.reveal!.results.every((x) => x.correct));
  assert.equal(Object.values(r.players).reduce((s, p) => s + p.score, 0), 7, 'no vote lost or double-counted');
  console.log('ok  8 players acting at the same instant: nothing lost, nothing double-counted');
}

async function testLateJoiner() {
  const { code, p: A } = await create('H');
  const { p: B } = await join(code, 'G1');
  await call(code, A, 'settings', { settings: SETTINGS });
  await call(code, A, 'start');
  const { p: L, view } = await join(code, 'Late');
  assert.equal(view.phase, 'writing');
  assert.equal(view.totalRounds, 3, 'a late joiner during writing gets a round too');
  for (const p of [A, B, L]) await call(code, p, 'submit', { statements: sts(p.name), lieIndex: 2 });
  const r = await raw(code);
  assert.equal(r.phase, 'guessing');
  assert.deepEqual(r.turns.map((t) => t.authorId), [A.pid, B.pid, L.pid], 'rounds follow join order');
  await fails(call(code, A, 'submit', { statements: sts('z'), lieIndex: 0 }), 409); // writing is over
  console.log('ok  late joiner during writing; rounds follow join order; late submit rejected');
}

(async () => {
  await testExactFlowAsDescribed();
  await testWritingNeverStartsEarly();
  await testTimerEndsWritingAndSkipsNonWriters();
  await testDisconnectAndRejoin();
  await testHostControls();
  await testEveryoneGoneThenReturns();
  await testHostHandoverAndNameReclaim();
  await testConcurrency();
  await testLateJoiner();
  console.log('\nALL TESTS PASSED');
})().catch((e) => {
  console.error('\nTEST FAILED:', e);
  process.exit(1);
});