# Bottlify

Bottlify runs original Win32 x86 games in the browser: a forked [v86](https://github.com/mrwayer/v86)
for x86 emulation in a Web Worker, plus a from-scratch Win32/DirectX HLE layer targeting
WebGPU/WebAudio/OPFS. No plugins, no install, no server in the render path.

**Status: Phase 5 — graphics.** Phases 0 through 4 are closed and no layer is a stub any more.

No BIOS is involved: a 64 KiB ROM of our own takes the CPU straight into protected mode, PE32 images
are mapped and their imports bound to stubs that trap into the host, and a real in-guest module is
synthesised per system library so an address from `GetProcAddress` is the one an import was bound to.
Threads run under a scheduler whose quantum is retired guest instructions. The bridge marshals
stdcall and cdecl, parks a caller that cannot be answered yet, calls back into guest code, and puts
COM interfaces into guest memory. Files come out of a mounted bundle over a virtual volume, and a
session persists what a program wrote. Around nine hundred Win32 functions are implemented across
kernel32, user32, gdi32, advapi32, ole32, ntdll, msvcrt and a dozen more.

Graphics is the phase in progress: the WebGPU backend, GDI's drawing half, DirectDraw and Direct3D 7
are done, Direct3D 8 is most of the way, and Direct3D 9, OpenGL and Direct3D 10 have their object
models but no guest-facing seam yet. **Nothing has drawn on a real GPU** — the whole path is verified
against the project's own model, which is the largest open risk and is tracked as such.

See `docs/core/` for what each layer does and does not do.

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
