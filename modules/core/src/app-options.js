/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What `createApp` is given (`AppOptions`) and the shapes it names: the types
 * alone, apart from `app.js` so that a module of the process (`process/`)
 * can name them without importing the process itself.
 */

/**
 * A gone process's memory, for the next process of the run to take
 * (`CorkHostConfig.reused`): below `guestEnd` its guest may have written, its
 * heap from `heapFrom` and its threads' stacks in [`stacks.from`, `stacks.to`);
 * the first `executors` executors' pages may hold its engine's state, laid out
 * as `engine` says. The process taking it zeroes at its start only what it
 * finds in place before anything hands it out (`reusedRanges`); the heap's
 * and the stacks' share as each block and stack is handed out.
 *
 * @typedef {{ memory: WebAssembly.Memory, guestEnd: number, executors?: number,
 *     heapFrom?: number, stacks?: { from: number, to: number },
 *     engine?: { layout: string, ranges: [number, number][] } }} SpareMemory
 */

/**
 * A bundle a bottle stands on (`bundle.layers`), read as `bundle` is: the
 * same fields, but no `prefix` or `revision` (a layer has no program directory,
 * and its hive is always under the bottle's). `id` is required and is the
 * layer's own, not the bottle's: it names the layer's block cache, which
 * every bottle standing on the layer shares.
 *
 * @typedef {{ id: string, fetch: (offset: number, length: number) => Promise<Uint8Array>,
 *     store?: any, evictOthers?: boolean, prefetch?: boolean, preload?: boolean,
 *     progress?: (state: { bytes: number, total: number } | { unbacked: string }) => void,
 *     indexSha256?: string,
 *     retry?: { attempts?: number, baseDelayMs?: number, maxDelayMs?: number } }} BundleLayer
 */

