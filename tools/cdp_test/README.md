# The browser harness

Everything a title needs before it draws -- its files, its threads, its
registry -- can be answered in Node. The moment it asks for a device, only a
browser can answer, and so only a browser can say what the title does next.
This folder is how the engine is put in front of a real browser with a real
GPU, driven, and asked what happened.

Nothing here is a unit test and nothing here is imported by a package. The
scenarios serve `modules/core` from source (no build step) and need a bundle
under `bundles/<id>/` (`bundle.btl` + `manifest.json`), which is not in the
repository; without one they say so and stop. A bundle mounts at `C:\App` in
the guest, its files directly in that directory.

## The scripts

| script | what it is | run it as |
|---|---|---|
| `game.mjs` | starts the engine on a bundle in a GPU browser, waits, writes a report | `npm run cdp:game -- <bundle-id> [flags]` |
| `frames.mjs` | lets a title settle, watches a window, reports what a frame costs and why | `npm run cdp:frames -- <bundle-id> [flags]` |
| `launcher.mjs` | starts a title in the launcher the way a person does and profiles the page thread | `node tools/cdp_test/launcher.mjs <bundle-id> [flags]` (launcher running: `npm run ui`) |
| `repro.mjs` | replays a scripted sequence of clicks and keys and stops on the first engine fault | `node tools/cdp_test/repro.mjs <bundle-id> [--scenario file.json]` |
| `triangle.mjs` | the graphics acceptance scenario: a fixture draws a triangle, four pixels are compared byte for byte | `node tools/cdp_test/triangle.mjs` |
| `probe.mjs` / `cli.mjs` | the Phase 0 acceptance probe: browser, page, worker, ping, screenshot | `npm run cdp:probe` |
| `browser.mjs` | finds and launches a Chromium with a CDP endpoint | library |
| `cdp.mjs` | a minimal CDP client over WebSocket | library |
| `server.mjs` | a static server for the sandbox pages, the sources and a bundle | library |
| `lease.mjs` | serialises everything that drives one shared, watched browser | `node tools/cdp_test/lease.mjs <who> -- <command...>` |

Reports land in `tools/cdp_test/reports/` (gitignored).

## `game.mjs` -- a title, a run, a report

```
node tools/cdp_test/game.mjs <bundle-id> [--wait 900] [--turns 200000] [--calls 40]
    [--log FILE [--log-lines N]] [--profile [QUANTUM]]
    [--dump-draws] [--max-draws N] [--skip-texture tN] [--probe tN]
    [--pointer x,y[,down]] [--click x,y[,after]] [--key Code[,after]] [--screen WxH]
    [--run-seconds N] [--command-line STRING] [--file HOST=GUEST] [--save-files]
    [--profile-calls] [--no-video] [--no-fog] [--no-mips] [--trace]
    [--worker [--pacing page|event]] [--coi]
    [--user-data-dir DIR] [--port N] [--store local] [--prefetch]
```

