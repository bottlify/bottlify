# The browser harness

Everything a title needs before it draws -- its files, its threads, its
registry -- can be answered in Node. The moment it asks for a device, only a
browser can answer, and so only a browser can say what the title does next.
This folder is how the engine is put in front of a real browser with a real
GPU, driven, and asked what happened.

Nothing here is a unit test and nothing here is imported by a package. The
scenarios serve `modules/core` and the translator beside it (`modules/cork`)
from source, with no build step, and the engine is cork: there is nothing to
fetch first. The one prebuilt file a page reads is the optional video decoder,
`modules/core/vendor/prebuilt/video-decoder.wasm` (`npm run fetch:video-decoder`);
without it a title's films do not play. The title scenarios need a bundle under
`bundles/<id>/` (`bundle.btl` + `manifest.json`), which is not in the
repository; without one they say so and stop. A bundle mounts at `C:\App` in
the guest, its files directly in that directory.

## The scripts

| script | what it is | run it as |
|---|---|---|
| `game.mjs` | starts the engine on a bundle in a GPU browser, waits, writes a report | `npm run cdp:game -- <bundle-id> [flags]` |
| `frames.mjs` | lets a title settle, watches a window, reports what a frame costs and why | `npm run cdp:frames -- <bundle-id> [flags]` |
| `launcher.mjs` | starts a title in the launcher the way a person does and profiles the page thread | `node tools/cdp_test/launcher.mjs <bundle-id> [flags]` (launcher running: `npm run ui`) |
| `triangle.mjs` | the graphics acceptance scenario: a fixture draws a triangle, four pixels are compared byte for byte; `--graphics-worker pixels` draws it in the graphics worker (`bitmap`, its default way of sending frames back, makes headless SwiftShader lose the read-back's `mapAsync`) | `node tools/cdp_test/triangle.mjs [--graphics-worker pixels] [--isolated]`; `--isolated` serves the page cross-origin isolated, so guest memory is shared |
| `probe.mjs` / `cli.mjs` | the acceptance probe: browser, page, worker, ping, screenshot | `npm run cdp:probe` |
| `browser.mjs` | finds and launches a Chromium with a CDP endpoint | library |
| `cdp.mjs` | a minimal CDP client over WebSocket | library |
| `server.mjs` | a static server for the sandbox pages, the sources and a bundle | library |
| `device-lag.mjs` | counts the engine's GPU submits and those the device finished, for a run that waits on the device | library |

Reports land in `tools/cdp_test/reports/` (gitignored).

## `game.mjs` -- a title, a run, a report

```
node tools/cdp_test/game.mjs <bundle-id> [--wait 900] [--turns 200000] [--calls 40]
    [--log FILE [--log-lines N]] [--profile [QUANTUM]]
    [--dump-draws] [--max-draws N] [--skip-texture tN] [--probe tN]
    [--pointer x,y[,down]] [--click x,y[,after]] [--key Code[,after[,frames]]] [--turn dx,dy,after,frames] [--screen WxH]
    [--run-seconds N] [--command-line STRING] [--windows NAME] [--file HOST=GUEST] [--save-files]
    [--profile-calls] [--no-video] [--no-fog] [--no-mips] [--trace]
    [--worker [--pacing page|event]] [--coi]
    [--user-data-dir DIR] [--port N] [--store local] [--prefetch] [--export-translations FILE]
```

| flag | default | what it does |
|---|---|---|
| `--wait SECONDS` | 900 | how long to wait for the page's result, from the start: the run, then the report, whose read-back of the last frame waits for the device to finish every frame queued before it -- a few frames with the graphics layer's bound, on a software adapter far longer than the run without it (see *A page that does not answer*). Bound the run itself with `--run-seconds` or a scene that ends |
| `--turns N` | 200000 | scheduler turns before the run gives up |
| `--calls N` | 40 | how many of the last host calls the report prints |
| `--log-match REGEX` | off | keep only the host calls whose formatted line matches, so a question about one family of calls (`"EnumDisplay|CreateDevice"`) is answered across the whole run instead of the last N lines of the frame loop |
| `--log FILE` | off | every host call, drained in chunks, to a file. The ring in a report holds the end of a run, and what a program decided it decided long before that |
| `--log-lines N` | 400000 | how many of those to keep; the default holds the head of the run, where a program makes its decisions, and something that only happens once a title is up needs more |
| `--profile [N]` | off; quantum 2000 when on | samples the guest's instruction pointer at turn boundaries. A sample lands at a turn boundary, so the quantum is the resolution: lowering it is what makes a sample a measurement rather than a rumour |
| `--dump-draws` | off | every draw of the last frame with the state it ran under. Off unless asked for: it transforms every vertex a second time on the processor |
| `--dump-every N` | off | the same account for every N-th presented frame, the last 120 of them, written as `game-<stamp>-dumps.txt` (`== frame <n>` before each); each frame's first 48 draws end with `gpu=same` or `gpu=differs(...)` -- what the GPU held against what the program wrote. For a picture wrong in one frame of a few, which the last frame alone misses. The launcher takes `?dumpEvery=N` the same way |
| `--max-draws N` | -1 (all) | draws per frame, for bisecting which one painted a region |
| `--skip-texture tN` | off | a texture id from a draws dump; every draw sampling it is dropped, so two runs differ by that draw and nothing else |
| `--probe tN` | off | with `--dump-draws`: copy the colour target out right after each dumped draw that samples this texture, and put a few of its pixels on the draw's line. What a draw painted is otherwise only knowable from the finished frame, where every later draw has had its say |
| `--pointer x,y[,down]` | off | hold the pointer at a position in the program's own pixels, optionally with the button down |
| `--click-at x,y,ms`, `--key-at Code,ms` | off | a click, or a key tap, at a wall-clock moment: `ms` after the run starts, held 120 ms. For a screen that waits without presenting -- a dialog box, a film waiting on its first click -- where a click counted in presented frames is never sent, because the frame it waits for never comes. Repeatable |
| `--route` | off | the title's saved route: `bundles/<id>/route.json`, `{ "reaches": "what screen it ends on", "args": ["--click", "512,400,20s", ...] }`, its `args` put behind the ones given, so a flag given by hand wins. A route takes a title through its launcher and menus to where it plays, so every run starts where the last one got to |
| `--press LABEL\|LABEL...` | off | for an installer: whenever the windows on the screen change and have had `--press-settle MS` (1500) to paint, the first of the labels an enabled button on the screen carries is clicked at its centre -- without its `&`, in any case; a check box or radio button once. A wizard's pages come when its work is done, which no frame count or moment foretells; pair it with `--watch S` for the desktop it paints |
| `--click x,y[,after]` | off | a click in the program's own pixels after that many presented frames (30 by default): pressed on one frame, released on the next, with the motion that brings a pointer there from where the last click left it, for a program that reads the mouse as relative motion. Repeatable, for a path through several screens |
| `--screen WxH` | 640x480 | the display the program is told it has. The launcher names the person's own screen, which is rarely a size a program of this era lists, and what a title does on one is a path of its own |
| `--run-seconds N` | off | how long the engine itself runs before it stops and reports. A title that reaches its loop runs out the turns hours later; this ends the run while the page can still be asked |
| `--snap-frame N` | off | the frame presented N frames after the last stall of 1.5 s or more, written as `game-<stamp>-snap.png` and taken again after any later stall; with `--snap-count C --snap-every K`, C frames K apart from it, each also as `-snap-<frame>.png` -- a series tells a scene that changes by itself from one drawn wrong |
| `--keep-images N,M` | off | the texels of those uncompressed OpenGL uploads (indices as the report's `imageDigests` count them) written as `game-<stamp>-image-<N>.png` -- what shows how two runs' images differ once their digests say they do |
| `--no-hooks` | off | leave the bundle's `hooks.json`/`hooks.mjs` unbound, so two runs differ by the hooks and nothing else |
| `--snap-from-start` | off | count `--snap-frame` from the first presented frame instead of the last stall: a program whose clock steps once per frame is then caught at the same moment in two runs whose stalls differ |
| `--steady-frames N` | off | the log's frame averages (frame, guest, host, over its last 240 frames) taken once N frames came after the last stall of 1.5 s or more, printed as `steady`. For a program that advances one step a frame and is given no input those are the same frames of play in every run, so the guest milliseconds of two builds compare; a load draws a few hundred frames of its own before the map, so N is taken past them |
| `--series N` | off | a row every N presents: the log's frame, host and guest milliseconds averaged over those frames, and the draws the backend encoded, the host calls the bridge dispatched and the bytes uploaded, per frame -- so per draw too. Printed as `frame series` and written as `game-<stamp>-series.json`. How a frame's cost moves with what it draws shows here and nowhere in a run's totals; each row reads every layer's diagnostics once, so a window of fewer than about thirty presents measures that as well |
| `--cpu-profile N` | off | with `--worker`: the browser's own sampling profiler on the engine's workers for N seconds from the start (or until the run ends). The report gets self time by file and by function -- a translated region is a function named by its address (`r004ea329`), the interpreter, the runtime and the layers are their own functions -- and the raw `.cpuprofile` lands beside the report for the browser's Performance panel. This is how "translated code is slow" is told apart from "the interpreter is slow" or "the runtime is" |
| `--profile-calls` | off | every host call timed as a phase of its own, so the phase table says which API a frame's host time went to rather than only that it went to the crossing |
| `--cpu-profile-from S` | 0 | with `--cpu-profile`: the window starts S seconds into the run instead of at the start, so a scene is profiled without the load in front of it |
| `--heap-profile [old]` | off | with `--cpu-profile`: the same workers' allocations sampled over the same window, garbage included (`old`: only what lived long enough to be promoted, the garbage a full collection is run for), as `game-<stamp>-heap-<n>.heapprofile` (the browser's Memory panel opens it) and the top allocating sites in the report; and every worker's heap read once a second for the whole run, `game-<stamp>-heap-usage.json` (`usedSize`, `totalSize`, and `backingStorageSize`, the array buffers outside the heap). A long collection pause is paid for by what was thrown away, which is what this shows |
| `--cork-config JSON` | `{"timings":true}` | the translator's own settings for the run, e.g. `{"countTransfers":true}` or `{"relinkAfter":0}`; the harness turns the translator's `timings` on (its milliseconds and `stalls`), which a shipped build leaves off, and `{"timings":false}` runs as it does; `{"traceStore":true}` writes every store key put and missed to `game-<stamp>-store.json` beside the report, for comparing a cold run's keys with a warm run's; `{"blockProfile":true}` counts every translated block's executions (with `"blockProfileFrom":S` only from S seconds on, so a profile holds the game and not its load) (no store is kept that run), prints the twenty hottest as `hottest blocks` and writes all of them to `game-<stamp>-blocks.json`, which `node tools/cork-mix.mjs <that file> [--top N]` turns into the dynamic instruction mix (a DLL's blocks too, placed with `--image name.dll@base`) by operation and operand form with the wasm operations cork emits for each form, ranked by weighted cost |
| `--js-flags FLAGS` | none | V8 flags for the browser (`--no-liftoff`), for a question about the wasm tiers |
| `--no-video` | video on | assemble the engine without a decoder, so a run is not measured through a cinematic |
| `--no-fog`, `--no-mips` | on | render as if fog, or mipmaps, were off, so a run differs from an ordinary one by that and nothing else |
| `--key Code[,after[,frames]]` | off | a key in `KeyboardEvent.code` names (`Enter`, `Escape`, `KeyA`) pressed after that many presented frames and released `frames` later (default 1) -- a held `KeyW` walks. Repeatable |
| `--turn dx,dy,after,frames` | off | relative mouse motion of dx,dy on every presented frame from `after` for `frames` frames -- how a first-person view is turned. Repeatable |
| `after` as `12s` | frames | any `after` above may be a time since the first presented frame instead of a frame count (`--click 520,400,12s`); a route timed in seconds survives a change in the frame rate, since the program's screens arrive on the clock |
| `--command-line STRING` | the bundle's manifest | what the program believes it was started with, image path first: `'"C:\App\Game.exe" +set r_mode 3'`. The manifest's `commandLine` is the default, so a title's usual arguments need not be repeated |
| `--windows NAME` | the bundle's manifest, else `winxp` | the Windows the title runs under (`docs/core/api.md`'s `windows`): `win2000`, `winxp`, `win7` or `win10`. The manifest's `windows` is the default; any other name is refused before the browser starts. `frames.mjs` takes it too |
| `--file HOST=GUEST` | none | a file put on the volume before the program's first instruction, from a host path to a guest one (`dbg/bench.demo=C:\App\base\demos\bench.demo`): what one run wrote, handed to the next. Repeatable |
| `--save-files` | text | keep every file the program wrote as the bytes it wrote, whole, beside the report. Without it a file is saved as text and capped at a megabyte, which reads a log and ruins anything binary |
| `--graphics-api CHOICE` | none | the graphics a bottle chooses in the launcher, `createApp`'s `graphicsApi`: `directx7`, `directx8`, `directx9`, `directx10` or `opengl` -- which system libraries the machine has and which DirectX release it reports |
| `--graphics-config JSON` | none | fields of the graphics layer's configuration (`docs/core/configuration.md`, graphics) merged into `createApp`'s `graphics` option: `--graphics-config '{"compressedTextures":true}'` turns the block-compressed upload path on for one run |
| `--audio-config JSON` | none | fields of the audio layer's configuration merged into `createApp`'s `audio` option: `--audio-config '{"mp3":false}'` runs the program's own MP3 decoder instead of the hosted one, an A/B of the two |
| `--capture-audio FROM:TO` | off | what the sound device mixed from FROM to TO seconds of the run, written as `game-<stamp>-audio.wav` (16-bit stereo at the device rate). With `--worker --coi` the device runs on the page, off the engine's thread, as a launcher's worklet does -- so a program the engine cannot keep fed is heard, and counted in the audio layer's `staleBytes`, as it is in the launcher |
| `--entry PATH` | the manifest's | another program of the bundle to start, with `--command-line` for its arguments: `--entry tool.exe --command-line '"C:\App\tool.exe" -x'` |
| `--trace` | off | peek every pointer argument of every host call for a string. Off by default: a title's draws pay for it and a measurement run should not without asking |
| `--hook SPEC` | none | a watch in front of a routine inside one of the program's own modules, `module:offset:label:argBytes:len,len[:what+what]` as the launcher's `?hook=` takes it (instruction lengths from a disassembly; no relative branch among them). Each call goes to `--log`, and its answer as `label -> result ...` with what `what` named: a stack slot or `ecx`/`edx` read as a C string, `ecx*104` as that many bytes of the object, `[ecx.88]*64` as the bytes of the object a field points at, `@hex` for an absolute address. A library the program imports is watched as well as one it loads later. Repeatable |
| `--watch-import LIB[#ord+ord]` | none | every import from that library -- `binkw32.dll`, or only those ordinals -- goes to `--log` with its arguments and, as `name -> result`, its answer: what a program does with a library of its own that the engine does not implement. Repeatable |
| `--record N` | 0 | the bridge's last N events -- each host call that parked and finished, each call into the guest, each callback that returned -- written as `game-<stamp>-bridge.jsonl`: how a thread's stack got to where a failure found it |
| `--peek address:length` | none | guest memory as the run left it, printed as hex bytes in the report: a flag, a counter or a table a program decides on without calling anything -- a middleware's timer slots, a driver's state -- that no call log shows. Repeatable |
| `--headed` | headless | a browser window on the machine's own GPU, as the launcher has it: a headless browser's adapter is not the one a person plays on, so a question about speed or about what the screen shows is asked headed |
| `--worker` | page thread | run the engine in a worker with the page's canvas transferred to it, which is how the launcher runs it |
| `--pacing page\|event` | `page` | with `--worker`: how the loop waits -- a look every few milliseconds, or sleep until something happens |
| `--coi` | off | serve with the cross-origin isolation headers, so the page comes up `crossOriginIsolated` and `SharedArrayBuffer` exists -- what the shared-table audio backend and its worklet need |
| `--user-data-dir DIR` | a fresh temp dir, removed on shutdown | a browser profile of your own, kept rather than thrown away when the run ends. Needed for `--store local` to warm anything: OPFS lives in the profile, so a later run only reads it back if it is the same profile. A browser an earlier run left on the same profile (its node process killed outright) is closed before the launch |
| `--port N` | random | fixes the static server's port, so `http://127.0.0.1:<port>` -- the origin OPFS is scoped to -- is the same origin every run. Pair with `--user-data-dir` for a warm store to survive between separate invocations of this tool; without a fixed port each run is a different origin no matter which profile it opens |
| `--store local` | none (nothing kept) | fetched bundle blocks are cached in OPFS instead of thrown away with the page. Requires `--worker` (only a worker can open OPFS synchronously) and, to survive to a later run, `--user-data-dir` and `--port` held fixed |
| `--prefetch` | off | with `--store local`: fill the rest of the cache from the bundle in the background beyond whatever the run itself reads, for a fuller warm-up between runs at the cost of the bandwidth to do it |
| `--export-translations FILE` | off | once the run ends, what the translator made of the title (`app.exportTranslations()`, the store kept to what its lookups can reach) is written to FILE as the seed a bundle carries; `node tools/make-btl.mjs translations <bundle-id> FILE` puts it into the bundle, so every first run of it starts from those translations. The store is the origin's file system (`--worker` for its synchronous handles), so a run on a kept profile (`--user-data-dir`, `--port`) exports what earlier runs made as well |

