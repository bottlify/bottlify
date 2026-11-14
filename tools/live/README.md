# Watching a game a person plays: the reference

What `live.mjs` attaches to and the switches of the running engine. Every tool by the
question it answers is in [the catalog](../README.md); the order to look in when a run is
slow, flickers or stops is [DIAGNOSING.md](DIAGNOSING.md).


A person plays in the shared headed browser; these scripts attach to it over
CDP (port 9333, `CDP_PORT` to change) and read the launcher tab and its
workers while it runs. Nothing here drives the page but `live.mjs drive`, which
keeps a headless launcher tab of its own. A worker is reached through the
page's auto-attach (`connect.mjs`), because a cross-origin-isolated page's
workers answer nothing to a direct attach.

The scripts are in the index above. `tools/read/wav-scan.mjs <file.wav>` reads a recording for what is wrong in it: gaps of
silence inside sound, clicks (a step far beyond the signal's own), and exact repeats.

### Switches on the running engine

`window.__bottlify__.app.debug.<name>(...)` in the launcher tab (through `live.mjs eval`), each a
promise of what the engine answers; they act on the game as it runs, no restart. The graphics
ones need the graphics worker.

| switch | what it does |
|---|---|
| `dumpFrames(n)`, then `dumped()` | the next n frames written down, every draw with its shaders, stages and state, and every clear with its colour, rectangles and target; `dumped()` is the last |
| `snapshot('t4414')`, then `snapped('t4414')` | a texture as the GPU holds it at the end of the next frame: an intermediate target or a shadow map a dump names |
| `shader('ps585')` | a shader the program drew with, by the id a dump names it: its bytecode and every WGSL translation made of it, each under its variant (fog, sampling, alpha test); `live.mjs shader` prints the bytecode disassembled beside them |
| `pick(x, y)` | which draw painted that pixel: the program paused while the frame is taken apart |
| `freeze(on)` | shows the last frame over and over, the program paused (a running one is paused here and `freeze(false)` resumes it), so a cut or a switch is seen on a still picture |
| `maxDraws(n)` | keeps the first n draws of every frame (-1 all): bisects which draw paints a region |
| `skipTexture('t12,t40')` | drops every draw sampling those textures (names as a dump gives them) |
| `skipShader('vs12,ps40')` | drops every draw made with those shaders |
| `srgb(false)` | reads and writes every texel as stored, D3DSAMP_SRGBTEXTURE and D3DRS_SRGBWRITEENABLE ignored; `srgb()` back |
| `stageLimit(n)` | keeps the first n texture stages of fixed-function draws |
| `textureStats('t642')` | adds to each dump what that texture's top level holds in guest memory |
| `occlusion(mode)` | how occlusion counts are answered from now on ('' as measured) |
| `bufferLocks(mode)` | how buffer locks are taken ('' as asked, 'rename' renaming at each) |
| `checkDraws(on)` | every draw from a buffer compares what it reads with what the graphics worker was sent, from now on; the report's `drawChecks` gains an entry each time it is turned on (`stale` draws, the first ones as samples) |
| `captureFrames(n)`, then `captured()` | in a run whose graphics worker captures what it is sent (`game.mjs --graphics-capture`): the frames to measure begin here and the capture ends n presents later; `captured()` ends it if it has not ended and answers `{ bytes, counts }`, the gzip stream and how many batches, presents and bytes it saw and zeroed |
| `handleWords(on)` | `false`: every wait on an event, mutex or semaphore, SetEvent, ResetEvent, ReleaseMutex and ReleaseSemaphore crosses into the host, as with `win32.handleWords: false`; `true` gives the guest its answers back |
| `windows()`, `desktop()` | every live window as the window manager lists it; the desktop picture |
| `modules()`, `moduleAt(address)` | every image mapped and where; which image an address is in |
| `read(address, length)` | guest memory |
| `hook(address, how)` | a watch in front of a routine: its calls in the trace with arguments and answer |
| `ringTrace(n)` | keeps the last n Direct3D calls the guest's command rings carried (calls that never cross to the host one by one), 0 stops; answers what was kept |
| `callRingSkip('A,B')` | names kept out of the bridge's call ring, the one `app.diagnostics()` reads as the bridge's `recentDetailed` (each call with its caller `from`, arguments and answer) |
| `processes()`, `diagnosticsOf(id)`, `readOf(id, address, length)`, `hookOf(id, address, how)` | every process standing, those running beside their parent (children, COM servers, services) marked `beside`; one process's diagnostics, its pipes among them (`win32.pipes`: each handle and what holds the other end); its memory; a watch (`hook`) in front of one of its routines, its calls in the `guest-return` events |
| `registry`, `exported(lib, name)` | the program's registry; whether a system library exports a name |
| `start(commandLine)` | a program of the bottle started beside the running one as its `CreateProcess` would start it, e.g. `ngen.exe install "C:\App\Game.exe"`; answers the child's process id (null when the line names no image). Its writes reach the session like the program's own |

One more is on `app.log` rather than `app.debug`, since it reads the profiler's frames:
`app.log.drops(n)` (default 1000; the engine keeps the last 240, about four seconds) answers
the mean frame rate, the slowest 1% and 0.1% as rates, the worst frames, and every frame over 16.7 ms
and twice the median named by the part that grew past an ordinary frame's: `translation` (more
modules instantiated, more translating on the engine's thread, or more interpreted), `guest work` (more instructions), `guest slower` (the
same work, slower), `host <phase>`, `fetch` or `waiting` (parked), `outside the engine` (wall
time no phase accounts for: `garbage collection` when the heap shrank). GPU time is not in the
frame record yet, nor the heap in a worker, and each is said to be not measured (`modules/core/src/frame-drops.js`).

