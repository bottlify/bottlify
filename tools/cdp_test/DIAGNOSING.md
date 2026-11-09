# Diagnosing a slow or broken run

The order to look in, for an agent handed "it is slow", "it flickers", "it stops". Every step
names the instrument in this folder that answers it ([README](README.md) has the full list). The
rule behind all of it: **a hypothesis is a measurement away from a fact; take the measurement
before building on it.** One decisive experiment beats an hour of argument, and a fix built on an
unmeasured cause is a second bug.

## 1. Know what you are reading

- **Which process answers.** `app.diagnostics()` is the first process of the run. A launcher that
  started a child (a setup's game, a benchmark's test runner) has the work in the child:
  `app.debug.processes()` lists them, beside ones included, `app.debug.diagnosticsOf(id)` reads one. Numbers from the
  wrong process look plausible and say nothing.
- **Which build is loaded.** A minified build names functions `a`, `Ze`; build readable for a
  profile (`BOTTLIFY_READABLE=1 BOTTLIFY_DIAGNOSTICS=1 npm run build`). `npm run
  test:integration` rebuilds the dist as production, so rebuild readable after it.
- **A window, not a total.** A run's totals mix its menus and loads into the scene. Read the
  difference of two readings over the scene itself (`live/phases.mjs`, `live/report-diff.mjs`),
  and compare scenes that are the same scene.

## 2. Who works and who waits

Profile every thread, not only the one you suspect: `live/worker-profile.mjs <seconds> <minMs>
<worker>` with the worker `graphics`, `executor`, `translator`, or none for the engine. A slow
frame is one thread working and the others waiting for it; find which.

The engine's phases (`live/phases.mjs`) say what that thread did:

| phase | means | usually the cure |
| --- | --- | --- |
| `guest` | translated program code ran | the translator (blocks, regions, caching) |
| `trap` | a host function answered a guest call | the call is hot: write it as guest code (`@guestCode`), or count it in guest memory as AddRef/Release do |
| `idle-host` | the thread parked on a host call that answers later (a promise, `host.callGuest`) | each park costs a scheduler turn; a call made thousands of times a frame drives its guest steps in place (`host.drive`) instead of awaiting them |
| `yield` / `idle-message-wait` | the program itself waited | look at what it waits for, not at speed |

The host calls under the phases name the function. Count them per frame: thousands of crossings a
frame for one method is the defect, whatever each one costs.

## 3. Work that should not be there

The usual cause of a slideshow is not slow code but code that runs when it should not: something
made per frame that should be made once (a shader, a pipeline, a table), a cache that never hits,
a copy of a buffer nobody changed, a background task that wakes on every frame. Look for a
counter that grows with frames where it should stay flat (shaders compiled, pipelines created,
buffers uploaded, objects made) and for a host call whose count is a multiple of the draws.

## 4. Memory and the collector

Count the workers before blaming a heap: every process opens executors and translators, each a
worker of its own, so a run with processes that never exit holds gigabytes no heap shows.
`processes()` names them; their `kernel.waiting` and `win32.pipes` say what each waits for.

### The collector

A collector pause is paid by whatever allocates; it is a symptom of allocation, not a cause by
itself. Two readings:

- `live/worker-allocations.mjs`: who allocates, garbage included, with callers. Allocation per
  call in a hot path (a spread, a closure, an array per call) is the thing to remove.
- `live/gc-trace.mjs`: which collections ran and why, per thread, and the "global" sum V8
  schedules full collections by against its limit. A thread whose global sum sits at its limit
  collects whole every few megabytes: then the question is what holds that memory, not who
  allocates (`live/big-buffers.mjs`, `live/memory-watch.mjs`).

Raising the heap limit or hiding memory pressure is not a fix; it was measured and moved nothing.

## 5. What the person sees

- A page screenshot in a cross-origin-isolated tab can show the WebGPU canvas black while the
  screen shows a picture. `live/cast.mjs` records what the compositor sent, every frame; two
  frame sizes taking turns is a flicker, and the index says how often.
- The headed browser's `devicePixelRatio` is not 1: a click in CSS pixels is the screenshot's
  pixel divided by it.
- Judge pictures on SwiftShader on a machine whose GPU driver distorts (a VM); judge speed on the
  hardware adapter.
- `app.debug.freeze(true)` holds the frame still for switches and dumps; never resume a game a
  person paused.

## 6. Things that hurt

- Never patch a worker's globals from outside (a `Proxy` over a typed array constructor, a
  wrapped `postMessage`): it crashed the renderer and measured nothing.
- Never close or restart the browser a person is using; attach to it.
- An instrument that cannot answer says so ("not measured"), never zero. If the evidence is not
  there, the instrument is the bug: widen it, then look again.
- What did not pay goes into [`roadmap/negative-results.md`](../../roadmap/negative-results.md)
  with its conditions, so the next agent does not measure it again.