The run is headless unless `--headed`, on a fresh profile unless `--user-data-dir` names one.
The browser flags it needs are in `browser.mjs` (below).

## `live/` -- watching a title a person is playing

A person plays in the shared headed browser; these scripts attach to it over
CDP (port 9333, `CDP_PORT` to change) and read the launcher tab and its
workers while it runs. Nothing here drives the page but `drive.mjs`, which
keeps a headless launcher tab of its own. A worker is reached through the
page's auto-attach (`connect.mjs`), because a cross-origin-isolated page's
workers answer nothing to a direct attach.

| script | what it answers | run it as |
|---|---|---|
| `browser.mjs` | opens the headed browser on the launcher, profile kept in `dbg/chrome-profile` | `node tools/cdp_test/live/browser.mjs [url]` |
| `eval.mjs` | the value of an expression in the launcher tab (`window.__bottlify__` is the engine) | `node tools/cdp_test/live/eval.mjs "<expression>"` |
| `audio-watch.mjs` | four times a second, with the clock: laps replayed, silence held, blocks starved, writer skips, late guest threads -- what a crackle was | `node tools/cdp_test/live/audio-watch.mjs` |
| `memory-watch.mjs` | every five seconds: the tab's private memory and each worker's JS heap | `node tools/cdp_test/live/memory-watch.mjs` |
| `worker-profile.mjs` | the engine worker's time: idle, GC, top functions, and every pause outside guest code with when it began | `node tools/cdp_test/live/worker-profile.mjs [seconds] [minMs]` |
| `allocations.mjs` | which functions of the engine worker allocate the most, garbage included | `node tools/cdp_test/live/allocations.mjs [seconds]` |
| `big-buffers.mjs` | every backing store over a size in the engine worker, and what holds it | `node tools/cdp_test/live/big-buffers.mjs [minMB]` |
| `drive.mjs` | a headless launcher tab that stays up and takes orders on http://127.0.0.1:9401 -- `/shot` (the picture as a PNG), `/click?x=&y=` in the program's pixels, `/move?x=&y=` (no button), `/drag?x=&y=&to=X,Y&steps=N` (the left button held along the way -- a window dragged), `/key?code=`, `/type?text=`, `/eval?js=`, `/upload?file=` (a file into the page's file input -- the library's Add, to run an installer), `/quit` -- for walking a title's screens a step at a time with screenshots, a person saying what to press next; the engine is `globalThis.app` in the tab, reports land in dbg/live-downloads | `node tools/cdp_test/live/drive.mjs [card regex] [query]` (launcher running over TLS on 5180) |
| `record-output.mjs` | what the person hears, uncompressed off the output node, the last two minutes (`arm` keeps a tap across reloads; `save` writes a WAV) | `node tools/cdp_test/live/record-output.mjs arm` then `… save [seconds] [file]` |

