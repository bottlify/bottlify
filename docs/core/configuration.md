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

`createApp` builds every layer itself, turning its options ([api.md](api.md)) into the settings
below and wiring the callbacks the layers need from each other (memory access, guest calls, COM
publishing). The tables list only the settings that are data. `memory` and `loader` have none.

## log

| Setting | Default | What it does |
| --- | --- | --- |
| `categories` | `{}` | Level per call area: `call.cpu`, `call.gpu`, `call.audio`, `call.video`, `call.input`, `call.net`, `call.com`, `input.press`, `input.message`. A thread's calls that repeat in a loop of up to 8 (name, arguments and answer) are written until the loop has gone round twice, then counted, and the count is written when the loop ends and every 65,536 calls while it runs. |
| `level` | none | The default level: `off`, `error`, `warn`, `info`, `debug`, `trace`. |
| `capacity` | none | Records the journal's index holds. |
| `bytes` | 1 MiB | The record ring's size. |
| `shared` | `false` | Keep the journal and counters in `SharedArrayBuffer`, readable from another thread. |
| `frames` | 240 | Rows of the per-frame table. |

## cpu

| Setting | Default | What it does |
| --- | --- | --- |
| `engine` | `'cork'` | `'cork'`, or `'emulator'` with a v86 build the caller brings. |
| `memorySize` | 1 GiB | Guest RAM. |
| `sampling` | `true` | Sample the guest's instruction pointer at every turn. |
| `noExecuteBelow` | 0 (`createApp`: `0x10000`) | Code below this address faults when run. |
| `closedBelow` | 0 | Memory below this address faults when read or written. |
| `cork.config` | | cork's settings: `precise` (`false`; keep the x87 flags and undefined flags exact), `store` (`'local'`: translations in OPFS; `null`: none), `worker` (translate in a worker where one exists), `batchRegions` (32), `maxBatchRegions` (256), `hotThreshold` (2000), `wasmInterpreter` (`true`), `sharedMemory` (`true`: guest memory is a `SharedArrayBuffer` wherever the page is cross-origin isolated; `false` keeps it unshared), `timings` (`false`), `translators` (unset: the run's pool lends them; a number: that many workers of the runtime's own), `arenaBytes` (48 MB: the functions already emitted, shared by the process's translators; `0`: each keeps its own), `atomic` (`false`; locked instructions as wasm atomics, indivisible on the shared memory, for a process whose threads run on more than one executor), `ordered` (unset: on for several executors on a host that reorders plain memory accesses, arm64, where a program's plain stores would reach its other threads out of order; `true` or `false` decides it; the cpu layer's diagnostics say which was taken). The full list is `EngineConfig` in `src/layers/cpu/engine.js`. |
| `cork.pool` | on where a translator would use a worker | The run's pool of translation workers. Each process is lent one from its start to its exit, and more while its translation lags and they make it go faster (the pool's driver, `src/host/pool/driver.js`). `false` turns it off; setting `cork.config.translators` does too. |
| `cork.poolPerProcess` | the host's cores less the program's (`cpu.cores`) and two, at least 1 | Workers of the pool at most for one process; the pool holds at most this many times the processes running. Each of the program's cores is an executor kept busy running it, and the graphics worker and the browser's own threads take about two more (an estimate): a translator past those takes a core from the program. |
| `jit` | none | The emulator's compiler budgets, by index. |
| `cpu` | cores: automatic | The machine's processor. `cores` (1 to 32) is how many processors the program is told it has and how many executors run its threads at once (the same number, set once; `executors` below is its older name). A run that names neither, in a browser whose page can share memory (cross-origin isolated, not `compatible`, under cork), gets one fewer than the host's processors (`navigator.hardwareConcurrency`), at most eight: the program sizes its threads to them, and their executors open only as its threads want them, so a program of one thread costs no more than on one core. Cores the run names open all before the program starts, since one opened as a thread first wants it comes some tens of milliseconds late, a stall in the middle of a game; `cpu.eager` says which outright (`false`: as threads want them, `true`: all at the start). Opened as threads want them, the count is kept in the translation store, and the next run of the bundle opens as many at its start: the stall is the first run's alone. Anywhere else it gets one. `cpu.placement` says where the threads run past one core: `spread`, each ready thread on a core of its own; `concentrate`, all of them taking turns on the process's own, as on one processor; `auto` (the default) tries both now and then for a few seconds and keeps the faster, by frames presented a millisecond where the program presents them and by instructions retired on every core where it does not, spreading having to win by 5%. `cpu.playPinned` (default `true`): a thread the program pinned to one processor whose calls into the host take the process's own core the most time may have that processor played by that core, where its calls are answered, the core that played it taking the process's; the trade is tried against no trade by the same trial as `placement`, never at once with it, and kept only where it wins; `false` keeps every processor on its own core. `cpu.freeHost` (default `false`): `true` keeps the process's own core for the host's answers while a thread is pinned to its processor (a game's main thread, pinned to the first): another core plays that processor, the process's own plays one no thread is pinned to, and the threads spread with no trial. Under node a run that names neither takes `BOTTLIFY_CORES` from the environment, and one without it, so a suite runs the same on every machine and can be run with every program on several executors; a test whose subject is one processor's behaviour names `cpu: { cores: 1 }`, as does a run that must be the same on every machine. |
| `executors` | as `cpu.cores` | `cpu.cores` by its older name. Under cork, the program's executors (`createApp`'s `executors`): past the process's own thread, each a worker running one of its threads at once with the others over the same memory, with the locked instructions atomic (`cork.config.atomic` is set for it). A worker is opened when a ready thread wants one (a thread more than the open executors run, or one whose affinity mask names it), some tens of milliseconds before it runs one; a program of one thread opens none. `cpu.eager` opens them all before the program starts, for a gate or a measurement that wants threads at once from the first instruction. Each thread keeps one executor: the process's first thread the process's own, every later one the other executor fewest threads keep; a thread whose executor is taken runs on one left free, and one kept by another executor comes to the process's own as soon as that one has nothing to run. A thread that calls into the host more often than once in 30 000 instructions over its last million or so instructions (each such call from another executor a round trip to the process's own), or whose runs elsewhere have mostly ended with the process's own calling it back runs on the process's own only, where its affinity mask allows it, and takes that executor from a thread that computes. The process's own thread runs its threads and answers the others' calls into Win32 and the kernel at each of its own calls, between its turns, and inside them: a call from another executor stores a word the process's translated code reads at every back edge, and its slice leaves there to answer and goes on: a load and a compare at each back edge, only where there is more than one core. The other executors' translations are made once for all of them: the same bytes on each, one arena of emitted functions shared by them and their translators, so a routine one of them translated another takes as it is; the process's own executor translates for itself, as with one executor, and keeps the translation store, which the others' translators ask through it, so a warm start is warm on every executor. A thread runs on one executor at a time, never on two at once. While more threads are ready than there are executors, another executor keeps its thread a turn, 1 ms (`cork.config.executorHoldMs`), before it gives it up for one that waits. The program is told it has one processor for each executor (GetSystemInfo, the process block, `cpuid`'s count and cores, GetLogicalProcessorInformation, NUMBER_OF_PROCESSORS and the registry's CentralProcessor keys all say so, and `cpuid` answers each executor's number as its APIC id), so an engine sizes its thread pool to them; a thread's affinity mask names the executors it may run on, and one that pins itself elsewhere moves there before SetThreadAffinityMask returns. At most 32. Executors share memory through a `SharedArrayBuffer`, which a page has only when it is cross-origin isolated: without one, or where the run keeps the memory unshared (`cork.config.sharedMemory: false`, as the `compatible` mode does), the program runs on one executor, is told of one, and the cpu layer's diagnostics say why (`executorsRefused`). |

