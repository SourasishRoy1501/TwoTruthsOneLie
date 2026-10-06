# Two Truths & a Lie — online multiplayer

Host a room, share a link or 4-letter code, and play. Next.js (App Router) on Vercel, Supabase (Postgres) for state.

## Deploy (about 5 minutes)

1. **Supabase**: create a project, open *SQL Editor*, paste and run `supabase/schema.sql`.
2. **Supabase keys**: *Project Settings → API*. Copy the **Project URL** and the **service_role** key.
3. **Vercel**: push this folder to GitHub, import it in Vercel, and add two environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`  (server-only, never prefix with `NEXT_PUBLIC_`)
4. Deploy. In Vercel → Settings → Functions, set the region closest to your Supabase region (lower latency).

## Run locally

```bash
npm install
npm run dev        # uses an in-memory store if no Supabase vars are set
npm test           # full-game simulation (disconnects, rejoin, races, scoring)
```
The in-memory store is for local development only; production requires the Supabase variables.

## How a game works

- **Round** = everyone writes a set (two truths + a lie) → the group guesses each set one at a time → scoreboard.
- **Scoring**: +1 to a player who spots the lie; +1 to the author for every player fooled.
- Host sets **rounds**, **writing time** and **guessing time** in the lobby.
- Scores are shown after every set, after every round, and the final screen highlights the winner (ties supported).

## Why it never stops

There is no server process to crash or time out. All state lives in Postgres and every request moves the
game forward if it is due ("lazy clock"):

- A phase ends when its timer expires **or** when everyone who is still around has answered.
- Players away for more than 30 s are no longer waited for; the game continues without them.
- Any connected client can trigger the next step, so the host disconnecting does not matter
  (host controls pass to the next active player automatically).
- Reconnecting (same browser, or same name from another device) drops the player back on the current question.
- If *everyone* leaves, the game pauses; when someone returns it resumes at the current question
  with a fresh timer (it never fast-forwards through rounds).
- Writes use optimistic concurrency (version check + retry), so simultaneous actions are never lost or double-counted.
- The "which one is the lie" answer lives only on the server until the reveal.

## Files

| Path | Purpose |
|---|---|
| `lib/engine.ts` | Pure game rules and state machine |
| `lib/service.ts` | Load → apply → save with retries; the API operations |
| `lib/store.ts` | Supabase store (+ in-memory for local dev) |
| `app/api/game/route.ts` | The single API endpoint |
| `app/page.tsx`, `app/room/[code]/page.tsx` | Home and game UI |
| `supabase/schema.sql` | Table, row-level security, presence function |
| `tests/simulate.ts` | End-to-end game simulation |
