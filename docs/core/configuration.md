# Configuration
<!-- covers: modules/core/src/app.js modules/core/src/app-options.js modules/core/src/layers/cpu/module.js modules/core/src/layers/kernel/module.js modules/core/src/layers/win32/module.js modules/core/src/layers/graphics/module.js modules/core/src/layers/audio/module.js -->

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
| `memorySize` | 1 GiB | The program's RAM: a limit on what a process is given in all (its images, its threads' stacks, its heap up to the highest address it handed out), not its address space. A gift past it is refused as at Windows's commit limit (`ERROR_COMMITMENT_LIMIT`), and `GlobalMemoryStatusEx` reports it as physical memory. The address space is Windows's whatever the RAM: 2 GiB, and for a program linked large-address-aware 4 GiB under WOW64 or 3 GiB on a 32-bit Windows (taken as started with /3GB). A process's memory starts small and grows, in powers of two, as the program is given more, so a process holds what its program took; with `cpu.grow` false the memory is made whole, as large as the RAM, and the address space is cut to it. A 64-bit program given more than 4 GiB, or linked past 4 GiB with no relocations, runs over a window of 8 GiB (its RAM a memory64 memory of the window less its last 64 KiB; a browser collects without end past 4 GiB of memory a thread in Chrome 157, so which layout runs a program better is its launcher's to find) and is given addresses below 4 GiB first, then its window's RAM past 4 GiB as much as `memorySize` says (its own code apart from the image, and the system's, is interpreted there: [limits](limits/README.md)). A `memorySize` past 2 GiB still makes `machine` `amd64` unless named. What the program holds is counted in the guest's zone ([Memory zones](#memory-zones)). |
| `machineMemory` | none | The tab's memory in bytes: everything the run holds together never passes it. One budget counts, by kind: each process's guest memory, at its whole length where growing a memory makes its pages the tab's at once (JavaScriptCore), elsewhere by what the guest was given (its heap's reach, its commits, its images, its stacks; `cpu.guestCharge` names one; a window past 4 GiB always so); the memories kept for the next process at what their process left in them; the engine's own (the tab itself before any program, each process, each executor's worker, the executors' shared arena); the translator's modules, each byte weighed for what holding it costs (its compiled code, the engine's state beside it), a module the run keeps for every process charged once, to the run, and not to each process running it; and the regions every process shares formed, sized to a thirty-second of the tab. A grow past it refuses the allocation that asked for it (`HeapAlloc`, `VirtualAlloc` answer nothing, a commit with `ERROR_COMMITMENT_LIMIT`; a library `LoadLibrary` would map fails with `ERROR_NOT_ENOUGH_MEMORY`); a translator past it lets its coldest modules go and translates them again when asked; an executor it has no room for is not opened; a process asked for while it is full first lets go the memories kept for the next process (the one it was to reuse last, and is then built in one of its own), then waits for others to end (`machineWaitMs`, ten minutes) and fails to start with STATUS_NO_MEMORY past that, which its parent hears as the child's exit. Each process holds its part apart and gives it back whole when it is gone, however it ended. `diagnostics()` reports it under the cpu table's `machineMemory` (limit, used, peak, by kind). The graphics device's memory (the GPU's process) is not counted. Unset, nothing bounds the tab. |
| `cpu.grow` | `true` | `false` gives each process the whole of `memorySize` from the start. |
| `cpu.far` | `false` | A 64-bit program may reserve past its window - past 4 GiB in its 4 GiB layout, past 8 GiB over a wide one - up to 64 GiB: a reservation of 256 MiB or more, or one the layout has no room left for, is placed there, and each 64 KiB of it the program commits is given 64 KiB of the layout's memory, so the memory stays as long as what the program holds (a browser collects without end past ~4 GiB of memory a thread, a 64-bit Unity player reserves 512 MiB at a time). Off by default: every read then tests whether it lies past 4 GiB, which costs read-heavy code about a fifth of its speed (call-heavy code a few per cent), and an access past 4 GiB takes a lookup. Code is not run from past 4 GiB. |
| `cpu.cores` | automatic | How many processors the program is told it has, 1 to 32, and how many executors run its threads at once: past the process's own thread each is a worker over the same memory. Unset, a browser page gets one fewer than the host's processors (`navigator.hardwareConcurrency`), at most eight; Safari and a phone get one. Under Node it is `BOTTLIFY_CORES` from the environment, or one. `executors`, its older name, is refused. |
| `cpu.hostMemory` | unknown | The host machine's memory in bytes. A 64-bit program linked past 4 GiB with no relocations (a game at 0x140000000) runs there, over a window of 8 GiB its RAM is a memory64 memory of; one that needs 16 GiB gets it only where this is 32 GB or more, and is refused otherwise. |
| `cork.moduleUrl` | beside `core.js` | Where the translator is loaded from, for a bundler that moves it. |
| `cork.config.store` | `'local'` | Where translations are kept between runs: `'local'`, the origin's private file system; a store of your own, when the engine runs on the calling thread; `null`, none. |

The program is told of one processor for each executor (GetSystemInfo, the process block,
`cpuid`'s count and cores, GetLogicalProcessorInformation, `NUMBER_OF_PROCESSORS`, the registry's
CentralProcessor keys), and `cpuid` answers each executor's number as its APIC id. A thread's
affinity mask names the executors it may run on. Executors the run names all open before the
program starts; automatic ones open as its threads want them, and the count a bundle's threads
opened is kept in the translation store so the next run opens as many at its start. The process's
own executor answers every call the others make, and keeps itself for those answers while a thread
is pinned to its processor: another executor plays that processor. On a thread that may not block
(the engine on a page's own thread), or with its pages past 4 GiB (a 64-bit program over the wide window), the program runs on one executor, is told
of one, and the cpu layer's diagnostics say why (`executorsRefused`). How threads are placed: [execution in Bottlify](../architecture/cork.md#execution-in-bottlify).

cork's own settings (`cork.config`, `EngineConfig` in `src/layers/cpu/engine.js`) are in
[cork settings](../cork/settings.md). The cpu layer sets `atomic` for a
process whose threads run on more than one executor.

## Memory zones

A tab running one program holds at most 1.5 GiB, in three zones whose ceilings sum to that and no
more (`src/memory-zones.js`):

| Zone | Ceiling | What it holds |
| --- | --- | --- |
| guest | 1 GiB | What the program took of its RAM: its images, its threads' stacks and its heap up to the highest address the heap ever handed out (a page touched once is the tab's for good: a browser cannot give it back, and zeroing it frees nothing). The RAM (`memorySize`) is a limit on that, not memory made: a page the program never touched costs the tab nothing. |
| translation | 256 MiB | The translator's tables past the RAM, every executor's, and its modules with their compiled code. The cpu layer gives cork what the tables leave, split among the executors' runtimes: all of it to one executor, else three quarters to the process's own executor and the rest shared by the others. Past its part a runtime lets the modules gone longest without running go, and brings one back from the translation store when it is reached again. |
| heaps | 256 MiB | The engine's own memory: the bundle's blocks, decoded, in shared memory read in place (64 MiB at most a bundle; idle 30 s or pushed out for room, a block goes to OPFS and is read back from there, or, with no storage, is let go, the least recently put first), the pieces of what the program wrote that it is writing (8 MiB at most; the rest are bodies of the run's cache, below; all of it where the cache has no room left: see `pageFile` in [api.md](api.md)), the run's cache (`cache`: bodies every process reads in place from shared memory, the ranges of files a process read twice, one range up to 128 MiB in parts of 8 MiB, the shaders D3DX compiled, each its source, its includes and its bytecode, the images D3DX's texture loaders decoded, each its file and its levels, and the glyphs GDI draws, pages of a face's 32 codes drawn again when let go; the host's copy of each Direct3D 10 and 11 resource's bytes, each Direct3D 8 and 9 frame's uniform arena, the RGBA an OpenGL context drawn on the processor samples, and the scratches graphics keep between calls, held for as long as they live and never let go for room, refused where it has none; 160 MiB at most unless `cache.budget` says, the least recently read let go first, each let go after 30 s unread; what the program wrote and the texels the GPU was given go to the run's folder for room instead, see `pageFile`), mirrors of guest memory behind a played device, kept texels, the translation store's index. The sound output's table (20 MiB: its rings, 4 MiB, and the copy arena, 16 MiB) is memory held in the run's cache, within its budget. A loaded image keeps no copy of its file: its resources and thread-local directory are read where it lies in guest memory. |

Each layer says what it holds in its diagnostics as `bytesHeld`, by zone and pool; a pool nothing
measures says `not measured`. The last table of a run's diagnostics, `zones`, sums them: each zone's
ceiling, bytes, pools and unmeasured pools, the layers that report nothing (`unreported`), and the
device's buffers and textures apart (`outside.device`), held by the GPU's process rather than the
tab unless the device is one in JavaScript, and the page file's bytes on the disk
(`outside.disk`). Its status is `over` when a zone or the total is past its ceiling.

Storage has a budget too. When a run mounts a bundle on the origin's file system, the origin is
kept to 80% of the quota the browser gives it (`navigator.storage.estimate()`, which each browser
sets by its system and disk): past that, other bundles' block caches and translations go, the
least recently written first. A session (the files a program wrote) is never touched, nor the
caches of the run asking (its bottle's and those of the layers under it, `bundle.layers`) or of
a bundle another tab runs. The `storage-budget` event says what
went. While a run plays, a block write the browser refuses for lack of room says `storage-full`
once and keeps the origin under the same budget again, other bottles' caches let go, the oldest
first, never one of a cache the run reads; the block stays in memory while there is room and is
fetched again after. `bundle.evictOthers: false` keeps other bottles' blocks, both then and before
the run. Opening a bundle's translations removes every file of an older generation and any file the
store does not know (`cpu` diagnostics, `store.opened.swept`).

## kernel

Each turn of a thread is 100 000 guest instructions, or, among ready threads with no deadline
within a millisecond, as many as the executor retires in a quarter of a millisecond when that is
more; a thread with no other ready beside it and no timed wait due within 16 ms takes ten quanta
at a time. `quantum` (Debugging) fixes every turn at the number given.

## win32

| Option | Default | What it does |
| --- | --- | --- |
| `windows` | `'winxp'` | The Windows version the program sees, or `'auto'` for the one it was made for ([api.md](api.md)). |
| `machine` | the first program's width | A 32- or 64-bit Windows ([api.md](api.md)). |
| `layout` | `machine` | The machine the volume was laid out for: a 32-bit machine over a 64-bit layout ([api.md](api.md)). |
| `win32.trustedRoots` | the roots a Windows 7 machine whose roots are kept up to date carries for code signing: Microsoft's (Root Authority, Root Certificate Authority, its 2010 and 2011), Thawte Timestamping CA, DigiCert Assured ID Root CA and VeriSign Universal Root (`wintrust/roots.js`) | The machine's trusted roots, as DER bytes or base64: what `WinVerifyTrust` accepts and what crypt32's ROOT store holds, which `CertGetCertificateChain` ends a chain at. An empty list trusts nothing. |
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

`openSpeaker().audioOptions()` gives both ([api.md](api.md#the-speaker)).