/**
 * @typedef {Object} AppOptions
 * @property {Uint8Array} executable      The program to run.
 * @property {Object} [cork]              The translator.
 * @property {string} [cork.moduleUrl]    Its entry module; the package beside core by default.
 * @property {import('./layers/cpu/engine.js').EngineConfig} [cork.config]  Its settings;
 *     `store` here is a request -- `'local'` (the default) for the origin's private file
 *     system, a store of your own when the app runs in this thread, `null` for none.
 * @property {number} [cork.poolPerProcess]  Workers of the run's translation pool at most
 *     for one process: the host's processors less the program's cores and two, at least one
 *     (`translatorsBeside`). A test of the pool's lending sets it.
 * @property {number} [cork.poolCapacity]  Workers of the run's translation pool at most for
 *     every process together: the host's processors less two, at least one
 *     (`translatorsInRun`). A process whose workers sat idle 5 s gives back its first.
 * @property {Object} [media]             Video decoding, when this build has it.
 * @property {ArrayBuffer} [media.wasmBytes]
 *           The decoder binary. Absent, the media layer comes up and reports
 *           that nothing can be played, which is what a build without it is.
 * @property {any} [media.instance]
 *           The decoder one machine already made, so the machine that replaces
 *           it attaches to the same compiled module and linear memory rather
 *           than instantiate the binary again. Set by `createApp` on a rebuilt
 *           machine and not something a caller supplies.
 * @property {number} [memorySize]   Guest RAM in bytes; a power of two.
 * @property {number} [machineMemory]
 *           The machine's memory in bytes: every process of the run together, as
 *           Windows' processes share its RAM. A process's memory is made and grown
 *           only within it (each memory counted at its whole length, the browser's
 *           measure); a grow past it is the guest's allocation refused, a process
 *           asked for while it is full waits for others to end. Unset, each process
 *           is bounded by `memorySize` alone.
 * @property {number} [machineWaitMs]  How long a process asked for while the
 *           machine's memory is full waits for another to end before it fails to
 *           start (STATUS_NO_MEMORY): ten minutes unless said.
 * @property {SharedArrayBuffer | ArrayBuffer} [memoryBudget]
 *           The run's machine's memory (`memory-budget.js`), made from
 *           `machineMemory` and carried to every process: set by the run.
 * @property {number} [memoryHolder]
 *           The holder of the machine's memory a process in a worker of its
 *           own holds what it takes on, claimed by its parent: set by the run.
 * @property {{ left: number }} [memoryCredit]
 *           What the run took of the machine's memory for this process's start,
 *           which its memory and grows draw on first: set by the run.
 * @property {number} [heapSize]     Bytes the guest's heap may allocate out of.
 *           Defaults to everything above the libraries up to the end of RAM.
 * @property {boolean} [traceStrings]  Keep the text an argument pointed at, for a trace.
 * @property {boolean | { answer?: (dialog: import('./layers/win32/user32/dialogs.js')
 *     .UnattendedDialog) => number | Promise<number> }} [unattended]
 *     Nobody is at the screen -- a silent install run from a terminal: every modal dialog and
 *     message box is put to `answer` (a terminal prompt, say), or without one answered with its
 *     default button as Enter would, and each answer is reported as a divergence.
 * @property {boolean} [driveGuestCalls]  Host calls written as steps (`bridge.drive`) call the
 *     guest in the slice they came in, rather than parking the thread for each guest call
 *     and resuming it a turn later. On by default: through promises each guest call of an
 *     effect pass was a turn of its own, thousands a frame (bridge `driveMs` is what to read).
 *     False runs the steps through promises.
 * @property {boolean} [profileCalls]  Time every host call as a phase of its own, for a
 *                                     report's cost per API; two clock readings a call.
 * @property {'software'} [gpuAdapter]  The browser's software WebGPU adapter (SwiftShader,
 *     `forceFallbackAdapter`) in place of the GPU: pictures judged on a renderer a driver
 *     cannot distort. The browser has to offer one (Chrome: --enable-unsafe-swiftshader).
 * @property {'sm1' | 'sm2' | 'sm3' | 'sm4' | 'host'} [gpuProfile]  The profile the
 *     video adapter is shown with (`GPU_PROFILES` in `layers/graphics/seam/adapter.js`):
 *     a known card of that shader model, by its PCI ids and with its shader versions,
 *     for a program that picks its render path from the cards it knows and takes its
 *     weakest on one it does not. 'host' or absent, the adapter is shown with the
 *     browser's vendor and model 3. Its name stays Bottlify's either way.
 * @property {boolean} [sampleJs]  Keep the browser's sampler of this thread's JavaScript
 *     running and report what it spends its time in, function by function, as the
 *     `js` table (`host/js-samples.js`). Needs `Document-Policy: js-profiling` on
 *     the page and the worker scripts; off by default.
 * @property {() => boolean} [pageHidden]
 *     Whether nobody is looking at this run. A hidden page's timers are clamped
 *     by the browser, which stops the machine rather than slowing it, so the
 *     loop waits differently when this is true. Defaults to asking the document.
 * @property {number} [record]
 *     How many events at the bridge to keep, so a run that went wrong can be
 *     saved and replayed in a test. Zero, the default, records nothing.
 * @property {(dll: string, name: string | null, ordinal: number | null)
 *     => ({ args: number, strings?: (number | string)[] } | null)} [watchImport]
 *     Asked about every import as it is bound. Answering with an argument count
 *     puts a watch in front of that function, so a call from one guest module
 *     into another shows up in the trace like a call into ours. This is the only
 *     way to see them, and a game's own libraries are where its decisions live.
 *     `strings` names the arguments that point at C strings -- a stack slot by
 *     position, or `'ecx'` / `'edx'` for one passed in a register -- and the
 *     watch reports those with the answer: a pointer into the stack says
 *     nothing once the call is over, and the name a program asked for is
 *     usually the whole point.
 * @property {number} [maxFps]
 *     The most frames a second that may reach the screen. Sixty unless said
 *     otherwise; zero delivers at whatever rate the caller's scheduler offers.
 *     A frame shown faster than a display can show it is a read of the surface
 *     and an upload that nobody sees.
 * @property {{ categories?: Record<string, string>, capacity?: number,
 *     bytes?: number, sequenceBase?: number, journal?: any,
 *     now?: () => number, shaders?: boolean }} [log]
 *     `shaders`: each shader a program compiled is a line in the journal, its
 *     profile, entry and defines; off, only one that failed is, with its source.
 *     Which call areas are recorded from the first instruction, and how much of
 *     the journal is kept -- `capacity` records in the index, `bytes` for the
 *     records themselves (default 1 MiB; a call area logging every argument as
 *     a string fills it far sooner than `capacity`'s own default assumes).
 *     Everything a program decides about a device it decides while starting
 *     up, so a category switched on once the engine exists is switched on too
 *     late to see any of it. `sequenceBase` is set by `createApp` on a rebuilt
 *     machine, `journal` and `now` on every process of the run; none is
 *     something a caller supplies.
 * @property {{ drained?: boolean, sampleRate?: number, mp3?: boolean, shared?: boolean,
 *     memory?: { control: ArrayBufferLike, samples: ArrayBufferLike }
 *         | { table: ArrayBufferLike },
 *     beside?: { arena: [number, number] | null } }} [audio]
 *     Sound leaves through a shared track table a worklet reads, or -- with no
 *     shared memory to hand one -- a ring the engine thread mixes into itself.
 *     `drained` says that something on the other side is really reading, which
 *     is what decides whether a program's play cursor follows the sound or a
 *     clock. `shared` picks the backend; default `typeof SharedArrayBuffer ===
 *     'function'`. `memory` is set by `createApp` on a rebuilt machine so the
 *     storage outlives the process that made it, and is not something a caller
 *     supplies.
 * @property {'win2000' | 'winxp' | 'win7' | 'win10'} [windows]
 *     The Windows the machine is, a bottle's setting: 2000 SP4, XP SP3, 7 SP1
 *     or 10 (build 19045). Every place a program reads the version from agrees
 *     on it -- GetVersionEx, VerifyVersionInfo, the process block,
 *     RtlGetVersion, the registry, a system library's file version -- and so do
 *     the profile folders the registry, the shell and the environment name.
 *     Windows 10 tells a program whose manifest does not declare it 6.2, as
 *     the real one does. Default `winxp`; any other name is refused.
 * @property {'x86' | 'amd64'} [machine]
 *     Whether the machine is a 32-bit or a 64-bit Windows. On a 64-bit one a
 *     32-bit process runs under WOW64 (IsWow64Process, GetNativeSystemInfo,
 *     the SysWOW64 directory and the environment say so). Default: the
 *     width of the run's first program, so a run started with a 64-bit one is
 *     on a 64-bit machine and its 32-bit children under WOW64. A process in a
 *     worker of its own is handed the run's.
 * @property {import('./mode.js').RunMode} [mode]
 *     How much rides on shared memory: `isolated` shares the guest's memory with the
 *     graphics worker, `compatible` keeps it the engine thread's own and copies what
 *     crosses, `auto` (the default) is `isolated` on a cross-origin isolated page and
 *     `compatible` elsewhere. `isolated` where memory cannot be shared is refused.
 * @property {import('./mode.js').Concurrency} [concurrency]
 *     How many processes run at once: 1 (the default) runs a child in its parent's
 *     place until it exits; 2 or 4 runs it beside its parent from CreateProcess on,
 *     each child in a worker of its own (`host/process.worker.js`) with the run's
 *     system half reached across a link, up to that many at once and the next
 *     beside its parent on the engine's thread. More than one needs shared memory:
 *     asked for in `compatible` mode or on a page that is not cross-origin isolated,
 *     the run falls back to `compatible`, one process at a time, and says so with a
 *     `fallback` event.
 * @property {{ asked: any, detail: string } | null} [fallback]
 *     What a run asked for and fell back from (`mode.js`): set by `createApp`, not
 *     something a caller supplies.
 * @property {'directx7' | 'directx8' | 'directx9' | 'directx10' | 'directx11' | 'opengl'}
 *     [graphicsApi]
 *     The graphics a bottle prefers: every DirectX up to the one named --
 *     DirectX 9 has DirectDraw and Direct3D 8 as well -- or OpenGL alone. Only
 *     those system libraries exist and only their wrappers are built, and the
 *     registry, the setup library, DxDiag and the DirectX libraries' file
 *     versions name its DirectX -- 7.0, 8.1, or 9.0c for 9 and 10. Absent,
 *     every library and DirectX 9.0c; any other name is refused.
 * @property {{ network?: any, trustedRoots?: (Uint8Array | string)[],
 *     handleWords?: boolean,
 *     steam?: import('./layers/win32/steamclient/functions.js').SteamAccount }} [win32]
 *     `network` is the transport under Winsock, in the shape the win32 layer's
 *     `wsock32/transport.js` names: what a relay client hands back, or an
 *     embedder's own. Absent, Winsock runs over the loopback adapter and
 *     nothing outside this runtime is reachable, which is the default.
 *     `trustedRoots` is the root store WinVerifyTrust judges Authenticode
 *     chains against, each root as DER bytes or base64; absent, it holds
 *     Microsoft's "Microsoft Root Authority" alone, and an empty list trusts
 *     nothing. `handleWords: false` leaves out the table of handle words that
 *     WaitForSingleObject, ReleaseMutex, ReleaseSemaphore, SetEvent and ResetEvent
 *     answer from in the guest, so every such call is the host's: the second path
 *     of their gates.
 *     `steam` is a signed-in Steam account (its Steam ID, name and the app ids
 *     its licences grant, as the embedder established with the person's own
 *     sign-in): the run then has a Steam client running, which a game's
 *     Steamworks calls reach, answering an app as owned only when it is listed.
 * @property {(record: any) => void} [onCall]
 *           Every host call as it returns. The ring kept for a failure holds
 *           the end of a run; this holds all of it, for a tool willing to
 *           write it somewhere. Each of the run's processes calls it, and a
 *           record names the process's image (`image`) and the calling
 *           thread (`thread`).
 * @property {number} [quantum]  Guest instructions per scheduler turn. Lowering
 *           it is what makes `sample` a profile rather than a rumour.
 * @property {{ cores?: number, eager?: boolean, placement?: 'spread' | 'concentrate',
 *           gcNudge?: boolean | { everyMs?: number, bytes?: number }, grow?: boolean,
 *           executorTranslators?: { add: (index: number, reach: any) => void,
 *               remove: (index: number) => void }, hostMemory?: number,
 *               guestCharge?: 'length' | 'given', executorWorker?: string | URL }} [cpu]
 *           The machine's processor. `cores`: how many
 *           processors the program is told it has -- by every road Windows has to say
 *           it -- and the executors that run its threads at once, each a worker past
 *           the process's own thread; 1 to 32. Unset, in a browser whose page can share
 *           memory one fewer than the host's processors, at most eight
 *           (`automaticCores`); elsewhere, and in node unless `BOTTLIFY_CORES` names
 *           them, one. On a page that cannot share memory the program runs on one and
 *           is told of one.
 *           Named, they all open before the program starts; automatic, each opens
 *           when a thread wants it, some tens of milliseconds before it runs one, so
 *           a program of one thread pays for none. `eager` says which outright.
 *           The process's own core is kept for the host's answers while a thread is
 *           pinned to its processor (a game's main thread, pinned to the first): that
 *           processor is played by another core.
 *           `placement`, a debugging switch: `spread` (the default) runs each ready
 *           thread on a core of its own, `concentrate` all of them taking turns on
 *           the process's own core.
 *           `gcNudge`: each thread that holds the guest's memory makes and drops an
 *           untouched buffer (every 20 ms, 64 MB or a quarter of the guest's memory
 *           past 256 MB, unless named) so that JavaScriptCore collects its young
 *           garbage before it piles up; on by default where JavaScriptCore runs and
 *           nowhere else, `false` for none.
 *           `grow`: `false` gives the process its whole `memorySize` from the start
 *           instead of a memory that grows as the program is given more.
 *           `hostMemory`: the host machine's memory in bytes, when known: a 64-bit image
 *           past 4 GiB is given a 16 GiB window only where it is 32 GB or more.
 *           `executorTranslators`: the run's own, set for each process on the thread
 *           the run's translation pool is on: its other executors are lent workers
 *           of the pool, as its own is, instead of each opening a translator.
 *           `executorWorker`: the script an executor's worker runs, for a host that
 *           serves the engine's files elsewhere; the file beside the engine by default.
 * @property {(eip: number, instructions: number) => void} [sample]
 *           Called with the guest's instruction pointer at every turn boundary.
 *           This is the only view of what a program is doing between host calls,
 *           which is where a program that fails on its own computed state fails.
 * @property {RunPacing} [pacing]
 *     How the run loop gives the thread away, and how it waits when the guest
 *     has nothing to run. The default is a page's: it cannot block, so it
 *     yields when something is pending or a few milliseconds have passed,
 *     and looks again on a short timer. A host on a thread of its own waits
 *     for the next event instead; see `RunPacing`.
 * @property {string} [imagePath]    What the program believes it was loaded from.
 * @property {string} [commandLine]
 *           What the program believes it was started with. argv[0] ends at the
 *           first space unless it is quoted, so a line composed by hand must
 *           quote it. Defaults to the image path, quoted.
 * @property {string} [startDirectory]
 *           The current directory the program starts in, where its starter
 *           chose one -- a system program, whose paths are its parent's to
 *           mean. Its own image's directory otherwise.
 * @property {number} [processId]    What GetCurrentProcessId answers: for a child, the
 *           identifier its parent was handed when it started it.
 * @property {any} [system]  The run's system half -- registry, volume, windows, ids, named
 *           objects -- for a process that joins another run's rather than making one: a
 *           process in a worker of its own is handed it across a link (`system-link.js`).
 * @property {(name: string, payload: any) => void} [relay]
 *           Told every event this process emits, for a process in a worker of its own
 *           to tell the bus of the run that started it.
 * @property {import('./layers/win32/kernel32/startup-info.js').StartupRecord | null} [startup]
 *           The STARTUPINFO a child's parent handed CreateProcess, which its
 *           GetStartupInfo answers.
 * @property {{ handle: number, type: string, object: any }[]} [inheritedHandles]
 *           The handles a child inherits from its parent on this thread, under
 *           the parent's numbers: pipe ends, open files, kernel objects.
 * @property {{ handle: number, type: 'file', access: number | null, object: any }[]}
 *           [inheritedFiles]  The open files a child in a worker of its own inherits:
 *           each the parent's open as values, its position asked across the link
 *           (`system/inherited-files.js`).
 * @property {{ input?: number, output?: number, error?: number }} [standardHandles]
 *           Which handles are its standard ones: those its parent's STARTUPINFO
 *           named, or the parent's own, as a child that inherits holds them.
 * @property {{ input?: number, output?: number, error?: number }} [consoleHandles]
 *           For a child that inherited nothing and was named none: the parent's
 *           standard handles, duplicated for it (`consoleOnly`), its own when it
 *           is a console program; a window program has none (`handedDown`).
 * @property {{ handle: number, side: 'server' | 'client', canRead: boolean, canWrite: boolean,
 *     messages: boolean }[]} [pipeEnds]
 *           The pipe ends a child in a worker of its own inherits, under the
 *           parent's numbers: served where the parent holds them, across the
 *           link (`system.pipes`), and held here as stand-ins.
 * @property {number} [parentProcessId]  The process that started this one, 0 for none.
 * @property {boolean} [startedBeside]  A process started beside another one -- a child, a server:
 *           its executors open as its threads want them, not as many as the bundle's
 *           program once opened, and what it opens is not the bundle's record.
 * @property {Record<string, string>} [environment]
 *           The variables a process starts with: a child's are the block its
 *           parent handed CreateProcess, or the parent's own as they were then.
 * @property {SpareMemory | null} [reusedMemory]
 *           The memory of a process of the run that has gone, for this one to
 *           take: set by the run, not something a caller supplies.
 * @property {SpareMemory[]} [spareMemories]
 *           The run's memories of gone processes, where this run is a process the
 *           run put in a worker of its own: each process built here takes one,
 *           each gone puts its own back, and they are kept past `dispose` for the
 *           worker to hand back to the run's thread. Set by the run, not something
 *           a caller supplies.
 * @property {boolean} [exitNotice]
 *           Whether a run the program ended with exit code 0 says so to the
 *           player: a `message-box` of the engine's own (`exit: { code }`,
 *           id 0), drawn by the page like the program's boxes, that the game
 *           has finished and its process has stopped. On by default; a
 *           nonzero code is the page's error report instead.
 * @property {any} [device]          The GPU to draw on, when there is one.
 * @property {{ presenter?: any, compressedTextures?: boolean, maxFrameLatency?: number,
 *     lendMemory?: boolean, guestCode?: boolean, guestTraps?: string[], worker?: any,
 *     driverRules?: 'legacy' | 'current', display?: (frame: any) => void }}
 *           [graphics]
 *           The graphics layer's configuration (docs/core/configuration.md,
 *           graphics), forwarded to it as given: `compressedTextures`
 *           turns the block-compressed upload path on where the device has the
 *           feature (BC, or for OpenGL's DXT1 ASTC where there is no BC), and
 *           `maxFrameLatency` is how many frames the device may
 *           still be working on when a present answers (three; zero for no
 *           bound), a bound the run's presenter keeps. `graphics.presenter` is
 *           the run's presenter -- the canvas, its configured format, the pacer
 *           and the texture the primary is copied into. Absent, one is made
 *           from `device` and handed to every machine; set by `createApp` on a
 *           rebuilt machine and not something a caller supplies.
 *           `graphics.worker` is a way in to the run's graphics worker for a
 *           process with no GPU of its own, and `graphics.display` where its
 *           surfaces' pictures go: both set for a child in a worker of its own,
 *           whose devices draw there and whose pictures the run shows.
 * @property {{ width: number, height: number, bitsPerPixel: number }} [screen]
 *           What the program is told its display is.
 * @property {{ picture?: { width: number, height: number, bits: Uint8Array } }} [desktop]
 *           What the desktop shows where no window is: `picture`, 32 bits a
 *           pixel, top row first, each B, G, R and a byte unused, scaled to the
 *           screen -- a wallpaper, or a loading screen of the embedder's own.
 *           Absent, the desktop colour.
 * @property {any} [storage]
 *           Where the session comes from and goes: a provider with `load` and
 *           `save`, a function that only loads, or the string `local` or
 *           `opfs`. A session is the files the program wrote and the registry
 *           it wrote; `save` is handed both, and `load` may answer with both
 *           or with a bare list of files.
 * @property {'local' | false | { root: any }} [pageFile]
 *           Where what the program writes goes once more of it is written
 *           than the tab keeps in memory (`HEAP_POOLS.writableFiles`): `'local'`,
 *           the default, a file of the run's own in the origin's private file
 *           system, where the engine's thread has synchronous access to one (a
 *           worker); `false` keeps every byte in memory, as a build with no
 *           such file does; `{ root }` a directory handle of the caller's.
 * @property {string} [id]           Names the session when storage does not.
 * @property {{ path: string, bytes: Uint8Array }[]} [files]
 *           The person's own edits to the title's files, laid over the
 *           session's at every start: a realm list, a line of configuration.
 *           They win over what the program last saved, and the bundle itself
 *           is never changed.
 * @property {import('./discs.js').DiscOption[]} [discs]
 *           Disc images, each mounted as a CD-ROM drive: D:, or the first free
 *           letter after it, unless `letter` names one. An image is a `Blob`
 *           (read a range at a time in a worker, whole on a thread without
 *           `FileReaderSync`), bytes, or a synchronous `{ size, read }`.
 * @property {Object} [bundle]       A .btl mounted as the volume's read-only source.
 * @property {(offset: number, length: number) => Promise<Uint8Array>} bundle.fetch
 *           Brings a byte range of the bundle in, from wherever it is kept.
 * @property {any} [bundle.store]  Where fetched blocks are kept. `'local'` is
 *           the default and means this machine; a synchronous store of your own
 *           is used as given; anything falsy keeps nothing, and a block the
 *           reader has let go is then fetched again.
 * @property {string} [bundle.id]  Names this bundle's cache. Two bundles sharing
 *           a name would read each other's blocks, so it has to be the bundle's.
 * @property {number} [bundle.revision]  The bottle's revision, raised each time it is
 *           packed again. A session saved under an earlier one has the bottle's
 *           registry laid over its own, as a reinstall would.
 * @property {string} [bundle.prefix]  Where in the volume the bundle appears.
 *           Defaults to the directory a game is installed into.
 * @property {boolean} [bundle.evictOthers]  Whether, when the origin runs out of
 *           room, other bottles' fetched blocks may be let go, the oldest first:
 *           before the run (the origin kept under its budget) and once this
 *           bottle has no blocks of its own older than two hours. On by default;
 *           off, a full store says `storage-full` instead.
 * @property {boolean} [bundle.prefetch]  Whether to fill the cache in the gaps
 *           when nothing is being read. On by default, and inert when there is
 *           nowhere durable to keep the blocks.
 * @property {boolean} [bundle.preload]  Whether to bring the whole bundle in
 *           before the program starts, so that nothing it reads waits on the
 *           network: every block not kept yet, before `createApp` resolves.
 *           Inert, and said through `progress`, where there is nowhere durable
 *           to keep the blocks.
 * @property {(state: { bytes: number, total: number } | { unbacked: string }) => void}
 *           [bundle.progress]  Told how far a preload is: packed bytes here of
 *           the bundle's, after every request that lands.
 * @property {string} [bundle.indexSha256]  From the manifest. Checked against
 *           the index this bundle actually carries, which is what makes the
 *           per-block checksums inside it worth trusting.
 * @property {Object} [bundle.retry] How hard to try when that fetch fails.
 * @property {number} [bundle.retry.attempts]     Including the first. Default 6.
 * @property {number} [bundle.retry.baseDelayMs]  Doubled each attempt. Default 250.
 * @property {number} [bundle.retry.maxDelayMs]   Ceiling for that. Default 10000.
 * @property {BundleLayer[]} [bundle.layers]  Bundles the bottle stands on - a
 *           runtime built once and shared by bottles - under it on C:, the
 *           first over the next. A layer is a bottle's system files alone:
 *           `.bottlify\drive_c` mounted at C:\, `.bottlify\system32` in
 *           system32, `.bottlify\registry.json` laid under the bottle's hive;
 *           anything else in it is not mounted (`layer-files-unmounted`).
 * @property {BundleLayer[]} [layers]  The same, for a run with no bundle of its
 *           own: an installer writing its whole volume, whose wizard needs the
 *           runtime a layer carries while it installs. Ignored beside a bundle,
 *           which names its own (`bundle.layers`).
 * @property {Object} [sidecarHooks]
 *           A bundle's sidecar, next to `manifest.json` and never inside the
 *           bundle itself: replaces one or more guest functions, or one loop
 *           inside one, with host code -- a `slot` entry through the
 *           bridge's slot-hook mechanism (`bridge.hook`, a data pointer
 *           rewrite that never touches guest code) or a `site` entry through
 *           its site-hook mechanism (`bridge.siteHook`, a code patch at a
 *           point inside a function nothing else can reach, resuming at
 *           another point in it). Not `hooks` above, which rewrites a
 *           routine's code as a diagnostic. Nothing here names a title; what
 *           a hook does is entirely `sidecarHooks.source`'s.
 * @property {{ hooks: (import('./layers/loader/internal/hooks.js').HookEntry
 *           | import('./layers/loader/internal/hooks.js').SiteHookEntry)[] }}
 *           sidecarHooks.spec  The parsed `hooks.json`.
 * @property {string} sidecarHooks.source
 *           The text of `hooks.mjs`, loaded as an ES module from a blob URL
 *           inside this worker -- the bundle's own code, run on the bundle's
 *           own data, with no engine object other than a bounds-checked view
 *           of guest memory reaching it.
 */

