# Bottlify

Bottlify runs original Win32 x86 games in the browser: a forked [v86](https://github.com/mrwayer/v86)
for x86 emulation in a Web Worker, plus a from-scratch Win32/DirectX HLE layer targeting
WebGPU/WebAudio/OPFS. No plugins, no install, no server in the render path.

**Status: Phase 1 — a 32-bit Windows executable runs.** No BIOS is involved: a 64 KiB ROM of our own
takes the CPU straight into protected mode, a PE32 image is mapped and its imports bound to stubs
that trap into the host, and a minimal kernel32 lets the program write to stdout and exit. The same
binary produces the same output under real Windows, which is how the runtime is checked.

Still stubs: threads and scheduling, the full call bridge, filesystem, graphics, audio, input. See
`docs/core/` for what each layer does and does not do, and `CLAUDE.md` for the architecture and
workflow.

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
