# UI: quick start

> A small, deliberately shallow first pass at the product UI, so there is something to click while
> the engine grows. Not a phase of the engine: it can be built and thrown away without the runtime
> noticing, and that independence is the point.
>
> **Status: built, and it moved.** It lives at `ui/` in the working copy rather than in
> `modules/ui`, is outside the npm workspaces, and is gitignored — the application ships from its own
> place, with its own assets and their own attribution. U1 through U4 are done; the session view
> shows a real canvas rather than the placeholder §2 described, and there is an install screen §4
> explicitly excluded (`../phases-history.md` (Phase 8), behind `allowInstall`). The decisions in
> §1 held; the location row below is corrected in place, and the rest is kept as written.

## 0. What this is

A React application that lets someone pick an application from a catalogue and run it, built on the
public `@bottlify/core` surface and nothing else.

Scope is intentionally small: three views, no accounts, no server, no persistence beyond the
browser. It exists to make the engine usable by hand and to prove the public API is actually enough
to build on — if the UI has to reach past `createApp` to get something done, that is a defect in the
API, not a reason to reach.

## 1. Decisions fixed on entry

| decision | value | consequence |
|---|---|---|
| where it lives | `ui/` as `@bottlify/ui`, a separate package outside the workspaces (planned as `modules/ui`; moved out so it ships from its own place) | React and MUI are dependencies of this package alone. The engine stays framework-agnostic and dependency-free; nothing here may become a runtime dependency of `@bottlify/core` |
| how it talks to the engine | only `createApp` and the `AppController` it returns | Reaching into `modules/core/src/layers/**` from here is a boundary violation and fails the same check that guards the engine's own layers |
| component library | MUI | Chosen for speed of a first pass. It is confined to this package, so replacing it later touches nothing else |
| build tool | **Vite**, not webpack | The engine is plain ES modules with no build step, and Vite serves those natively in development rather than bundling them first — so what runs in the browser stays recognisably the same code that runs under the test runner. It also handles the two things this app actually needs, a worker entry point and a `.wasm` asset, without configuration. Webpack would do the job, but it buys a slower loop and a config to maintain for no property we need |
| look | monochrome: dark graphite surfaces, white and grey ink, **no accent hue** | The Bottlify brand is white and grey, and the UI stays that way. Graphite `#4a4e52`, paper `#ffffff`, backdrop `#1e2022`, surfaces stepping `#1a1b1d` → `#2b2d30`. Type: Bricolage Grotesque for display, Hanken Grotesk for body, IBM Plex Mono where numbers must line up |
| emphasis without colour | weight, size, contrast and space | With no accent hue, the primary action is made obvious by contrast against the graphite — a white surface with dark text — rather than by tinting it. Colour is then free to mean something later (a failure, a warning) instead of being spent on decoration |
| brand assets | the existing Bottlify logo, copied into `modules/ui/src/assets/` | Committed with the package rather than fetched, like everything else the product needs at runtime |
| the engine runs in a worker | the UI owns the page, never the guest | Already true of the engine; the UI must not be the thing that drags execution onto the main thread |

## 2. The three views

**Catalogue.** The landing page: a grid of what can be run. Each entry is a card with cover art,
title, and enough metadata to tell two similar things apart.

**Detail.** Selecting an entry expands it in place rather than navigating away — the console-style
pattern, where the card grows into a panel with description, metadata and a single obvious primary
action. Expanding must not disturb the grid's scroll position; that is the detail that makes this
pattern feel right or wrong.

**Session.** Pressing play goes to the running application: the surface it draws on, and the
controls around it — pause and resume, and the log.

State the truth about that last view: **there is nothing to draw yet.** Graphics, audio and input
are later phases, so today a session shows the program's console output, its exit code and the
diagnostics snapshot. The layout should therefore be built with the display area as a first-class
region that currently holds a placeholder, so that the arrival of a real canvas is a substitution
rather than a redesign.

## 3. Steps

### U1 — the shell

Package, dev server, routing between the three views, the theme (palette, type scale, dark surfaces)
and the logo in place.

**Done when:** the three views exist and are reachable, and the theme is applied from one place
rather than sprinkled through components.

### U2 — the catalogue and its data

A catalogue entry is data, not code: id, title, description, cover, and where the executable comes
from. For now that is a static list checked into the package; it becomes a real manifest when the
bundle format lands.

**Done when:** the grid renders from that list, an entry expands into its detail panel in place, and
the primary action is unmistakably the one thing to press.

### U3 — the session view

Wire `createApp`: hand it the executable and the emulator artifacts, `attachLog` into a log panel,
show the exit code when it ends, and surface the diagnostics snapshot — module statuses, instruction
count, traps, region layout.

Errors get shown, not swallowed: an unresolved import, a program that never exits, a failure to load
the artifacts. A blank screen with a spinner is the one outcome that must not be possible.

**Done when:** the checked-in console fixture can be started from the catalogue and its output
appears in the session view, in a real browser.

### U4 — pause and resume

The controller already offers both. Make them real in the view, and make the current state legible —
running, paused, finished — because a paused emulator and a hung one look identical otherwise.

**Done when:** pausing stops instructions retiring (visible in the diagnostics), and resuming
continues from the same place rather than restarting.

## 4. Not in scope

- Accounts, saves, sync, anything server-side.
- A bundle format or an installer path; the catalogue is a static list until the format exists.
- Graphics, audio and input surfaces beyond the placeholder region.
- Mobile layout and touch controls.
- Anything that would put React, MUI or the UI's own state anywhere near `@bottlify/core`.

## 5. Open questions

- **Where do catalogue covers and metadata come from** once there is a real bundle format — inside
  the bundle, or a separate index fetched alongside it? The former makes a bundle self-describing;
  the latter makes a catalogue listable without touching gigabytes.
- **How does the session view get the emulator artifacts?** Today they are files served next to the
  app. Once the engine ships as a package, whether the consumer or the package supplies them is part
  of the delivery story and should be settled there, not improvised here.
- **Does this package eventually absorb the bare development harness** that exists for driving the
  engine by hand, or do the two stay separate — one an instrument, one a product?
