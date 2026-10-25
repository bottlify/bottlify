# Configuration

## The module contract

- A layer is a module: `{ name, version, requires, create(config, host), diagnostics(), dispose() }`
  (`src/system/contract.js`).
- `requires` names the layers it may use. `host.requireApi(name)` answers only for those, and
  `host.provide(name, api)` only for the layer's own name (`src/system/host.js`).
- `assembleModules(config)` (`src/core.js`) takes `{ layerName: true | false | config }`, orders the
  layers by `requires` and creates them. A disabled layer that another needs is replaced by a stub
  whose every method throws `NOT_IMPLEMENTED`; one nothing needs is left out.
- An unknown name or a cycle is a configuration error before anything is created
  (`src/system/registry.js`).
- `npm run check:boundaries` checks that a layer imports only what its `requires` names.

`createApp` builds every layer itself: it turns its options ([api.md](api.md)) into the settings
below and wires the callbacks the layers need from each other (memory access, guest calls, COM
publishing). The tables list only the settings that are data; `memory` and `loader` have none.

## log

| Setting | Default | What it does |
| --- | --- | --- |
| `categories` | `{}` | Level per call area: `call.cpu`, `call.gpu`, `call.audio`, `call.video`, `call.input`, `call.net`, `call.com`, `input.press`, `input.message`. A thread's calls that repeat in a loop of up to 8 (name, arguments and answer) are written until the loop has gone round twice, then counted; the count is written when the loop ends and every 65,536 calls while it runs. |
| `level` | none | The default level: `off`, `error`, `warn`, `info`, `debug`, `trace`. |
| `capacity` | none | Records the journal's index holds. |
| `bytes` | 1 MiB | The record ring's size. |
| `shared` | `false` | Keep the journal and counters in `SharedArrayBuffer`, readable from another thread. |
| `frames` | 240 | Rows of the per-frame table. |

## cpu