## kernel

| Setting | Default | What it does |
| --- | --- | --- |
| `quantum` | 100 000 | Guest instructions per scheduler turn. Unless it is given, a turn among ready threads with no deadline within a millisecond is as many instructions as a quarter of a millisecond takes at the rate the executor retires them, when that is more, up to a solo turn: a turn's own cost is a few microseconds, a fifth of a quantum of fast translated code. Given, every such turn is that many, to the instruction. |
| `soloQuantum` | 10 quanta | Guest instructions per turn of a thread no other is ready beside, while no timed wait or timer is due within 16 ms: with nobody to share the processor with, a turn only costs the host its own bookkeeping. |
| `preemption` | `false` | End a turn early when a thread of higher priority is due. |
| `pendingYieldMs` | 1 | While a host answer is outstanding and other threads still run, how often the loop leaves for the event loop to hear it. |
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
| `handleWords` | `true` | `false` leaves every WaitForSingleObject, ReleaseMutex, SetEvent and ResetEvent to the host, with no answers in the guest: the second path their tests compare against. |
| `http` | `null` | The request function behind WinINet; without it WinINet says there is no network. |
| `directx` | `'9'` | `'7'`, `'8'` or `'9'`: the DirectX release the registry, `DirectXSetupGetVersion` and DxDiag report. `createApp` sets it from `graphicsApi`. |

