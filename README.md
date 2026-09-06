# Bottlify

Bottlify runs original Win32 x86 games in the browser: a forked [v86](https://github.com/mrwayer/v86)
for x86 emulation in a Web Worker, plus a from-scratch Win32/DirectX HLE layer targeting
WebGPU/WebAudio/OPFS. No plugins, no install, no server in the render path.

**Status: Phase 0 — Skeleton.** The module system, dependency graph, and vendored v86 are in place;
every engine layer (cpu, memory, kernel, bridge, loader, win32, graphics, audio, input) exists as a
`NOT_IMPLEMENTED` stub with its real `requires` wired up. No x86 instruction executes yet — that's
Phase 1. See `CLAUDE.md` for the architecture, principles, and workflow, and `docs/core/` for
`@bottlify/core`'s module contract and current limitations.

## Quick start

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run check:boundaries && npm run build
npm run cdp:probe   # boots the core in a real browser, checks the worker answers ping
```

Building the vendored v86 from source requires Docker (`npm run build:v86 -- --docker`, then
`npm run verify:reproducibility`) — everyday development doesn't need it, since `dist/vendor/`
artifacts aren't rebuilt on every change.

## Layout

- `modules/core/` — `@bottlify/core`, the engine package (npm workspace).
- `tools/cdp_test/` — dev-only CDP harness used by `npm run cdp:probe`.
- `docs/core/` — durable documentation of the core module contract and its current state.

Licenses for vendored components: `THIRD-PARTY-NOTICES.md`.