| Setting | Default | What it does |
| --- | --- | --- |
| `engine` | `'cork'` | `'cork'`, or `'emulator'` with a v86 build the caller brings. |
| `memorySize` | 1 GiB | Guest RAM: an address space; what the program holds of it is counted in the guest's zone (see [Memory zones](#memory-zones)). |
| `sampling` | `true` | Sample the guest's instruction pointer at every turn. |
| `noExecuteBelow` | 0 (`createApp`: `0x10000`) | Code below this address faults when run. |
| `closedBelow` | 0 | Memory below this address faults when read or written. |
| `cork.config` | | cork's settings (`EngineConfig` in `src/layers/cpu/engine.js`); each one's default, effect and risk is in [modules/cork/SETTINGS.md](../../modules/cork/SETTINGS.md). The cpu layer adds its own defaults: guest memory is a `SharedArrayBuffer` wherever the page is cross-origin isolated (`sharedMemory: false` keeps it unshared); `translators` left unset lets the run's pool lend them, a number opens that many workers of the runtime's own; `atomic` is set for a process whose threads run on more than one executor; `ordered` is off unless given: `true` keeps a program's plain stores in their order between its threads on a host that reorders them (arm64), at the cost of every integer access being an atomic one, and the cpu layer's diagnostics say which way a process runs. |
| `cork.pool` | on where a translator would use a worker | The run's pool of translation workers. Each process is lent one from its start to its exit, and more while its translation lags and they make it faster (the pool's driver, `src/host/pool/driver.js`). `false` turns it off, as does setting `cork.config.translators`. |
| `cork.poolPerProcess` | the host's cores less the program's (`cpu.cores`) and two, at least 1 | The most pool workers one process gets; the pool holds at most this many times the processes running. Each of the program's cores is an executor kept busy running it, and the graphics worker and the browser's own threads take about two more (an estimate), so a translator past those takes a core from the program. |
| `jit` | none | The emulator's compiler budgets, by index. |
| `cpu` | cores: automatic | The machine's processor. `cores` (1 to 32) is how many processors the program is told it has and how many executors run its threads at once (one number, set once; `executors` below is its older name). A run that names neither, in a browser whose page can share memory (cross-origin isolated, not `compatible`, under cork), gets one fewer than the host's processors (`navigator.hardwareConcurrency`), at most eight; anywhere else, one. The program sizes its threads to them, and their executors open only as its threads want them, so a program of one thread costs no more than on one core; the count opened is kept in the translation store, and the next run of the bundle opens as many at its start, so only the first run stalls. Cores the run names all open before the program starts, because a core opened when a thread first wants it comes some tens of milliseconds late, a stall mid-game. `cpu.eager` decides outright: `false`, as threads want them; `true`, all at the start. `cpu.placement`, where threads run past one core: `spread`, each ready thread on a core of its own; `concentrate`, all taking turns on the process's own core, as on one processor; `auto` (the default with `cpu.freeHost: false`), each thread moved in or out of the process's own core on its gains, reckoned every quarter second from what it did (its work, its waits for the process's answers, its waits for a turn, its calls) and built up until they reach 300 ms, one thread at a time; nothing is tried or measured back on the running program, and a move is taken back only on the gains of the move back. `cpu.playPinned` (default `true`, with `cpu.freeHost: false`): a thread the program pinned to one processor, whose calls into the host take the most of the process's own core's time, may have that processor played by the process's own core, where its calls are answered, while the core that played it takes the process's; the trade is made and given back on its gains as a move is; `false` keeps every processor on its own core. `cpu.freeHost` (default `true`) keeps the process's own core for the host's answers while a thread is pinned to its processor (a game's main thread, pinned to the first): another core plays that processor, the process's own core plays one no thread is pinned to, and the threads spread, none moved, unless `cpu.placement` is named; `false` gives back `auto` and `playPinned`. Under Node a run that names neither takes `BOTTLIFY_CORES` from the environment, or one without it, so a suite runs the same on every machine and can run every program on several executors; a test whose subject is one processor's behaviour names `cpu: { cores: 1 }`, as does a run that must be the same on every machine. How the scheduler places threads: [architecture.md](../architecture.md#execution-in-bottlify). `cpu.gcNudge` (default: on where JavaScriptCore runs, Safari and every browser on iOS; off elsewhere): the threads that hold the guest's memory, and the graphics worker, make and drop an untouched buffer every 20 ms (64 MB, or a quarter of the guest's memory past 256 MB), which JavaScriptCore counts as allocated and so collects their garbage sooner; the buffer is never written and costs no memory. The engine's thread also makes one between the guest's slices once 20 ms have passed, since a load can keep it from its event loop, and so from the timer, for seconds. It keeps the page's process smaller at the start and after it (the Quake III Arena demo in WebKit: about 1.3 GB at the peak instead of 1.5-1.8, and about 0.95 GB after it instead of 1.0-1.4; the Doom 3 demo with 2 GB: 1.5-1.6 GB at the peak instead of 2.3). `false` turns it off; `{ everyMs, bytes }` sets its period and size; `true` turns it on in any browser. |
| `executors` | as `cpu.cores` | `cpu.cores` by its older name (`createApp`'s `executors`). Under cork, each executor past the process's own thread is a worker running one of the program's threads at once with the others over the same memory, with the locked instructions atomic (`cork.config.atomic` is set for it). A worker opens when a ready thread wants one: a thread more than the open executors run, or one whose affinity mask names it. `cpu.eager` opens them all at the start, for a gate or a measurement that wants threads at once from the first instruction. The other executors' calls are answered by the process's own thread, which reads a word at every back edge of its translated code: a load and a compare, only where there is more than one core. The translation store is shared through the process, so a warm start is warm on every executor. While more threads are ready than there are executors, an executor keeps its thread a turn, 1 ms (`cork.config.executorHoldMs`), before giving it up to one that waits. The program is told it has one processor for each executor (GetSystemInfo, the process block, `cpuid`'s count and cores, GetLogicalProcessorInformation, NUMBER_OF_PROCESSORS and the registry's CentralProcessor keys), and `cpuid` answers each executor's number as its APIC id, so an engine sizes its thread pool to them. A thread's affinity mask names the executors it may run on; one that pins itself elsewhere moves there before SetThreadAffinityMask returns. Executors share memory through a `SharedArrayBuffer`, which a page has only when it is cross-origin isolated: without one, or where the run keeps memory unshared (`cork.config.sharedMemory: false`, as the `compatible` mode does), the program runs on one executor, is told of one, and the cpu layer's diagnostics say why (`executorsRefused`). Which thread runs on which executor: [architecture.md](../architecture.md#execution-in-bottlify). |

## Memory zones

A tab running one program holds at most 1.5 GiB, in three zones whose ceilings sum to that and no
more (`src/memory-zones.js`):

| Zone | Ceiling | What it holds |
| --- | --- | --- |
| guest | 1 GiB | What the program holds of its RAM: its images, its threads' stacks and the heap's blocks it was handed. The RAM itself (`memorySize`) is an address space: a page the program never touched costs the tab nothing. |
| translation | 256 MiB | The translator's tables past the RAM, every executor's, and its modules with their compiled code. The cpu layer gives cork what the tables leave (`cork.config.cacheBytes`, unless the run names one), split among the executors' runtimes, each of which makes its own instances: all of it to one executor, else three quarters to the process's own executor and the rest shared by the others. Past its part a runtime lets the modules gone longest without running go, and brings one back from the translation store when it is reached again. |
| heaps | 256 MiB | The engine's own memory: the bundle's blocks held where no storage takes them (64 MiB at most, the least recently read let go first), its decoded blocks (16 MiB at most), mirrors of guest memory behind a played device, kept texels, sound rings, the translation store's index. |

Each layer says what it holds in its diagnostics as `bytesHeld`, by zone and pool; a pool nothing
measures says `not measured`. The last table of a run's diagnostics, `zones`, sums them: each zone's
ceiling, bytes, pools and unmeasured pools, the layers that report nothing (`unreported`), and the
device's buffers and textures apart (`outside.device`), held by the GPU's process rather than the
tab unless the device is one in JavaScript. Its status is `over` when a zone or the total is past
its ceiling.

Storage has a budget too. When a run mounts a bundle on the origin's file system, the origin is
kept to 80% of the quota the browser gives it (`navigator.storage.estimate()`, which each browser
sets by its system and disk): past that, other bundles' block caches and translations go, the
least recently written first. A session (the files a program wrote) is never touched, nor the
caches of the run asking or of a bundle another tab runs. The `storage-budget` event says what
went. Opening a bundle's translations removes every file of an older generation and any file the
store does not know (`cpu` diagnostics, `store.opened.swept`).

## kernel

| Setting | Default | What it does |
| --- | --- | --- |
| `quantum` | 100 000 | Guest instructions per scheduler turn. Unless it is given, a turn among ready threads with no deadline within a millisecond lasts as many instructions as the executor retires in a quarter of a millisecond, when that is more, up to a solo turn: a turn's own cost is a few microseconds, a fifth of a quantum of fast translated code. Given, every such turn is exactly that many. |
| `soloQuantum` | 10 quanta | Guest instructions per turn of a thread with no other ready beside it, while no timed wait or timer is due within 16 ms: with nobody to share the processor with, a turn costs the host only its own bookkeeping. |
| `preemption` | `false` | End a turn early when a thread of higher priority is due. |
| `pendingYieldMs` | 1 | While a host answer is outstanding and other threads still run, how often the loop yields to the event loop to hear it. |
| `stacks` | set by `createApp` | Where thread stacks are carved from and how big each is: `base`, `size`, `limit`. |

## bridge

| Setting | Default | What it does |
| --- | --- | --- |
| `traceStrings` | `false` | Keep the text a string argument points at. |
| `callPhases` | `false` | Time every host call as a phase. |
| `record` | 0 | Events at the bridge to keep for a replay. |

## filesystem

| Setting | Default | What it does |
| --- | --- | --- |
| `drives` | `{}` | Drives by letter, each with its stores. |
| `openFileLimit` | 4096 | Files open at once. |

## win32

| Setting | Default | What it does |
| --- | --- | --- |
| `windows` | `'winxp'` | The Windows version reported everywhere. |
| `compatibility` | from the image | The program's manifest compatibility: what Windows 10 tells it its version is. |
| `screen` | 640 × 480, 32 | The display. |
| `commandLine` | the quoted image path | `GetCommandLine`. |
| `environment` | none | The environment block. |
| `processorMhz` | none | The speed the registry's processor key reports. |
| `unattended` | `false` | Answer every modal dialog with its default button. |
| `network` | loopback | The transport under Winsock (a relay client). |
| `trustedRoots` | Microsoft Root Authority | Roots `WinVerifyTrust` accepts, as DER bytes or base64. |
| `handleWords` | `true` | `false` leaves every WaitForSingleObject, ReleaseMutex, SetEvent and ResetEvent to the host, with no answers in the guest: the second path their tests compare against. `app.debug.handleWords(on)` switches the same while a program runs. |
| `http` | `null` | The request function behind WinINet; without it WinINet says there is no network. |
| `directx` | `'9'` | `'7'`, `'8'` or `'9'`: the DirectX release the registry, `DirectXSetupGetVersion` and DxDiag report. `createApp` sets it from `graphicsApi`. |

## graphics

| Setting | Default | What it does |
| --- | --- | --- |
| `screen` | 640 × 480, 32 | The display the devices start from. |
| `compressedTextures` | `false` | Upload DXT textures as BC where the GPU has `texture-compression-bc`. Where it has `texture-compression-astc` and not BC, as a phone's GPU, OpenGL's DXT1 textures are uploaded as ASTC 4x4 blocks, a byte a texel instead of four. Otherwise they are decoded on the CPU. |
| `maxFrameLatency` | 3 | Frames the GPU may still be drawing when `Present` returns; 0 for no bound. A device in the graphics worker counts a frame drawn when the browser's GPU process says so, later than the GPU finishes it. |
| `maxFps` | 60 | Passed to the presenter; not applied yet ([limits.md](limits.md#graphics)). |
| `choice` | every API | `createApp`'s `graphicsApi`: which roots are built ([api.md](api.md)). |
| `videoMemory` | the choice's | Megabytes of video memory every API reports (DirectDraw's caps and `GetAvailableVidMem`, Direct3D 8/9's `GetAvailableTextureMem`, DXGI's adapter description). Absent, the `graphicsApi` preset's era: 64 for DirectX 7, 128 for 8, 256 for 9, 1024 for 10, 256 for OpenGL and for no choice. |
| `raster` | `true` | `false` leaves OpenGL primitives drawn without a GPU unrasterised, for measurement. |
| `draw` | `true` | `false` draws nothing: no API reaches the GPU or the graphics worker, OpenGL is not rasterised, and every API keeps the state a program sets and answers what it asks, as in a build without a GPU. A Direct3D 9 occlusion query then counts every pixel of the target, so a program culls nothing it would draw. For measuring a program's own work without the GPU's. |
| `lendMemory` | `true` | With a graphics worker and shared guest memory, the worker reads what a Direct3D 8 or 9 program unlocks in place instead of a copy. `false` copies it, for measurement. |
| `guestCode` | `true` | Direct3D 8 and 9 keep the state a program sets, the calls it makes in order and its reference counts in guest memory, and answer its getters there, so most calls never cross to the host. `false` traps every call: a fault that goes away with it is in that guest code. |
| `driverRules` | `'legacy'` | Where Direct3D left a behaviour to the driver and drivers changed it, which generation Direct3D 9, 8, 7 and earlier follow: `'legacy'`, the drivers of the shader-model-1 and 2 era that programs of that time were written against; `'current'`, later drivers, which Wine's conformance tests record. Four behaviours ([decisions.md](../../roadmap/decisions.md)): A43, table fog through a vertex shader runs over the oFog it wrote, or, when it wrote none, over z or w as the projection says (`'legacy'`), or over z (`'current'`); A44, under a vertex shader a 1.0-1.3 pixel shader's projective read divides by w (`'legacy'`) or by the last coordinate its transform flags count (`'current'`); A45, a pre-transformed vertex with a negative RHW is clipped behind the eye only in a draw from a vertex buffer ProcessVertices clipped (`'legacy'`), or in every draw (`'current'`); A46, under Direct3D 8 a draw through a vertex format is drawn by the texture stages whatever pixel shader is bound (`'legacy'`), or by the bound shader (`'current'`). |
| `keepMemory` | `false` | For debugging: memory a released Direct3D 9 resource held is never given back to the guest's heap. |
| `checkDraws` | `false` | For debugging, with a graphics worker: every Direct3D draw from a buffer compares the bytes it reads in guest memory with what the worker was sent of them; the report's `drawChecks` counts the draws that read stale bytes and keeps the first of them. `app.debug.checkDraws(on)` switches it while a program runs, comparing from that moment. |
| `verifyDynamic` | `false` | For debugging, with a graphics worker: every Direct3D draw from a dynamic buffer compares the bytes its indices reach in the worker's copy of guest memory with the buffer's copy as the draw is recorded, and with the GPU buffer it binds once its frame is submitted, read back from the GPU within 4 MB a frame; the report's `verifyDynamic` counts the ranges that differ (`copyStale`, `gpuStale`), the vertices indices reach past a draw's declared range (`beyond`), and keeps the first of each with the buffer's last moves. |
| `rereadBuffers` | `false` | For debugging, without a graphics worker: every Direct3D draw compares the vertices it reaches with guest memory and sends what changed, for every buffer (a dynamic one always does). |
| `guestTraps` | `[]` | With `guestCode` on, the parts of that guest code kept as traps anyway: methods by name, or the groups `getters`, `ring`, `locks`, `levels` and `counts`, and `moves`: a DISCARD under draws comes to the host instead of moving the buffer onto a spare storage in the guest. For narrowing down which part a fault is in. |

## audio

| Setting | Default | What it does |
| --- | --- | --- |
| `shared` | `false` (`createApp`: when `SharedArrayBuffer` exists) | Write the voices into a shared table an `AudioWorklet` reads; otherwise into a ring on the engine thread. |
| `drained` | `false` | Something really reads the output, so play cursors follow the sound rather than a clock. |
| `sampleRate` | none | The output's rate. |
| `mp3` | `true` | The engine's MP3 provider for Miles in place of the program's `Mp3dec.asi`; `false` keeps the program's own. |

## input

No settings of its own: `createApp` connects it to `win32`'s windows and focus.

## media

| Setting | Default | What it does |
| --- | --- | --- |
| `wasmBytes` | none | The video decoder's binary. Without it the layer reports that nothing can be played. |