`tools/wav-scan.mjs <file.wav>` reads such a recording for what is wrong in it: gaps of
silence inside sound, clicks (a step far beyond the signal's own), and exact repeats.

`tools/install-watch.mjs` is the same question for an installer in Node: it
runs one unattended and prints every process's threads, waits and parked
calls every few seconds (`app.standing()`), and with `--journal S` the last
cross-process COM calls S seconds in. `--bundle ID` runs an installed
program's launcher or entry the same way, with `--click`, `--key`, `--shots`
and, with `--attended`, its message boxes left on the desktop to answer.
`--copy DIR TO` writes a directory of the volume out once the run is over:
what a setup unpacked, for the audit below.

`tools/import-audit.mjs <file|directory|bundle.btl|disc.iso>...` reads the
import table of every PE image under the paths and lists what this build does
not export: each missing function or ordinal with the images that import it,
each library nobody provides, and each image that looks packed (its imports
are looked up at run time). Run it before a title's or a setup's first run.
`--used` lists every function of this build's libraries the images import;
`--dynamic --specs DIR` adds what the images name in their strings for
LoadLibrary and GetProcAddress, checked against the real libraries' export
lists (Wine's spec files, fetched once into DIR by `--fetch-specs DIR` and not
kept in the repository): a function a program looks up by name that this
build does not export is a NULL it may call.

`tools/arg-bytes-audit.mjs <spec directory>` checks the bytes every stdcall
entry of the win32 layer pops against Wine's export spec files kept locally:
one argument too many moves the caller's stack a call at a time, and the
program returns to nowhere far from the call that did it.

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
| `--allocations` | off | sample what the engine allocates in the window, by the function that allocated it |
| `--quantum N` | engine default | guest instructions per scheduler turn -- the one number that decides how long a thread may hold the machine |
| `--no-trace` | trace on | without the per-call string peeks, which read guest memory on every host call |

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

## What comes back

The report opens with what the engine did not do -- an `E_NOTIMPL`, a stub, a refused shader -- and then what it did otherwise than Windows, each counted once with how often, taken from a list of their own so the events' cap cannot hide them. Every shader the program compiled is written to `game-<stamp>-shaders/`: the source with the program's macros and flags at the top, the files its includes handed over, and what the compiler made of it disassembled; `node tools/shader-diff.mjs <that directory>` compiles the same sources with the system's `D3DCompiler_47` and runs both programs on the reference machine with the same inputs (Windows only; pixel shader model 1 is compared with Microsoft's ps_2_0).