| flag | default | what it does |
|---|---|---|
| `--wait SECONDS` | 900 | how long the page runs before it is asked for its result. The page cannot be asked how it is doing while the engine holds its thread, so this is the run's length |
| `--turns N` | 200000 | scheduler turns before the run gives up |
| `--calls N` | 40 | how many of the last host calls the report prints |
| `--log FILE` | off | every host call, drained in chunks, to a file. The ring in a report holds the end of a run, and what a program decided it decided long before that |
| `--log-lines N` | 400000 | how many of those to keep; the default holds the head of the run, where a program makes its decisions, and something that only happens once a title is up needs more |
| `--profile [N]` | off; quantum 2000 when on | samples the guest's instruction pointer at turn boundaries. A sample lands at a turn boundary, so the quantum is the resolution: lowering it is what makes a sample a measurement rather than a rumour |
| `--dump-draws` | off | every draw of the last frame with the state it ran under. Off unless asked for: it transforms every vertex a second time on the processor |
| `--max-draws N` | -1 (all) | draws per frame, for bisecting which one painted a region |
| `--skip-texture tN` | off | a texture id from a draws dump; every draw sampling it is dropped, so two runs differ by that draw and nothing else |
| `--probe tN` | off | with `--dump-draws`: copy the colour target out right after each dumped draw that samples this texture, and put a few of its pixels on the draw's line. What a draw painted is otherwise only knowable from the finished frame, where every later draw has had its say |
| `--pointer x,y[,down]` | off | hold the pointer at a position in the program's own pixels, optionally with the button down |
| `--click x,y[,after]` | off | a click in the program's own pixels after that many presented frames (30 by default): pressed on one frame, released on the next, with the motion that brings a pointer there from where the last click left it, for a program that reads the mouse as relative motion. Repeatable, for a path through several screens |
| `--screen WxH` | 640x480 | the display the program is told it has. The launcher names the person's own screen, which is rarely a size a program of this era lists, and what a title does on one is a path of its own |
| `--run-seconds N` | off | how long the engine itself runs before it stops and reports. A title that reaches its loop runs out the turns hours later; this ends the run while the page can still be asked |
| `--profile-calls` | off | every host call timed as a phase of its own, so the phase table says which API a frame's host time went to rather than only that it went to the crossing |
| `--no-video` | video on | assemble the engine without a decoder, so a run is not measured through a cinematic |
| `--no-fog`, `--no-mips` | on | render as if fog, or mipmaps, were off, so a run differs from an ordinary one by that and nothing else |
| `--key Code[,after]` | off | a key tap in `KeyboardEvent.code` names (`Enter`, `Escape`, `KeyA`) after that many presented frames: pressed on one frame, released on the next. Repeatable |
| `--command-line STRING` | the bundle's manifest | what the program believes it was started with, image path first: `'"C:\App\Game.exe" +set r_mode 3'`. The manifest's `commandLine` is the default, so a title's usual arguments need not be repeated |
| `--file HOST=GUEST` | none | a file put on the volume before the program's first instruction, from a host path to a guest one (`dbg/bench.demo=C:\App\base\demos\bench.demo`): what one run wrote, handed to the next. Repeatable |
| `--save-files` | text | keep every file the program wrote as the bytes it wrote, whole, beside the report. Without it a file is saved as text and capped at a megabyte, which reads a log and ruins anything binary |
| `--graphics-config JSON` | none | fields of the graphics layer's configuration (`docs/core/graphics.md`, the Configuration table) merged into `createApp`'s `graphics` option: `--graphics-config '{"compressedTextures":true}'` turns the block-compressed upload path on for one run |
| `--trace` | off | peek every pointer argument of every host call for a string. Off by default: a title's draws pay for it and a measurement run should not without asking |
| `--worker` | page thread | run the engine in a worker with the page's canvas transferred to it, which is how the launcher runs it |
| `--pacing page\|event` | `page` | with `--worker`: how the loop waits -- a look every few milliseconds, or sleep until something happens |
| `--coi` | off | serve with the cross-origin isolation headers, so the page comes up `crossOriginIsolated` and `SharedArrayBuffer` exists -- what the shared-table audio backend and its worklet need |
| `--user-data-dir DIR` | a fresh temp dir, removed on shutdown | a browser profile of your own, kept rather than thrown away when the run ends. Needed for `--store local` to warm anything: OPFS lives in the profile, so a later run only reads it back if it is the same profile |
| `--port N` | random | fixes the static server's port, so `http://127.0.0.1:<port>` -- the origin OPFS is scoped to -- is the same origin every run. Pair with `--user-data-dir` for a warm store to survive between separate invocations of this tool; without a fixed port each run is a different origin no matter which profile it opens |
| `--store local` | none (nothing kept) | fetched bundle blocks are cached in OPFS instead of thrown away with the page. Requires `--worker` (only a worker can open OPFS synchronously) and, to survive to a later run, `--user-data-dir` and `--port` held fixed |
| `--prefetch` | off | with `--store local`: fill the rest of the cache from the bundle in the background beyond whatever the run itself reads, for a fuller warm-up between runs at the cost of the bandwidth to do it |

