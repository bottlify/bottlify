# Roadmap

Two kinds of document, in two directories, because they are consulted differently.

- **`phases/`** — the phases, in order. One document per phase, **named for its phase number**, not
  for its position in a sequence. That is deliberate: a phase document is written when the phase is
  entered, which is not the order the phases were planned in, and a global sequence number meant
  renumbering everything to insert one. `phase-8-installers.md` is Phase 8 wherever it was written.
- **`registers/`** — what is consulted throughout and belongs to no phase: the knowledge registers,
  and two standing plans for work that spans phases.

`00-bottlify-master-plan.md` sits above both and is the source of truth: product model,
architecture, the whole phase list, and Part IV — the register of pitfalls that each cost weeks and
is required reading before touching the kernel, bridge, graphics or audio layers. **It is not in
git** (`.gitignore` excludes `roadmap/00-*`), so a fresh clone has everything here except that file.
Nothing else depends on having read it: each phase document states the scope and acceptance criteria
it inherited.

## The phases

| document | phase | state |
|---|---|---|
| `phases/phase-0-skeleton.md` | Phase 0 — repository, build, CI, module system, browser harness | closed |
| `phases/phase-0-core-module.md` | Phase 0 — the `@bottlify/core` package itself | closed |
| `phases/phase-1-cpu-memory-loader.md` | Phase 1 — CPU, memory, PE loader, minimal kernel32 | closed |
| `phases/phase-2-threads-and-scheduler.md` | Phase 2 — threads, scheduler, synchronisation | closed |
| `phases/phase-3-bridge-and-win32.md` | Phase 3 — the call bridge and the Win32 surface | closed |
| `phases/phase-4-filesystem-and-sessions.md` | Phase 4 — filesystem, bundles and sessions | closed |
| `phases/phase-5-graphics.md` | Phase 5 — every drawing API over one WebGPU backend | **active** |
| — | Phase 6 — audio | partly built, no document |
| — | Phase 7 — input | partly built, no document |
| `phases/phase-8-installers.md` | Phase 8 — acquiring a game: the bundler's input side | partly built |
| `phases/phase-9-networking.md` | Phase 9 — Winsock, the transport seam, the relay | partly built |
| `phases/phase-10-warcraft-iii.md` | Phase 10 — titles: bringing up the first one | **active** |
| `phases/phase-11-generated-code.md` | Phase 11 — the generated code, and the frame it has to fit in | **active** |

The order in the master plan is the plan, not a queue anyone is standing in. Phases 6 to 9 have work
landed in them while Phase 5 is still open, because a title asks for what it asks for. Where a phase
has no document, the master plan's Part III entry is all there is.

**Phase 5** — the backend, GDI's drawing half and DirectDraw are done; Direct3D 7, 8, 9 and 10,
OpenGL and Vulkan all have guest-facing seams; Direct3D 8 is the one that has drawn a real title,
the rest are verified by tests; Glide is not started. Pixels have reached a real GPU.

**Phase 10** — Warcraft III runs in a browser on a real GPU and draws its main menu. This is the
phase that decides what the others do next.

## The registers

| document | what it is |
|---|---|
| `registers/carried-knowledge.md` | Defects and mechanisms established by earlier work on this problem, so they are not rediscovered. |
| `registers/defects-carried-forward.md` | The narrower half of the above: each entry checked against *this* tree's source and marked live, gap, satisfied or unchecked. |
| `registers/decisions-and-optimisations.md` | Behaviour we decided rather than established (A), and where the correct implementation is knowingly the slow one (B). |
| `registers/porting.md` | What has been rebuilt here, what deliberately will not be, and what remains. A checklist, expected to shrink. |
| `registers/process-creation.md` | A standing plan: how `CreateProcess` will work. Being implemented as this index was written; Phase 8's later stages are blocked on it. |
| `registers/ui-quick-start.md` | A standing plan for the product UI, which is built and lives outside this repository. |

## How to work with these

A phase document records the decisions taken on entry, the steps with their acceptance criteria,
what is deliberately out of scope, and the questions still open. They are working documents: a
decision made while implementing belongs here, not in a commit message or a comment. When landed
work overtakes a claim, correct the claim in place and say what changed — a plan nobody trusts is
worse than no plan.

For the engine's own documentation — the module contract, the layer layout, what each layer does and
does not do today — see [`docs/core/`](../docs/core/).