`tools/cdp_test/reports/game-<stamp>.txt` is the report, beside it
`game-<stamp>.png` (the screenshot), `game-<stamp>-draws.txt` when draws were
dumped, one PNG per texture the engine uploaded (and its device-side copy),
and every file the program itself wrote. A game's own crash report is its
account of what went wrong and beats any trace taken from outside it.

A run that never answers within `--wait` -- a program still running, not only a
hung page -- leaves no report; instead the debugger pauses the page and the
JS stack it was running is printed, `game-<stamp>-live.json` holds every
layer's metrics as the run stood (the kernel's threads and time, the
bridge's last call, the cpu's ports), and `game-<stamp>-frame.png` the frame
presented last, which a page screenshot of the WebGPU canvas does not show.

`game-<stamp>-presents.json` holds every present's wall-clock time. Two runs are
compared over the same frames rather than the same seconds with
`node tools/frame-span.mjs <presents.json>... [--skip N] [--frames N]`: the span
starts after the load's last long stall, and for a program whose simulation
advances one step a frame and is given no input it is the same work in every
run. With `--cpu-profile`, the report also says how
many frames were presented inside the profile's window and how long each took,
so the profile's milliseconds divide into a frame's. Runs on one machine vary by
a quarter from one to the next: a difference is only a measurement across
several runs of each side.

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