The run is headless and always on a fresh profile. The browser flags it needs
are in `browser.mjs` (below).

## `frames.mjs` -- where a frame's time goes

The whole-run scenario is the wrong question for a frame rate: a run is
dominated by starting up. This one lets the title settle, watches for a fixed
window, and reports per frame -- how much was ours and how much the guest's,
which phases made it up, and how the slow frames differ from the ordinary ones.
A frame is counted where the engine presents.

| flag | default | what it does |
|---|---|---|
| `--seconds N` | 60 | how long to watch once the title is up |
| `--settle N` | 20 | how long to let it start first; measuring through loading measures loading |
| `--video` | off | keep the decoder (a cinematic is minutes long and is not the steady state) |
| `--profile` | off | sample the guest's instruction pointer once a turn |
| `--exact` | off | the emulator's own account instead: every compiled block counts itself |
| `--allocations` | off | sample what the engine allocates in the window, by the function that allocated it |
| `--quantum N` | engine default | guest instructions per scheduler turn -- the one number that decides how long a thread may hold the machine |
| `--no-trace` | trace on | without the per-call string peeks, which read guest memory on every host call |
| `--jit i=v,...` | off | the emulator's compiler budgets by index |

## `launcher.mjs` -- the launcher path, profiled

The launcher is a different path from the scenarios: a real audio thread, a
decoder, a settings panel, and its own way of putting a frame on the screen. A
fix measured on the harness is not proven until it has been driven through the
launcher. This script needs `npm run ui` running (port 5180), opens a headed
browser on it, follows the `/library` link, clicks the card whose text matches
the first word of the bundle id, presses Play, lets the title settle (clicking
the canvas every five seconds from the tenth, which is how a person skips an
intro), then samples the page's main thread with
the browser's profiler and prints where the time went by file and by function.

| flag | default | what it does |
|---|---|---|
| `--seconds N` | 30 | the profiling window |
| `--settle N` | 40 | seconds to let the title start before the window opens |
| `--url URL` | `http://127.0.0.1:5180/` | where the launcher is |
| `--settings JSON` | none | settings written into the launcher's storage before it starts, as the panel would have saved them: `--settings {"traceStrings":false}` |
| `--heap` | off | sample allocations too, by site |
| `--headless` | headed | no window; the default is a window the person can watch, because what they see is the thing being measured |

It also prints two frame counts over the window: frames the engine drew into
the canvas, and frames the browser composed for the screen. They differ, and
the second is the one a person sees.

## `repro.mjs` -- a failure on demand

A crash reached by clicking through a menu costs a minute of attention every
time. A scenario here is data: a list of steps in a small JSON file, run
against a real browser; the moment the engine reports a fault the whole trace
is printed and the run fails.

```
node tools/cdp_test/repro.mjs <bundle-id> [--scenario file.json] [--seconds 120] [--video] [--keep]
```

A scenario is `{ "steps": [ ... ] }`, each step one of `{ "wait": ms }`,
`{ "click": [x, y] }` (canvas coordinates), `{ "type": "escape" }` (a key by
name or a character), `{ "hide": ms }` (background the page), `{ "note": "..." }`
(printed, so a log reads as a path) or `{ "until": "frames > 100", "for": ms }`.
With no scenario it runs and watches, which is the shortest way to ask "does
this still crash on its own". `--keep` leaves the browser open at the end.

## `browser.mjs` -- launching a browser that has a GPU

`findBrowser()` takes `CDP_TEST_CHROME` or `CHROME_BIN`, then the usual Chrome
and Edge install paths. Two launchers:

- `launch()` -- headless, `--disable-gpu`. Right for the ping probe, fatal for
  anything that draws.
- `launchWithGpu({ headed })` -- `--enable-unsafe-webgpu` (without it
  `requestAdapter` answers null and the machine looks like one with no WebGPU
  at all), `--enable-unsafe-swiftshader` (a software adapter where there is no
  hardware one -- the report says which answered, because a software
  rasteriser and a real one are not the same measurement), and
  `--autoplay-policy=no-user-gesture-required` (a click sent through the
  protocol is not a gesture, and without this the audio context stays
  suspended and a run meant to measure sound measures its absence).

