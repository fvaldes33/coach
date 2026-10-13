# coach

A nutrition coach I text. It's a Claude Code (or Codex) session on my Mac, reached over iMessage, with a small CLI over SQLite as its only tool.

Text it what you ate ("3 scrambled eggs, 2 Kodiak waffles, some fruit"), or send a photo of the meal, label, or barcode. It looks up real nutrition data and logs calories, macros, fiber, micronutrients, and gut-relevant tags. Then it tells you where you stand for the day. Ask "where am I today?" and you get a dashboard image back.

```
you:   3 scrambled eggs, 2 kodiak power waffles, some berries
coach: Logged breakfast: 3 scrambled eggs (+1 tsp butter), 2 Kodiak Power Waffles, ~1 cup berries
       ≈ 598 kcal · P 32 · C 49 · F 32 · Fiber 7
       Today: 1,283 kcal · P 84/180 · Fiber 20/35
       What fruit was it, roughly how much?
```

## The interesting parts

If you only want to steal the idea, read these two:

- **[`coach/AGENTS.md`](coach/AGENTS.md): the coach's brief.** It covers where numbers come from: your own food library first, then official brand or barcode data, then USDA for whole foods. It also has rules for ambiguity, a kcal ≈ 4P + 4C + 9F sanity check on every entry, cooking fat, movement (screenshot numbers, MET estimates), gut-symptom pattern finding, durable memory about the person, and scheduled check-ins. It works as a prompt for any agent, even without the rest of this repo.
- **[`src/cli.ts`](src/cli.ts) (`bin/coach`): the only interface the agent has.** It wraps a SQLite log with JSON in and JSON out, plus Open Food Facts, UPCitemdb, and USDA FoodData Central lookups, a personal food library, goals (min / max / target), symptoms, measurements, notes, and nudges. The agent never touches the database directly. Try it with `bin/coach help`.

Everything else is plumbing to make it feel like texting a person:

- **Bridge** (`src/index.ts`, `src/bridge/`): iMessage via [Spectrum](https://photon.codes/docs/spectrum-ts). It only answers allowlisted senders, and only in 1:1 chats. It acks with 👀 and debounces message bursts into one turn. It sweeps messages it missed while down, and queues replies that can't be sent yet and retries them with backoff. Each person gets one long-running agent session that the bridge resumes.
- **Routing** (`src/bridge/router.ts`): a fast intent call ([TypeSafe](https://typesafe.ai) / Jev, optional). "Where am I today?" skips the LLM and renders the dashboard directly.
- **Dashboard** (`src/core/dashboard.ts`): SVG rasterised to PNG with resvg, no browser.
- **Barcodes**: decoded locally with zxing-wasm before the agent ever sees the photo.
- **Profiles**: several people can use the same coach. Each gets their own database, photos, notes, and session. The agent is scoped to one profile per turn and can't read anyone else's.

## Running it

You need a Mac (iMessage, `sips` for HEIC photos), [Bun](https://bun.sh), [Claude Code](https://claude.com/claude-code) or Codex CLI logged in, and a [Photon](https://app.photon.codes) project for iMessage.

```sh
bun install
cp .env.example .env                 # PROJECT_ID / PROJECT_SECRET, optional TYPESAFE_API_KEY, USDA_API_KEY
cp config.example.json config.json   # who the coach talks to (phone/email + profile id)
bun start                            # foreground
daemon/daemon.sh install             # or: launchd, auto-restart
```

`COACH_WORKER=codex` switches the worker to Codex, and `COACH_WORKER_MODEL` overrides the model.

To use the log without iMessage, run `bin/coach` directly or point any agent at `coach/` and let it follow `coach/AGENTS.md`. Set `COACH_DB=/tmp/x.db` to experiment against a scratch database.

All data stays local in `data/` (gitignored).

See [`AGENTS.md`](AGENTS.md) for architecture notes.

## License

MIT
