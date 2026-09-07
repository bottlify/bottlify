# Roadmap

One document per phase, numbered in sequence with the phase in the filename, followed by the
registers and working plans that are not phases.

| document | phase | state |
|---|---|---|
| `01-phase-0-skeleton.md` | Phase 0 — repository, build, CI, module system, browser harness | completed |
| `02-phase-0-core-module.md` | Phase 0 — the `@bottlify/core` package itself | completed |
| `03-phase-1-cpu-memory-loader.md` | Phase 1 — CPU, memory, PE loader, minimal kernel32 | completed |
| `04-phase-2-threads-and-scheduler.md` | Phase 2 — threads, scheduler, synchronisation | completed |
| `06-phase-3-bridge-and-win32.md` | Phase 3 — the call bridge and the Win32 surface | completed |
| `07-phase-4-filesystem-and-sessions.md` | Phase 4 — filesystem, bundles and sessions | completed |
| `08-phase-5-graphics.md` | Phase 5 — every drawing API over one WebGPU backend | **active** |

Within Phase 5: the backend, GDI's drawing half, DirectDraw and Direct3D 7 are done and Direct3D 8
is most of the way. Direct3D 9, OpenGL and Direct3D 10 have object models and contract tests but no
guest-facing seam. Nothing has yet drawn on a real GPU.

The rest are not phases:

| document | what it is |
|---|---|
| `05-ui-quick-start.md` | A first pass at the product UI, so there is something to click. |
| `09-process-creation.md` | A decision recorded in full; nothing implements it yet. |
| `10-carried-knowledge.md` | Defects and mechanisms established by earlier work on this problem. |
| `11-porting-register.md` | What is rebuilt, what deliberately will not be, and what remains. |
| `12-decisions-and-optimisations.md` | Behaviour we decided rather than established, and where we know we are slow. |
| `13-war3-bring-up.md` | **Active.** Bringing up the first target title, written from measurement. |

Each phase document records the decisions taken on entry, the steps with their acceptance criteria,
what is deliberately out of scope, and the questions still open. They are working documents: a
decision made while implementing belongs here, not in a commit message or a comment.

These documents refer to a **master plan** that is kept privately and is not part of this
repository. It holds the product model, the long-range phase order and a register of hard-won
pitfalls. Nothing here depends on having read it: each phase document states the scope and
acceptance criteria it inherited, so a reader without the master plan can still tell what a phase
must deliver and why.

For the engine's own documentation — the module contract, the layer layout, what each layer does and
does not do today — see [`docs/core/`](../docs/core/).