Both use a fresh temporary profile with the first-run screens switched off,
`--no-sandbox`, no proxy, a 1280x720 window, and `--remote-debugging-port=0`;
the handle carries `browserWs` (the CDP endpoint), `proc` and `profileRoot`.
`shutdown(handle)` kills the browser and removes the profile. `headed: true`
drops `--headless=new` and nothing else.

## `cdp.mjs`

`CdpEndpoint(wsUrl)`: `open()`, `send(method, params, sessionId)` (answers
the result or rejects with the protocol's error), `on(event, handler)`,
`close()`. Attach to a page with `Target.attachToTarget { targetId, flatten: true }`
and pass the returned `sessionId` to every page-level command. Every scenario
here evaluates expressions in the page with `Runtime.evaluate
{ returnByValue: true, awaitPromise: true }` and polls, because a command sent
while the engine holds the page's thread is not answered until it yields.

## `server.mjs`

`serveStatic({ sandboxDir, srcDir, extra })` serves `sandboxDir` under
`/sandbox/`, `srcDir` under `/src/` and any extra prefix, on a free port.
Every file is range-addressable, because one of the things served is a game
bundle: a gigabyte that must never be read whole to answer one block.

## `lease.mjs` -- one browser at a time

A person may be watching a long-lived browser (the one on CDP port 9333), and
two scripts navigating it at once ruin both runs and the watching. Anything
that drives that browser -- navigates, clicks, types, reloads -- runs under
the lease:

```
node tools/cdp_test/lease.mjs <who> -- node some-script.mjs args...
```

The lease is a directory in the temp folder: creating it is atomic, so whoever
creates it wins. A holder is waited for (up to 45 minutes), a lease older than
10 minutes is taken over (a killed script must not block the queue for ever),
and the lease is released when the command exits, however it exits. A script
that only reads -- attaches, evaluates, screencasts, drains the journal, never
sends input or navigates -- does not need the lease and must not take one:
a read-only capture attaches beside whoever is driving.

## What comes back

`tools/cdp_test/reports/game-<stamp>.txt` is the report, beside it
`game-<stamp>.png` (the screenshot), `game-<stamp>-draws.txt` when draws were
dumped, one PNG per texture the engine uploaded (and its device-side copy),
and every file the program itself wrote. A game's own crash report is its
account of what went wrong and beats any trace taken from outside it.

The report, in the order it answers questions:

1. adapter, elapsed, guest instructions, and `stopped:` -- why the run ended.
2. imports nothing claimed, grouped by library, then names asked for by
   `GetProcAddress` at run time and not found.
3. each layer's own diagnostics metrics.
4. where the time went, as phase self-time.
5. graphics: which interfaces were created, `frames`/`draws`/`clears`, what was
   skipped, the lighting and fog state, the calls that failed.
6. `threads` by state, and one line per blocked thread naming what it waits on.
7. the bridge: calls in order, the last calls with their arguments and the
   error each left behind, and the hottest by count.
8. `frames presented`, and the frame's colours and opacity.
9. failure reasons with their traces, then the guest's own output, then page
   exceptions, then the profile.

Reading it:

- `frames presented: 0` with `graphics: created=[]` -- it never reached a
  device. The question is what it was doing instead, which is in the last
  calls.
- Every thread in a timed wait that always expires, while the clock advances --
  not a deadlock, and not stopped time. Something is never signalled, and the
  blocked lines name what.
- A wait of a minute and a half on a completion port means an operation
  finished without posting its completion.
- An unresolved import is a real answer, not noise: a program that cannot bind
  one may take a different path silently.

## Two rules the numbers depend on

- A frame rate is counted on the canvas the person sees (the browser's
  screencast or compositor), never from the engine's own frame counter: the
  engine can present frames the page never shows.
- A hypothesis needs a measurement, not an argument. If the evidence is not in
  the report, the instrument is what to widen -- not the theory.