#### A wrong picture in a running game, step by step

The person at the game holds the pause; nothing here presses resume or reloads the tab.

1. Start `live.mjs console > dbg/console.log` before anything else and read it grouped by kind: a
   WebGPU validation error drops a whole frame, and Chrome stops printing them after a few
   hundred per device, so a log started late shows nothing.
2. `dumpFrames(2)`, then `dumped()`: the first frame may be caught half-way, the second is whole
   (a frame submitted in parts is joined with `-- submitted (N draws)` lines). Find the draw by
   its target, its textures and its state; ids (`ps585`, `t698`) last until the tab reloads.
3. `live.mjs snapshot` on the textures that draw reads and the target it writes: an input already
   wrong points before the draw, inputs right and output wrong point at the draw.
4. `live.mjs shader ps585`: the bytecode disassembled beside its WGSL, read for the instruction that
   came out wrong (a component, a register, a coordinate).
5. To prove which draw it is: `skipShader('ps585')` (or `skipTexture`) and look; on a paused
   game `freeze(true)` first, which plays the shown frame again with the switch applied.
6. Never mix frames: a dump of one frame and textures of another disagree by however much the
   camera moved and by whatever the program regenerates only some frames (shadow cascades, cached
   maps), and the disagreement looks like a bug. Take the dump and the textures of one frame:
   paused, `freeze(true)` then `maxDraws(n)` and `snapshot(...)` -- the frozen frame's lines
   (`dumped()`) carry each draw's pass, target and the constants its recorded blocks hold. A
   program that destroys its targets every frame breaks the frozen replay (the console says
   `Destroyed texture used in a submit` and the snapshots come back zero); then let it run with
   the player standing still and take `dumpFrames(1)` and `snapshot` together.
7. A visual bisect is the person's to judge, not a screenshot's (a VM's GPU driver distorts
   them): switch a group off and leave it, say what is off, wait for the verdict; keep what
   is off off and add the next group. Per-draw groups come from what a draw reads:
   `skipTexture('t727')` drops the one draw of a cascade's shadow mask that samples its map.
8. Before blaming the data, run the shader on it: a small script that executes the dump's
   bytecode line by line on the snapshots (`live.mjs shader` gives the bytecode) says whether the
   GPU's answer follows from its inputs. If it does, the inputs or the state around the draw
   (stencil, which pixels it reaches) are wrong; if not, the translation is.

`app.diagnostics()` is the whole engine's account (what a report holds), and two reports of
one run diffed (`live.mjs diff`) are a scene's window.