### Translated code gone wrong

When a title fails only translated (`--cork-config '{"translate":false}'`
runs it whole on the interpreter): `{"interpretRange":[from,to]}` leaves
those addresses to the interpreter, so halving the range finds the code
whose translation breaks; `{"checkStale":true}` puts `stale regions` in the
report -- published regions whose bytes no longer form as they did, code a
write should have dropped and did not.

### A NaN

A float exception (0xC0000090 and its kin), NaN vertices or an object that
flies off start where something first made a NaN, long before anyone notices.
Run with `--cork-config '{"precise":true}'` and the cork section of the report
names the first of each, by the guest address of the instruction:

- `first NaN made` -- x87 arithmetic, a square root, a logarithm (`fyl2x`,
  `fyl2xp1`) or a remainder that made a NaN out of numbers (0/0, inf-inf, the
  root or the log of a negative), with its two operands;
- `first x87 stack fault` -- a register read while empty or pushed onto while
  held; the indefinite it produces is a NaN;
- `first NaN result` -- any x87 arithmetic whose result was a NaN, made or
  carried in from an operand;
- `first NaN loaded`, `first NaN stored` -- an x87 float load that read a NaN
  and a store that wrote one, with the address in memory. A NaN read before
  any was made or stored was written there by something else (interpreted
  code, SSE, integer stores of what was never a float).

