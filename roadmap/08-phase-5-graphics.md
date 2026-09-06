# 08 — Phase 5: graphics. Roadmap

> Working document for the phase. Source of truth is `00-bottlify-master-plan.md` (below: Master
> Plan), whose §14 is the register of graphics pitfalls and is required reading before touching
> anything here. Phase 4 is `07-phase-4-filesystem-and-sessions.md`.

## 0. What this phase is, and why it is organised differently

Every earlier phase was one thing built once. This one is five guest-facing APIs over one backend,
and it is the largest single body of work in the project — for scale, a comparable implementation
runs to roughly forty thousand lines for DirectDraw and D3D7 alone.

So it is planned as **parallel streams over a shared backend**, not as a sequence. Each API is a
directory nobody else edits, with its own contract tests; the backend and the plumbing between them
belong to whoever is assembling. That split is the plan, and the rest of this document exists to
make the streams genuinely independent.

**Nothing here draws until the contract tests exist.** That is not ceremony. The conformance corpus
described in §2 pins down hundreds of behaviours that are cheap to satisfy while writing and
expensive to retrofit — object lifetimes, error codes, default state — and almost all of it can be
tested with no rendering at all.

## 1. The layout

```
modules/core/src/layers/graphics/
├── webgpu/       our own device, surfaces, presentation, composition — no guest DLL
├── gdi/          BitBlt/StretchBlt: the drawing half of gdi32 (§3 of docs/core/infrastructure.md)
├── ddraw/        surfaces, blitting, palettes, mode setting, flip chains
├── d3d7/         on top of ddraw
├── d3d8/
├── d3d9/
├── opengl/
└── glide/        lowest priority, "as needed"
```

`graphics` requires `win32`, `bridge` and `memory`. It does not require `cpu`: what it needs from
the emulator arrives injected, the way the filesystem's stores do.

Two structural facts, both learned from how the same problem was solved elsewhere:

- **The backend has no tests of its own.** Its contract is only observable through the guest-facing
  facades, and that is where it is checked. A separate "backend test" tests our idea of the backend
  rather than what a program sees.
- **The same scenario is tested once per interface version.** DirectDraw's four interface
  generations are not one API with a version field; their expectations genuinely differ, and the
  differences *are* the version semantics. Four near-parallel suites is the right shape, not
  duplication to be factored out.

## 2. Where the contract comes from

Wine's conformance tests are the specification for this phase. Across ddraw, d3d8, d3d9 and
opengl32 they are about 160 000 lines and **~30 500 individual assertions**, and they encode what
these APIs actually do — which argument combinations fail and with which code, what state a fresh
device has, what happens when a resource is released while still bound.

**What we take is the expectation, never the expression.** The tests are LGPL-2.1+; their structure,
their helpers, their message texts and their ordering are Wine's work and are not copied or
translated. That an unpaired `EndScene` returns `D3DERR_INVALIDCALL` is a fact about a Microsoft
product, established by measurement, and belongs to nobody. We write our own tests, in our own
style, asserting the same facts.

Three things about how to read that corpus correctly:

- **`todo_wine` is a reliable map, not a stale comment.** A todo assertion that unexpectedly passes
  is *also* counted a failure, so the list is kept exact by force. Where Wine marks todo, expect
  trouble.
- **`broken(...)` is not the contract.** It records what a particular Windows version or driver did.
  Do not implement it — except where a comment says programs depend on the lenient behaviour, in
  which case choose the lenient one. Accepting a malformed lock rectangle is the documented example.
- **Many expectations are conditional on reported capabilities.** An expectation carried across
  without its condition freezes an arbitrary branch. Take the condition too.

A single `THIRD-PARTY-NOTICES.md` entry covers this phase: the boundary-case sets and validity
tables are *derived from* expectations recorded in Wine's conformance tests; no code is taken. One
entry for the phase, added with the first stream that lands.

## 3. What Wine itself does not pass, and what that means for us

The todo clusters divide into three, and confusing them makes the map useless.

**Where we should be better than Wine.** `test_window_style` (23 todo in *each* of the four ddraw
suites), `test_wndproc`, `test_coop_level_mode_set`, `test_cursor_clipping`, `test_window_position`
— nearly all of it is Wine not controlling the window manager. Our window manager is ours. These
expectations are fully reachable for us, and "the game runs but the window is the wrong size and the
mouse drifts" is a standard bring-up symptom, so this is worth taking deliberately rather than
inheriting the excuse.

**Where we will hit exactly the same wall.** These four get contract tests first:

| cluster | todo | what it is |
|---|---|---|
| `test_enum_devices_caps_callback` | 18 → 34 → 57 across ddraw versions | With no 3D device present, the HAL description must be *entirely zeroed*. For us the sharper question is whether our single backend announces itself as HAL or HEL, and what the other structure then holds. Games branch on this — decide before `d3d7/`. |
| `test_caps` | 9, identically in all four ddraw suites | Capability reporting. Easy to over-claim, and an over-claim fails deep inside a game rather than at the call. |
| `test_check_device_format` | 6 in d3d8, 6 in d3d9 | Which formats to announce, with which usage flags. Probably our worst cluster: the WebGPU format set and the D3D9 format set overlap only partly. |
| `test_surface_attachment`, `test_clipper_refcount` | 4-6 each, every version | Ownership. Attachment rules, what a Release detaches, who holds what. Ownership mistakes are the ones that get rewritten with the whole layer. |

Also expect trouble at `test_resource_access` (the pool×usage table — Wine fails several rows even
with the table in front of it), `test_depthbias` and `test_filling_convention`.

