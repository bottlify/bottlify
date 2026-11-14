# .NET Framework as a shared layer

Status: plan; step 2 (mount) done 2026-11-14, the rest no code. Numbers marked *(not measured)* are estimates.

## Why

A .NET Framework program's bottle carries the Framework only as its setup installed it: The
Swapper's session holds 2.1 GB, 570 MB of it the Framework, 1.4 GB six extraction folders the
setup left behind; the install with ngen took over ten minutes in the engine. Every .NET bottle
would pay that again. The Framework is the same files for every program: built once in a browser,
it can serve every bottle there.

## What

1. **One runtime: .NET Framework 4.8**, in two layers by machine - `x86` (`Framework` only) and
   `amd64` (`Framework` and `Framework64`). 4.8 updates 4.0-4.7.2 in place, so it serves every
   CLR 4 program. CLR 2 (2.0-3.5) is left until a program needs it.
2. **The layer is a bundle** in the shape a bottle's own system files already have
   (`.bottlify\drive_c\...`, `.bottlify\registry.json`; `steam/redist.js`): the Framework's
   files, its registry, and the native images ngen made for it. It is kept once per browser in
   OPFS, beside the bottles, and never copied into one.
3. **The Windows a program sees** stays one rule: the bottle's setting in the launcher, else a
   32-bit program sees XP and a 64-bit one Windows 10. The layer does not depend on it. The one
   assumption to check first: 4.8's runtime starts in a bottle that says XP (its setup refuses
   XP, its runtime only needs the APIs the engine answers whatever version it reports). If it
   does not, what it trips on is fixed in Win32, not answered by another rule.

## How

| step | where | what |
|---|---|---|
| 1. Need | core | A program needs the Framework when its image is a CLR one (a COM descriptor directory, `_CorExeMain` from mscoree) and the volume has no `mscoree.dll` of its line; or a setup the program starts is the Framework's (known by its version block, as `DXSETUP` is: `PROGRAMS_IN_PLACE`). Either asks the embedder for the layer (an event), and a Framework setup stands in as run and exited 0 once the layer is there. |
| 2. Mount | core, filesystem | Done, 2026-11-14: `bundle.layers` (`docs/core/api.md`). A volume's source can be several bundles: a union source reads a path from the first that has it - the bottle's bundle over the layer. The layer's registry is laid under the bottle's at the start, as an installation's is (`fillFromJSON`). Gate: `bundle-layers.itest.js`. |
| 3. Installer | site, dist | The offline installer (`ndp48-x86-x64-allos-enu.exe`, unmodified - what the licence allows to redistribute) is fetched at build time from Microsoft with its SHA-256 pinned, and served from the launcher's own origin (Microsoft's download host sends no CORS headers). Not in git. |
| 4. Build | launcher | The first time a layer is asked for and is not in this browser: a run with no picture - a modal with a progress bar - starts the installer with `/q /norestart` on an empty Windows 7 machine of the layer's width, then `ngen executeQueuedItems` until the queue is empty (WPF's assemblies included), and packs what the run wrote (files and registry, the setup's extraction folders and temp left out) into the layer bundle. *(not measured: about 15-20 minutes on this machine.)* |
| 5. Resume | launcher | The build keeps its own session, saved as it goes (the first-save fix, d79ced0bf). A page closed during the extraction or the MSI starts that stage again; one closed during ngen goes on with what is left in ngen's queue, which lives in the build's registry. A process cannot be resumed mid-run: that would need its memory and the host's state saved. |
| 6. Bottles already installed | launcher | A bottle whose session holds the Framework (The Swapper's) keeps working. Moving it onto the layer - dropping the Framework's files and the setup's leftovers from its session - is a separate, later step, offered, not done silently. |

## Order

1. Check the assumption (4.8 in an XP bottle) by hand: the layer files from a build run, mounted
   into The Swapper's bottle in place of its 4.0.
2. Union source and layer mount, with a gate: a program reads the same bytes and registry
   whether the Framework is in its session or in a layer.
3. Need detection and the stand-in for the Framework's setups, with tests over real images'
   headers.
4. Installer on the site and in dist; the build run and its modal; resume.
5. Measure: a .NET program's first start without the layer built, with it built, and The
   Swapper's start on the layer against its own install (time to the level, instructions).