Only translated x87 code is watched; interpreted code and SSE are not.
Compare the addresses with a run that does not fail.

### A page that does not answer

The page's report reads the last frame back, and that read waits until the
device has finished every frame queued before it. A present waits for the
device once it is the graphics layer's bound of frames behind
(`maxFrameLatency`, three by default; `docs/core/configuration.md`,
graphics), so the report answers soon after the run. On a software adapter
(SwiftShader, what a machine without a GPU hands out) the program then goes
at the device's pace, several times slower than it would present. With the
bound off (`--graphics-config '{"maxFrameLatency":0}'`) the program presents
faster than the device finishes, a run whose program has stopped can still
have minutes of frames queued, and a `--wait` shorter than that drain ends in
`the page did not answer`. The result is read a piece at a time, since a
run's is larger than one answer carries.

So bound the run -- `--run-seconds`, or a scene that ends by itself, such as a
title's own timed demo that quits when done -- and give `--wait` the run plus
its drain. While it waits, the driver says how far behind the device is every
30 s once the oldest unfinished submit is five seconds old, and a timeout's
reason ends with the same count (`device-lag.mjs` wraps `GPUQueue.submit` in
the realm the engine runs in, the page or its worker); a report that did
answer says how long after the start it did, and how many presents waited for
the device and for how long in all.

