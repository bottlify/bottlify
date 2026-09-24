# Roadmap

Two tracked documents, because they are consulted differently, plus the local working notes.

- **`phases-history.md`** — what used to be eleven separate documents under `phases/`, one per
  phase, folded into one file once every phase had been carried out past what its own document
  said. Kept for the decisions still in force and the reasoning behind them; the day-to-day plans
  and step lists are compressed to what was decided and when it landed, by commit. Also carries
  "Process creation", a cross-cutting mechanism that outgrew any one phase.
- **`decisions.md`** — behaviour this project chose rather than derived from a specification (a
  refusal, a capability claim, a calling convention, a caching scheme), each with its reason and
  the commit it landed in. Consulted throughout, not phase by phase — this is what used to be six
  separate knowledge/planning registers under `registers/`, sorted by what each entry actually was
  (see "Where the registers went" below).

- **`cork-x86-translator.md`** — the design and milestones of *cork*, the user-mode x86 → wasm
  translator that replaces the vendored emulator behind the `cpu` layer: why the emulator's
  throughput is structural, what is taken from it (knowledge and test data), what is left out,
  the architecture, the hybrid/differential migration, and what it changes for media.
- **`cork-plan.md`** — the step-by-step integration plan for cork: five milestones broken into
  steps of at most a day, each with its files, contracts, tests, acceptance number and what could
  go wrong; written against the design above, ending with cork as the default engine and the
  emulator an optional layer chosen per bundle launch, with the seams for x86-64 named.

The `00-*` files beside these are **not in git** (`.gitignore` excludes `roadmap/00-*`):
`00-TODO-list.md` is an index of them -- the week's goal and one file per area (cork, v86,
graphics, win32 and kernel, audio and input, installers and bundles, diagnostics), each holding
that area's open work and then its pitfalls, the ones that each cost weeks and are required reading
before touching the kernel, bridge, graphics or audio layers -- beside `00-product-plan.md`, what
is decided and not yet built around the engine, and `00-references.md`.
A fresh clone has everything here except those files. Nothing else depends
on having read them: `phases-history.md` states the scope and acceptance criteria each phase
inherited, the same as the documents it replaced.

## The phases

Phases 0 through 5 are closed; installers (8) and networking (9) are areas of ongoing work rather
than phases with a document of their own; Warcraft III's bring-up (10) and the generated-code/
frame-budget work (11) are both active. **See [`phases-history.md`](phases-history.md)** for what
every phase decided and how far each has come; open scope from any of them lives in
`00-TODO-list.md`.

## Where the registers went

`registers/` — six files, none of them a phase document — used to hold everything consulted
throughout rather than worked through in order. Each was read in full and every entry sorted by
what it actually was, once, rather than kept as a directory nobody could describe the purpose of:

- A **decision** this project made, with its reason, is in `decisions.md` now.
- **Work** — an open defect, an optimisation still to take, a piece of the earlier tree still to
  port — is in `00-TODO-list.md` (local), marked `[из реестра <file>]`.
- A **lesson from the earlier tree** (a mechanism, a defect it paid for) is in `00-pitfalls.md`
  (local) — local because `CLAUDE.md` bars a predecessor mention from anything tracked, and these
  three files carried them: `carried-knowledge.md`, `defects-carried-forward.md`, `porting.md`.
- **History** — a design carried out, a plan executed or abandoned — is folded into
  `phases-history.md`: `process-creation.md`'s design and build are the new "Process creation"
  section there; `ui-quick-start.md`, entirely built by the time it was read, is the "UI: quick
  start" section; the measured half of `decisions-and-optimisations.md` (cause found, fix landed,
  before/after numbers) is folded into whichever phase it measured, mostly Phase 11.

## How to work with these

`phases-history.md` records the decisions each phase took and what is still true about them, and
`decisions.md` records the decisions that don't belong to one phase; both are history, not a
working plan, so a decision made while implementing new work belongs in `decisions.md` directly
(new entry, same format: decision, reason, commit) or in `00-TODO-list.md` if it isn't decided yet.
When landed work overtakes a claim in either file, correct the claim in place and say what
changed — a plan nobody trusts is worse than no plan.

For the engine's own documentation — the module contract, the layer layout, what each layer does and
does not do today — see [`docs/core/`](../docs/core/).
