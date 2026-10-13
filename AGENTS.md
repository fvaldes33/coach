# coach — agent instructions

> **Coach worker (COACH_BRIDGE=1, cwd `coach/`): this file is developer docs. Ignore it and follow `coach/AGENTS.md`.**

This is a [Spectrum](https://photon.codes/docs/spectrum-ts) app, pinned to `spectrum-ts@^12.10.1`: an LLM nutrition coach over iMessage.

## Architecture

- `src/index.ts`: the bridge daemon. Allowlisted senders (`config.json`) get a 👀 ack, and 5 s bursts are debounced into one turn. Photos land in `data/inbox/` (HEIC→JPEG via `sips`) and barcodes are decoded locally (zxing-wasm). Missed messages are swept on boot. A reply Photon refuses (e.g. its daily send limit) goes to `data/outbox.json` and is retried with backoff (1 → 15 min). Once sending works, one waiting reply is resent as-is; several become one catch-up text the coach writes. Scheduled nudges (`src/bridge/nudger.ts`, per-profile `nudges.json`) are never retried. The coach keeps durable notes per person in `data/profiles/<id>/memory.md` (`coach memory`), included in every prompt. The process exits non-zero on stream failure so launchd relaunches it.
- `src/bridge/router.ts`: TypeSafe/Jev intent routing, one ~200 ms call. A confident "where am I today/yesterday?" goes straight to the deterministic dashboard (no LLM). Everything else goes to the worker with the intent as a hint.
- **Profiles:** each allowlisted person in `config.json` has an `id`. `data/profiles/<id>/` holds their own `coach.db`, photo inbox, and dashboards. The bridge only touches a person's data through `bin/coach` with `COACH_PROFILE=<id>` (`src/bridge/coachcli.ts`), and a reply can only attach files from inside that person's profile dir.
- `src/bridge/worker.ts`: a headless `claude -p` (default) or `codex exec` (`COACH_WORKER=codex`) running in `coach/` with `COACH_PROFILE` set. It resumes ONE long session per person (`data/sessions.json`, key `<worker>:<id>`). The CLI's own compaction keeps the thread going. Each person's jobs run one at a time; different people run in parallel (`src/bridge/jobs.ts`).
- `coach/AGENTS.md`: the worker's nutritionist brief and output contract (`REPLY:` + `FILE:` lines).
- `src/cli.ts` (`bin/coach`): the only interface the worker uses. It covers the per-profile SQLite log, Open Food Facts / UPCitemdb / USDA FDC lookups, the personal food library, gut symptoms, goals, and the dashboard.
- `src/core/dashboard.ts`: an SVG dashboard rasterised to PNG with resvg (no browser).

## Working in this project

- Run in the foreground with `bun start`. As a daemon: `daemon/daemon.sh install|restart|status|logs` (restart typechecks first).
- Poke the log by hand with `bin/coach help`. It defaults to the `me` profile. Use `COACH_PROFILE=<id>` for someone else, or `COACH_DB=/tmp/x.db` to experiment without touching a real log.
- Add providers by importing them in `src/index.ts` and listing them in the `Spectrum({ providers: [...] })` config.
- Outgoing message content uses the builders documented in the skill (text, attachment, voice, contact, richlink, poll, group, custom).

## Environment

This project reads secrets from `.env` (gitignored). **Do not read, write, or echo `.env`** — it contains credentials.

If startup fails with an authentication error, tell the user to verify their `PROJECT_ID` / `PROJECT_SECRET` at the [Photon dashboard](https://app.photon.codes).

## Spectrum SDK reference

This project includes the `spectrum` skill from [`photon-hq/skills`](https://github.com/photon-hq/skills). Your agent should auto-discover it. If it doesn't, or if you switch agents, install for your agent with:

```sh
npx skills add photon-hq/skills --skill spectrum --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

## Managing the Spectrum Cloud project (CLI)

If this app uses a platform provider, the `PROJECT_ID` / `PROJECT_SECRET` in `.env` belong to a **Spectrum Cloud** project. To manage that project from the terminal — authenticate, rotate the secret, list the line(s) you send from, manage platforms/users, or create more projects — use the `photon-cli` skill (the `photon` CLI) from [`photon-hq/skills`](https://github.com/photon-hq/skills):

```sh
npx skills add photon-hq/skills --skill photon-cli --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

Common tasks once it's installed:

- `photon whoami` — confirm you're authenticated (run `photon login` if not).
- `photon projects regenerate-secret` — rotate the Spectrum API secret (then update `PROJECT_SECRET` in `.env`).
- `photon spectrum lines list` — see the line(s) your app sends from.
- `photon projects show` — inspect the active project (set `PHOTON_PROJECT_ID`, or pass `--project <id>`).

## See also

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [`spectrum-ts` on GitHub](https://github.com/photon-hq/spectrum-ts)
