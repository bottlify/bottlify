# Roadmap

Two kinds of document, in two directories, because they are consulted differently.

- **`phases-history.md`** — what used to be eleven separate documents under `phases/`, one per
  phase, folded into one file once every phase had been carried out past what its own document
  said. Kept for the decisions still in force and the reasoning behind them; the day-to-day plans
  and step lists are compressed to what was decided and when it landed, by commit.
- **`registers/`** — what is consulted throughout and belongs to no phase: the knowledge registers,
  and two standing plans for work that spans phases.

Three `00-*` files sit beside these and **are not in git** (`.gitignore` excludes `roadmap/00-*`):
the follow-ups roadmap — what is decided and not yet built after the phased plan — the
register of pitfalls that each cost weeks, required reading before touching the kernel, bridge,
graphics or audio layers — and `00-TODO-list.md`, the current follow-ups list drawn from staff
reports and review audits. A fresh clone has everything here except those files. Nothing else depends
on having read them: `phases-history.md` states the scope and acceptance criteria each phase
inherited, the same as the documents it replaced.

## The phases

Phases 0 through 5 are closed; installers (8) and networking (9) are areas of ongoing work rather
than phases with a document of their own, each with its own standing plan register
(`registers/process-creation.md` for what installers are blocked on); Warcraft III's bring-up (10)
and the generated-code/frame-budget work (11) are both active. **See
[`phases-history.md`](phases-history.md)** for what every phase decided and how far each has come;
open scope from any of them lives in `00-TODO-list.md`.

## The registers

| document | what it is |
|---|---|
| `registers/carried-knowledge.md` | Defects and mechanisms established by earlier work on this problem, so they are not rediscovered. |
| `registers/defects-carried-forward.md` | The narrower half of the above: each entry checked against *this* tree's source and marked live, gap, satisfied or unchecked. |
| `registers/decisions-and-optimisations.md` | Behaviour we decided rather than established (A), and where the correct implementation is knowingly the slow one (B). |
| `registers/porting.md` | What has been rebuilt here, what deliberately will not be, and what remains. A checklist, expected to shrink. |
| `registers/process-creation.md` | A standing plan: how `CreateProcess` works. The replacement model is built and two installers (Mafia, NFSU2's SFX stage) have run through it; what blocks Phase 8's later stages now is the case the register calls "two machines" — a parent that must resume after its child rather than being replaced by it (Battlefield 2). |
| `registers/ui-quick-start.md` | A standing plan for the product UI, which is built and lives outside this repository. |

## How to work with these

`phases-history.md` records the decisions each phase took and what is still true about them; it
is a history, not a working plan, so a decision made while implementing new work belongs in the
relevant register or in `00-TODO-list.md`, not appended there. When landed work overtakes a claim
anywhere in this directory, correct the claim in place and say what changed — a plan nobody trusts
is worse than no plan.

For the engine's own documentation — the module contract, the layer layout, what each layer does and
does not do today — see [`docs/core/`](../docs/core/).