## `../host-call-bench.mjs` -- what a call into an import costs

`node tools/host-call-bench.mjs [N] [--rounds R] [--call SPEC]... [--root DIR] [--baseline DIR]
[--json]` runs, in node, a program that calls an import N times (1 000 000 by default) against
the same loop with the call's pushes and pops but no call, and prints the difference over N: for
a host handler one call out of translated code into the host and back, for an import that is
code in the guest's own library that code. A SPEC is `DLL!name(arg,...)[:st0][@cdecl|@stdcall]`,
each argument `s:text` (a pointer to the string, `s:"a,b"` with a comma), `b:N` (a pointer to N
zeroed bytes), `i:N` (a dword), `d:X` (a double, two slots), `x:X` (a double on the x87 stack,
for `_ftol`) or `c:` (a pointer to a cdecl comparator of two signed dwords in the program's own
code, for `qsort` and `bsearch`); `:st0` pops a double result; the convention is cdecl for the C
runtimes and stdcall otherwise unless one is named. Several
`--call`s are timed in one run; each is timed in every round, in turn with its loop, and printed
as the median over the rounds with the spread and the bridge's count of host calls -- some
imports never cross (`GetLastError` runs in the guest's kernel32, `strncmp` in its msvcrt), and a
count of one (the program's `ExitProcess`) means the call never reached the host. The default call
is `KERNEL32.dll!lstrlenA(s:a)`.

`--root DIR` times another checkout's engine; `--baseline DIR` times another checkout round for
round with this one and prints the two side by side with their ratio -- a host handler against
the same function as code in the guest, with no switch in the engine for it (a checkout of the
commit before is `git worktree add --detach ../base <commit>`). `--json` prints the rounds for
`--compare BEFORE.json AFTER.json`. `--profile` runs the first call's loop once under the V8
profiler and prints the functions a crossing spends its time in -- the dispatch, the reads of
guest memory, the bookkeeping -- which is what a change to the crossing is judged by. Pin it to
one core (`taskset -c N`) on a quiet machine: the spread printed is how far to trust a median.

## Two rules the numbers depend on

- A frame rate is counted on the canvas the person sees (the browser's
  screencast or compositor), never from the engine's own frame counter: the
  engine can present frames the page never shows.
- A hypothesis needs a measurement, not an argument. If the evidence is not in
  the report, the instrument is what to widen -- not the theory.