/**
 * What the loop is waiting on when nothing is pending: a turn boundary's yield
 * and an idle wait are the two places the loop gives the thread away, and a
 * host decides how, because the answer depends on whose thread it is.
 *
 * @typedef {Object} RunPacing
 * @property {() => Record<string, number>} [counts]  What the pacing counted, for a report.
 * @property {(pending: YieldPending) => Promise<void> | null} yield
 *     At every turn boundary: a promise to await before the next turn, or
 *     null to go straight on. `pending` says what the host may have an answer
 *     for -- calls suspended on it, ranges in flight, a turn that retired
 *     nothing -- so a host can yield only when there is something to deliver.
 * @property {(until: { timer: boolean, sleep: boolean, deadlineMs: number | null,
 *     wakes: Promise<void>[] }) => Promise<void>} wait
 *     The turn found something waiting on the host. `sleep` says nothing at
 *     all can run until the host or the clock says so, and a host with a
 *     thread of its own may then sleep: `deadlineMs` is how long, in wall
 *     milliseconds, before the guest's own next deadline -- a timed wait, a
 *     queue timer, a device that wants feeding -- or null when it has none,
 *     and `wakes` settle when a host call answers or a range arrives. Without
 *     `sleep` a thread is still getting work done and the wait is a yield.
 *     `timer` is the page's own distinction, between a machine that has
 *     stopped retiring instructions and one still spinning through turns,
 *     which its default wait needs.
 * @property {(count: number) => void} [machines]
 *     How many machines take turns on the thread now, told whenever it
 *     changes: a pacing that may block the thread to wait must not while
 *     another machine has turns to run.
 * @property {() => number} [now]
 *     The clock, in milliseconds, the pacing keeps its interval by; the sound
 *     is pumped by it too (`SOUND_PUMP_MS`). The host's own where absent.
 */

