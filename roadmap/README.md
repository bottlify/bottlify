# Roadmap

One document per phase, numbered in sequence with the phase in the filename:

| document | phase | state |
|---|---|---|
| `01-phase-0-skeleton.md` | Phase 0 — repository, build, CI, module system, browser harness | done |
| `02-phase-0-core-module.md` | Phase 0 — the `@bottlify/core` package itself | done |
| `03-phase-1-cpu-memory-loader.md` | Phase 1 — CPU, memory, PE loader, minimal kernel32 | done |
| `04-phase-2-threads-and-scheduler.md` | Phase 2 — threads, scheduler, synchronization | active |

Each one records the decisions taken on entry, the steps with their acceptance criteria, what is
deliberately out of scope, and the questions still open. They are working documents: a decision made
while implementing belongs here, not in a commit message or a comment.

These documents refer to a **master plan** that is kept privately and is not part of this
repository. It holds the product model, the long-range phase order and a register of hard-won
pitfalls. Nothing here depends on having read it: each phase document states the scope and
acceptance criteria it inherited, so a reader without the master plan can still tell what a phase
must deliver and why.

For the engine's own documentation — the module contract, the layer layout, what each layer does and
does not do today — see [`docs/core/`](../docs/core/).
