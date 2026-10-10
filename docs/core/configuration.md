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
| `level` | — | The default level: `off`, `error`, `warn`, `info`, `debug`, `trace`. |
| `capacity` | — | Records the journal's index holds. |
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
| `cork.config` | | cork's settings: `precise` (`false`; keep the x87 flags and undefined flags exact), `store` (`'local'`: translations in OPFS; `null`: none), `worker` (translate in a worker where one exists), `batchRegions` (32), `maxBatchRegions` (256), `hotThreshold` (2000), `wasmInterpreter` (`true`), `sharedMemory` (`true`: guest memory is a `SharedArrayBuffer` wherever the page is cross-origin isolated; `false` keeps it unshared), `timings` (`false`), `translators` (unset: the run's pool lends them; a number: that many workers of the runtime's own), `arenaBytes` (48 MB: the functions already emitted, shared by the process's translators; `0`: each keeps its own), `atomic` (`false`; locked instructions as wasm atomics, indivisible on the shared memory, for a process whose threads run on more than one executor). The full list is `EngineConfig` in `src/layers/cpu/engine.js`. |
| `cork.pool` | on where a translator would use a worker | The run's pool of translation workers. Each process is lent one from its start to its exit, and more while its translation lags and they make it go faster (the pool's driver, `src/host/pool/driver.js`). `false` turns it off; setting `cork.config.translators` does too. |
| `cork.poolPerProcess` | `navigator.hardwareConcurrency` | Workers of the pool at most for one process; the pool holds at most this many times the processes running. |
| `jit` | — | The emulator's compiler budgets, by index. |
| `executors` | 1 | Under cork, the program's executors (`createApp`'s `executors`): past the process's own thread, each a worker running one of its threads at once with the others over the same memory, with the locked instructions atomic (`cork.config.atomic` is set for it). Each thread keeps one executor, where its translations are: the process's first thread the process's own, every later one the other executor fewest threads keep. The process's own thread runs its threads and answers the others' calls into Win32 and the kernel at each of its own calls and between its turns. The translation store is the process's own executor's; the others translate for themselves. A thread whose executor is busy runs on one left free, never on two at once. Executors share memory through a `SharedArrayBuffer`, which a page has only when it is cross-origin isolated: without one the program runs on one executor and the cpu layer's diagnostics say why (`executorsRefused`). |

## kernel

| Setting | Default | What it does |
| --- | --- | --- |
| `quantum` | 100 000 | Guest instructions per scheduler turn. |
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
| `environment` | — | The environment block. |
| `processorMhz` | — | The speed the registry's processor key reports. |
| `unattended` | `false` | Answer every modal dialog with its default button. |
| `network` | loopback | The transport under Winsock (a relay client). |
| `trustedRoots` | Microsoft Root Authority | Roots `WinVerifyTrust` accepts, as DER bytes or base64. |
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
| `lendMemory` | `true` | With a graphics worker and shared guest memory: what a Direct3D 8 or 9 program unlocks is read by the worker in place instead of copied to it. `false` copies it, for measurement. |
| `guestCode` | `true` | Direct3D 8 and 9 keep the state a program sets, the calls it makes in order and the counts of its references in guest memory, and answer its getters there, so most calls never cross to the host. `false` traps every call, as before they did: a fault that goes away with it is in that guest code. |
| `driverRules` | `'legacy'` | Where Direct3D left a behaviour to the driver and drivers changed it, which generation Direct3D 8 and 9 follow: `'legacy'`, the drivers of the shader-model-1 and 2 era that programs of that time were written against; `'current'`, later drivers, which Wine's conformance tests record. One behaviour so far: table fog through a vertex shader that writes oFog runs over that oFog (`'legacy'`) or over the depth (`'current'`) -- [decisions.md](../../roadmap/decisions.md) A43. |
| `guestTraps` | `[]` | With `guestCode` on, the parts of that guest code kept as traps all the same: methods by name, or the groups `getters`, `ring`, `locks`, `levels` and `counts`. For narrowing down which part a fault is in. |

## audio

| Setting | Default | What it does |
| --- | --- | --- |
| `shared` | `false` (`createApp`: when `SharedArrayBuffer` exists) | Write the voices into a shared table an `AudioWorklet` reads; otherwise into a ring on the engine thread. |
| `drained` | `false` | Something really reads the output, so play cursors follow the sound rather than a clock. |
| `sampleRate` | — | The output's rate. |
| `mp3` | `true` | The engine's MP3 provider for Miles in place of the program's `Mp3dec.asi`; `false` keeps the program's own. |

## input

No settings of its own: `createApp` connects it to `win32`'s windows and focus.

## media

| Setting | Default | What it does |
| --- | --- | --- |
| `wasmBytes` | — | The video decoder's binary. Without it the layer reports that nothing can be played. |