## graphics

| Setting | Default | What it does |
| --- | --- | --- |
| `screen` | 640 × 480, 32 | The display the devices start from. |
| `compressedTextures` | `false` | Upload DXT textures as BC where the GPU has `texture-compression-bc`; otherwise they are decoded on the CPU. |
| `maxFrameLatency` | 3 | Frames the GPU may still be drawing when `Present` returns; 0 for no bound. |
| `maxFps` | 60 | Passed to the presenter; not applied yet ([limits.md](limits.md#graphics)). |
| `choice` | every API | `createApp`'s `graphicsApi`: which roots are built ([api.md](api.md)). |
| `videoMemory` | the choice's | Megabytes of video memory every API reports (DirectDraw's caps and `GetAvailableVidMem`, Direct3D 8/9's `GetAvailableTextureMem`, DXGI's adapter description). Absent, the `graphicsApi` preset's era: 64 for DirectX 7, 128 for 8, 256 for 9, 1024 for 10, 256 for OpenGL and for no choice. |
| `raster` | `true` | `false` leaves OpenGL primitives drawn without a GPU unrasterised, for measurement. |
| `draw` | `true` | `false` draws nothing: no API reaches the GPU or the graphics worker, OpenGL is not rasterised, and every API keeps the state a program sets and answers what it asks, as in a build without a GPU. A Direct3D 9 occlusion query counts every pixel of the target, so a program culls nothing it would draw. For measuring a program's own work without the GPU's. |
| `lendMemory` | `true` | With a graphics worker and shared guest memory: what a Direct3D 8 or 9 program unlocks is read by the worker in place instead of copied to it. `false` copies it, for measurement. |
| `guestCode` | `true` | Direct3D 8 and 9 keep the state a program sets, the calls it makes in order and the counts of its references in guest memory, and answer its getters there, so most calls never cross to the host. `false` traps every call, as before they did: a fault that goes away with it is in that guest code. |
| `driverRules` | `'legacy'` | Where Direct3D left a behaviour to the driver and drivers changed it, which generation Direct3D 9, 8, 7 and earlier follow: `'legacy'`, the drivers of the shader-model-1 and 2 era that programs of that time were written against; `'current'`, later drivers, which Wine's conformance tests record. Four behaviours: table fog through a vertex shader runs over the oFog it wrote, or over z or w as the projection says when it wrote none (`'legacy'`), or over z (`'current'`), [decisions.md](../../roadmap/decisions.md) A43; and under a vertex shader a 1.0-1.3 pixel shader's projective read divides by w (`'legacy'`) or by the last coordinate its transform flags count (`'current'`), A44; and a pre-transformed vertex with a negative RHW is clipped behind the eye only in a draw from a vertex buffer ProcessVertices clipped (`'legacy'`), or in every draw (`'current'`), A45; and under Direct3D 8 a draw through a vertex format is drawn by the texture stages whatever pixel shader is bound (`'legacy'`), or by the bound shader (`'current'`), A46. |
| `keepMemory` | `false` | For debugging: memory a released Direct3D 9 resource held is never given back to the guest's heap. |
| `rereadBuffers` | `false` | For debugging, without a graphics worker: every Direct3D draw compares the vertices it reaches with guest memory and sends what changed, for every buffer (a dynamic one always does). |
| `guestTraps` | `[]` | With `guestCode` on, the parts of that guest code kept as traps all the same: methods by name, or the groups `getters`, `ring`, `locks`, `levels` and `counts`. For narrowing down which part a fault is in. |

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