/**
 * What a turn boundary knows about whether the host has anything to deliver.
 *
 * @typedef {Object} YieldPending
 * @property {number} suspended   Host calls suspended on the host: not the
 *     callers parked on a queue of the guest's own, which `idlers` counts.
 * @property {number} fetching    Range requests outstanding.
 * @property {number} idlers      Callers parked on an empty message queue.
 * @property {number} spun        Turns in a row that retired no instruction.
 */

/**
 * What one process of a run is built with: what `createApp` was given, and
 * what the run hands a process it starts beside the first.
 *
 * @typedef {AppOptions & {
 *     events?: any,
 *     seed?: { path: string, bytes?: Uint8Array, delete?: boolean }[],
 *     spawned?: (request: any) => void,
 *     logSinks?: Map<Function, (payload: any) => void>,
 *     system?: { namedObjects: Map<string, any>, registry: any, bundle: any, windows?: any,
 *         sharedViews?: any, processDirectory?: Map<number, any>,
 *         processTables?: Map<number, any>,
 *         ids: { thread: number, process: number }, volume: any },
 *     mainThreadId?: number,
 *     beside?: (request: any) => void,
 *     terminate?: (request: any, code: number) => boolean,
 *     askChild?: (request: any, call: any) => Promise<any> | null,
 *     debugger?: { report: (report: import('./layers/win32/kernel32/debug-events.js')
 *         .DebugReport) => Promise<number>, debugged?: () => boolean,
 *         object?: () => any, noInherit?: () => boolean },
 *     suspended?: boolean,
 *     othersRunning?: () => boolean,
 *     com?: { table: any, process: unknown },
 *     service?: string,
 * }} ProcessOptions
 */

export {};