**Out of scope entirely:** `test_d3d9on12`, `test_shader_validator`, `test_pbuffers` (32 todo, but
pbuffers are a dead WGL mechanism), 16-bit DIB rendering. From opengl32 the relevant clusters are
`test_dc`, `test_framebuffer`, `test_sharelists` and `test_bitmap_rendering` — the WGL↔GDI seam,
which for us is the seam between `graphics/opengl/` and `graphics/gdi/`.

## 4. Steps

### P5.0 — the contract tests, before anything renders

All of these run against objects and state with no drawing at all, which is why they come first.
Order within the step matters and is by how expensive the mistake is to unwind:

1. **DirectDraw ownership.** Interface generations do *not* share a reference count — after four
   `QueryInterface` calls each of the four has a count of one, which violates the usual COM rule and
   is the single biggest trap in the API. `IDirectDrawX` and `IDirect3DX` *are* linked. Creating a
   surface or a palette increments the ddraw object; `SetPalette` increments the palette, not the
   surface; releasing a surface detaches its palette and decrements it. Aggregation is checked
   before cooperative level.
2. **The scene state machine.** `EndScene` unpaired → `INVALIDCALL`; a nested `BeginScene` fails but
   leaves the counter alone, so the following `EndScene` succeeds; `Reset` clears scene state.
   Eight assertions, the best ratio of defect-caught to effort in the whole list.
3. **Default device state.** About sixty-five render states with documented values, plus the fact
   that reading a light before writing one returns `INVALIDCALL` rather than a default — the light
   array starts empty, not populated.
4. **Lock discipline.** Double `Lock` → `INVALIDCALL` *with the output structure left untouched*;
   `Unlock` before `Lock` → `INVALIDCALL`; double `Unlock` → `D3D_OK` for a surface obtained from a
   texture but `INVALIDCALL` for offscreen-plain and cube faces. That asymmetry cannot be derived
   from documentation. In DirectDraw the same double lock is `DDERR_SURFACEBUSY`, and the failed
   lock must leave the surface pointer null.
5. **Lock ↔ GetDC, which is not a symmetric mutex.** `GetDC` twice → `DDERR_DCALREADYCREATED` with
   the output handle untouched; `GetDC` held then `Lock` → `DDERR_SURFACEBUSY`; but `Lock` held then
   `GetDC` → *succeeds*. A single busy flag passes three of four.
6. **Pointer arithmetic of a partial lock.** `pBits - base == top * Pitch + left * bpp`, and `Pitch`
   does not change.
7. **Validity tables**: pool × usage × surface type, and swap-chain parameters (`COPY` allows zero
   or one back buffer but not two; `DISCARD`/`FLIP` allow up to three).
8. **Reference-count contract of d3d8/d3d9**: `Set*` never adds a reference; `Get*` of an implicit
   resource increments the *device*; render target and back buffer zero are the same pointer; a
   texture and its surface level share one count; `AddRef` on an implicit surface at zero is legal.
   And `GetStreamSource` after unbinding keeps the previous stride.
9. **Flip-chain topology**: front → bb1 → bb2 → bb3 → front; `dwBackBufferCount` non-zero only on
   the front buffer; `Flip` on a back buffer, on a foreign surface, or on itself → `NOTFLIPPABLE`.

**Every one of these ends by asserting the device's reference count reached zero.** That is Wine's
habit and it is worth copying wholesale: for us it doubles as a GPU-resource leak detector in every
contract test, for free.

**Done when:** the tests exist and fail honestly against empty implementations.

### P5.1 — the WebGPU backend

Device, surfaces, presentation, composition. Written against an injected device so it is testable
headless. §14.1 through §14.4 and §14.11 through §14.16 of the Master Plan are the specification
for its internals — every one of them is a defect that has already cost somebody weeks, and each
becomes an executable assertion here rather than a comment.

Two that are easy to miss because nothing reports them: call `getCompilationInfo()` after every
shader module build (§14.14), and never let a diagnostic read-back bypass the composition the user
sees (§14.13).

### P5.2 — DirectDraw

Surfaces, blitting, palettes, mode setting, clippers, flip chains. The largest single API here.

The seam to `graphics/gdi/` matters more than it looks: `GetDC` on a surface must yield a real
DIB section with specific field values, and games get a DC and draw into it with GDI.

### P5.3 — Direct3D 7, on top of DirectDraw

Where the HAL/HEL decision from §3 lands.

### P5.4 — Direct3D 8

Inherits both viewport conventions if the two executors are not unified — see Master Plan §14.10.
Decide the viewport contract once, for the whole backend, before this stream starts.

### P5.5 — Direct3D 9

The largest test corpus and the best-documented behaviour. Also where a fixed-function draw with a
pixel shader bound but no vertex shader must not fall into the fixed-function path (§14 register).

### P5.6 — OpenGL 1.x/2.x

The WGL↔GDI seam is the interesting part; the rest is a well-trodden API.

### P5.7 — Glide

Only if something needs it.

## 5. What each stream is given, and what it may not touch

- One directory. Nothing outside it, ever — the assembling stream wires the backend, the module
  table and the layer graph.
- The contract tests for its API, from §2, written first.
- The Master Plan's §14 in full. It is not background reading; it is the list of ways this exact
  work has already gone wrong.
- The rule that no test may assert a frame is correct by looking at it. Compare pixels numerically,
  with a per-channel tolerance, at named coordinates — which is exactly what the conformance corpus
  does, and it is far cheaper than reference images.

## 6. What this phase deliberately does not do

- **No audio, no input.** They are their own phases and their own streams.
- **No per-game work.** A title that misbehaves is a signal about a generic contract; that is rule 4
  and it applies here more than anywhere, because graphics is where the temptation is strongest.
- **No reference screenshots as the primary check.** Numerical pixel comparison at named points
  first; whole-frame comparison only where a defect is genuinely positional (§14.9).
