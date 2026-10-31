# Configuration

What `createApp`'s nested options ([api.md](api.md)) set, layer by layer. Options that exist to
rule something out while debugging are listed apart, under [Debugging](api.md#debugging); they are
not settings to ship with.

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

`createApp` builds every layer itself from its options and wires what the layers need from each
other (memory access, guest calls, COM publishing). The settings below are the ones a page gives.

## cpu

| Option | Default | What it does |
| --- | --- | --- |
| `memorySize` | 1 GiB | Guest RAM, a power of two: an address space. What the program holds of it is counted in the guest's zone ([Memory zones](#memory-zones)). |
| `cpu.cores` | automatic | How many processors the program is told it has, 1 to 32, and how many executors run its threads at once: past the process's own thread each is a worker over the same memory. Unset, a browser page that can share memory (cross-origin isolated, not `compatible`) gets one fewer than the host's processors (`navigator.hardwareConcurrency`), at most eight; Safari, a phone, and any page that cannot share memory get one. Under Node it is `BOTTLIFY_CORES` from the environment, or one. `executors`, its older name, is refused. |
| `cork.moduleUrl` | beside `core.js` | Where the translator is loaded from, for a bundler that moves it. |
| `cork.config.store` | `'local'` | Where translations are kept between runs: `'local'`, the origin's private file system; a store of your own, when the engine runs on the calling thread; `null`, none. |

The program is told of one processor for each executor (GetSystemInfo, the process block,
`cpuid`'s count and cores, GetLogicalProcessorInformation, `NUMBER_OF_PROCESSORS`, the registry's
CentralProcessor keys), and `cpuid` answers each executor's number as its APIC id. A thread's
affinity mask names the executors it may run on. Executors the run names all open before the
program starts; automatic ones open as its threads want them, and the count a bundle's threads
opened is kept in the translation store so the next run opens as many at its start. The process's
own executor answers every call the others make, and keeps itself for those answers while a thread
is pinned to its processor: another executor plays that processor. Without shared memory the
program runs on one executor, is told of one, and the cpu layer's diagnostics say why
(`executorsRefused`). How threads are placed: [architecture.md](../architecture.md#execution-in-bottlify).

cork's own settings (`cork.config`, `EngineConfig` in `src/layers/cpu/engine.js`) are in
[modules/cork/SETTINGS.md](../../modules/cork/SETTINGS.md). The cpu layer sets `atomic` for a
process whose threads run on more than one executor.

## Memory zones

A tab running one program holds at most 1.5 GiB, in three zones whose ceilings sum to that and no
more (`src/memory-zones.js`):

| Zone | Ceiling | What it holds |
| --- | --- | --- |
| guest | 1 GiB | What the program took of its RAM: its images, its threads' stacks and its heap up to the highest address the heap ever handed out (a page touched once is the tab's for good: a browser cannot give it back, and zeroing it frees nothing). The RAM itself (`memorySize`) is an address space: a page the program never touched costs the tab nothing. |
| translation | 256 MiB | The translator's tables past the RAM, every executor's, and its modules with their compiled code. The cpu layer gives cork what the tables leave, split among the executors' runtimes: all of it to one executor, else three quarters to the process's own executor and the rest shared by the others. Past its part a runtime lets the modules gone longest without running go, and brings one back from the translation store when it is reached again. |
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

Each turn of a thread is 100 000 guest instructions, or, among ready threads with no deadline
within a millisecond, as many as the executor retires in a quarter of a millisecond when that is
more; a thread with no other ready beside it and no timed wait due within 16 ms takes ten quanta
at a time. `quantum` (Debugging) fixes every turn at the number given.

## win32

| Option | Default | What it does |
| --- | --- | --- |
| `windows` | `'winxp'` | The Windows version the program sees ([api.md](api.md)). |
| `machine` | the first program's width | A 32- or 64-bit Windows ([api.md](api.md)). |
| `win32.trustedRoots` | Microsoft Root Authority | The machine's trusted roots, as DER bytes or base64: what `WinVerifyTrust` accepts and what crypt32's ROOT store holds, which `CertGetCertificateChain` ends a chain at. An empty list trusts nothing. |
| `win32.steam` | none | A signed-in Steam account (its Steam ID, name and the app ids its licences grant, as the page established with the person's own sign-in): the run then has a Steam client running, which a game's Steamworks calls reach, answering an app as owned only when it is listed. |
| `win32.network` | loopback | The transport under Winsock, when the engine runs on the calling thread; from a page, `network` ([api.md](api.md#network)). |

## graphics

| Option | Default | What it does |
| --- | --- | --- |
| `graphicsApi` | every API | Which system libraries exist and which DirectX the machine reports ([api.md](api.md)). |
| `gpuProfile` | `'host'` | The card the video adapter is shown as. `'sm1'` to `'sm4'`: a known card of that shader model, by its PCI ids and its shader versions, for a program that picks its render path from the cards it knows and takes its weakest on one it does not. `'host'`: the browser's vendor and shader model 3. The adapter's name stays Bottlify's either way. |
| `graphics.compressedTextures` | `false` | Upload DXT textures as BC where the GPU has `texture-compression-bc`. Where it has `texture-compression-astc` and not BC, as a phone's GPU, OpenGL's DXT1 textures go as ASTC 4x4 blocks, a byte a texel instead of four. Otherwise they are decoded on the CPU. Off by default: on some hardware BC uploads jammed the GPU process. |
| `graphics.maxFrameLatency` | 3 | Frames the GPU may still be drawing when `Present` returns; 0 for no bound. A device in the graphics worker counts a frame drawn when the browser's GPU process says so, later than the GPU finishes it. |
| `graphics.videoMemory` | the `graphicsApi` preset's | Megabytes of video memory every API reports (DirectDraw's caps and `GetAvailableVidMem`, Direct3D 8/9's `GetAvailableTextureMem`, DXGI's adapter description): 64 for DirectX 7, 128 for 8, 256 for 9, 1024 for 10, 256 for OpenGL and for no choice. |
| `graphics.driverRules` | `'legacy'` | Where Direct3D left a behaviour to the driver and drivers changed it, which generation Direct3D 9, 8, 7 and earlier follow: `'legacy'`, the drivers of the shader-model-1 and 2 era that programs of that time were written against; `'current'`, later drivers, which Wine's conformance tests record. Four behaviours ([decisions.md](../../roadmap/decisions.md)): A43, table fog through a vertex shader runs over the oFog it wrote, or, when it wrote none, over z or w as the projection says (`'legacy'`), or over z (`'current'`); A44, under a vertex shader a 1.0-1.3 pixel shader's projective read divides by w (`'legacy'`) or by the last coordinate its transform flags count (`'current'`); A45, a pre-transformed vertex with a negative RHW is clipped behind the eye only in a draw from a vertex buffer ProcessVertices clipped (`'legacy'`), or in every draw (`'current'`); A46, under Direct3D 8 a draw through a vertex format is drawn by the texture stages whatever pixel shader is bound (`'legacy'`), or by the bound shader (`'current'`). |
| `maxFps` | 60 | The display's refresh rate the program is told, which its vertical sync keeps to; 0 for none. |

## audio

| Option | Default | What it does |
| --- | --- | --- |
| `audio.drained` | `false` | Something really reads the output, so play cursors follow the sound rather than a clock. |
| `audio.sampleRate` | none | The output's rate. |
| `audio.port` | none | On a page without shared memory, the engine's end of the channel the worklet reads ([README.md](README.md#sound)). |

`openSpeaker().audioOptions()` gives all three ([api.md](api.md#the-speaker)).
