/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createJsSampler } from './host/js-samples.js';
import { fitFrame, isShown, placementOf, stretchFrame } from './letterbox.js';
import { assembleModules } from './core.js';
import { createEvents } from './events.js';
import { captureTrace, describeAddress, formatTrace } from './trace.js';
import { coalescedSaver, inflateRaw, normaliseSession, resolveStorage } from './storage.js';
import {
    DEFAULT_ENGINE, DEFAULT_INITIAL_STACK, DEFAULT_MEMORY_SIZE,
    DEFAULT_THUNK_BASE, DEFAULT_THUNK_CAPACITY,
} from './layers/cpu/module.js';
import { CORK_TSC_MHZ } from './layers/cpu/internal/cork-host.js';
import { SETTINGS, processorName } from './settings.js';
import { createPresenter } from './layers/graphics/webgpu/internal/presenter.js';
import { baseOf, compositionPlan, needsComposing } from './layers/graphics/webgpu/internal/compose.js';
import { connectGraphicsWorker, portEnd } from './layers/graphics/remote/connect.js';
import { openBundle } from './layers/filesystem/internal/bundle/format.js';
import { DIR_EXPORT, parseExportDirectory, parsePe, readExports, readImports, rvaToFileOffset }
    from './layers/loader/internal/pe.js';
import { planDependencies } from './layers/loader/internal/dependencies.js';
import {
    findResource, listResources, loadString, RT_STRING, stringInBundle,
} from './layers/loader/internal/resources.js';
import { readTls } from './layers/loader/internal/tls.js';
import { jumpBytes, relocatablePrefix } from './layers/loader/internal/hooks.js';
import { mangledCall } from './layers/loader/internal/mangling.js';
import { mapImage } from './layers/loader/internal/image.js';
import { createProcessBlocks, TEB } from './layers/win32/kernel32/teb.js';
import { supportedOsOf, windowsVersion } from './layers/win32/kernel32/versions.js';
import { GRAPHICS_CHOICES, graphicsChoice } from './layers/graphics/choice.js';
import { searchesBesideProgram } from './layers/win32/kernel32/modules.js';
import { synthesiseProcessInit, DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH }
    from './layers/loader/internal/init.js';
import { createBundleSource } from './layers/filesystem/internal/bundle/source.js';
import { crc32 } from './layers/filesystem/internal/bundle/crc32.js';
import { createSharingMemory, openSharedSharing } from './layers/filesystem/internal/shared-sharing.js';
import { resolveTranslationStore } from './layers/cpu/internal/translation-store.js';
import { createBlockCache, resolveBlockStore }
    from './layers/filesystem/internal/bundle/cache.js';
import { decompressZstd } from './zstd.js';
import { mountDiscs } from './discs.js';
import { loadZstdWasm } from './zstd-wasm.js';
import { createClassTable } from './layers/win32/ole32/remote.js';
import { comHandlers, remoteClassTable } from './com-link.js';
import { createCallRepeats } from './call-repeats.js';
import { withRunMode } from './mode.js';
import { createLinkMemory, openLink } from './system/link.js';
import { systemHandlers } from './system-link.js';
import { storeHandlers } from './layers/cpu/internal/store-link.js';
import { eventFrom } from './system/events-across.js';
import { defaultModules } from './layers/index.js';
import { createRunRegistry } from './layers/win32/module.js';
import { systemProgramImage } from './layers/win32/programs/table.js';
import { createWindowDirectory } from './layers/win32/user32/directory.js';
import { createMixer } from './layers/audio/output/mixer.js';
import { objectHandlers } from './system-objects.js';
import { openProcessWorker } from './host/process-worker.js';
import { createTranslatorPool, portTranslator } from './host/pool/pool.js';
import { createInputRoute } from './layers/input/route.js';

/** FNV-1a, 32 bits: a call's number for telling its repeats apart in the journal. */
const FNV_OFFSET = 0x811c9dc5;
/** @param {number} hash @param {number} word */
const hashWord = (hash, word)=>{
    let h = hash;
    for (let shift = 0; shift < 32; shift += 8)
    {
        h = Math.imul(h ^ ((word >>> shift) & 0xff), 0x01000193);
    }
    return h >>> 0;
};
/** @param {number} hash @param {string} text */
const hashText = (hash, text)=>{
    let h = hash;
    for (let at = 0; at < text.length; at++)
    {
        h = Math.imul(h ^ text.charCodeAt(at), 0x01000193);
    }
    // The length too, so "ab" then "c" is not "a" then "bc".
    return hashWord(h >>> 0, text.length);
};

/**
 * createApp — the consumer-facing entry point: run a Win32 application.
 *
 * Everything below it is the module graph; this is the one place that wires the
 * cross-cutting step the graph deliberately does not express. An executable's
 * imports have to become guest addresses that call into win32, but win32 does
 * not know what a guest call looks like and the bridge does not know what win32
 * implements. Neither should. Assembling a process is what knows both.
 */

/**
 * @typedef {{ path: string, position: number }} StandardFile
 */

/**
 * @typedef {Object} AppOptions
 * @property {Uint8Array} executable      The program to run.
 * @property {Object} [v86]               The emulator, for `engine: 'emulator'`. The
 *           package carries none: a caller that wants it brings both halves.
 * @property {string} [v86.moduleUrl]     The emulator's module (`libv86.mjs`).
 * @property {ArrayBuffer} [v86.wasmBytes]  Its binary (`v86.wasm`).
 * @property {Object} [cork]              The translator, for every engine but `emulator`.
 * @property {string} [cork.moduleUrl]    Its entry module; the package beside core by default.
 * @property {import('./layers/cpu/engine.js').EngineConfig} [cork.config]  Its settings;
 *     `store` here is a request -- `'local'` (the default) for the origin's private file
 *     system, a store of your own when the app runs in this thread, `null` for none.
 * @property {boolean} [cork.pool]  The run's pool of translation workers, lent to its
 *     processes as their translation needs (roadmap/v2): on by default wherever a machine's
 *     translator would open a worker of its own, unless `cork.config.translators` is set.
 * @property {number} [cork.poolPerProcess]  Workers of the pool at most for one process:
 *     `navigator.hardwareConcurrency` by default.
 * @property {number} [cork.poolWindowMs]  How often the pool's driver reads its workers.
 *     Default 500.
 * @property {Partial<import('./host/pool/driver.js').DriverSettings>} [cork.poolDriver]  The
 *     driver's thresholds (`joinAt`, `leaveBelow`, `leaveAfterMs`, `idleBelow`, `trialWindows`,
 *     `trialLimit`, `restMs`, `yieldShare`).
 * @property {Object} [zstd]              The bundle decoder's wasm build, when the package's
 *           own is not wanted: `vendor/zstd.wasm` beside this module by default; absent
 *           there, the JavaScript decoder (or the emulator's, while it is loaded) decodes.
 * @property {string} [zstd.wasmUrl]      Where its binary is fetched from.
 * @property {ArrayBuffer} [zstd.wasmBytes]  Or the binary itself.
 * @property {Object} [media]             Video decoding, when this build has it.
 * @property {ArrayBuffer} [media.wasmBytes]
 *           The decoder binary. Absent, the media layer comes up and reports
 *           that nothing can be played, which is what a build without it is.
 * @property {any} [media.instance]
 *           The decoder one machine already made, so the machine that replaces
 *           it attaches to the same compiled module and linear memory rather
 *           than instantiate the binary again. Set by `createApp` on a rebuilt
 *           machine and not something a caller supplies.
 * @property {number} [stackSize]
 * @property {number} [memorySize]   Guest RAM in bytes; a power of two.
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
 *     and resuming it a turn later. Off by default: in a game's frame its committed effect
 *     parameters cost several times what they cost through promises, for a reason not yet
 *     found (bridge `driveMs` is what to read).
 * @property {boolean} [profileCalls]  Time every host call as a phase of its own, for a
 *                                     report's cost per API; two clock readings a call.
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
 *     now?: () => number }} [log]
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
 * @property {'directx7' | 'directx8' | 'directx9' | 'directx10' | 'opengl'} [graphicsApi]
 *     The graphics a bottle prefers: every DirectX up to the one named --
 *     DirectX 9 has DirectDraw and Direct3D 8 as well -- or OpenGL alone. Only
 *     those system libraries exist and only their wrappers are built, and the
 *     registry, the setup library, DxDiag and the DirectX libraries' file
 *     versions name its DirectX -- 7.0, 8.1, or 9.0c for 9 and 10. Absent,
 *     every library and DirectX 9.0c; any other name is refused.
 * @property {{ network?: any, trustedRoots?: (Uint8Array | string)[] }} [win32]
 *     `network` is the transport under Winsock, in the shape the win32 layer's
 *     `wsock32/transport.js` names: what a relay client hands back, or an
 *     embedder's own. Absent, Winsock runs over the loopback adapter and
 *     nothing outside this runtime is reachable, which is the default.
 *     `trustedRoots` is the root store WinVerifyTrust judges Authenticode
 *     chains against, each root as DER bytes or base64; absent, it holds
 *     Microsoft's "Microsoft Root Authority" alone, and an empty list trusts
 *     nothing.
 * @property {(record: any) => void} [onCall]
 *           Every host call as it returns. The ring kept for a failure holds
 *           the end of a run; this holds all of it, for a tool willing to
 *           write it somewhere. Each of the run's processes calls it, and a
 *           record names the process's image (`image`) and the calling
 *           thread (`thread`).
 * @property {Record<string, number>} [jit]
 *     The emulator's compiler budgets, by config index. For measurement.
 * @property {'emulator' | 'cork'} [engine]
 *     Which execution engine runs the program. Default `cork`, the one the
 *     package carries; `emulator` only with `v86` handed in, and refused
 *     without it.
 * @property {boolean} [sampling]  The `cpu` layer's always-on guest sampler.
 *     `false` turns it off, for a caller measuring the emulator's own compiler
 *     rather than the guest's code.
 * @property {number} [quantum]  Guest instructions per scheduler turn. Lowering
 *           it is what makes `sample` a profile rather than a rumour.
 * @property {number} [executors]  Executors of the program's process under cork: past
 *           the process's own thread, each a worker running one of its threads at once
 *           with the others, the locked instructions atomic (roadmap/v2, stage 3).
 *           Default 1, every thread on the process's own.
 * @property {boolean} [preemption]  End a slice early when a thread of higher
 *           priority comes due, as Windows preempts (the kernel's option; off).
 * @property {(eip: number, instructions: number) => void} [sample]
 *           Called with the guest's instruction pointer at every turn boundary.
 *           This is the only view of what a program is doing between host calls,
 *           which is where a program that fails on its own computed state fails.
 * @property {number} [pendingYieldMs]  How often, in milliseconds, the run
 *     loop gives its thread away to hear an outstanding host answer while
 *     other threads still run. Default 1; lower hears answers sooner at more
 *     trips round the event loop.
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
 * @property {{ output?: StandardFile, error?: StandardFile }} [standardFiles]
 *           The files a child's parent handed it as its output and error,
 *           each the parent's own open file, whose position the child's
 *           writes move.
 * @property {{ memory: WebAssembly.Memory, guestEnd: number } | null} [reusedMemory]
 *           The memory of a process of the run that has gone, for this one to
 *           take: set by the run, not something a caller supplies.
 * @property {boolean} [refuseReplacement]
 *           Stop rather than replace this process with a child it asked for. A
 *           replacement erases every log and ring of the run that asked for it,
 *           once per iteration of a loop that keeps asking, so this is how the
 *           machine is made to stand still at the point of the request with the
 *           evidence still in it.
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
 *           feature, and `maxFrameLatency` is how many frames the device may
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
 * @property {boolean} [bundle.prefetch]  Whether to fill the cache in the gaps
 *           when nothing is being read. On by default, and inert when there is
 *           nowhere durable to keep the blocks.
 * @property {string} [bundle.indexSha256]  From the manifest. Checked against
 *           the index this bundle actually carries, which is what makes the
 *           per-block checksums inside it worth trusting.
 * @property {Object} [bundle.retry] How hard to try when that fetch fails.
 * @property {number} [bundle.retry.attempts]     Including the first. Default 6.
 * @property {number} [bundle.retry.baseDelayMs]  Doubled each attempt. Default 250.
 * @property {number} [bundle.retry.maxDelayMs]   Ceiling for that. Default 10000.
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
 * A range fetch that survives the network going away for a moment.
 *
 * This belongs to the engine rather than to whoever supplies `fetch`, and the
 * reason is a property of the format rather than a preference: a range of a
 * bundle is immutable, so asking for it again is always safe and always yields
 * the same bytes. Nothing else in the system can say that about a retry.
 *
 * A short read counts as a failure. A truncated range is the ordinary shape of
 * a glitch -- a proxy closing a connection early answers with fewer bytes and
 * no error at all -- and accepting it would put wrong bytes into a guest's file
 * with nothing downstream in a position to notice.
 *
 * Each wait is jittered downwards. A stall usually strands many blocks at once,
 * and an unjittered backoff would march them all at the same instant into the
 * server that just failed.
 *
 * @param {any} deps
 * @returns {(offset: number, length: number,
 *            verify?: (bytes: Uint8Array) => string | null) => Promise<Uint8Array>}
 */
export function retryingFetch({ fetch, events, retry }){
    const attempts = retry?.attempts ?? 6;
    const baseDelayMs = retry?.baseDelayMs ?? 250;
    const maxDelayMs = retry?.maxDelayMs ?? 10000;

    return async(offset, length, verify)=>{
        /** @type {any} */
        let failure = null;
        for (let attempt = 1; attempt <= attempts; attempt++)
        {
            try
            {
                const bytes = await fetch(offset, length);
                if (bytes.length !== length)
                {
                    throw new Error(
                        `short read: ${bytes.length} of ${length} bytes`);
                }
                // Checked here rather than by the caller so that bytes which
                // arrived damaged are asked for again, like any other failure.
                // Damage is what a retry is for; a caller outside this loop
                // could only turn it into an error.
                const wrong = verify?.(bytes);
                if (wrong)
                {
                    throw new Error(wrong);
                }
                return bytes;
            }
            catch (e){
                failure = e;
                if (attempt === attempts)
                {
                    break;
                }
                const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
                const delayMs = Math.round(ceiling * (0.5 + Math.random() * 0.5));
                events.emit('bundle-retry', {
                    offset, length, attempt, attempts, delayMs,
                    reason: failure?.message ?? String(failure),
                });
                await new Promise(resolve=>setTimeout(resolve, delayMs));
            }
        }

        const reason = failure?.message ?? String(failure);
        events.emit('bundle-unavailable', { offset, length, attempts, reason });
        throw new Error(
            `bundle: ${length} bytes at ${offset} did not arrive in ${attempts} `
            + `attempts: ${reason}`);
    };
}

/**
 * The process id of a run's first process, where the caller named none: the
 * kernel's, its windows' and its frames' alike, wherever it stands.
 */
const FIRST_PROCESS_ID = 0x1000;

/**
 * A first process id of its own for each run, under the 0x2000 the run's other
 * processes are numbered from, on the kernel table's step of eight. Windows
 * never hands out the same id twice in a row, and a program that keeps its
 * id in a file to refuse a second copy of itself -- OpenProcess on the id it
 * wrote, then the modules of what answers -- found itself under the same id
 * the next run and quit as the copy.
 */
export const runProcessId = ()=>0x400 + 8 * Math.floor(Math.random() * ((0x2000 - 0x400) / 8));

/**
 * How much one range request may ask for.
 *
 * The bound is not bandwidth but what a failure costs: a request that dies at
 * 95% is refetched whole, and a thread waiting on it is parked for all of it.
 *
 * This is a separate knob from the block size, and deliberately so: the block
 * decides how long one thread is held, this decides how many times the network
 * is asked. It only has to stay above one block, or a block would be split
 * across two requests and neither half could be checked against its checksum.
 * At the default block size a full request carries sixty-four blocks.
 *
 * A demand fetch never reaches this: a group is built only from blocks the read
 * actually wants, so a small read is a small request and is not made to wait
 * behind bytes it did not ask for. The cap is for the background filler and for
 * reads that genuinely span that much.
 */
const MAX_REQUEST_BYTES = 16 << 20;

/**
 * Blocks that are already here, between two that are not, are downloaded again
 * rather than split the request in two. A round trip costs more than this many
 * bytes on any connection worth having.
 */
const MAX_BRIDGED_GAP = 128 << 10;

/**
 * Requests in flight at once. Six is what a browser will open to one host over
 * HTTP/1.1; over HTTP/2 it is one connection and the limit stops mattering, but
 * asking for more would only queue behind this on the worse of the two.
 */
const MAX_CONCURRENT_REQUESTS = 6;

/**
 * How often the background filler looks up to see whether a read is parked.
 * Short enough that a demand fetch is never held up by much, long enough that
 * an idle session is not a timer running hot.
 */
const IDLE_CHECK_MS = 50;

/**
 * Microtasks a turn waits for a host call's answer before the next thread is
 * picked: a call that runs guest code chains a few promises before it builds
 * the frame. The limit is not measured yet: `hostTurns` counts the ticks taken and the
 * waits that ran out.
 */
const HOST_ANSWER_TICKS = 64;

/** How many of the hottest sampled addresses a report carries the code around. */
const HOT_CODE_SAMPLES = 64;

/**
 * Turns blocks into range requests.
 *
 * This is what decides how many times the network is asked, and it matters far
 * more than the block size does: blocks sit in the container back to back in
 * file order, so a read that spans a run of them is one request rather than one
 * per block. A game reading a hundred megabytes of an archive asks perhaps
 * thirteen times, not four hundred.
 *
 * @param {any[]} blocks  Absent, in ascending offset order.
 * @returns {{ start: number, end: number, blocks: any[] }[]}
 */
export function groupBlocks(blocks){
    /** @type {{ start: number, end: number, blocks: any[] }[]} */
    const groups = [];
    for (const block of blocks)
    {
        const open = groups.at(-1);
        const grown = block.offset + block.packed - (open?.start ?? 0);
        if (open
            && block.offset - open.end <= MAX_BRIDGED_GAP
            && grown <= MAX_REQUEST_BYTES)
        {
            open.end = block.offset + block.packed;
            open.blocks.push(block);
            continue;
        }
        groups.push({
            start: block.offset,
            end: block.offset + block.packed,
            blocks: [block],
        });
    }
    return groups;
}

/**
 * How much a miss brings in beyond what the read wanted: the aligned window of
 * the container it falls in, and past a forward reader's miss, this many more
 * packed bytes of what follows.
 *
 * A miss is one round trip whatever its size, and on a real title a start is
 * a hundred of them for a few megabytes: latency, not bandwidth. Two mebibytes
 * is small against a request's ceiling and large against a block, and a
 * program that touches one block of a region it never returns to pays for this
 * much extra at most.
 */
export const READ_AHEAD_BYTES = 2 << 20;

/**
 * Widens every miss to the aligned window of the container that holds it.
 *
 * Whatever the read wanted, the request is the window: the blocks around a
 * miss are the rest of the file it is in, or the file beside it, and a start
 * that comes back for them one miss at a time pays a round trip for each.
 * Blocks already resident are stepped over, and a window is clipped at the
 * container's end. Two misses in one window are one request.
 *
 * @param {any[]} blocks  Wanted and not resident, ascending by offset.
 * @param {{ block: (index: number) => any, blockCount: number }} bundle
 * @param {(index: number) => boolean} resident
 * @param {number} [bytes]  The window, and its alignment.
 * @returns {any[]} the same blocks and the rest of their windows, ascending
 */
export function withWindow(blocks, bundle, resident, bytes = READ_AHEAD_BYTES){
    /** @type {Map<number, any>} */
    const chosen = new Map(blocks.map(block=>[block.index, block]));
    /** @param {number} index */
    const add = index=>{
        if (!chosen.has(index) && !resident(index))
        {
            const block = bundle.block(index);
            chosen.set(index, { index, offset: block.offset, packed: block.packed, ahead: true });
        }
    };
    for (const block of blocks)
    {
        const start = Math.floor(block.offset / bytes) * bytes;
        for (let index = block.index - 1;
            index >= 0 && bundle.block(index).offset >= start; index--)
        {
            add(index);
        }
        for (let index = block.index + 1;
            index < bundle.blockCount && bundle.block(index).offset < start + bytes; index++)
        {
            add(index);
        }
    }
    return [...chosen.values()].sort((left, right)=>left.offset - right.offset);
}

/**
 * The blocks a request would bring in for the second time.
 *
 * A block downloaded once must not be downloaded again, and this is where
 * that is checked rather than assumed: everything inside a request's span
 * that is already resident, whether asked for by name or bridged over as a
 * gap, is a byte paid for twice. Counted before the request goes out, so the
 * number is about what was asked, not about what arrived.
 *
 * @param {{ blocks: any[] }} group
 * @param {{ block: (index: number) => any }} bundle
 * @param {(index: number) => boolean} resident
 * @returns {{ blocks: number, bytes: number }}
 */
export function refetchedIn(group, bundle, resident){
    let blocks = 0;
    let bytes = 0;
    const first = group.blocks[0]?.index ?? 0;
    const last = group.blocks[group.blocks.length - 1]?.index ?? -1;
    for (let index = first; index <= last; index++)
    {
        if (resident(index))
        {
            blocks++;
            bytes += bundle.block(index).packed;
        }
    }
    return { blocks, bytes };
}

/**
 * Extends a miss with the blocks that follow it in the container.
 *
 * Only when the miss continues where the last fetch stopped: that is a program
 * reading forward, and reaching past it turns the run into a few requests.
 * Measured on a real title's cinematic, one block a request for two hundred
 * and forty blocks. A miss anywhere else gets its window and no more. Blocks
 * already resident count against the reach but are not asked for again.
 *
 * @param {any[]} absent  Wanted and not resident, ascending by offset.
 * @param {{ block: (index: number) => any, blockCount: number }} bundle
 * @param {(index: number) => boolean} resident
 * @param {number[]} expected
 *        The blocks a forward reader would want next: one per recent fetch,
 *        because a program streams one file while it reads another, and the
 *        two runs take turns at missing.
 * @param {number} [bytes]
 * @returns {any[]} the same blocks, then the ones reached, ascending
 */
export function withReadAhead(absent, bundle, resident, expected, bytes = READ_AHEAD_BYTES){
    if (absent.length === 0 || !expected.includes(absent[0].index))
    {
        return absent;
    }
    const last = absent[absent.length - 1];
    /** @type {any[]} */
    const reached = [];
    let reach = 0;
    for (let index = last.index + 1; index < bundle.blockCount && reach < bytes; index++)
    {
        const block = bundle.block(index);
        reach += block.packed;
        if (!resident(index))
        {
            reached.push({ index, offset: block.offset, packed: block.packed, ahead: true });
        }
    }
    return reached.length === 0 ? absent : [...absent, ...reached];
}

/**
 * One event's payload as a line.
 *
 * Built now rather than left as a template argument, which is the journal's
 * usual economy: an event carries an object, and an object read later is the
 * object as it ended up rather than as it was reported. Events are occasional
 * -- a library loading, a write, a failure -- so the string costs nothing that
 * matters, and it is the difference between a log that can be read and one
 * that says [object Object].
 *
 * @param {any} payload
 * @returns {string}
 */
export function describeEvent(payload){
    if (payload === null || payload === undefined)
    {
        return '';
    }
    if (typeof payload !== 'object')
    {
        return String(payload);
    }
    return Object.entries(payload)
        .map(([key, value])=>{
            if (value instanceof Error)
            {
                return `${key}=${value.message}`;
            }
            if (Array.isArray(value))
            {
                return `${key}=[${value.join(' ')}]`;
            }
            // A picture's bytes are not a line: a cursor told every frame
            // would fill the journal with its pixels.
            if (ArrayBuffer.isView(value))
            {
                return `${key}=<${value.byteLength} bytes>`;
            }
            return `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`;
        })
        .join(' ');
}

/**
 * What a call to an import nothing claims may do: return to its caller, taking
 * the arguments it was passed off the stack as the caller expects, or not
 * return at all -- the stack is the one thing a stub must get right.
 *
 * A C++ name says its own convention and, mostly, its argument bytes: a C
 * runtime's classes are `thiscall` whatever the rest of the library is. A
 * `_name@N` name is stdcall with N bytes. Anything else is cdecl when its
 * library is, and otherwise stdcall with a count nobody knows. A library the
 * program brought is a mismatch between two of its own files, and answers
 * as its name says.
 *
 * @param {string | null} name
 * @param {{ own: boolean, cdeclLibrary: boolean }} library
 * @returns {{ returns: boolean, argBytes: number }}
 */
export function missingImportCall(name, { own, cdeclLibrary }){
    const mangled = name === null ? null : mangledCall(name);
    if (mangled)
    {
        return { returns: mangled.argBytes !== null || own, argBytes: mangled.argBytes ?? 0 };
    }
    const decorated = name === null ? null : /@(\d+)$/.exec(name);
    return {
        returns: decorated !== null || own || cdeclLibrary,
        argBytes: decorated ? Number(decorated[1]) : 0,
    };
}

/**
 * Binds an import nothing implements, once per label, and bounds what a
 * program that calls it in a loop does to the engine.
 *
 * Leaving the slot alone is not an option: it keeps what the file wrote -- the
 * relative address of the name block -- so a call through it jumps to a small
 * number, runs whatever bytes are there, and dies as an invalid opcode naming
 * an address that has nothing to do with the import. What is wanted instead is
 * the name.
 *
 * Whether the stub may return is decided by the one thing that must be right
 * for the program to go on: what the caller expects of the callee's stack
 * (`missingImportCall`). Where that is known the stub answers zero and returns;
 * where nobody knows the count -- an undecorated name from a stdcall library,
 * a C++ name whose arguments the name does not size -- no stub can return
 * without leaving the stack short, so the first call goes to `fault`, which
 * names the import and its caller and ends the run. That branch cannot flood,
 * since it happens once.
 *
 * The branch that can flood is the returning one. A program calls a missing
 * classifier once per character of every string, and announcing every call puts
 * tens of thousands of structured clones and wake-ups a second through the port
 * to the page, filling its queue until the program freezes. So the event fires
 * once per label, on the first call, which is all a person needs to see that
 * the import exists and is missing; every later call is counted for
 * `diagnostics` and written to the journal, which is a ring in shared memory
 * that never waits and can afford a record a call.
 *
 * @param {Object} deps
 * @param {(name: string, spec: Object) => number} deps.register
 *        The bridge's `register`; the address it answers is what the import
 *        binds to.
 * @param {ReturnType<typeof createEvents>} deps.events
 * @param {{ write: (level: string, category: string, template: string,
 *     ...args: any[]) => void } | Record<string, any>} deps.journal
 *        The log's api; its `write` is what keeps a record of a call.
 * @param {(dll: string, name: string | null) => { own: boolean,
 *     returns: boolean, argBytes: number }} deps.classify
 *        What the library and the decoration say about the call.
 * @param {(label: string, frame: any) => number} deps.fault
 *        The non-returning branch: raise the fault, hold the thread, answer
 *        zero.
 * @returns {{ bind: (dll: string, name: string | null, ordinal: number | null)
 *     => number, calls: Map<string, number> }}
 */
export function createMissingImports({ register, events, journal, classify, fault }){
    /** @type {Map<string, number>} */
    const addresses = new Map();
    // How often a program actually called an import nothing claims. Binding one
    // is routine and mostly harmless -- a program imports far more than it
    // calls -- so the list of unresolved names says little on its own. Being
    // called is the event that matters, and without this counter it leaves no
    // trace anywhere a run can be read.
    /** @type {Map<string, number>} */
    const calls = new Map();

    /**
     * One stub per name, because a program is quite capable of calling the same
     * missing import a thousand times before it gives up.
     *
     * @param {string} label
     * @param {'program' | 'system'} origin
     * @param {boolean} returns
     */
    const handlerFor = (label, origin, returns)=>
        (/** @type {number[]} */ _args, /** @type {any} */ frame)=>{
            const count = (calls.get(label) ?? 0) + 1;
            calls.set(label, count);
            const payload = { import: label, origin, count };
            journal.write('warn', 'unimplemented', '{0}', describeEvent(payload));
            if (count === 1)
            {
                events.emit('unimplemented', payload);
            }
            if (returns)
            {
                // Zero, and back to the caller. It reads as failure for the
                // commonest shapes -- a null pointer, a null handle, FALSE, a
                // count of none -- so such a caller takes its own failure path
                // and says something about what it wanted. Not for every shape:
                // an HRESULT or an error code of zero is success, and a C
                // runtime call that fails with -1 or EOF (fgetc, _read) or
                // answers "not yet" with zero (feof) reads it as a result, which
                // can leave a read loop going round for ever. No one value
                // fails under every convention; this one fails under most.
                return 0;
            }
            return fault(label, frame);
        };

    /** @param {string} dll @param {string | null} name @param {number | null} ordinal */
    const bind = (dll, name, ordinal)=>{
        const label = `${dll}!${name ?? `#${ordinal}`}`;
        const known = addresses.get(label);
        if (known !== undefined)
        {
            return known;
        }
        const { own, returns, argBytes } = classify(dll, name);
        const address = register(label, {
            argBytes,
            handler: handlerFor(label, own ? 'program' : 'system', returns),
        });
        addresses.set(label, address);
        // Said at bind time as well as when called: a program that is about
        // to run is the moment to read what it imports and nobody answers,
        // before the first of them corrupts a stack.
        events.emit('import-unresolved', { import: label, origin: own ? 'program' : 'system' });
        return address;
    };

    return { bind, calls };
}

/**
 * A yield to the macrotask queue, so everything the host has queued gets a turn.
 *
 * Everything means the host's timers too, which is why Node yields through
 * `setImmediate` and not through a port. Node hands a port's messages over at
 * least a thousand at a time in one pass of its event loop, running the
 * microtasks after each, and a loop that posts its next yield from those
 * microtasks stays inside the pass: a thousand turns go by before a timer
 * fires, a file read or a fetch answers, another port -- a worker's --
 * delivers a message, or a module the emulator compiled for a hot page is
 * installed, so the emulator interprets. Measured: a loop of half-millisecond
 * turns yielding through a port saw a 3 ms interval fire three times in two
 * seconds, and through an immediate six hundred and sixty times. An immediate
 * set from inside an immediate runs on the next pass, and every pass looks at
 * the timers and polls for I/O.
 *
 * Elsewhere through a message channel rather than a timer, and the difference
 * is not small: a browser clamps a zero timeout to four milliseconds and more
 * once they nest, so a loop yielding that way pays the clamp every time --
 * measured at eight milliseconds a yield and fifteen seconds in one run, larger
 * than the emulation it was interrupting. A channel message is delivered on
 * the same macrotask turn without the clamp, and a browser schedules it beside
 * its timers rather than ahead of them: in Chromium, on a page and in a
 * worker, a 3 ms timer came at most 9 ms late with 4 ms of work between two
 * yields, and about 3 ms late with half a millisecond.
 *
 * A timer is still the fallback, because this file has to run in a worker, in a
 * page and under a test runner, and not all of them have a channel.
 *
 * The ports are the machine's for as long as it runs, so the yield carries its
 * own `close`: an open port is a live handle, and a host that counts them --
 * Node does, and will not exit while one is open -- never sees the end of a
 * process that only dropped its reference to it.
 *
 * @returns {(() => Promise<void>) & { close: () => void }}
 */
export function createMacrotask(){
    if (typeof setImmediate === 'function')
    {
        // Nothing to close: an immediate holds the process open only until it
        // runs, and whoever is mid-yield is answered when it does.
        return Object.assign(
            ()=>new Promise(resolve=>{
                setImmediate(resolve);
            }),
            { close: ()=>{} });
    }
    if (typeof MessageChannel !== 'function')
    {
        return Object.assign(
            ()=>new Promise(resolve=>{
                setTimeout(resolve, 0);
            }),
            { close: ()=>{} });
    }
    const channel = new MessageChannel();
    /** @type {(() => void)[]} */
    const waiting = [];
    // One channel for the life of the process rather than one per yield: a
    // channel is a pair of ports the host has to keep, and making one per turn
    // is the cost this was meant to remove.
    channel.port1.onmessage = ()=>waiting.shift()?.();
    channel.port1.start?.();
    return Object.assign(
        ()=>new Promise(resolve=>{
            waiting.push(/** @type {() => void} */ (resolve));
            channel.port2.postMessage(0);
        }),
        {
            close(){
                channel.port1.close();
                channel.port2.close();
                // Whoever was mid-yield is owed an answer: the port that would
                // have delivered it is gone, and a caller left awaiting it
                // would hold the run loop open for ever.
                while (waiting.length > 0)
                {
                    waiting.shift()?.();
                }
            },
        });
}

/**
 * Whether the page this is running in is out of sight.
 *
 * @returns {boolean} false wherever there is no page to ask.
 */
export function pageIsHidden(){
    return typeof document !== 'undefined' && Boolean(document.hidden);
}

/**
 * How the run loop waits when every guest thread is waiting on a deadline.
 *
 * A real timer, ordinarily: the machine has nothing to run, and spinning the
 * event loop to discover that again immediately is heat rather than progress.
 *
 * Except when nobody is looking. A browser clamps a hidden page's timers to
 * about a second, which does not slow the machine down politely -- it stops it.
 * Measured switching tabs during a cinematic: the loop fell from roughly two
 * hundred and fifty turns a second to one, the film from twenty-four frames a
 * second to four, and what came back when the tab did was a program that had
 * lived through one second of every five. A program running in the background
 * is still running, so the wait becomes a macrotask, which nothing clamps.
 *
 * @param {Object} how
 * @param {() => boolean} how.hidden
 * @param {() => Promise<void>} how.macrotask
 * @param {() => Promise<void>} how.timer
 * @returns {Promise<void>}
 */
export function timedWait({ hidden, macrotask, timer }){
    return hidden() ? macrotask() : timer();
}

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
 * How long a page's thread may run turns back to back before it is given to
 * the browser regardless.
 *
 * On a page the gap between tasks is where everything else happens: a click
 * is delivered, a frame is composed, the launcher's own interface repaints.
 * The bound is tight because all of that is felt directly -- and a yield every
 * turn, measured on a real title, was the largest host phase of the run at
 * over a hundred microseconds each, because whatever the browser does in the
 * gap is paid on every trip. A few turns between trips keep the page as
 * responsive as a frame needs and cut the trips by that factor.
 */
export const PAGE_YIELD_MS = 2;

/**
 * How often an outstanding host answer -- a call suspended on the host, a
 * range in flight -- is looked for while other guest threads still have work.
 * It bounds how late the parked thread hears its answer; a trip costs tens of
 * microseconds, a turn a few hundred, so one look a millisecond keeps the
 * trips a small share of the run.
 */
export const PENDING_YIELD_MS = 1;

/**
 * A yield by need and by time, not by turn.
 *
 * The loop leaves the microtask queue when the host may have something to
 * deliver -- a call answered, a range arrived, a message posted, a turn that
 * retired nothing and so is waiting on the host -- and otherwise at most once
 * per `intervalMs`, which is what bounds how long an input event or a
 * decoder's output waits behind the guest. A caller parked on an empty
 * message queue is not such a thing: the loop lets it look again every turn
 * without the host, and what the page posts to it waits no longer than the
 * interval -- while a trip a turn, behind a thread that is copying, cost more
 * than the copying. The clock is reset when the trip ends, not when it
 * begins: a trip the browser stretched to compose a frame has already given
 * the thread away for that long.
 *
 * @param {Object} deps
 * @param {() => Promise<void>} deps.macrotask
 * @param {() => number} deps.now             Wall milliseconds.
 * @param {number} deps.intervalMs
 * @param {() => boolean} [deps.signalled]    Whether a message is known to be waiting.
 * @param {number} [deps.pendingMs]  How long after the last trip an outstanding host
 *     answer or range is looked for again while other threads still run.
 * @param {Record<string, number>} [deps.counts]  Counted into: each turn, by why it went to
 *     the event loop (`suspended`, `fetching`, `spun`, `signalled`, `interval`) or `kept`.
 * @returns {RunPacing['yield']}
 */
export function pacedYield({ macrotask, now, intervalMs, signalled = ()=>false,
    pendingMs = PENDING_YIELD_MS, counts })
{
    let rested = now();
    return pending=>{
        // An answer outstanding is looked for at once only when the turn ran
        // nothing; while other threads run it waits out pendingMs, since a
        // trip a turn behind a loader running beside a thread parked on
        // Present was the largest host phase of a run (2.46 M trips in 1500 s).
        const since = now() - rested;
        const look = pending.spun > 0 || since >= pendingMs;
        // Why the turn went to the event loop, the first reason that held -- what a report
        // reads when the trips are many.
        const why = pending.suspended > 0 && look ? 'suspended'
            : pending.fetching > 0 && look ? 'fetching'
                : pending.spun > 0 ? 'spun' : signalled() ? 'signalled'
                    : since >= intervalMs ? 'interval' : null;
        if (counts)
        {
            counts[why ?? 'kept'] = (counts[why ?? 'kept'] ?? 0) + 1;
        }
        if (why === null)
        {
            return null;
        }
        return macrotask().then(()=>{
            rested = now();
        });
    };
}

/**
 * The pacing of a thread that cannot block: a yield when something is pending
 * or the page's interval is up, and an idle wait that looks again on a short
 * timer, or on a macrotask when the page is hidden and its timers clamped.
 *
 * @param {Object} deps
 * @param {() => Promise<void>} deps.macrotask
 * @param {() => boolean} deps.hidden
 * @param {number} [deps.lookMs]
 * @param {number} [deps.yieldMs]
 * @param {() => number} [deps.now]
 * @param {() => boolean} [deps.signalled]
 * @param {number} [deps.pendingMs]
 * @returns {RunPacing}
 */
export function pagePacing({ macrotask, hidden, lookMs = IDLE_LOOK_MS, yieldMs = PAGE_YIELD_MS,
    now = ()=>performance.now(), signalled, pendingMs })
{
    /** Turns kept on the thread and trips to the event loop, by why. @type {Record<string, number>} */
    const counts = {};
    return {
        counts: ()=>({ ...counts }),
        yield: pacedYield({ macrotask, now, intervalMs: yieldMs, signalled, pendingMs, counts }),
        wait({ timer, wakes }){
            if (!timer)
            {
                return macrotask();
            }
            const look = timedWait({
                hidden,
                macrotask,
                timer: ()=>new Promise(resolve=>{
                    setTimeout(resolve, lookMs);
                }),
            });
            return wakes.length > 0 ? Promise.race([look, ...wakes]) : look;
        },
    };
}

/**
 * How long a machine with a device to feed may wait between looks.
 *
 * A film's next frame and a wave buffer's completion are deadlines the guest
 * owns without writing them down anywhere the loop can read, so while a
 * device is open the loop looks this often at most. Long enough to be tens of
 * looks a second rather than thousands, short against a ring that holds two
 * hundred milliseconds.
 */
const DEVICE_LOOK_MS = 10;

/**
 * Consecutive turns retiring no guest instruction at all before the run loop
 * stops spinning on the event loop and waits on a timer instead.
 *
 * Both waits are needed and neither will do alone. A machine whose threads are
 * running while one of its calls is parked has to come back at once, because
 * the turn after this one is real work -- and a zero timeout is clamped to four
 * milliseconds, and to more once they nest, which is that much wall clock per
 * turn for nothing. A machine where nothing ran at all has nothing to come back
 * to: only the host can change its mind, and spinning until it does burns a
 * processor to arrive no sooner while starving the very I/O it is waiting on.
 *
 * So the loop spins while the guest is still getting work done and backs off
 * once it stops. The count is small because of which way it is worse to be
 * wrong: a few spare turns cost microseconds and one turn too many on a timer
 * costs milliseconds.
 */
const IDLE_SPINS_BEFORE_TIMER = 4;

/**
 * How long the run loop sleeps between looks when nothing can run, unless
 * something wakes it sooner.
 *
 * Not zero. A zero timeout is no longer clamped by a browser that is not
 * nesting them, and the loop breaks the nesting every few turns by yielding
 * through a message port -- so a zero timeout here came round fifty thousand
 * times a second. That is a busy loop with extra steps, and it starved the
 * very thing the machine was waiting for: a decoder on the same thread whose
 * output took a second to be delivered instead of a millisecond, while every
 * guest thread sat blocked behind the one waiting on it.
 *
 * The sleep is short because it is not what ends the wait -- a host call
 * answering does, and that wakes the loop at once. It only bounds how long
 * the guest's own deadlines and the sound ring go unattended: the ring holds
 * two hundred milliseconds and the pump runs on every look.
 */
const IDLE_LOOK_MS = 4;

/**
 * How often the run loop pumps the sound at most: what the pump does --
 * position notifications, a buffer's volume and pan carried over, a queue
 * track topped up -- waits a millisecond at most, against a device that
 * reads on its own clock and a ring that holds 200 ms.
 */
const SOUND_PUMP_MS = 1;

/**
 * What the run loop is waiting on when it cannot go straight on, and how.
 *
 * A range request, a message queue with nothing in it, and some other host call
 * that has not answered are one condition from inside the loop and three
 * different costs. Named apart, a profile says which of the three a run went
 * into; named together it can only say that the machine waited.
 *
 * @param {Object} state
 * @param {number} state.fetching   Range requests outstanding.
 * @param {number} state.idlers     Callers parked on an empty message queue.
 * @param {number} state.suspended  Host calls suspended on the host, the
 *     callers parked on the guest's own queue left out.
 * @param {number} state.spun       Turns in a row that retired no instruction.
 * @returns {{ phase: string, timer: boolean } | null} null to go straight on.
 */
export function idleWait({ fetching, idlers, suspended, spun }){
    if (idlers === 0 && suspended === 0)
    {
        return null;
    }
    // A caller parked on the guest's own queue has had its look this turn, and
    // while the guest still retires instructions its next turn is work: only an
    // answer that has to come from the host is worth handing the thread over.
    if (spun === 0 && suspended === 0 && fetching === 0)
    {
        return null;
    }
    const on = fetching > 0 ? 'fetch' : idlers > 0 ? 'message' : 'host';
    const timer = spun >= IDLE_SPINS_BEFORE_TIMER;
    return { phase: `idle-${on}${timer ? '-wait' : ''}`, timer };
}

/**
 * Whether a library is answered from this engine's table even when the program
 * brought a file of that name: a KnownDLL, which Windows never looks for beside
 * the program, or a redistributable runtime a layer stands in for -- a sound
 * library's MPEG provider, a JPEG library -- which this engine makes ours
 * whoever's copy it is, since the program's copy found first runs the whole
 * decoder as emulated x86. Every other name the
 * program's own file wins, and the table is the fallback.
 *
 * @param {readonly string[]} knownDlls
 * @param {readonly string[]} runtimes
 * @returns {(name: string) => boolean}
 */
export function answeredByEngine(knownDlls, runtimes){
    const keys = new Set([...knownDlls, ...runtimes].map(moduleKeyOf));
    return name=>keys.has(moduleKeyOf(name));
}

/**
 * The key a module is known by: its file name, without directory, case or
 * the extension a program is free to leave off.
 *
 * A library is asked for by bare name in an import descriptor and by full
 * path from a loader that found the file itself, and both must find the one
 * module -- a second copy at a second address has globals its first copy's
 * callers do not share.
 *
 * @param {string} name
 */
export function moduleKeyOf(name){
    const file = name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1);
    return file.toLowerCase().replace(/\.dll$/, '');
}

// `relocatablePrefix` and `jumpBytes` live in `layers/loader/internal/hooks.js`
// now -- `bindSiteHook` needs the same two functions, and `check:boundaries`
// allows a root file to import a layer's `internal/` (this file already does
// it for pe, dependencies, resources and tls) but not the reverse. Re-exported
// so this module stays what a caller of `debug.hook` imports them from.
export { jumpBytes, relocatablePrefix };

/**
 * Where the address space above the program begins: the system modules, the
 * pool of thread stacks, and the heap, in that order.
 *
 * Placed relative to where the program's own image ends rather than at fixed
 * addresses, because an image is as large as its headers say and a self-
 * extracting installer carries its whole payload in a section: a few hundred
 * megabytes mapped at 0x400000 reaches well past where a fixed layout put the
 * modules, and a real loader simply maps everything else above it.
 *
 * @param {number} imageEnd  One past the last byte of the program's image.
 * @returns {{ moduleBase: number, stackPoolBase: number, heapBase: number }}
 */
export function spaceAbove(imageEnd){
    const granule = 0x00100000;
    const lowest = 0x02000000;
    const shift = Math.max(0, Math.ceil(imageEnd / granule) * granule - lowest);
    return {
        moduleBase: lowest + shift,
        stackPoolBase: 0x08000000 + shift,
        heapBase: 0x0c000000 + shift,
    };
}

/**
 * The least stack a thread is given, whatever its image was linked for. An
 * image linked for 64 KiB was measured here reaching 70 KiB down its first
 * thread, inside a window procedure, for a program released to run on
 * Windows; the linked figure is not what such a program can count on being
 * held to. A megabyte, the linker's own default, is the floor. Recorded in
 * roadmap/decisions.md (A42).
 */
export const MINIMUM_STACK_RESERVE = 0x100000;

/**
 * The stack a thread of an image linked for `reserve` gets.
 *
 * @param {number} reserve  The image's SizeOfStackReserve.
 */
export function stackReserveOf(reserve){
    return Math.max(reserve >>> 0, MINIMUM_STACK_RESERVE);
}

/**
 * Where the first thread's stack goes. Under the default initial stack pointer
 * when what the image was linked to reserve fits between the stub table and
 * it; otherwise at the bottom of the stack pool, the size the image asked for
 * (on a 64 KiB granule, capped at a quarter of the pool), with the pool for
 * the other threads starting above it. Clamping to the low span instead hands
 * a program linked for eight megabytes less than two, and the first deep call
 * walks off the stack's bottom -- through the stub table and below it -- with
 * nothing to say the stack was what ran out.
 *
 * @param {number} reserve      The image's SizeOfStackReserve.
 * @param {number} poolBase     Where the stack pool starts.
 * @param {number} poolSize     How large it is.
 * @returns {{ initialStack: number | undefined, poolBase: number, poolSize: number }}
 *   `initialStack` undefined keeps the processor's default.
 */
export function placeMainStack(reserve, poolBase, poolSize){
    const asked = Math.max(reserve >>> 0, 0x10000);
    if (asked <= DEFAULT_INITIAL_STACK - (DEFAULT_THUNK_BASE + DEFAULT_THUNK_CAPACITY))
    {
        return { initialStack: undefined, poolBase, poolSize };
    }
    const size = Math.min(Math.ceil(asked / 0x10000) * 0x10000, Math.floor(poolSize / 4));
    return { initialStack: poolBase + size, poolBase: poolBase + size, poolSize: poolSize - size };
}

/**
 * How much of the guest's RAM the heap gets: what the caller asked for, or
 * everything from the heap's base to the end of RAM. The heap is the last
 * region, so the end of RAM is the only ceiling there is -- and a fixed size
 * short of it was what a program loading a level ran into, reporting the
 * machine's memory as exhausted while most of it sat unused above.
 *
 * @param {number} memorySize
 * @param {number} [asked]
 * @param {number} [base]
 */
export function heapSizeFor(memorySize, asked, base = 0x0c000000){
    if (asked !== undefined)
    {
        return asked;
    }
    if (memorySize <= base)
    {
        throw new Error(`heap: ${memorySize} bytes of RAM is less than the heap's base`);
    }
    return memorySize - base;
}

/**
 * Hands a film's sound to its track and says how much of the film's timeline
 * that was, in the device's frames -- all of it, whether the track took it or
 * not.
 *
 * The picture is decoded to just ahead of the sound heard, and heard is what
 * was handed over less what is still owed. A track that refuses part of a
 * block (full, or a queue the device is behind on) still moves the film on by
 * the whole block: counted as taken only, the refused part would be heard the
 * moment it was offered, the picture would race ahead to meet it and more would
 * be refused -- a film run through in a fraction of its length on a sound
 * mostly dropped.
 *
 * @param {{ write: (bytes: Uint8Array) => number }} track
 * @param {Int16Array[]} blocks
 * @param {number} channels     the film's
 * @param {number} rate         the film's sample rate
 * @param {number} deviceRate   the rate the track counts `played()` in
 * @returns {{ offered: number, refused: number }} device frames
 */
export function feedFilmSound(track, blocks, channels, rate, deviceRate){
    let offered = 0;
    let refused = 0;
    for (const block of blocks)
    {
        const frames = Math.round(block.length / channels * deviceRate / rate);
        const taken = track.write(new Uint8Array(block.buffer, block.byteOffset, block.byteLength));
        offered += frames;
        refused += Math.max(0, frames - taken);
    }
    return { offered, refused };
}

/**
 * Credits the guest's clock with the wall time that has passed, all of it.
 *
 * Between two slices of the guest the loop yields to the browser, mixes sound,
 * moves cursors and polls its own state, and none of that used to move the
 * guest's clock: it was credited only for the slices themselves. A program
 * then saw its clock run slow by whatever share of the wall the loop took --
 * a tenth at a menu -- and everything paced against a real device fell behind
 * by that share: a sound buffer's cursor lagged the device that plays it, and
 * the device filled the difference with silence, heard as a constant crackle.
 * A real clock runs while the machine is in a syscall too.
 *
 * Capped, because a stall is not time the program spent: a fetch that took a
 * second, a tab in the background, a debugger. Credited in full, a program
 * would wake to find a second gone and run a second's worth of frames at once.
 *
 * @param {() => number} source   The wall clock, in milliseconds.
 * @param {{ advance: (milliseconds: number) => void }} clock  The guest's.
 * @param {number} cap            The most one credit may be.
 * @returns {(limit?: number) => number} credits what passed since the last call
 *     and says how much; a limit of its own for a wait that was asked for in full
 */
export function clockCredit(source, clock, cap){
    let creditedTo = source();
    return (limit = cap)=>{
        const now = source();
        const credit = Math.min(limit, Math.max(0, now - creditedTo));
        creditedTo = now;
        clock.advance(credit);
        return credit;
    };
}

/**
 * Where the package's own binaries are, relative to this module: the bundle
 * decoder's wasm build.
 *
 * A built package carries them beside itself and the build says where; the
 * source tree keeps them in its prebuilt directory. One expression rather
 * than two entry points, so a caller that imports either finds them without
 * being told.
 */
const VENDOR = /** @type {{ env?: { BOTTLIFY_VENDOR?: string } }} */ (import.meta).env?.BOTTLIFY_VENDOR
    ?? '../vendor/prebuilt/';

/**
 * Where the translator is, relative to this module: built beside a package,
 * the workspace's own source otherwise.
 */
const CORK = /** @type {{ env?: { BOTTLIFY_CORK?: string } }} */ (import.meta).env?.BOTTLIFY_CORK
    ?? '../../cork/src/index.js';

/**
 * The translator to load for `cork`: what the caller named, else
 * the one built beside this module (see `CORK`).
 *
 * @param {{ moduleUrl?: string } | undefined} asked
 * @param {string} [here]
 */
export function corkArtifacts(asked, here = import.meta.url){
    return { moduleUrl: asked?.moduleUrl ?? new URL(CORK, here).href };
}

/**
 * The run's pool of translation workers (roadmap/v2, stage 2), where every
 * machine's translator would otherwise open a worker of its own: on cork, with
 * shared memory and ports to lend through, and unless the caller turned it off
 * (`cork.pool: false`) or set the translators a machine opens itself
 * (`cork.config.translators`). A process in a worker of its own is lent its
 * workers by the run's system, and makes no pool.
 *
 * @param {AppOptions} options
 * @returns {Promise<ReturnType<typeof createTranslatorPool> | null>}
 */
async function openTranslationPool(options){
    const cork = options.cork ?? {};
    const config = /** @type {any} */ (cork.config ?? {});
    if ((options.engine ?? DEFAULT_ENGINE) !== 'cork' || options.system || cork.pool === false
        || typeof SharedArrayBuffer !== 'function' || typeof MessageChannel !== 'function')
    {
        return null;
    }
    const wanted = cork.pool === true || (config.translators === undefined
        && (config.worker ?? (config.feed !== 'slice' && typeof globalThis.Worker === 'function')));
    if (!wanted)
    {
        return null;
    }
    const engine = await import(corkArtifacts(cork).moduleUrl);
    const url = config.workerUrl ?? engine.translatorWorkerUrl?.() ?? null;
    if (url === null)
    {
        return null;
    }
    return createTranslatorPool({
        open: ()=>openProcessWorker(url),
        perProcess: cork.poolPerProcess
            ?? Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 4),
        ...(cork.poolWindowMs === undefined ? {} : { windowMs: cork.poolWindowMs }),
        driver: cork.poolDriver ?? {},
    });
}

/**
 * The emulator the caller brought, for `engine: 'emulator'`; null for any other
 * engine. The package carries no emulator, so a launch that names it without
 * handing one in is refused before anything is built.
 *
 * @param {Pick<AppOptions, 'engine' | 'v86'>} options
 * @returns {{ moduleUrl: string, wasmBytes: ArrayBuffer } | null}
 */
export function emulatorOf(options){
    if ((options.engine ?? DEFAULT_ENGINE) !== 'emulator')
    {
        return null;
    }
    const { moduleUrl, wasmBytes } = options.v86 ?? {};
    if (!moduleUrl || !wasmBytes)
    {
        throw new Error('cpu: the emulator is not installed -- engine "emulator" needs'
            + ' the caller\'s v86, as `v86: { moduleUrl, wasmBytes }`');
    }
    return { moduleUrl, wasmBytes };
}

/**
 * The bytes at a URL, wherever this runs: a browser fetches, and Node reads a
 * file URL from disk because its fetch does not.
 *
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
export async function bytesAt(url){
    if (url.startsWith('file:'))
    {
        const [{ readFile }, { fileURLToPath }] = await Promise.all([
            import('node:fs/promises'), import('node:url')]);
        const bytes = await readFile(fileURLToPath(url));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    const response = await fetch(url);
    if (!response.ok)
    {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
}

/**
 * Where a program starts: its own directory.
 *
 * That is where the shell puts a process it starts from an icon or a disc's
 * autorun, and a program that opens its files by bare name -- a companion
 * library, a configuration beside it -- is written against it. The root of
 * the drive keeps its backslash, since `C:` alone names a drive's current
 * directory rather than its root.
 *
 * @param {string} imagePath
 */
export function startDirectoryOf(imagePath){
    const cut = Math.max(imagePath.lastIndexOf('\\'), imagePath.lastIndexOf('/'));
    const directory = imagePath.slice(0, cut + 1);
    return /^[A-Za-z]:[\\/]$/.test(directory) ? directory : directory.replace(/[\\/]$/, '');
}

/**
 * Where a LoadLibrary at run time actually looks.
 *
 * A name that already says where it is, is where it is. Windows searches for a
 * bare name and takes a qualified one as given, and a program that has worked
 * out an absolute path -- a runtime loading its own plug-ins out of a directory
 * beside the executable, say -- passes one. Prefixing it again asks for
 * C:\App\C:\App\..., which is not there, and the plug-in is reported missing
 * while sitting exactly where it was asked for.
 *
 * @param {string} name        What the guest passed to LoadLibrary.
 * @param {string} imagePath   The running executable, whose directory is searched.
 */
export function resolveLibraryPath(name, imagePath){
    const qualified = /^[A-Za-z]:[\\/]/.test(name) || /^[\\/]/.test(name);
    if (qualified)
    {
        return name;
    }
    return `${imagePath.slice(0, imagePath.lastIndexOf('\\') + 1)}${name}`;
}

/**
 * The file LoadLibrary looks for under a name: one whose last component has no
 * extension gets `.dll`, and a trailing dot says "no extension" and is dropped.
 * A program that asks for `rglsw` means `rglsw.dll`.
 *
 * @param {string} name
 * @returns {string}
 */
export function withLibraryExtension(name){
    if (name.endsWith('.'))
    {
        return name.slice(0, -1);
    }
    const file = name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1);
    return file.includes('.') ? name : `${name}.dll`;
}

/** Where Windows looks for a bare library name after the program's own directory. */
const SYSTEM_LIBRARY_DIRECTORIES = ['C:\\WINDOWS\\system32\\', 'C:\\WINDOWS\\'];

/** The system directory, on the volume, without its drive or a trailing separator. */
const SYSTEM_DIRECTORY = 'WINDOWS\\system32';

/**
 * Every place a LoadLibrary at run time looks, in order: beside the
 * executable first, then the system directories -- which is where an
 * installer puts a library it brought and then loads by bare name -- then the
 * current directory, where XP's safe search mode puts it: a setup that changes
 * to a folder of its disc and loads a helper there by bare name finds it. A
 * name with a directory in it names its one place and is looked for nowhere
 * else.
 *
 * `ours` drops the system directories: for a name the engine's own table
 * already answers, the system's copy is the engine's, and a runtime an
 * installer put there is not loaded beside it. Two of one library in a process
 * -- the installed D3DX compiling an effect our D3DX is then asked to read --
 * is a format neither side shares.
 *
 * @param {string} name
 * @param {string} imagePath
 * @param {string} [currentDirectory]
 * @param {{ ours?: boolean }} [how]
 * @returns {string[]}
 */
export function libraryCandidates(name, imagePath, currentDirectory, how = {}){
    const first = resolveLibraryPath(name, imagePath);
    if (first !== `${imagePath.slice(0, imagePath.lastIndexOf('\\') + 1)}${name}`
        || /[\\/]/.test(name))
    {
        return [first];
    }
    const places = [first,
        ...how.ours ? [] : SYSTEM_LIBRARY_DIRECTORIES.map(directory=>directory + name)];
    if (currentDirectory)
    {
        const inCurrent = `${currentDirectory.replace(/\\$/, '')}\\${name}`;
        if (!places.some(place=>place.toLowerCase() === inCurrent.toLowerCase()))
        {
            places.push(inCurrent);
        }
    }
    return places;
}

/**
 * Reads a library from wherever the loader would find it, in the order it
 * would find it: beside the running program, then the system directories the
 * engine fills. The first place that has the file is the one whose bytes come
 * back; a name in none of them is null, which is what lets `planDependencies`
 * fall back to the engine's own table.
 *
 * The order matters because the bytes decide whether a real PE is mapped or a
 * synthesised table stands in for one, and the two answer different exports.
 * A title that shipped its own `d3dx9_26.dll` gets that file; one whose
 * installer put the runtime in `C:\WINDOWS\system32\` gets that one.
 *
 * @param {any} filesystem
 * @param {any} blocks       The bundle fetcher, or null when there is no bundle.
 * @param {string} imagePath The running program, whose directory is searched first.
 * @returns {(name: string) => Promise<Uint8Array | null>}
 */
export function shippedLibraryReader(filesystem, blocks, imagePath){
    return async name=>{
        for (const candidate of libraryCandidates(name, imagePath))
        {
            const file = await readWholeFile(filesystem, blocks, candidate);
            if (file)
            {
                return file;
            }
        }
        return null;
    };
}

/**
 * Runs `work` over `items`, at most `limit` at a time.
 *
 * Bounded rather than all at once: the point of issuing requests together is to
 * overlap their latency, and past the connection limit they queue anyway, with
 * the ones that queue holding their errors until the end.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} work
 */
export async function inParallel(items, limit, work){
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async()=>{
        while (next < items.length)
        {
            await work(items[next++]);
        }
    });
    await Promise.all(runners);
}

/**
 * How a program reaches a module's resources by the instance it holds.
 *
 * An HINSTANCE is the base a module was mapped at, and zero means the running
 * program -- which is what a program passes when it asks for its own strings,
 * dialogs and icons, which is nearly always. All three answers are made from
 * one lookup so that they cannot disagree about which module an instance
 * names: a resource found in one module and addressed relative to another's
 * base is a pointer into the wrong image.
 *
 * A library LoadLibraryEx mapped as data is no module, and its handle is its
 * base with a low bit set: one for a view of the file as it lies on disk, two
 * for one laid out as an image. The resource calls take that handle as they
 * take a module's, and in the file's own layout a resource lies at its file
 * offset from the base rather than at its RVA -- so that is the `rva` a data
 * file's lookup answers, since every caller adds it to the base.
 *
 * A mapped module's strings are read where it lies in memory, as Windows
 * reads them: a packed image's file names its string tables at addresses
 * that hold them only once its own code has unpacked them there.
 *
 * @param {() => any} main       The running program's module, once loaded.
 * @param {Map<number, any>} byBase  Every mapped module by its base.
 * @param {Map<number, any>} [dataFiles]  Libraries mapped as data, by handle.
 * @param {(address: number, length: number) => Uint8Array} [readMemory]
 */
export function resourceLookup(main, byBase, dataFiles = new Map(), readMemory){
    /** @param {number} instance */
    const moduleOf = instance=>{
        if (instance === 0)
        {
            return main();
        }
        return (instance & 3) !== 0
            ? dataFiles.get(instance >>> 0) ?? null
            : byBase.get(instance >>> 0) ?? null;
    };
    return {
        /** @param {number} instance @param {number} id */
        loadString: (instance, id)=>{
            const module = moduleOf(instance);
            if (!module?.file || module.flat || !readMemory)
            {
                return module?.file ? loadString(module.file, module.image, id) : null;
            }
            const found = findResource(module.file, module.image, RT_STRING,
                ((id >>> 0) >> 4) + 1);
            return found
                ? stringInBundle(readMemory(module.base + found.rva, found.size), id & 15)
                : null;
        },
        /**
         * Whether a module carries a resource, and where: what a cursor or
         * icon loaded out of the program's own image is checked against
         * before a handle to it is handed out.
         *
         * @param {number} instance @param {number} type @param {number | string} name
         * @param {number | null} [language]  Absent means the first language there is.
         */
        findResource: (instance, type, name, language = null)=>{
            const module = moduleOf(instance);
            const found = module?.file
                ? findResource(module.file, module.image, type, name, language)
                : null;
            if (!found || !module.flat)
            {
                return found;
            }
            try
            {
                return { ...found, rva: rvaToFileOffset(module.image, found.rva) };
            }
            catch {
                // Data outside every section: a file that describes a
                // resource it does not hold.
                return null;
            }
        },
        /**
         * Everything a module carries, for the enumerations: a program picks
         * its string table by language this way.
         *
         * @param {number} instance
         */
        listResources: instance=>{
            const module = moduleOf(instance);
            return module?.file ? listResources(module.file, module.image) : [];
        },
        /**
         * Where a module is mapped: the address a resource's RVA is relative
         * to. An instance that names no module is zero, and a caller adding
         * an RVA to that gets an address nothing is mapped at rather than one
         * inside the wrong module.
         *
         * @param {number} instance
         */
        moduleBase: instance=>moduleOf(instance)?.base ?? 0,
    };
}

/**
 * Sorts a parent's deferred writes into the ones that land in the child's image
 * and the ones that do not.
 *
 * A launcher that hollows its child writes into it while it is suspended, which
 * here is a write against an image nothing has mapped yet. The writes are kept
 * and replayed at the addresses they name -- but only inside the image they were
 * meant for. One outside it was addressing a mapping this process does not have,
 * and putting those bytes down anyway would corrupt whatever really is there
 * while looking, from the guest's side, like the child being wrong.
 *
 * @param {{ address: number, bytes: Uint8Array }[]} patches
 * @param {number} base
 * @param {number} size
 * @returns {{ applied: { address: number, bytes: Uint8Array }[],
 *             refused: { address: number, bytes: Uint8Array }[] }}
 */
export function placePatches(patches, base, size){
    /** @type {{ address: number, bytes: Uint8Array }[]} */
    const applied = [];
    /** @type {{ address: number, bytes: Uint8Array }[]} */
    const refused = [];
    for (const patch of patches)
    {
        const inside = patch.address >= base
            && patch.address + patch.bytes.length <= base + size;
        (inside ? applied : refused).push(patch);
    }
    return { applied, refused };
}

/**
 * What a mapped library's base is rounded up to.
 *
 * Where they start is not a constant: it is wherever the system modules end,
 * because a fixed address chosen in advance is a guess about how much memory
 * the emulator was given, and a wrong guess maps a library outside guest RAM.
 */
const LIBRARY_ALIGN = 0x10000;

/** LoadLibraryEx's flags: mapped with nothing resolved or run, or loaded as data. */
const DONT_RESOLVE_DLL_REFERENCES = 0x1;
const LOAD_LIBRARY_AS_DATAFILE = 0x2;
const LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;
const LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE = 0x40;
const LOAD_AS_DATA = LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE
    | LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE;
/** A page: a view of a file is mapped in whole ones. */
const PAGE_SIZE = 0x1000;

/**
 * The system libraries in every process, whatever it imports.
 */
const ALWAYS_LOADED = ['ntdll', 'kernel32'];

/**
 * What loading one system library brings in with it: the libraries it
 * imports itself on Windows, as far as those this engine provides go. A
 * program that imports USER32 finds GDI32 loaded, and may ask for a handle
 * to it without ever having loaded it.
 *
 * @type {Readonly<Record<string, string[]>>}
 */
const SYSTEM_IMPORTS = Object.freeze({
    user32: ['gdi32', 'advapi32'],
    gdi32: ['user32'],
    advapi32: ['rpcrt4'],
    rpcrt4: ['advapi32'],
    ole32: ['advapi32', 'gdi32', 'user32', 'rpcrt4', 'msvcrt'],
    oleaut32: ['ole32', 'rpcrt4', 'user32', 'gdi32', 'advapi32'],
    shell32: ['shlwapi', 'comctl32', 'user32', 'gdi32', 'advapi32', 'msvcrt'],
    shlwapi: ['advapi32', 'gdi32', 'user32', 'msvcrt'],
    comctl32: ['advapi32', 'gdi32', 'user32', 'msvcrt'],
    comdlg32: ['shell32', 'shlwapi', 'comctl32', 'gdi32', 'user32', 'msvcrt'],
    winmm: ['advapi32', 'user32'],
    msacm32: ['winmm', 'user32', 'advapi32'],
    imm32: ['user32', 'gdi32', 'advapi32'],
    wsock32: ['ws2_32', 'mswsock'],
    ws2_32: ['advapi32', 'msvcrt'],
    mswsock: ['ws2_32', 'advapi32', 'msvcrt'],
    mpr: ['advapi32', 'user32'],
    wininet: ['shlwapi', 'user32', 'advapi32', 'msvcrt'],
    winspool: ['gdi32', 'user32', 'advapi32'],
    quartz: ['ole32', 'oleaut32', 'user32', 'gdi32', 'advapi32', 'winmm', 'msvcrt'],
    ddraw: ['user32', 'gdi32', 'advapi32', 'msvcrt'],
    d3d8: ['user32', 'gdi32', 'advapi32', 'msvcrt'],
    d3d9: ['user32', 'gdi32', 'advapi32', 'msvcrt'],
    dsound: ['winmm', 'user32', 'advapi32', 'ole32', 'msvcrt'],
    dinput: ['user32', 'advapi32', 'msvcrt'],
    dinput8: ['user32', 'advapi32', 'msvcrt'],
});

/**
 * Where a mounted game appears inside the guest's volume: its files sit
 * directly in this directory, the way an installation's do.
 *
 * A directory of its own rather than the root, because a program of this era
 * finds its own data by asking where it is itself and looking beside that. At
 * the root those two places coincide, so a wrong answer to that question still
 * works and stays hidden until something depends on it being right.
 */
const BUNDLE_DIRECTORY = 'App';

/**
 * Where in a bottle the registry its installation left is kept: beside the
 * files, as one of them, so an unpacked bottle describes itself. The installer
 * writes it there (`@bottlify/installer`'s `REGISTRY_PATH`).
 */
export const BOTTLE_REGISTRY_PATH = '.bottlify\\registry.json';

/**
 * Where in a bottle the files its installation added to `C:\WINDOWS\system32`
 * are kept -- the libraries its DirectX setup installed, say -- beside the
 * registry, and mounted back where Windows keeps them. The installer puts
 * them there (`@bottlify/installer`'s `SYSTEM_PATH`, the same path).
 */
export const BOTTLE_SYSTEM_PATH = '.bottlify\\system32';

/**
 * The version resource of a file on the volume, or null: for a file that is
 * not there, is not an image or carries none. A file of a bundle whose bytes
 * have not arrived answers with a promise: the blocks the read missed are
 * fetched and the walk made again, as ReadFile waits for its own, so the guest
 * call is parked until they are here. Without `blocks` such a file is null.
 *
 * Only the headers, the resource directory and the block itself are read: an
 * installer asks after every file it puts down, a gigabyte archive among them.
 *
 * @param {any} filesystem
 * @param {string} path
 * @param {{ fetch: (blocks: any) => Promise<unknown> } | null} [blocks]
 * @param {number} [tries]  Walks left: each of its reads may miss once.
 * @returns {Uint8Array | null | Promise<Uint8Array | null>}
 */
export function versionResourceOf(filesystem, path, blocks = null, tries = 4){
    const RT_VERSION = 16;
    const DIR_RESOURCE = 2;
    const HEADER_BYTES = 0x1000;
    let handle;
    try
    {
        handle = filesystem.open(path, { create: false });
    }
    catch {
        return null;
    }
    try
    {
        const size = filesystem.size(handle);
        /** @param {number} offset @param {number} length */
        const readAt = (offset, length)=>{
            filesystem.seek(handle, offset);
            return filesystem.read(handle, Math.max(0, Math.min(length, size - offset)));
        };
        /** @param {Uint8Array} bytes */
        const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let head = readAt(0, HEADER_BYTES);
        const peOffset = head.length >= 0x40 ? viewOf(head).getUint32(0x3c, true) : 0;
        if (peOffset + 24 > head.length && head.length < size)
        {
            head = readAt(0, peOffset + HEADER_BYTES);
        }
        // The section table ends the headers: the file header's counts say where.
        if (peOffset + 24 <= head.length)
        {
            const end = peOffset + 24 + viewOf(head).getUint16(peOffset + 20, true)
                + viewOf(head).getUint16(peOffset + 6, true) * 40;
            if (end > head.length && head.length < size)
            {
                head = readAt(0, end);
            }
        }
        const image = parsePe(head);
        const directory = image.directories[DIR_RESOURCE];
        if (!directory || directory.size === 0)
        {
            return null;
        }
        // The directory alone, as a section of its own starting at its first
        // byte: every offset the walk follows is inside it, and the leaf it
        // ends at names the block's place in the file.
        const tree = readAt(rvaToFileOffset(image, directory.address), directory.size);
        const found = findResource(tree, {
            ...image,
            sizeOfHeaders: 0,
            sections: [{ name: '.rsrc', virtualAddress: directory.address,
                virtualSize: directory.size, rawSize: directory.size, rawOffset: 0,
                readable: true, writable: false, executable: false }],
        }, RT_VERSION, 1);
        if (!found)
        {
            return null;
        }
        const block = readAt(rvaToFileOffset(image, found.rva), found.size);
        return block.length === found.size ? block : null;
    }
    catch (e){
        const miss = /** @type {any} */ (e);
        if (miss?.code === 'BLOCK_MISS' && blocks && tries > 0)
        {
            return blocks.fetch(miss.blocks)
                .then(()=>versionResourceOf(filesystem, path, blocks, tries - 1), ()=>null);
        }
        return null;
    }
    finally
    {
        filesystem.close(handle);
    }
}

/**
 * What a program's own image says about the Windows it was written for: the
 * supportedOS elements of its manifest (RT_MANIFEST 1, the one CreateProcess
 * reads) and the operating system version its PE header names. Windows 10
 * answers the program's version calls from these.
 *
 * @param {Uint8Array} executable
 * @returns {import('./layers/win32/kernel32/versions.js').ProgramCompatibility}
 */
export function compatibilityOf(executable){
    const RT_MANIFEST = 24;
    const image = parsePe(executable);
    const view = new DataView(executable.buffer, executable.byteOffset, executable.byteLength);
    // MajorOperatingSystemVersion and its minor, forty bytes into the optional
    // header that follows the signature and the file header.
    const optional = view.getUint32(0x3c, true) + 24;
    const imageVersion = {
        major: view.getUint16(optional + 40, true),
        minor: view.getUint16(optional + 42, true),
    };
    const found = findResource(executable, image, RT_MANIFEST, 1);
    if (!found)
    {
        return { supportedOS: [], imageVersion };
    }
    const at = rvaToFileOffset(image, found.rva);
    const bytes = executable.subarray(at, at + found.size);
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
    return { supportedOS: supportedOsOf(new TextDecoder(encoding).decode(bytes)), imageVersion };
}

/**
 * A child's image: its file on the volume, or -- for a program of the system
 * folder the volume has no file for -- the image the engine makes for it
 * (`win32/programs/table.js`). Every way a child is started reads it here, so
 * a system program is a process in each of them.
 *
 * @param {any} filesystem
 * @param {any} blocks
 * @param {string} path
 * @returns {Promise<Uint8Array | null>}
 */
async function readProgramImage(filesystem, blocks, path){
    return await readWholeFile(filesystem, blocks, path) ?? systemProgramImage(path);
}

/**
 * Reads a whole file off the volume, waiting for whatever is not here yet.
 *
 * A read of a block that has not been fetched reports which blocks it needs
 * rather than waiting -- that is what lets a guest read look synchronous -- so
 * a host-side reader has to do what the guest's would: fetch, and look again.
 * This runs before the first guest instruction, so it may simply wait.
 *
 * @param {any} filesystem
 * @param {any} blocks
 * @param {string} path
 * @returns {Promise<Uint8Array | null>}
 */
async function readWholeFile(filesystem, blocks, path){
    let handle;
    try
    {
        handle = filesystem.open(path, { create: false });
    }
    catch {
        return null;
    }

    try
    {
        const size = filesystem.size(handle);
        const bytes = new Uint8Array(size);
        let at = 0;
        while (at < size)
        {
            let chunk;
            try
            {
                chunk = filesystem.read(handle, size - at);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS' || !blocks)
                {
                    throw miss;
                }
                await blocks.fetch(miss.blocks);
                continue;
            }
            if (chunk.length === 0)
            {
                break;
            }
            bytes.set(chunk, at);
            at += chunk.length;
        }
        return bytes.subarray(0, at);
    }
    finally
    {
        filesystem.close(handle);
    }
}

/**
 * Where a library goes.
 *
 * One that carries relocations takes the first base at or after `next` that
 * nothing holds. One that does not can run only at its preferred base -- every
 * absolute address in it assumes that base -- and takes it when it lies in the
 * modules' space and nothing holds it, or when `claim` can give up that span
 * from elsewhere: a base such a library names is free memory of a new process
 * on Windows, whatever this layout has put there. Otherwise it is refused, as
 * the PE format says a loader refuses such an image, rather than mapped
 * somewhere its addresses do not describe. A library that can move and finds
 * the modules' space full is put wherever `claim` finds room, as Windows puts
 * one in any free span.
 *
 * @param {{ relocatable: boolean, imageBase: number, sizeOfImage: number }} image
 * @param {{ next: number, floor: number, limit: number,
 *     holder: (base: number, size: number) => { base: number, size: number } | null,
 *     claim?: (base: number | null, size: number) => number }} space
 *        `floor` and `limit` bound the modules' space: below is the program and
 *        the engine's own, above the thread stacks and the heap. `holder`
 *        answers what already holds part of a span, if anything; `claim` takes
 *        a span outside the space -- at a base, or anywhere for null -- and
 *        answers where, or zero when there is none.
 * @returns {{ base: number } | { refused: string }}
 */
export function placeLibrary(image, { next, floor, limit, holder, claim }){
    if (!image.relocatable)
    {
        const base = image.imageBase;
        if ((base >= floor && base + image.sizeOfImage <= limit
            && !holder(base, image.sizeOfImage)) || claim?.(base, image.sizeOfImage) === base)
        {
            return { base };
        }
        return { refused: `no relocations, and 0x${base.toString(16)} is not free` };
    }
    let base = next;
    // Past the limit there is nothing more to search, and a holder that spans
    // to the end of the space answers there for ever.
    for (let held = holder(base, image.sizeOfImage); held && base + image.sizeOfImage <= limit;
        held = holder(base, image.sizeOfImage))
    {
        base = Math.ceil((held.base + held.size) / LIBRARY_ALIGN) * LIBRARY_ALIGN;
    }
    if (base + image.sizeOfImage > limit)
    {
        const anywhere = claim?.(null, image.sizeOfImage) ?? 0;
        return anywhere === 0 ? { refused: 'no room' } : { base: anywhere };
    }
    return { base };
}

/**
 * Maps every library the program brought with it, in dependency order.
 *
 * Nothing is bound here. A set of libraries that import each other has to be
 * mapped first -- every base settled, every export directory readable -- and
 * bound afterwards, or the first one binds against a library that has no
 * address yet.
 *
 * A library is looked for beside the executable, which is where a program's own
 * libraries live and where its loader would look.
 *
 * @param {any} options
 * @returns {Promise<any[]>}
 */
export async function mapShippedLibraries(options){
    const { executable, imagePath, filesystem, loader, blocks, events, isSystem,
        isKnownDll, byName, byBase } = options;
    const directory = imagePath.slice(0, imagePath.lastIndexOf('\\') + 1);

    /**
     * The first place a bare library name is on the volume: beside the program,
     * then the system directories. Where it was found is what the module is
     * recorded as living at, so a program reading its own loaded path off a
     * library gets the directory it is really in -- a `d3dx9_26` an installer
     * put in `system32` belongs there, not beside the executable.
     *
     * @param {string} name
     * @returns {string}
     */
    const placeOf = name=>libraryCandidates(name, imagePath).find(candidate=>{
        try
        {
            const entry = filesystem.stat(candidate);
            return Boolean(entry) && !entry.directory;
        }
        catch {
            return false;
        }
    }) ?? `${directory}${name}`;

    const { order, missing } = await planDependencies({
        entry: executable,
        entryName: imagePath.slice(
            Math.max(imagePath.lastIndexOf('\\'), imagePath.lastIndexOf('/')) + 1),
        isSystem,
        isKnownDll,
        // A file the program brought is read from beside it; a file it did not
        // bring is looked for in the system directories the engine fills, which
        // is where the runtime a title links against actually lives. Only when
        // neither has it does the engine's own table answer.
        readLibrary: shippedLibraryReader(filesystem, blocks, imagePath),
    });

    if (missing.length > 0)
    {
        // Not fatal: a program that never calls into one of these runs, and one
        // that does fails where it called, which says far more than a refusal
        // here would.
        events.emit('libraries-missing', { names: missing });
    }

    let next = options.base;
    /** @type {any[]} */
    const mapped = [];
    for (const { name, file } of order)
    {
        const image = parsePe(file);
        const place = placeLibrary(image, { next, floor: options.floor, limit: options.limit,
            holder: options.holder, claim: options.claim });
        if ('refused' in place)
        {
            // Refused here rather than as an overlap with the pool of thread
            // stacks above, found only when a thread's stack is laid over it,
            // or as a throw out of the mapping, saying nothing about which
            // library or why.
            events.emit('libraries-missing', { names: [name], reason: place.refused });
            continue;
        }
        const base = place.base;
        const record = loader.map(file, { base, name });
        const { exports } = readExports(file, image);

        const addresses = new Map(exports
            .filter(entry=>entry.name !== null && entry.forwards === null)
            .map(entry=>[String(entry.name), base + entry.rva]));
        const ordinals = new Map(exports
            .filter(entry=>entry.forwards === null)
            .map(entry=>[entry.ordinal, base + entry.rva]));

        const held = {
            name,
            base,
            size: image.sizeOfImage,
            /** @param {string} exported */
            addressOf: exported=>addresses.get(exported) ?? null,
            /** @param {number} ordinal */
            addressOfOrdinal: ordinal=>ordinals.get(ordinal) ?? null,
            entryPoint: record.record.entryPoint,
            mapped: record,
            // Kept for the same reason the program's own image is: a resource
            // is read out of the file rather than out of the mapping, and a
            // library a program ships carries the strings, icons, dialogs and
            // version information that program asks for. Without these a
            // module answers nothing for every resource call -- including the
            // one it makes to tell a person what went wrong.
            file,
            image,
            // Where it came from. A program asks a library where it lives and
            // then looks for its own data beside it, so this has to be the
            // directory the file was really found in -- a library the program
            // brought lives beside it, and one found in `system32` lives
            // there, where a program that walks its own installation expects
            // to find it.
            path: placeOf(name),
        };
        byName.set(name.toLowerCase().replace(/\.dll$/, ''), held);
        byBase.set(base, held);
        mapped.push(held);

        if (image.relocatable)
        {
            next = base + Math.ceil(image.sizeOfImage / LIBRARY_ALIGN) * LIBRARY_ALIGN;
        }
    }

    events.emit('libraries', { loaded: mapped.map(entry=>entry.name), missing });
    return mapped;
}

/**
 * The check that makes every block's checksum worth something.
 *
 * The index carries them, so nothing inside the container can vouch for the
 * index itself: a bundle replaced wholesale would arrive with an index that
 * agrees with its own blocks perfectly. The digest that settles it has to come
 * from somewhere else, and the manifest -- fetched to decide whether to
 * download at all -- is that somewhere.
 *
 * The whole-bundle digest in the manifest answers the same question, but over
 * gigabytes. This one is over the index alone, which is already being fetched,
 * so it is affordable on every launch rather than on request.
 *
 * @param {string | undefined} expected
 * @returns {((stored: Uint8Array) => Promise<string | null>) | undefined}
 */
function expectIndex(expected){
    if (!expected)
    {
        return undefined;
    }
    return async stored=>{
        const digest = await crypto.subtle.digest('SHA-256', stored.slice());
        const found = [...new Uint8Array(digest)]
            .map(byte=>byte.toString(16).padStart(2, '0')).join('');
        return found === expected.toLowerCase()
            ? null
            : `its digest is ${found}, not ${expected}`;
    };
}

/**
 * The zstd decoder a bundle read uses, by engine. While the emulator is loaded
 * its wasm decoder is several times faster than this project's own
 * (`modules/core/src/zstd.js`), and a first bundle load decodes the whole
 * bundle, so `emulator` uses it; `cork` has no emulator and uses
 * the project's. Both answer synchronously, as a guest read needs. The choice
 * is made once, when the bundle is mounted; when `zstd.js` is measured at the
 * wasm decoder's speed it becomes the decoder for every engine.
 *
 * @param {string} engine
 * @param {{ decompressZstd: (packed: Uint8Array, expectedLength: number) => Uint8Array }} cpu
 * @param {import('./zstd-wasm.js').ZstdWasm | null} [wasm]  The wasm build, when carried.
 * @returns {(packed: Uint8Array, expectedLength: number) => Uint8Array}
 */
export function chooseZstdDecoder(engine, cpu, wasm = null){
    // The wasm build of the project's own decoder, when this build carries it,
    // decodes for every engine at the emulator decoder's speed and with no
    // emulator loaded.
    if (wasm)
    {
        return wasm.decompress;
    }
    if (engine !== 'cork')
    {
        return (packed, expectedLength)=>cpu.decompressZstd(packed, expectedLength);
    }
    return decompressZstd;
}

/**
 * The wasm decoder from the app's options or the package's vendor directory;
 * null when the build carries none (the artifact is optional: a fetch that
 * fails or a file that is absent is the JavaScript decoder's turn, not an
 * error), so a package built without it still mounts every bundle.
 *
 * @param {AppOptions} options
 * @param {string} [here]
 * @returns {Promise<import('./zstd-wasm.js').ZstdWasm | null>}
 */
export async function zstdWasmFor(options, here = import.meta.url){
    try
    {
        const bytes = options.zstd?.wasmBytes
            ?? await bytesAt(options.zstd?.wasmUrl ?? new URL(`${VENDOR}zstd.wasm`, here).href);
        return await loadZstdWasm(bytes);
    }
    catch {
        return null;
    }
}

/**
 * Mounts a bundle as the read-only half of the volume.
 *
 * The blocks that have been brought in are held here rather than inside the
 * source, because what fetches them is the caller's business -- a file, a range
 * request, a cache -- and the source only has to know whether a block is
 * resident. A read of an absent block reports which ones it needs; this is what
 * goes and gets them.
 *
 * They are held in storage rather than in the heap. A bundle can be larger than
 * any single buffer a browser will hand out, and a program that plays a lot of
 * a large game eventually touches nearly all of it, so blocks accumulating in
 * memory is not a cost that levels off -- it is the run failing later instead
 * of sooner. The source keeps its own bounded cache of decoded blocks in front
 * of this, which is what a repeated read actually hits.
 *
 * @param {any} deps
 * @returns {Promise<{ source: any, fetch: (needed: any[]) => Promise<void>,
 *                     stop: () => void, ahead: () => number,
 *                     refetched: () => { blocks: number, bytes: number },
 *                     ranges: () => { requests: number, bytes: number },
 *                     decoded: () => { blocks: number, bytes: number, ms: number },
 *                     registry: Promise<any> } | null>}
 */
async function mountBundle({ options, cpu, events, translationStore }){
    if (!options.bundle?.fetch)
    {
        return null;
    }
    // Everything below fetches through this, the index included: the first
    // range of the run is as exposed to a dropped connection as the last.
    const fetchRange = retryingFetch({
        fetch: options.bundle.fetch,
        events,
        retry: options.bundle.retry,
    });

    const zstdForEngine = chooseZstdDecoder(options.engine ?? DEFAULT_ENGINE, cpu,
        await zstdWasmFor(options));
    /**
     * A block, turned back into bytes, without awaiting anything.
     *
     * zstd is decoded by the engine's decoder (`chooseZstdDecoder` above): the
     * emulator's wasm one under `emulator`, this project's own
     * (`zstd.js`) under `cork`. Both answer synchronously. Deflate has
     * no synchronous decoder in a browser at all, so a deflate block is
     * inflated when it is *fetched* -- which is already an asynchronous step --
     * and by the time a read reaches it, it is plain. That is why codec 1 is
     * passed through rather than refused.
     *
     * @param {number} codec
     * @param {Uint8Array} bytes
     * @param {number | null} expectedLength
     */
    const decode = (codec, bytes, expectedLength)=>{
        if (codec === 2)
        {
            // Counted: the decoding a guest read waits for is what a pool
            // worker would take off this thread (roadmap/v2, stage 2).
            const startedAt = performance.now();
            const plain = zstdForEngine(bytes, expectedLength ?? 0);
            decoded.blocks++;
            decoded.bytes += plain.length;
            decoded.ms += performance.now() - startedAt;
            return plain;
        }
        return bytes;
    };
    const decoded = { blocks: 0, bytes: 0, ms: 0 };

    // The index is deflated, and opening is asynchronous anyway, so it may use
    // the decoder a guest read cannot.
    const bundle = await openBundle(
        fetchRange,
        (codec, bytes)=>codec === 1 ? inflateRaw(bytes) : decode(codec, bytes, null),
        { verifyIndex: expectIndex(options.bundle.indexSha256) });

    // How much of a block its slot holds: a zstd block is kept packed, because
    // the decoder that answers a guest read runs synchronously, and everything
    // else is kept in the form a read can use as it stands.
    /** @param {any} block */
    const storedLength = block=>block.codec === 2 ? block.packed : block.length;

    const cache = await createBlockCache({
        // Absent means local, and only an explicit falsy value turns it off --
        // so `??` will not do here: `store: null` has to mean no cache.
        store: await resolveBlockStore(
            options.bundle.store === undefined ? 'local' : options.bundle.store),
        // ponytail: the cache of a bundle packed again is left behind on the
        // store; drop names of this bundle with another fingerprint when the
        // space matters.
        name: `${options.bundle.id ?? options.id ?? 'bundle'}-${bundle.fingerprint}`,
        blockSize: bundle.blockSize,
        blockCount: bundle.blockCount,
    });

    const source = createBundleSource({
        bundle,
        /** @param {number} index */
        readBlock: index=>cache.read(index, storedLength(bundle.block(index))),
        decode,
        // A game lives in a directory of its own, the way an installation does.
        // At the root of the volume a program's own directory and the system
        // root are the same place, so every answer to "where do I live" happens
        // to work and a wrong one is invisible until it is not.
        prefix: options.bundle.prefix ?? BUNDLE_DIRECTORY,
        // What the installation left in system32 is found there again, read
        // from the bundle a block at a time like any of its files.
        relocate: { [BOTTLE_SYSTEM_PATH]: SYSTEM_DIRECTORY },
    });


    /**
     * A member's bytes, read before the program runs: one request for its run
     * of blocks, each checked against the index and decoded as a guest read's
     * block is. Not kept in the block cache, where nothing would read it
     * again: whoever asked keeps what it takes.
     *
     * @param {import('./layers/filesystem/internal/bundle/format.js').BundleMember} of
     * @param {string} what  named in a damaged block's report
     */
    const readMember = async(of, what)=>{
        const first = bundle.block(of.firstBlock);
        const last = bundle.block(of.firstBlock + of.blocks - 1);
        const whole = await fetchRange(first.offset, last.offset + last.packed - first.offset,
            bytes=>{
                for (let at = of.firstBlock; at < of.firstBlock + of.blocks; at++)
                {
                    const block = bundle.block(at);
                    const from = block.offset - first.offset;
                    if (block.crc !== null
                        && crc32(bytes.subarray(from, from + block.packed)) !== block.crc)
                    {
                        return `block ${at} of ${what} arrived damaged`;
                    }
                }
                return null;
            });
        const out = new Uint8Array(of.size);
        let written = 0;
        for (let at = of.firstBlock; at < of.firstBlock + of.blocks; at++)
        {
            const block = bundle.block(at);
            const from = block.offset - first.offset;
            const raw = whole.subarray(from, from + block.packed);
            const bytes = block.codec === 1 ? await inflateRaw(raw) : decode(block.codec, raw,
                block.length);
            out.set(bytes, written);
            written += bytes.length;
        }
        return written === of.size ? out : null;
    };

    // The bundle's translation seed goes into the translator's store before
    // the program's first instruction, and every lookup waits for it, so the
    // first run of the bundle on this machine starts from the regions a run
    // elsewhere made instead of from none. Once a store has taken this seed
    // it is not fetched again. Only an engine with the translator has a use
    // for it, the default among them.
    const member = bundle.translations;
    if (member !== null && (options.engine ?? DEFAULT_ENGINE) !== 'emulator'
        && typeof translationStore?.seed === 'function')
    {
        const seeding = (async()=>(await translationStore.seededWith() === member.sha256
            ? null : readMember(member, 'the translations'))
        )();
        translationStore.seed(seeding, member.sha256).then((/** @type {any} */ result)=>{
            events.emit('bundle-translations', { size: member.size, ...result });
        });
    }

    // The registry the installation left, which travels in the bottle beside
    // its files: read now, while nothing else is, and parsed once.
    const registryFile = bundle.find(BOTTLE_REGISTRY_PATH);
    const registry = registryFile === null ? Promise.resolve(null)
        : readMember(registryFile, 'the registry').then(bytes=>(bytes === null ? null
            : JSON.parse(new TextDecoder().decode(bytes)))).catch((/** @type {any} */ e)=>{
            events.emit('bundle-registry-unreadable', { reason: e?.message ?? String(e) });
            return null;
        });

    events.emit('bundle', {
        files: bundle.files.length,
        blockSize: bundle.blockSize,
        blocks: bundle.blockCount,
        cached: cache.diagnostics().resident,
        backed: cache.backed,
        remembered: cache.order().length,
    });
    if (!cache.backed)
    {
        // Said out loud, in the words of the setting it defeats: a store that
        // quietly failed to open reads from outside as a cache that never
        // worked, and every block of this run will be fetched again next time.
        events.emit('bundle-unbacked', {
            reason: cache.reason,
            effect: 'fetched blocks are not kept on this machine',
        });
    }

    /**
     * Brings in one run of blocks: one request, then split and checked.
     *
     * The checksums are per block, so a group is verified block by block and a
     * group with one bad block is asked for again whole. Damage is rare enough
     * that paying for the neighbours beats tracking which part to re-ask for.
     *
     * Each block is copied out with `slice`, not viewed with `subarray`: a view
     * would keep the entire request's buffer alive for as long as any one block
     * of it is held, which for a 8 MiB request holding one 256 KiB block is
     * thirty-one blocks of the group nobody wanted.
     *
     * @param {{ start: number, end: number, blocks: any[] }} group
     */
    const fetchGroup = async group=>{
        const twice = refetchedIn(group, bundle, has);
        refetched.blocks += twice.blocks;
        refetched.bytes += twice.bytes;
        const span = group.end - group.start;
        ranges.requests++;
        ranges.bytes += span;
        const whole = await fetchRange(group.start, span, bytes=>{
            for (const block of group.blocks)
            {
                const expected = bundle.block(block.index).crc;
                if (expected === null)
                {
                    continue;
                }
                const at = block.offset - group.start;
                const found = crc32(bytes.subarray(at, at + block.packed));
                if (found !== expected)
                {
                    return `block ${block.index} arrived damaged `
                        + `(checksum ${found}, expected ${expected})`;
                }
            }
            return null;
        });

        for (const block of group.blocks)
        {
            const at = block.offset - group.start;
            const raw = whole.slice(at, at + block.packed);
            // Inflated here, once, rather than on every read: this is the only
            // place a deflate block can be decoded at all, since the read side
            // is synchronous and the browser's inflate is not.
            cache.put(block.index,
                bundle.block(block.index).codec === 1 ? await inflateRaw(raw) : raw);
        }
    };

    /** @param {number} index */
    const has = index=>cache.has(index);
    /** Blocks a request went out for that were already here. */
    const refetched = { blocks: 0, bytes: 0 };
    /**
     * What went over the wire: range requests and the bytes they spanned. The
     * count of reads that waited is a different number -- one read may be
     * several requests, and a request may serve a read that never waited.
     */
    const ranges = { requests: 0, bytes: 0 };
    /**
     * Blocks a request is out for right now, each with the promise of it. A
     * second read that wants one of them waits for that request rather than
     * sending its own: two threads reading neighbouring files would otherwise
     * fetch the same window twice, once each.
     *
     * @type {Map<number, Promise<void>>}
     */
    const inFlight = new Map();

    // What a read is waiting on right now. The background filler stands aside
    // whenever this is above zero: a block a parked thread wants is worth more
    // than any block nobody has asked for.
    let waiting = 0;
    let stopped = false;
    /** Blocks brought in ahead of a read, ever. */
    let ahead = 0;
    /**
     * The block after each of the last few fetches: where a forward reader's
     * next miss lands. A few rather than one, because two files streamed at
     * once take turns at missing and each turn would otherwise start over.
     */
    /** @type {number[]} */
    const expected = [];
    const EXPECTED_KEPT = 4;

    /** @param {any[]} needed */
    const demand = async needed=>{
        for (const block of needed)
        {
            cache.demanded(block.index);
        }
        const absent = [...new Map(needed
            .filter(block=>!cache.has(block.index))
            .map(block=>[block.index, block])).values()]
            .sort((left, right)=>left.offset - right.offset);

        const reaching = withWindow(withReadAhead(absent, bundle, has, expected), bundle, has);
        ahead += reaching.length - absent.length;
        if (reaching.length > 0)
        {
            expected.push(reaching[reaching.length - 1].index + 1);
            if (expected.length > EXPECTED_KEPT)
            {
                expected.shift();
            }
        }
        const borrowed = [...new Set(reaching.map(block=>inFlight.get(block.index)))]
            .filter(promise=>promise !== undefined);
        const own = reaching.filter(block=>!inFlight.has(block.index));
        waiting++;
        const request = inParallel(groupBlocks(own), MAX_CONCURRENT_REQUESTS, fetchGroup);
        for (const block of own)
        {
            inFlight.set(block.index, request);
        }
        try
        {
            // A borrowed request that fails is the other read's failure to
            // report; this one comes back for the block if it is still absent.
            await Promise.all([request, ...borrowed.map(promise=>promise.catch(()=>{}))]);
        }
        finally
        {
            waiting--;
            for (const block of own)
            {
                inFlight.delete(block.index);
            }
        }

        // Once per batch, not once per block: losing the record of a block that
        // is already on disk costs one refetch, and writing it every time would
        // cost far more than that.
        await cache.persist();
    };

    /**
     * Brings groups in one at a time, and only while no read is parked. Both
     * follow from what the filler is for: it exists to use idle time, so the
     * moment the time stops being idle it has to give the connections back to
     * the read that a player is actually waiting on.
     *
     * @param {{ start: number, end: number, blocks: any[] }[]} groups
     * @returns {Promise<boolean>} whether to go on
     */
    const fillGroups = async groups=>{
        for (const group of groups)
        {
            while (true)
            {
                if (stopped)
                {
                    return false;
                }
                if (waiting === 0)
                {
                    break;
                }
                await new Promise(resolve=>setTimeout(resolve, IDLE_CHECK_MS));
            }
            // Only what is still missing, regrouped: a read may have brought
            // part of this group in while the filler stood aside.
            const missing = group.blocks
                .filter(block=>!has(block.index) && !inFlight.has(block.index));
            if (missing.length === 0)
            {
                continue;
            }

            try
            {
                for (const part of groupBlocks(missing))
                {
                    await fetchGroup(part);
                }
                await cache.persist();
            }
            catch (e){
                // A run that cannot be filled in the background is still a run.
                // The blocks it failed on will be asked for again, in front of a
                // parked thread, where the failure belongs.
                events.emit('bundle-prefetch-failed',
                    { start: group.start, reason: /** @type {any} */ (e).message });
                return false;
            }
            events.emit('bundle-prefetch', {
                resident: cache.diagnostics().resident,
                blocks: bundle.blockCount,
            });
        }
        return true;
    };

    /**
     * Fills the rest of the cache while the game is not asking for anything.
     *
     * First what the last run asked for, in the order it asked: a start reads
     * the same things in the same order every time, so that is the one thing
     * known about what will be read next, and each of those blocks comes in
     * with its window the way a miss would. Then the whole bundle, in container
     * order, taken one request at a time out of the gaps -- not a guess about
     * what will be read next, so nothing about it can be wrong about the game's
     * access pattern, it can only be early or late.
     *
     * Off when the blocks have nowhere to go. Filling a bounded heap cache with
     * a whole bundle would evict as fast as it fills, and pay for every byte of
     * it twice.
     */
    const fill = async()=>{
        if (!cache.backed || options.bundle.prefetch === false)
        {
            return;
        }

        for (const index of cache.order())
        {
            if (!has(index)
                && !await fillGroups(groupBlocks(withWindow([bundle.block(index)], bundle, has))))
            {
                return;
            }
        }

        // The translation seed's blocks are the store's business, read once.
        const all = Array.from({ length: bundle.blockCount },
            (unused, index)=>bundle.block(index))
            .filter(block=>member === null || block.index < member.firstBlock
                || block.index >= member.firstBlock + member.blocks);
        await fillGroups(groupBlocks(all));
    };

    // Deliberately not awaited: it runs for as long as the bundle has blocks
    // left, which is the whole session.
    fill();
    return {
        /** The bundle's files as a drive's read-only layer, for each machine to mount. */
        source,
        fetch: demand,
        registry,
        /** How many blocks were brought in ahead of a read, ever. */
        ahead: ()=>ahead,
        /** Blocks a request went out for that were already here: the number
         *  that has to stay at zero. */
        refetched: ()=>({ ...refetched }),
        decoded: ()=>({ ...decoded }),
        /** Range requests made and bytes asked for, ever. */
        ranges: ()=>({ ...ranges }),
        stop(){
            stopped = true;
        },
    };
}

/**
 * Which part of the machine a host call belongs to.
 *
 * A program of this age reaches one engine through a dozen libraries, and the
 * question a reader has is never "which DLL" but "what was it doing" --
 * drawing, making a sound, reading a file, asking the processor something. So
 * the libraries are grouped the way the work is, and the group is the
 * journal's category, which is what makes a filter possible at all.
 *
 * @type {Record<string, string>}
 */
export const CALL_AREAS = {
    'D3D8.dll': 'gpu', 'D3D9.dll': 'gpu', 'DDRAW.dll': 'gpu',
    'OPENGL32.dll': 'gpu', 'GDI32.dll': 'gpu',
    'DSOUND.dll': 'audio', 'WINMM.dll': 'audio', 'mss32.dll': 'audio', 'Mp3dec.asi': 'audio',
    'MSACM32.dll': 'audio',
    'quartz.dll': 'video', 'blizzard.ax': 'video', 'ijl15.dll': 'video',
    'DINPUT.dll': 'input', 'DINPUT8.dll': 'input', 'USER32.dll': 'input',
    'WSOCK32.dll': 'net', 'WS2_32.dll': 'net', 'MSWSOCK.dll': 'net',
    'WININET.dll': 'net',
};

/**
 * The journal category one call is written under.
 *
 * A COM method arrives named by its interface rather than by a library, and
 * there is no library to look up -- so it gets its own group instead of being
 * filed under a guess. Everything else that is not drawing, sound, video,
 * input or the network is the processor's own business: memory, files,
 * threads, the registry, the C runtime.
 *
 * Memoised by name in the cache the caller hands in: a call site is made
 * thousands of times in a run and the name it arrives under never changes, so
 * only the first occurrence pays for the split and the lookup.
 *
 * @param {any} call
 * @param {Map<string, string>} cache
 */
export function areaOf(call, cache){
    const name = String(call?.name ?? '');
    const cached = cache.get(name);
    if (cached !== undefined)
    {
        return cached;
    }
    const at = name.indexOf('!');
    const area = at === -1 ? 'call.com' : `call.${CALL_AREAS[name.slice(0, at)] ?? 'cpu'}`;
    cache.set(name, area);
    return area;
}

/**
 * @typedef {Object} GuestMemory
 * @property {(address: number) => number} readU8
 * @property {(address: number, value: number) => void} writeU8
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU32
 * @property {(address: number, count: number, into: number[] | Float32Array) => void} readF32sInto
 * @property {(address: number, length: number) => Uint8Array} window
 */

/**
 * A kernel's view of guest memory: the scalar accessors a hook has always
 * had, plus `u8s`/`i32s`/`f32s`, a typed-array view over a span rather than
 * one call per element. `memory.window` already hands back a live subarray
 * of the emulator's own RAM, bounds-checked once for the whole span (the
 * same primitive `audio` and `graphics` already read through) -- this only
 * adds the `Int32Array`/`Float32Array` reinterpretation on top of it, so
 * nothing new needed to be added to the memory layer itself.
 *
 * `Int32Array`/`Float32Array` need a 4-byte-aligned byte offset into the
 * backing buffer, so an unaligned span throws -- the same outcome as any bad
 * address: the call falls through to the guest's own function. A copy would
 * be the alternative, and a copy's writes would never reach the guest.
 *
 * @param {GuestMemory} memory
 */
export function createGuestView(memory){
    const floatScratch = new Float32Array(1);
    const floatBits = new DataView(floatScratch.buffer);

    /**
     * @param {number} at @param {number} count @param {number} bytesPerElement
     * @param {Float32ArrayConstructor | Int32ArrayConstructor} Ctor
     */
    const typedView = (at, count, bytesPerElement, Ctor)=>{
        const span = memory.window(at, count * bytesPerElement);
        if (span.byteOffset % bytesPerElement !== 0)
        {
            throw new RangeError(
                `${Ctor.name} view at 0x${at.toString(16)} is not ${bytesPerElement}-byte aligned`);
        }
        return new Ctor(/** @type {ArrayBuffer} */ (span.buffer), span.byteOffset, count);
    };

    return {
        u8: (/** @type {number} */ at)=>memory.readU8(at),
        writeU8: (/** @type {number} */ at, /** @type {number} */ value)=>{
            memory.writeU8(at, value);
        },
        i32: (/** @type {number} */ at)=>memory.readU32(at) | 0,
        f32: (/** @type {number} */ at)=>{
            memory.readF32sInto(at, 1, floatScratch);
            return floatScratch[0];
        },
        writeF32: (/** @type {number} */ at, /** @type {number} */ value)=>{
            floatScratch[0] = value;
            memory.writeU32(at, floatBits.getUint32(0, true));
        },
        /** A `Uint8Array` window over `count` bytes at `at`, bounds-checked once. */
        u8s: (/** @type {number} */ at, /** @type {number} */ count)=>memory.window(at, count),
        /** An `Int32Array` view over `count` dwords at `at`, bounds-checked once. */
        i32s: (/** @type {number} */ at, /** @type {number} */ count)=>typedView(at, count, 4, Int32Array),
        /** A `Float32Array` view over `count` floats at `at`, bounds-checked once. */
        f32s: (/** @type {number} */ at, /** @type {number} */ count)=>typedView(at, count, 4, Float32Array),
    };
}

/**
 * The lazy, remembered resolve of the OpenGL seam `frame.gl` needs:
 * `graphics.opengl()` is not called until a kernel's first `entry()` call,
 * and a seam that throws (a build with no OpenGL layer) is remembered rather
 * than retried on every later call, so a Direct3D title still binds its
 * kernels with `entry` answering `null` for every name.
 * @param {{ opengl: () => {
 *   entry: (name: string) => ((args: number[]) => number) | null } }} graphics
 * @returns {{ entry: (name: string) => ((args: number[]) => number) | null }}
 */
export function resolveOpenglEntry(graphics){
    let openglLayer = /** @type {ReturnType<typeof graphics.opengl> | null} */ (null);
    let openglSeamFailed = false;
    return {
        entry(name){
            if (openglSeamFailed)
            {
                return null;
            }
            if (!openglLayer)
            {
                try
                {
                    openglLayer = graphics.opengl();
                }
                catch {
                    openglSeamFailed = true;
                    return null;
                }
            }
            return openglLayer.entry(name);
        },
    };
}

/**
 * The OpenGL handle a site kernel gets as `frame.gl`.
 *
 * `entry(name)` resolves one OPENGL32 entry point to a function the kernel
 * keeps and calls with raw dwords; each call is written to the journal under
 * `call.gpu` exactly as a trapped call is (same name, same category), so a
 * trace of the run stays honest when a kernel issues the work the guest would
 * have issued. Nothing else of the engine reaches the kernel through this.
 *
 * A build with no OpenGL seam (a Direct3D title) has an `opengl.entry` that
 * throws or is otherwise unusable; that answers `null` for every name rather
 * than taking the run down, so a title with no OpenGL still binds its kernels.
 *
 * @param {{ entry: (name: string) => ((args: number[]) => number) | null }} opengl
 * @param {(call: { name: string, args: number[], result: string }) => void} journalCall
 * @param {() => boolean} traced   whether `call.gpu` is on at TRACE right now
 * @param {{ calls: number }} counters
 */
export function createKernelGl(opengl, journalCall, traced, counters){
    return {
        /** @param {string} name @returns {((args: number[]) => number) | null} */
        entry(name){
            let handler;
            try
            {
                handler = opengl.entry(name);
            }
            catch {
                return null;
            }
            if (!handler)
            {
                return null;
            }
            const label = `OPENGL32.dll!${name}`;
            return args=>{
                // Counted before the call, not after: a handler that throws
                // still issued the call (its GL side effect, if any, already
                // happened), and `kernelGlCalls` must match what the
                // `hook-error` payload's `glCalls` counts against it.
                counters.calls++;
                const result = handler(args);
                if (traced())
                {
                    journalCall({ name: label, args, result: `0x${(result >>> 0).toString(16)}` });
                }
                return result;
            };
        },
    };
}

/**
 * The session storage holds for a run, its registry laid into `registry`
 * before the program's first instruction, and what saves it from then on.
 *
 * @param {{ options: AppOptions, events: any, filesystem: any, registry: any,
 *     inherited: boolean, standing?: boolean }} deps
 *     `standing`: the volume is the run's already, its files laid on it.
 *     `inherited`: the registry is the run's already, made by a process before
 *     this one
 */
async function openSession({ options, events, filesystem, registry, inherited, standing = false }){
    const storage = resolveStorage(options.storage, options.id ?? 'session');

    // Seeded before the program's first instruction, and awaited: a save that
    // arrives after the program has looked for it is a save that was not there.
    // A process standing on the run's drives and hive reads nothing: what was
    // saved is on them already, laid there by the process that made them, and
    // reading the folder while that process saves into it -- a launcher
    // starting a compiler for every shader -- catches an entry mid-write.
    const seeded = normaliseSession(standing && inherited ? null : await storage.load());
    // The registry first, and before the program's first instruction: its
    // settings and its name are here as often as in a file, and a program
    // that finds the key empty writes its defaults over them. The files wait
    // for the volume they belong on, which the bundle mount replaces.
    // A process the run started after the first has the run's registry
    // already, with what its parent wrote a moment before starting it -- a
    // write no save may have reached -- and reading the save back over it
    // would undo that.
    if (seeded.registry && !inherited)
    {
        registry.fromJSON(seeded.registry);
    }

    // One way out. What the program writes is announced once the writes settle;
    // nothing is ever pulled back in while it runs.
    const persist = storage.save;
    /** @type {ReturnType<typeof coalescedSaver> | null} */
    let saver = null;
    let stopSavingRegistry = ()=>{};
    if (persist)
    {
        saver = coalescedSaver({
            snapshot: ()=>({
                files: filesystem.export(),
                // The bottle's revision it was saved under rides with the hive.
                registry: { ...registry.toJSON(), revision: options.bundle?.revision ?? 0 },
            }),
            persist: (session, changes)=>Promise.resolve(persist(session, changes)).catch(
                (/** @type {Error} */ error)=>{
                    events.emit('error', { reason: 'session-save', error });
                }),
        });
        const pending = saver;
        /** @param {any[]} changes */
        const save = changes=>{
            events.emit('session', { changes });
            pending.note(changes);
        };
        filesystem.onChanged(save);
        // A registry write is a change to the session like a file write is,
        // announced without a path: the whole hive travels with every save.
        // The hive is the run's and outlives this machine: the subscription
        // goes with it (`dispose`).
        stopSavingRegistry = registry.onChanged(()=>save([{ kind: 'registry' }]));
    }
    return { seeded, saver, stopSavingRegistry };
}

/**
 * Lays down the run's volume before its first instruction: the bundle under
 * C:, the discs, the session's files and the page's own over them; and the
 * registry the installation wrote into `registry`, when there is one to fill.
 *
 * @param {{ options: AppOptions, events: any, filesystem: any, blocks: any,
 *     seeded: { files: any[], registry?: any }, registry: any }} deps
 */
async function furnishVolume({ options, events, filesystem, blocks, seeded, registry }){
    if (blocks)
    {
        filesystem.mount('C', { source: blocks.source });
    }
    // What the installation wrote to the registry is the machine's before the
    // program's first instruction, as it was on the machine it was installed
    // on: a launcher finds its game installed by the key its setup made. What
    // the session saved since is kept over it -- unless the session was saved
    // under an earlier revision of the bottle, whose registry is then laid over
    // it, as a reinstall would: a corrected install path reaches a person who
    // ran the bottle before.
    const installedRegistry = await blocks?.registry;
    if (installedRegistry && registry)
    {
        registry.fillFromJSON(installedRegistry,
            (seeded.registry?.revision ?? 0) < (options.bundle?.revision ?? 0));
    }
    // A disc is a drive of its own, and takes D: or the first letter nothing
    // holds once the machine's own disk is mounted.
    await mountDiscs({ discs: options.discs, filesystem, events });

    // The session's files go onto the volume once the bundle is under it, so
    // that a saved file the bundle also carries is the one the program sees.
    if (seeded.files.length > 0)
    {
        filesystem.apply(seeded.files);
    }
    // The person's own edits to the title's files -- a realm list, a config
    // line -- laid over the session's, so they win over what the program
    // last saved and never touch the bundle itself.
    if (options.files && options.files.length > 0)
    {
        filesystem.apply(options.files);
    }
}

/**
 * The severity an event is journalled at: its own. A failure the program
 * cannot see is an error whether or not anybody was listening for it, and a
 * library that could not be found is the warning that explains a program's
 * next decision. Everything else is what happened, at info.
 */
const SEVERITY = /** @type {Record<string, string>} */ ({
    error: 'error',
    'bundle-unavailable': 'error',
    'library-missing': 'warn',
    'libraries-missing': 'warn',
    divergence: 'warn',
    // The program's own words about why it is stopping. It is not our
    // failure, but it is never good news.
    'message-box': 'warn',
    'bundle-retry': 'warn',
    'bundle-prefetch-failed': 'warn',
    'bundle-unbacked': 'warn',
});

/**
 * An event whose own source writes the journal keeps a record per call while
 * the event itself fires once, so the bus must not write the first of those
 * calls a second time. `unimplemented` is the one: a program that calls a
 * missing import in a loop would otherwise fill the page's queue with a clone
 * and a wake-up per call.
 */
const SELF_JOURNALLED = new Set(['unimplemented']);

/**
 * Every event the run reports also goes to its journal, so that one ordered
 * stream carries the whole story. A consumer that subscribes to a name still
 * gets it exactly as before -- a watcher never answers, so it cannot take an
 * event away from a handler that would have.
 *
 * @param {{ onAny: (watcher: (name: string, payload: any) => void) => unknown }} events
 * @param {{ write: (level: string, category: string, template: string,
 *     ...args: any[]) => any }} into
 */
function journalEvents(events, into){
    events.onAny((/** @type {string} */ name, /** @type {any} */ payload)=>{
        if (SELF_JOURNALLED.has(name))
        {
            return;
        }
        into.write(SEVERITY[name] ?? 'info', name, '{0}', describeEvent(payload));
    });
}

/**
 * One machine, running one image.
 *
 * `createApp` below is what a caller reaches for; this is what it builds, once
 * per process. A child process is a second call to this against the child's
 * image, after the first has been disposed -- so everything here belongs to the
 * program it was built for, and nothing survives except what is passed back in.
 *
 * @param {AppOptions & {
 *     events?: any,
 *     seed?: { path: string, bytes?: Uint8Array, delete?: boolean }[],
 *     patches?: { address: number, bytes: Uint8Array }[],
 *     spawned?: (request: any) => void,
 *     logSinks?: Map<Function, (payload: any) => void>,
 *     system?: { namedObjects: Map<string, any>, registry: any, bundle: any, windows?: any,
 *         ids: { thread: number, process: number }, volume: any },
 *     mainThreadId?: number,
 *     beside?: (request: any) => void,
 *     terminate?: (request: any, code: number) => boolean,
 *     othersRunning?: () => boolean,
 *     com?: { table: any, process: unknown },
 * }} options
 * @returns {Promise<any>} an AppController
 */
async function buildApp(options){
    // Handed in across a replacement, so a caller's subscriptions outlive the
    // process they were made against: the program has changed, the machine it
    // is running in has not.
    const events = options.events ?? createEvents();
    // The presenter the run made. A machine is a process; the canvas, the
    // texture the primary is copied into and the pacer are not. This machine
    // hands the run's presenter to the graphics layer and draws through it, so
    // the last frame of the process it replaced stays on the canvas until this
    // one has something to show.
    const runPresenter = options.graphics?.presenter ?? null;

    // The address space above the program: the system modules first, then the
    // libraries a game brought with it, and the heap above all of them with
    // everything that is left.
    //
    // The heap is last because it is the part that has to be big. A game of
    // this era loads its textures, its models and its sound into ordinary
    // memory and expects hundreds of megabytes of it; a heap wedged between
    // the image and the modules can only ever be a few, and what a program
    // does when it runs out is not fail gracefully -- one real title writes a
    // crash report saying there was not enough memory and stops, tens of
    // millions of instructions after everything else had worked.
    //
    // The gap left for modules is generous for the same reason in reverse: a
    // library a game ships can itself be twelve megabytes, and a library
    // placed inside the heap would be overwritten by the first large
    // allocation.
    const mainImage = parsePe(options.executable);
    const { moduleBase: MODULE_BASE, stackPoolBase: STACK_POOL_START, heapBase: HEAP_BASE }
        = spaceAbove(mainImage.imageBase + mainImage.sizeOfImage);
    // Where a thread that is not the first gets its stack. Above the space
    // libraries are mapped into and below the heap, because a stack of the size
    // a program was linked for is a megabyte or more and the megabyte under the
    // image will not hold several of them.
    const STACK_POOL_WHOLE = 0x04000000;
    const mainStack = placeMainStack(mainImage.stackReserve, STACK_POOL_START, STACK_POOL_WHOLE);
    const STACK_POOL_BASE = mainStack.poolBase;
    const STACK_POOL_SIZE = mainStack.poolSize;
    // What each of them gets: what the image was linked to expect, floored so a
    // program that asks for almost nothing still has room to make a call, and
    // capped so that a program asking for an enormous stack cannot leave the
    // pool with room for only one thread.
    const threadStackSize = Math.min(stackReserveOf(mainImage.stackReserve),
        Math.floor(STACK_POOL_WHOLE / 16));
    const memorySize = options.memorySize ?? DEFAULT_MEMORY_SIZE;
    const HEAP_SIZE = heapSizeFor(memorySize, options.heapSize, HEAP_BASE);

    /**
     * The modules win32 implements, filled in below. win32 is built before they
     * exist -- it is what says which functions they export -- so it is handed
     * these lookups rather than the answers, and only ever calls them while the
     * guest is running.
     *
     * @type {Map<string, any>}
     */
    const byName = new Map();
    /** @type {Map<number, any>} */
    const byBase = new Map();
    /**
     * Libraries LoadLibraryEx loaded as data, by the handle it gave out: no
     * modules, so in neither table above.
     *
     * @type {Map<number, any>}
     */
    const dataFiles = new Map();
    /**
     * Every library whose DllMain has been told DLL_PROCESS_ATTACH, in the
     * order it was: ExitProcess tells them of the detach the other way round.
     *
     * @type {any[]}
     */
    const attachOrder = [];
    /** @type {any} */
    let mainModule = null;

    /**
     * Marks a module the process has loaded, with what it brings in, for
     * everything that answers only about loaded modules: GetModuleHandle and
     * PEB->Ldr. A module synthesised at the start is there to be bound to
     * whenever it is asked for, but it is loaded only once something imports
     * it or loads it.
     *
     * @param {any} module
     */
    const markLoaded = module=>{
        if (!module || module.loaded !== false)
        {
            return;
        }
        module.loaded = true;
        threadBlocks?.addModule(module);
        for (const imported of SYSTEM_IMPORTS[moduleKeyOf(module.name)] ?? [])
        {
            markLoaded(byName.get(imported) ?? null);
        }
    };

    /** @param {string | null} name */
    const findModule = name=>{
        if (name === null || name === '')
        {
            return mainModule;
        }
        return byName.get(moduleKeyOf(name)) ?? null;
    };

    // Where input goes when nobody names a window: the active one, and while
    // there is none -- a program whose window was never shown -- the one it
    // made last, which is the only other thing it could be looking at.
    let lastCreated = 0;
    const foreground = ()=>win32.activeWindow?.() || lastCreated;
    /** Whether a frame is open in the journal: the first present opens one, the rest close and reopen. */
    let framed = false;
    // Where the counters stood when the frame being measured began.
    let retiredAtFrameStart = 0;
    let interpretedAtFrameStart = 0;
    let writtenAtFrameStart = 0;
    let heapAtFrameStart = 0;
    /** The JS heap, where the runtime will say; a frame's growth is what the host allocated. */
    const heapUsed = ()=>{
        const performance = /** @type {any} */ (globalThis.performance);
        return performance?.memory?.usedJSHeapSize ?? 0;
    };

    // Filled in once the emulator is up and a bundle, if any, is mounted. win32
    // is built before that and is handed the lookup rather than the answer.
    /** @type {{ source: any, fetch: (needed: any[]) => Promise<void>, stop: () => void,
     *          ahead: () => number,
     *          refetched: () => { blocks: number, bytes: number },
     *          ranges: () => { requests: number, bytes: number },
     *          decoded?: () => { blocks: number, bytes: number, ms: number },
     *          registry: Promise<any> } | null} */
    let blocks = null;
    /**
     * Where a thread's environment block comes from, once the process has
     * one to hand out. Every thread needs its own: FS points at it, and a
     * thread without one reads its id, its stack bounds and its thread-local
     * slots from linear address zero and up.
     *
     * @type {{
     *     createThreadBlock: (thread: { id: number, stackBase: number,
     *         stackLimit: number }) => { teb: number, tls: number },
     *     addModule: (module: import('./layers/win32/kernel32/teb.js').LoadedModule) => number,
     *     removeModule: (base: number) => void,
     * } | null}
     */
    let threadBlocks = null;

    /** Range requests outstanding: what a parked guest thread is really on. */
    let fetching = 0;
    /**
     * Resolved when the last of them answers, so the loop can wait for the
     * thing itself rather than poll a timer until it happens.
     *
     * @type {Promise<void> | null}
     */
    let fetched = null;
    /** @type {() => void} */
    let arrived = ()=>{};

    /**
     * What the guest has waited on the network for, and how much of it twice.
     *
     * A block asked for a second time is one the cache had and let go, and
     * there is no other way to tell that apart from a program simply reading
     * more of its own archives -- both look like a run that spends its time
     * fetching. One is a bound to raise; the other is nothing to do with us.
     */
    const bundleReads = { requests: 0, blocks: 0, bytes: 0, again: 0, againBytes: 0 };
    /** @type {Set<number>} */
    const blocksSeen = new Set();

    // A call that is waiting -- a message loop with an empty queue -- is let go
    // once per scheduler turn to look again.
    /** @type {(() => void)[]} */
    let idlers = [];

    /**
     * What the program is told its display is. Mutable: a program that creates
     * its Direct3D device at a resolution other than the one the launch named
     * is telling the engine its screen is that resolution, one window full of
     * it. The reported metrics follow, so a cursor the game normalises by the
     * screen and draws in its own back buffer stays under the pointer.
     *
     * What does not follow is how large the display can be. A program reads
     * the modes on offer to build its resolution menu, and a list bounded by
     * the mode it is already in offers it nothing else: it created its device
     * at the size it last saved, and from then on that was the only size it
     * could see. So the display's own size travels beside the mode in effect,
     * set once from the launch and never moved.
     */
    const launched = options.screen ?? { width: 640, height: 480, bitsPerPixel: 32 };
    const display = { ...launched, displayWidth: launched.width, displayHeight: launched.height };

    /**
     * Divergences already reported, so each is said once.
     *
     * A layer notices a divergence where it happens, which for a graphics state
     * is every draw. Reported per call it would fill a frame's journal with one
     * repeated line and bury everything else; reported once it is a short list
     * of what this build does differently, which is what a reader wants.
     *
     * @type {Set<string>}
     */
    const divergences = new Set();

    /**
     * Says that a call succeeded but did not do all of what it promises.
     *
     * Not a failure: a program is entitled to make the call, and refusing it
     * changes what the program does -- usually by stopping it. But accepting a
     * state and not honouring it is the defect class that produces a picture
     * rather than an error, and the only thing separating it from correct
     * behaviour is somebody saying so.
     *
     * @param {string} api      Which surface diverged, as a program names it.
     * @param {string} detail   What was accepted and not acted on.
     */
    const reportDivergence = (api, detail)=>{
        const key = `${api}: ${detail}`;
        if (divergences.has(key))
        {
            return;
        }
        divergences.add(key);
        events.emit('divergence', { api, detail });
    };

    // A call site is made thousands of times in a run and its name never
    // changes, so the area string is built once per name rather than on
    // every call; the cache is this instance's own, not shared with another.
    /** @type {Map<string, string>} */
    const areaCache = new Map();
    const areaOfCall = (/** @type {any} */ call)=>areaOf(call, areaCache);
    /** @type {Map<string, { revision: number, area: string, on: boolean, seed: number }>} */
    const tracedCalls = new Map();
    /** Each thread's name as the journal writes it, made once. @type {WeakMap<object, string>} */
    const threadTags = new WeakMap();
    // Every process of a run names its first thread "main", so in the run's one
    // journal a later process's threads carry its image name as well.
    const callerImage = String(options.imagePath ?? '').split(/[\\/]/).pop() ?? '';
    const callerTag = options.log?.journal ? `${callerImage}:` : '';
    // The cursor the page shows: what the program last said of it -- user32's
    // count and SetCursor, or a device cursor; the last report wins -- hidden
    // while it holds the mouse exclusively through DirectInput, as Windows does.
    /** @type {any} */
    let programCursor = { shown: true };
    let mouseHeld = false;
    const showCursor = ()=>{
        const cursor = mouseHeld ? { ...programCursor, shown: false } : programCursor;
        core.api('input')?.cursorShown?.(cursor.shown !== false);
        events.emit('cursor', cursor);
    };
    /** @type {any} */
    let win32Api = null;

    /**
     * Writes one host call to the journal.
     *
     * Every one of them, which is why the categories start switched off: a
     * short run makes tens of thousands of calls, and a reader who has not
     * asked for them should pay a map lookup and a comparison rather than a
     * formatted line. Turning one on is what a filter does. Even that was a
     * tenth of a crossing, so the answer is kept per name until a level moves
     * (the journal's `revision`).
     *
     * @param {any} call
     */
    const journalCall = call=>{
        const revision = journal.revision();
        let traced = tracedCalls.get(call.name);
        if (traced === undefined || traced.revision !== revision)
        {
            const area = areaOfCall(call);
            traced = { revision, area, on: journal.enabled(area, journal.Level.TRACE),
                seed: hashText(FNV_OFFSET, call.name) };
            tracedCalls.set(call.name, traced);
        }
        const category = traced.area;
        if (!traced.on)
        {
            return;
        }
        // Named by the thread that made it. A program of this age runs a dozen
        // of them and the interleaving is the whole story: without this, a loop
        // that is one thread waiting and another working reads as a single
        // thread doing something incoherent, and a thread that has stopped
        // calling anything at all cannot be picked out from the noise of the
        // ones that have not.
        // An argument whose text was kept (traceStrings) is shown as that
        // text: a path is what a question about a failed open needs. Every
        // kept argument is written: a blit's source context is its sixth.
        const current = core.api('kernel').currentThread();
        let thread = current ? threadTags.get(current) : undefined;
        if (thread === undefined)
        {
            thread = callerTag + (current?.name ?? '?');
            if (current)
            {
                threadTags.set(current, thread);
            }
        }
        // A thread polling for something is a loop of the same few calls,
        // written twice and then counted (`call-repeats.js`): written each
        // time, it would push out of the ring the moment it began waiting.
        // The calls are told apart by a number made from the name, the
        // arguments and the answer -- a polling loop makes millions, and a
        // line of text made for each was most of what the journal cost.
        let key = traced.seed;
        const values = call.args ?? [];
        for (let at = 0; at < values.length; at++)
        {
            const text = call.strings?.[at];
            key = text ? hashText(key, String(text)) : hashWord(key, values[at] >>> 0);
        }
        key = typeof call.result === 'number' ? hashWord(key, call.result >>> 0)
            : hashText(key, String(call.result));
        const { write, said } = callRepeats.note(thread, key);
        if (said)
        {
            journal.write('trace', category, said.ended
                ? '[{0}] the {1} calls before went round again: {2} calls not written'
                : '[{0}] the last {1} calls still go round: {2} calls not written so far',
            thread, said.period, said.calls);
        }
        if (write)
        {
            // An argument whose text was kept (traceStrings) is shown as that
            // text: a path is what a question about a failed open needs.
            const args = values
                .map((/** @type {number} */ value, /** @type {number} */ at)=>(
                    call.strings?.[at] ? JSON.stringify(String(call.strings[at]).slice(0, 160))
                        : `0x${(value >>> 0).toString(16)}`))
                .join(', ');
            journal.write('trace', category, '[{3}] {0}({1}) = {2}', call.name, args, call.result,
                thread);
        }
    };
    const callRepeats = createCallRepeats();

    // The translator's cache goes with the bundle's blocks: local by default,
    // the bundle's name its namespace, resolved here in the engine's own
    // thread as the block store is. Held here as well, for the bundle's seed.
    const storeSpec = options.cork?.config?.store === undefined ? 'local'
        : options.cork.config.store;
    const translationStore = await resolveTranslationStore(storeSpec,
        options.bundle?.id ?? options.id ?? 'bundle');
    // Closed with this machine only when opened for it: a store handed in is
    // the run's, shared with the machines of the processes still running.
    const ownsTranslationStore = storeSpec === 'local';

    // What the volume's reader calls for blocks a read found absent, kept so a
    // reader outside win32 -- DirectMusic's loader -- can wait for them too.
    /** @type {((needed: any[]) => Promise<unknown>) | null} */
    let fetchBundleBlocks = null;

    const core = await assembleModules({
        kernel: {
            // How many guest instructions a thread runs before the next one
            // gets a turn. Lowering it is how a sampled profile gets enough
            // points to say anything; raising it costs nothing but resolution.
            quantum: options.quantum,
            // Off unless asked for: see the kernel's `preemption`.
            preemption: options.preemption,
            // Every thread gets the stack the image was linked to expect, the
            // way Windows does -- not a fixed small one. A program that recurses
            // in a worker thread, or builds a large structure on its stack,
            // sizes that against SizeOfStackReserve and has no reason to expect
            // less; measured on a real title, a worker was already using three
            // quarters of a sixty-four kilobyte stack.
            stacks: {
                base: STACK_POOL_BASE,
                size: threadStackSize,
                limit: STACK_POOL_BASE + STACK_POOL_SIZE,
            },
            // The run's thread and process ids, which every process numbers
            // its own from (`system`).
            ids: options.system?.ids,
            // A process across a link reaches the run's named objects there.
            remoteObjects: options.system?.objects ?? null,
        },
        cpu: {
            jit: options.jit, sampling: options.sampling, memorySize,
            reused: options.reusedMemory ?? undefined,
            initialStack: mainStack.initialStack,
            // ponytail: open, where Windows never maps the first 64 KiB, until
            // a store alone can fault there. Closed, FMOD's mixer thread reads
            // NULL+0x54 before its creator has set the pointer and faults; open,
            // PECompact2's deliberate store through NULL goes through instead of
            // reaching the handler it installed, so a packed setup cannot run.
            closedBelow: 0,
            // Nothing runs there all the same: a call through a null pointer
            // faults, as on Windows, rather than sliding through the zeroes.
            noExecuteBelow: 0x10000,
            engine: options.engine ?? DEFAULT_ENGINE,
            executors: options.executors ?? 1,
            engineUrl: (options.engine ?? DEFAULT_ENGINE) !== 'emulator'
                ? corkArtifacts(options.cork).moduleUrl : null,
            cork: {
                cacheVersion: SETTINGS.cork.cacheVersion,
                ...options.cork?.config,
                store: translationStore,
                bundleId: options.bundle?.id ?? options.id ?? 'bundle',
            },
        },
        bridge: {
            // win32 sits above the bridge and cannot be reached from it, so the
            // reader is handed down from here. It costs one call per traced
            // call and buys a trace that says which call left an error behind.
            // Looked up once: it is asked on every crossing.
            lastError: ()=>(win32Api ??= core.api('win32')).lastError(),
            // Where the reader above finds it for a thread with a block,
            // read there directly.
            lastErrorOffset: TEB.LAST_ERROR,
            // Costly and off unless asked for; see the dispatcher.
            traceStrings: options.traceStrings ?? false,
            callPhases: options.profileCalls ?? false,
            driveGuestCalls: options.driveGuestCalls ?? false,
            record: options.record ?? 0,
            onCall: (/** @type {any} */ call)=>{
                journalCall(call);
                if (options.onCall)
                {
                    // Every process of a run hands its calls to the one sink,
                    // and names its first thread "main": a call says whose
                    // image made it, beside the thread the bridge names.
                    call.image = callerImage;
                    options.onCall(call);
                }
            },
            // Which calls the sink above keeps: every one for a caller's own
            // sink, the traced ones otherwise. The bridge asks once for each
            // function and again when a level moves, and calls the sink for
            // those alone.
            wantsCall: (/** @type {string} */ name)=>options.onCall !== undefined
                || journal.enabled(areaOfCall({ name }), journal.Level.TRACE),
        },
        filesystem: {
            // The run's drives, as one Windows has one volume: a process after
            // the first stands on the first one's, its writes and all, rather
            // than on a copy of it.
            volume: options.system?.volume,
        },
        media: {
            // The decoder, handed down the same way the emulator's binary is:
            // this layer is one module over one wasm blob, and which blob is
            // the assembling caller's decision rather than something to fetch
            // from inside a worker. Absent, the layer comes up and says so.
            wasmBytes: options.media?.wasmBytes,
            // The decoder a machine that replaced this one already made, so
            // this process opens its cinematics over the same compiled module
            // and linear memory instead of compiling the binary again. Absent
            // on the first process, which makes its own.
            instance: options.media?.instance,
            // The hosted JPEG library reads a program's buffers and writes its
            // pictures; handed the same thunks the sound layer's provider gets.
            readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
                core.api('memory').readBytes(address, length),
            writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
                core.api('memory').writeBytes(address, bytes),
            allocate: (/** @type {number} */ bytes)=>core.api('win32').heap().allocate(bytes),
            warn: (/** @type {string} */ message)=>reportDivergence('ijl15', message),
        },
        log: {
            // Every call area starts switched off. A short run makes tens of
            // thousands of host calls; a reader who has not asked for them
            // should pay a map lookup and a comparison, not a formatted line.
            // A filter turning one on is what makes them appear.
            //
            // A caller may ask for some of them on from the first instruction,
            // and has to be able to: everything a program decides about a
            // device it decides while starting up, and a category switched on
            // once the engine exists is switched on after that has happened.
            categories: {
                'call.cpu': 'off', 'call.gpu': 'off', 'call.audio': 'off',
                'call.video': 'off', 'call.input': 'off', 'call.net': 'off',
                'call.com': 'off', 'call.hook': 'off',
                ...options.log?.categories,
            },
            // Likewise the ring: a run whose interesting part is its first
            // second needs it no bigger, and one that has to hold a whole
            // startup needs it much bigger.
            capacity: options.log?.capacity,
            // The record count above bounds how many entries the index holds;
            // this is the byte budget the entries themselves are packed into,
            // and a category logging strings on every host call (a call area,
            // every argument as hex) fills it far faster than `capacity`'s own
            // default assumes. Left at the layer's default for a caller that
            // never asks.
            bytes: options.log?.bytes,
            // A machine rebuilt on a child's image continues the sequence
            // numbering of the one it replaced, so a reader holding a cursor
            // from that journal keeps reading rather than falling behind a
            // block that started over.
            sequenceBase: options.log?.sequenceBase,
            // The run's journal, when this machine is one of its later processes.
            journal: options.log?.journal,
            // The guest's clock, for the same reason the sound buffers use it:
            // a phase timed against the host and a phase timed against the
            // guest cannot be added together, and the number this layer exists
            // to produce -- how much of a frame was ours -- is a sum.
            now: options.log?.now ?? (()=>core.api('kernel').clock.virtualTime()),
        },
        audio: {
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            divergence: reportDivergence,
            // The guest's clock, never the host's. A program that fills a sound
            // buffer reads how far playback has got and compares it with a time
            // it took from somewhere else; two clocks make it disagree with
            // itself about whether it is behind.
            now: ()=>core.api('kernel').clock.virtualTime(),
            allocate: (/** @type {number} */ bytes)=>core.api('win32').heap().allocate(bytes),
            // A guest buffer a handler fills on the program's behalf -- a
            // segment's bytes read out of its stream -- goes back to the same
            // heap it came from.
            free: (/** @type {number} */ address)=>core.api('win32').heap().free(address),
            // How DirectMusic's loader reads a wave a segment names. The
            // loader knows the file's name and not where the volume keeps it,
            // and the layer that answers for the volume is below audio, so
            // the reader is handed down as a thunk the same way the mixer is
            // handed to win32.
            readFile: async(/** @type {string} */ path)=>{
                /** @type {any} */
                let handle;
                try
                {
                    handle = core.api('filesystem').open(path, { create: false });
                }
                catch {
                    return null;
                }
                if (!handle)
                {
                    return null;
                }
                const filesystem = core.api('filesystem');
                try
                {
                    try
                    {
                        return filesystem.read(handle, filesystem.size(handle));
                    }
                    catch (e){
                        // A block of the bundle not fetched yet: fetched, then
                        // read once more, as the volume's own reader does.
                        const miss = /** @type {any} */ (e);
                        if (miss?.code !== 'BLOCK_MISS' || !fetchBundleBlocks)
                        {
                            throw miss;
                        }
                        await fetchBundleBlocks(miss.blocks);
                        filesystem.seek(handle, 0);
                        return filesystem.read(handle, filesystem.size(handle));
                    }
                }
                finally
                {
                    core.api('filesystem').close(handle);
                }
            },
            // Whether anything is reading the other end of the ring. Told from
            // outside because only the assembling caller knows whether it
            // opened a device, and it decides whether a program's play cursor
            // follows the sound or the clock.
            drained: options.audio?.drained ?? false,
            // The storage of the output an earlier machine made, so a process
            // replacement mixes into the same storage its reader already
            // holds instead of orphaning it on a buffer nothing reads. Absent
            // on the first process, which makes its own.
            memory: options.audio?.memory,
            // A process beside another on that storage rather than in its
            // place: the arena span it was lent, and nothing of the other's
            // closed.
            beside: options.audio?.beside,
            // Shared memory is what a worklet needs to read the far end at
            // all, so this is an environment question answered here rather
            // than guessed inside the mixer: without it (a page that is not
            // cross-origin isolated) only this thread can ever read the
            // output, and the engine mixer is the only backend built for that.
            shared: options.audio?.shared ?? (typeof SharedArrayBuffer === 'function'),
            // Whose call a sound provider is answering, read before it awaits
            // anything: a callback into the guest after an await has to name
            // the thread whose call it continues.
            currentThread: ()=>core.api('kernel').currentThread(),
            // An export's address, of a library the program ships or of one we
            // synthesised. A provider announces itself through the library
            // that loaded it, and hands that library its own entry points.
            /** @param {string} dll @param {string} name */
            resolveImport: (dll, name)=>resolveImport(dll, name, null),
            // Setting an event belongs to the kernel, which sits below this
            // layer and cannot be reached from it, so it is handed down the way
            // the wave notifier's is. A stale handle is the program's mistake
            // and not ours to fault on.
            signal: (/** @type {number} */ handle)=>{
                try
                {
                    const kernel = core.api('kernel');
                    kernel.setEvent(kernel.handles.resolve(handle, 'event'));
                }
                catch (e){
                    void e;
                }
            },
            sampleRate: options.audio?.sampleRate,
            // Whether the hosted MPEG provider is offered at all. Off, a
            // program runs the decoder it ships, which is the comparison a
            // measurement of the hosted one is made against.
            mp3: options.audio?.mp3 ?? true,
        },
        input: {
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            /** @param {boolean} held */
            mouseHeld: held=>{
                mouseHeld = held;
                showCursor();
            },
            divergence: reportDivergence,
            // The event SetEventNotification names, set when the device takes
            // input -- the kernel's, handed down as the sound layer's is.
            signal: (/** @type {number} */ handle)=>{
                try
                {
                    const kernel = core.api('kernel');
                    kernel.setEvent(kernel.handles.resolve(handle, 'event'));
                }
                catch (e){
                    void e;
                }
            },
            now: ()=>core.api('kernel').clock.virtualTime(),
            // Where a keystroke goes: the window win32 reports as foreground --
            // the active one, not merely the last made, which may be hidden or
            // a child -- because a person types into what they are looking at.
            foreground,
            // The cursor is confined to the display the program was told it
            // has: a program that reads a position outside its own screen
            // concludes the mouse left the window.
            bounds: display && (()=>({ width: display.width, height: display.height })),
            /**
             * One line per press, and nothing at all when nobody asked for it.
             *
             * A press used to leave no trace anywhere: `call.input` is the
             * program's own calls into USER32 and DINPUT, so it says what was
             * asked and never whether anything arrived. "Did the click get in,
             * and where did it land" was then unanswerable from a log, which is
             * the one question a dead button asks.
             *
             * Its own category so a reader can take this and nothing else, and
             * formatted behind the level check so a run nobody is watching pays
             * a comparison per press.
             *
             * @param {import('./layers/input/router.js').PressRecord} press
             */
            trace: press=>{
                if (!journal.enabled('input.press', journal.Level.TRACE))
                {
                    return;
                }
                journal.write('trace', 'input.press', '{0} {1} at={2} {3}',
                    press.button, press.down ? 'down' : 'up', `${press.x},${press.y}`,
                    `hwnd=0x${press.hwnd.toString(16)} msg=0x${press.message.toString(16)}`
                    + ` wParam=0x${press.wParam.toString(16)}`
                    + ` lParam=0x${press.lParam.toString(16)}`);
            },
        },
        graphics: {
            // The layer's own configuration fields, as the caller set them
            // (`compressedTextures` and whatever the layer adds); what this
            // build composes below -- the device, the presenter, the screen --
            // is the run's and wins over a caller's value of the same name.
            ...options.graphics,
            choice: options.graphicsApi,
            // Whose frames this machine's devices present: the run's screen
            // is composed of every process's picture by its windows.
            processId: options.processId ?? FIRST_PROCESS_ID,
            // The display's raster -- the vertical blank, the scan line --
            // runs on the guest's clock, which only this assembly can reach:
            // a program times its spin on the blank with its own timers.
            guestNow: ()=>core.api('kernel').clock.virtualTime(),
            // Where a COM interface goes when a program asks for one. Without
            // it the drawing entry points refuse rather than publishing into
            // nowhere, which is what a build with no bridge should do.
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            unpublishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').unpublishInterface(object, iid),
            // The device, with the frame boundary marked around what it
            // presents. The profiler has always been able to account per frame
            // and nothing ever told it where a frame ends, so every report said
            // it had seen none -- and "where did the frame go" could not be
            // asked at all, only "where did the run go".
            // How often a frame may reach the screen at most. A guest presents
            // whenever its own loop finishes, which can be far more often than
            // any display shows -- and every one of those costs a read of the
            // surface out of guest memory and an upload.
            maxFps: options.maxFps ?? SETTINGS.frame.maxFps,
            // The run's presenter, made once above every machine. The layer
            // draws through it without making one of its own, so a replacement
            // does not reconfigure the canvas or clear the last frame.
            presenter: runPresenter,
            device: options.device
                ? {
                    ...options.device,
                    // The profile the adapter is shown with (`seam/adapter.js`).
                    adapter: options.gpuProfile && options.gpuProfile !== 'host'
                        ? { ...options.device.adapter, profile: options.gpuProfile }
                        : options.device.adapter,
                    /** @param {any} frame */
                    presentTo: frame=>{
                        // A frame runs from one present to the next, so the
                        // first present has none to close. Closing one anyway
                        // is counted as an imbalance and was the one this
                        // engine reported on every run.
                        if (framed)
                        {
                            // What the frame retired, and how much of it the
                            // interpreter ran: a frame of ordinary slices that
                            // all ran slowly is a compiler that had thrown its
                            // code away, and nothing else in the frame says so.
                            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                            {
                                journal.note('instructions',
                                    cpu.instructionCount() - retiredAtFrameStart);
                                journal.note('interpreted',
                                    cpu.interpretedSteps() - interpretedAtFrameStart);
                                journal.note('hostWrittenBytes',
                                    cpu.hostWrittenBytes() - writtenAtFrameStart);
                                journal.note('heapDelta', heapUsed() - heapAtFrameStart);
                            }
                            // Run in every build: the frame's samplers feed the translator.
                            journal.endFrame();
                        }
                        // The run's presenter owns the canvas copy; a build
                        // with no presenter of its own -- a direct assembly,
                        // a test -- still has whatever the caller handed in.
                        if (runPresenter)
                        {
                            // A frame of the graphics worker says whose it is;
                            // one drawn here is this process's.
                            runPresenter.show(frame.source === undefined
                                ? { ...frame, source: options.processId ?? FIRST_PROCESS_ID }
                                : frame);
                        }
                        else
                        {
                            options.device.presentTo?.(frame);
                        }
                        journal.beginFrame();
                        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                        {
                            retiredAtFrameStart = cpu.instructionCount();
                            interpretedAtFrameStart = cpu.interpretedSteps();
                            writtenAtFrameStart = cpu.hostWrittenBytes();
                            heapAtFrameStart = heapUsed();
                        }
                        framed = true;
                    },
                }
                : null,
            screen: display,
            // A program that creates its device at a resolution names its screen:
            // one window is that resolution. The reported metrics follow it.
            /**
             * @param {number} width @param {number} height
             * @param {{ window?: number, fullscreen?: boolean, announce?: boolean }} [where]
             */
            resolution: (width, height, where = {})=>{
                if (width > 0 && height > 0)
                {
                    display.width = width;
                    display.height = height;
                    // A fullscreen device takes the window it presents into
                    // with it, as the real one does: placed at the origin, the
                    // mode's size, and told so. A window left at its old size
                    // has the program clipping its cursor to a corner of the
                    // picture -- the picture fills the mode, the window does not.
                    if (where.fullscreen && where.window)
                    {
                        win32.placeWindow(where.window, 0, 0, width, height,
                            { announce: where.announce === true });
                    }
                }
            },
            // Where a locked surface or vertex buffer's bytes live. A lock
            // hands the program an address it writes through and the unlock
            // reads those bytes back, so it has to be memory the guest can
            // reach -- an address invented for the purpose is one the program
            // writes into nothing and we read nothing out of.
            allocate: (/** @type {number} */ bytes)=>win32.heap().allocate(bytes),
            // The guest code the seams write, on pages nothing else is handed.
            // None of it waits, and some of it writes records other threads'
            // entries into the host read, so no slice ends inside it.
            allocateCode: (/** @type {number} */ bytes)=>{
                const at = win32.heap().allocateCode(bytes);
                if (at !== 0)
                {
                    core.api('kernel').atomicCode(at, bytes);
                }
                return at;
            },
            // What wglGetProcAddress answers for a name OPENGL32 exports
            // itself: the export's own address, the one an import bound to.
            /** @param {string} name */
            exportAddress: name=>findModule('OPENGL32.dll')?.addressOf(name) ?? 0,
            // And back again when the last reference to a resource goes. The
            // arena is the same one the program's own allocator draws from, and
            // GlobalMemoryStatus reports what is left of it -- so a texture
            // whose pixels are never given back does not only cost address
            // space, it tells the program it is running out of memory.
            free: (/** @type {number} */ address)=>win32.heap().free(address),
            // Where "this call succeeded and did not do all of what it
            // promises" goes. Every drawing API has states it accepts and does
            // not honour yet, and a state accepted in silence is the defect
            // class that produces a picture rather than an error.
            divergence: reportDivergence,
            // A window's client area, which is the size a device's back buffer
            // takes when the program asks for zero by zero. Only the window
            // layer can measure one, and a device answered with the whole
            // display instead lays out and rasterises against a screen its
            // window does not have.
            windowClientSize: (/** @type {number} */ hwnd)=>{
                const rect = win32.clientRect(hwnd);
                return rect ? {
                    width: rect.right - rect.left,
                    height: rect.bottom - rect.top,
                } : null;
            },
            // The cursor a program asks its device to draw. Nothing here
            // composites one over the frame; the host is told, with the
            // bitmap and the hot spot, and shows it the way its screen can.
            /** @param {any} cursor */
            cursor: cursor=>{
                programCursor = cursor;
                showCursor();
            },
        },
        win32: {
            // The Windows the machine is, and what the program says it knows,
            // which is all Windows 10 needs to decide what to tell it.
            windows: options.windows,
            directx: options.graphicsApi
                ? GRAPHICS_CHOICES[options.graphicsApi].directx ?? undefined : undefined,
            compatibility: compatibilityOf(options.executable),
            // The speed the registry reports: the rate the engine's rdtsc
            // advances at. The emulator's counter keeps the default.
            processorMhz: (options.engine ?? DEFAULT_ENGINE) === 'cork' ? CORK_TSC_MHZ : undefined,
            processorName: (options.engine ?? DEFAULT_ENGINE) === 'cork'
                ? processorName(SETTINGS) : undefined,
            performanceFrequency: SETTINGS.qpc.frequency,
            // What every process of the run shares, as one Windows does: the
            // namespace a named mutex, event, semaphore, timer and file
            // mapping are found in, and the registry. Carried in from outside
            // this build, so a name a parent registered is one a child still
            // finds and a key it wrote is one the child reads -- a
            // replacement rebuilds this layer, and neither was ever this
            // process's to keep.
            system: options.system,
            processId: options.processId,
            standardFiles: options.standardFiles,
            // The run's table of class objects served out of process, and this
            // process's name in it: shared for the same reason.
            com: options.com,
            // The network beyond this runtime, when the embedder supplied one.
            network: options.win32?.network,
            unattended: Boolean(options.unattended),
            answer: typeof options.unattended === 'object' ? options.unattended.answer : undefined,
            // The roots WinVerifyTrust judges a signature's chain against;
            // absent, the win32 layer's default store.
            trustedRoots: options.win32?.trustedRoots,
            // What the program is told its display is, handed to the libraries
            // that answer for one as well as to the layer that draws on it.
            screen: display,
            desktop: options.desktop,
            // The cursor the program asks the page to show, from user32's own
            // state -- ShowCursor's count and a null SetCursor -- the same event
            // the Direct3D device methods emit above. Two producers, one
            // consumer, and the last report wins.
            /** @param {any} cursor */
            reportCursor: cursor=>{
                programCursor = cursor;
                showCursor();
            },
            // Sound leaves through the audio layer's mixer, and win32 sits
            // below it. Handed down as a thunk and asked for only when a
            // program opens a device: audio is created after win32, and a build
            // with nothing draining the ring answers null, which is what keeps
            // the wave cursor on the clock rather than stalling it against a
            // device nobody is listening to.
            output: ()=>{
                const audio = core.api('audio');
                return audio?.available?.() ? audio.output() : null;
            },
            // Where the pointer is and what is held down, for the calls that
            // ask rather than wait for a message. Handed down for the same
            // reason as the mixer: input is above win32 and cannot be reached
            // from it, and it does not exist yet when this is read.
            // The pixel-format negotiation and the end of an OpenGL frame,
            // whose entry points GDI32 exports but whose answers belong to the
            // graphics layer above. Every call goes through a thunk for the
            // reason the mixer does: graphics is created after win32.
            graphics: {
                pixelFormat: {
                    size: ()=>core.api('graphics').opengl().pixelFormat.size(),
                    count: ()=>core.api('graphics').opengl().pixelFormat.count(),
                    /** @param {Uint8Array} bytes */
                    choose: bytes=>core.api('graphics').opengl().pixelFormat.choose(bytes),
                    /** @param {number} index @param {number} bytes */
                    describe: (index, bytes)=>
                        core.api('graphics').opengl().pixelFormat.describe(index, bytes),
                    /** @param {number} hdc @param {number} index */
                    set: (hdc, index)=>core.api('graphics').opengl().pixelFormat.set(hdc, index),
                    /** @param {number} hdc */
                    get: hdc=>core.api('graphics').opengl().pixelFormat.get(hdc),
                },
                /** @param {number} hdc */
                swapBuffers: hdc=>core.api('graphics').opengl().swapBuffers(hdc),
                // GDI's drawing, and the pixels a context over a bitmap in
                // guest memory draws into. Every draw a program makes through
                // a device context lands here or fails.
                /** @param {{ objects: any, metrics: (font: number) => any }} drawing */
                createDrawing: drawing=>core.api('graphics').gdiDrawing().create(drawing),
                /** @param {any} dc @param {any} bitmap */
                surfaceFor: (dc, bitmap)=>core.api('graphics').gdiDrawing().surfaceFor(dc, bitmap),
                // The font engine's measurements, so what a program lays out
                // against is what the same engine draws.
                /** @param {import('./layers/win32/gdi32/structs.js').LogFontFields} font */
                fontMetrics: font=>core.api('graphics').gdiDrawing().fontMetrics(font),
                /**
                 * @param {number} code
                 * @param {import('./layers/win32/gdi32/structs.js').LogFontFields} font
                 */
                glyph: (code, font)=>core.api('graphics').gdiDrawing().glyph(code, font),
                /**
                 * @param {import('./layers/win32/gdi32/structs.js').LogFontFields} font
                 * @param {string} text
                 */
                textWidth: (font, text)=>core.api('graphics').gdiDrawing().textWidth(font, text),
                /** A program's own font, AddFontMemResourceEx's. @param {string} family @param {Uint8Array} bytes */
                addFont: (family, bytes)=>core.api('graphics').gdiDrawing().addFont(family, bytes),
                // The desktop every window context draws into, shown after
                // a paint pass. The window manager decides when a pass is
                // over; the graphics layer owns the surface and the screen.
                presentDesktop: ()=>core.api('graphics').gdiDrawing().presentDesktop(),
                // The display's gamma ramp, which the presenter shows every
                // frame through, whichever API set it last.
                /** @param {any} ramp */
                setGammaRamp: ramp=>core.api('graphics').gdiDrawing().setDisplayGamma(ramp),
                gammaRamp: ()=>core.api('graphics').gdiDrawing().displayGamma(),
                appliesGamma: ()=>core.api('graphics').gdiDrawing().appliesGamma(),
            },
            // What a filter graph plays. Handed down rather than reached for:
            // win32 sits below the media layer and may not import it, and the
            // file the graph is asked for is read through the same volume every
            // other file goes through -- which for a bundle means waiting for
            // blocks, so this answers with a promise and the graph's own
            // RenderFile parks the calling thread on it.
            video: {
                /** @param {string} path */
                open: async path=>{
                    const media = core.api('media');
                    if (!media?.available?.())
                    {
                        return null;
                    }
                    try
                    {
                        const bytes = await readWholeFile(filesystem, blocks, path);
                        return await media.open(bytes);
                    }
                    catch (e){
                        // A film that cannot be read or cannot be decoded is an
                        // ordinary state of a machine -- a codec nobody
                        // installed -- and the graph already answers for it.
                        events.emit('debug', { text: `video: ${path} could not be opened: ${
                            e instanceof Error ? e.message : String(e)}` });
                        return null;
                    }
                },
            },
            cursor: ()=>core.api('input')?.cursor?.() ?? { x: 0, y: 0 },
            // The cursor space a program declares with ClipCursor: the input
            // layer scales pointer motion into it, so a menu built for a smaller
            // logical screen than the backbuffer tracks the pointer exactly.
            /** @param {{ left: number, top: number, right: number, bottom: number } | null} rect */
            clipCursor: rect=>core.api('input')?.clip?.(rect),
            /** @param {number} x @param {number} y */
            placeCursor: (x, y)=>core.api('input')?.place?.(x, y),
            // What SendInput puts into the stream goes into the input layer's
            // router, the same place a real event from the page goes: a move
            // becomes a message and a DirectInput delta both, or neither.
            /** @param {any} event */
            sendInput: event=>core.api('input')?.send?.(event),
            /** @param {number} key */
            keyState: key=>core.api('input')?.keyState?.(key) ?? 0,
            /** @param {number} key */
            asyncKeyState: key=>core.api('input')?.asyncKeyState?.(key) ?? 0,
            // The whole keyboard, as GetKeyboardState fills its caller's array
            // and SetKeyboardState writes back: the same state GetKeyState
            // reads one key at a time, so the two can never disagree.
            keyboardState: ()=>core.api('input')?.keyboardState?.() ?? null,
            /** @param {Uint8Array} bytes */
            setKeyboardState: bytes=>core.api('input')?.setKeyboardState?.(bytes),
            // The same reporter the graphics layer gets: a Win32 function that
            // accepts a flag it does not act on owes the reader the same
            // warning as a Direct3D state that is stored and unused.
            divergence: reportDivergence,
            // Each shader the program compiled, its source beside what came
            // out, for a tool that asks: a picture wrong in a shader is read
            // there and nowhere else.
            shaderCompiled: (/** @type {any} */ record)=>events.emit('shader-compiled', record),
            // Text a program copied, for the page to put on the browser's
            // clipboard: the copy button of an error console is useless if
            // what it copied cannot leave the engine.
            /** @param {string} text */
            onClipboard: text=>events.emit('clipboard', { text }),
            // An address the program asked the shell to open -- a setup's
            // "visit our site", a readme's link -- for the page to open, as
            // XP's browser would. Taken whether or not anyone opens it: the
            // machine reports a browser installed, and its ShellExecute
            // answers success.
            /** @param {string} url */
            openUrl: url=>{
                events.emit('open-url', { url });
                return true;
            },
            /** @param {number} handle @param {string} text */
            onOutput: (handle, text)=>events.emit('output', { handle, text }),
            /** @param {string} text */
            onTrace: text=>events.emit('debug', { text }),
            registers: {
                /** @param {string} name */
                read: name=>core.api('cpu').readReg32(name),
                /** @param {string} name @param {number} value */
                write: (name, value)=>core.api('cpu').writeReg32(name, value),
            },
            // A C runtime returns a double on the floating-point stack, not in
            // a register, so the functions that do are exported only when this
            // is here to leave one there.
            fpu: {
                /** @param {number} value */
                setResult: value=>core.api('cpu').fpu.setResult(value),
                /** @param {number} index */
                get: index=>core.api('cpu').fpu.get(index),
                pop: ()=>core.api('cpu').fpu.pop(),
            },
            arena: { base: HEAP_BASE, size: HEAP_SIZE },
            modules: {
                /**
                 * A module the process has loaded: one synthesised but not yet
                 * imported or loaded is not there to be asked about.
                 *
                 * @param {string | null} name
                 */
                find: name=>{
                    const module = findModule(name);
                    return module?.loaded === false ? null : module;
                },
                /** @param {number} base */
                byBase: base=>byBase.get(base >>> 0) ?? null,
                /** Every module the process has loaded, in the order it loaded them. */
                list: ()=>[...byBase.values()].filter(module=>module.loaded !== false),
                /**
                 * The module an address lies in, or null: what a program asks
                 * GetModuleHandleEx of an address in its own code.
                 *
                 * @param {number} address
                 */
                containing: address=>{
                    const at = address >>> 0;
                    for (const module of byBase.values())
                    {
                        if (at >= module.base && at < module.base + (module.size ?? 0))
                        {
                            return module;
                        }
                    }
                    return null;
                },
                imagePath: ()=>options.imagePath ?? 'C:\\app.exe',
                /** @param {string} name */
                /** @param {string} name @param {number} [flags] */
                load: (name, flags)=>loadLibraryAtRuntime(name, flags),
                /** @param {number} handle */
                dataFile: handle=>dataFiles.get(handle >>> 0) ?? null,
                /** The libraries still attached, the last attached first. */
                attachedLibraries: ()=>attachOrder
                    .filter(held=>held.loaded !== false && held.attached !== false)
                    .reverse()
                    .map(held=>({ name: held.name, base: held.base, entryPoint: held.entryPoint })),
                /** @param {any} asked */
                resolved: asked=>events.emit('resolved', asked),
                ...resourceLookup(()=>mainModule, byBase, dataFiles,
                    (address, length)=>core.api('memory').readBytes(address, length)),
                /**
                 * The version resource of a file on the volume, by path: what
                 * an installer compares before it replaces a shared component.
                 *
                 * @param {string} path
                 */
                versionInfo: path=>versionResourceOf(filesystem, path, blocks),
                /**
                 * Whether a library is one this build synthesises, which has
                 * a version though no file.
                 *
                 * @param {string} name
                 */
                systemLibrary: name=>systemLibraries.has(moduleKeyOf(name)),
            },
            commandLine: options.commandLine,
            // Every child a program asks for, while the stack that asked is
            // still standing. Kept by the caller above this, because honouring
            // one of these tears the machine down and takes the logs with it.
            /** @param {any} request */
            spawned: request=>{
                events.emit('process-create', {
                    image: request.imagePath,
                    commandLine: request.commandLine,
                    suspended: request.suspended,
                });
                options.spawned?.({
                    imagePath: request.imagePath,
                    commandLine: request.commandLine,
                    suspended: request.suspended,
                    trace: formatTrace(captureTrace({ cpu, memory, kernel, bridge })),
                });
            },
            // A child running beside this process, ended where it runs.
            terminate: (/** @type {any} */ request, /** @type {number} */ code)=>
                options.terminate?.(request, code) ?? false,
            /** @param {any} thread */
            threadBlock: thread=>{
                const block = threadBlocks?.createThreadBlock({
                    id: thread.id, stackBase: thread.stackTop, stackLimit: thread.stackLimit,
                });
                if (block)
                {
                    thread.tebAddress = block.teb;
                }
            },
            idle: ()=>new Promise(resolve=>idlers.push(()=>resolve(undefined))),
            /** @param {any[]} needed */
            /** @param {any[]} needed */
            fetchBlocks: fetchBundleBlocks = needed=>{
                if (!blocks)
                {
                    return Promise.resolve();
                }
                // Counted, because from the run loop every parked thread looks
                // the same and they are not: a thread waiting on a range
                // request is waiting on the network, and a thread waiting on
                // its own message queue is waiting on nothing at all. Told
                // apart, one of them is a number to reduce and the other is a
                // loop to stop taking so seriously.
                bundleReads.requests++;
                for (const block of needed)
                {
                    bundleReads.blocks++;
                    bundleReads.bytes += block.packed;
                    if (blocksSeen.has(block.index))
                    {
                        bundleReads.again++;
                        bundleReads.againBytes += block.packed;
                    }
                    else
                    {
                        blocksSeen.add(block.index);
                    }
                }
                fetching++;
                if (fetching === 1)
                {
                    // The loop is about to have nothing to do until this
                    // answers, and it can be told exactly when that is. Without
                    // it the only way to find out was to sleep and look again,
                    // on a timeout a browser clamps to a millisecond -- which
                    // measured out at nineteen wake-ups per range request and a
                    // fifth of a whole run spent asking.
                    fetched = new Promise(resolve=>{
                        arrived = resolve;
                    });
                }
                return blocks.fetch(needed).finally(()=>{
                    fetching--;
                    if (fetching === 0)
                    {
                        const open = arrived;
                        fetched = null;
                        arrived = ()=>{};
                        open();
                    }
                });
            },
            /** @param {number} hwnd */
            created: hwnd=>{
                lastCreated = hwnd;
            },
        },
    });

    // The hosted MPEG provider decodes through the media layer's binary and
    // asks for it synchronously, so the binary has to be up before the first
    // stream opens -- seconds after a program starts, and inside the
    // compilation burst that starts it. Compiled now, off the thread, rather
    // than found missing then; a build with no binary has nothing to prepare.
    if ((options.audio?.mp3 ?? true) && core.api('media').available())
    {
        core.api('media').prepare().catch(()=>{
            // Reported by the layer's own diagnostics; the provider falls back.
        });
    }

    const filesystem = core.api('filesystem');
    const registryInherited = core.api('win32').registryInherited?.() ?? false;
    const { seeded, saver, stopSavingRegistry } = await openSession({ options, events, filesystem,
        registry: core.api('win32').registry(), inherited: registryInherited,
        standing: filesystem.inherited?.() ?? false });

    const journal = core.api('log');
    // The run's processes share one event bus and one journal, so only the
    // machine that made the journal writes the bus into it, and straight into
    // the journal rather than through its own view: that view closes with the
    // machine, and a process that replaced it still fires events.
    if (!options.log?.journal)
    {
        journalEvents(events, journal.journal?.() ?? journal);
    }

    const cpu = core.api('cpu');
    /** The workers of the run's translation pool lent to this machine, by the pool's token.
     * @type {Map<number, import('./layers/cpu/engine.js').TranslatorPort>} */
    const lentTranslators = new Map();
    const memory = core.api('memory');
    const kernel = core.api('kernel');
    const loader = core.api('loader');
    const win32 = core.api('win32');
    const bridge = core.api('bridge');
    const graphics = core.api('graphics');
    const audio = core.api('audio');
    const input = core.api('input');

    // Cork runs with nothing of the emulator loaded: its own host, its own
    // memory, and the translator named by `engineUrl`.
    await cpu.boot(emulatorOf(options) ?? undefined);

    // A processor exception goes to the handlers the program registered
    // before it stops the machine. The thread waits the way a host call does
    // while they run; if none of them takes it, the machine stops on the
    // fault exactly as it would have without being asked.
    cpu.onFault((/** @type {any} */ fault)=>{
        const thread = kernel.currentThread();
        const answer = thread ? win32.dispatchFault(fault) : null;
        if (!answer)
        {
            return false;
        }
        bridge.holdForFault(thread, {
            name: `<${fault.name}>`,
            restingStack: fault.stack ?? 0,
            hostReturn: fault.eip,
        }, answer.then((/** @type {any} */ where)=>{
            if (where)
            {
                return where;
            }
            cpu.stopWithFault(fault);
            return new Promise(()=>{});
        }));
        return true;
    });

    // Mounted after the machine is up. A zstd block is decoded by this
    // project's own decoder now, so the mount no longer needs the emulator.
    // The bundle is the run's: the first process opens it -- its index, its
    // block cache, the background fill -- and every process after it mounts
    // the same one, rather than each reading the index again and filling a
    // second cache from the network beside the first.
    blocks = options.system?.bundle
        ?? await mountBundle({ options, cpu, events, translationStore });
    if (options.system && blocks)
    {
        options.system.bundle = blocks;
    }
    // A process that stands on the run's drives finds the bundle under C:
    // already, and its discs, the session and the files the page laid over
    // it; mounting or applying any of them again would put older bytes over
    // what the processes before it wrote.
    if (!(filesystem.inherited?.() ?? false))
    {
        await furnishVolume({ options, events, filesystem, blocks, seeded,
            registry: registryInherited ? null : core.api('win32').registry() });
    }
    // And what the process this one replaces had written. A self-extracting
    // installer unpacks its payload and then starts it; without this the
    // payload goes with the machine that wrote it and the child is started
    // against files that are no longer there.
    if (options.seed && options.seed.length > 0)
    {
        filesystem.apply(options.seed);
    }

    // A program starts in its own directory. One loaded from bytes alone, with
    // nothing at its path on the volume, starts at the root as before.
    try
    {
        filesystem.setCurrentDirectory(options.startDirectory
            ?? startDirectoryOf(options.imagePath ?? 'C:\\app.exe'));
    }
    catch (e){
        void e;
    }

    const { entryVector, initialStack, thunkBase } = cpu.layout;

    // The first thread gets the stack its own image asked the linker for.
    //
    // A fixed default is a guess, and the guess is wrong for anything but a
    // trivial program: a C runtime starting up inside a library the program
    // ships will walk past sixty-four kilobytes on its way to `main`. What
    // that produces is not a stack-overflow exception -- it is a read below
    // the mapped stack, reported at whichever call happened to be crossing
    // the boundary, with nothing pointing at the code that wanted the space.
    //
    // Clamped to what actually fits under the initial stack pointer, because
    // the region below it is finite and a request larger than the room is a
    // layout question rather than something to honour silently.
    const stackRoom = initialStack - (mainStack.initialStack === undefined
        ? thunkBase + cpu.layout.thunkCapacity : STACK_POOL_START);
    const stackSize = options.stackSize
        ?? Math.min(stackReserveOf(parsePe(options.executable).stackReserve), stackRoom);

    memory.register({
        name: 'entry-vector', base: entryVector, size: 4,
        kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE,
    });
    memory.register({
        name: 'stack', base: initialStack - stackSize, size: stackSize,
        kind: memory.RegionKind.STACK, access: memory.Access.READ_WRITE,
    });
    memory.register({
        name: 'heap', base: HEAP_BASE, size: HEAP_SIZE,
        kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE,
    });
    // Our own boot ROM, so that a report can name it. A fault leaves the
    // processor standing in the stub behind its vector, and until this was here
    // that address came back as unmapped -- which sent every reader of a crash
    // looking for a guest bug at an address belonging to the engine. Cork has
    // no ROM and so registers none.
    if (cpu.layout.romSize > 0)
    {
        memory.register({
            name: 'boot-rom', base: cpu.layout.romBase, size: cpu.layout.romSize,
            kind: memory.RegionKind.LOW_MEM, access: memory.Access.READ_EXECUTE,
        });
    }

    // Every system module exists in guest memory before the program's first
    // instruction, not when something first asks for it. An address taken early
    // has to be the address that works later (§13.3), and a module conjured on
    // demand cannot promise that.
    const ordinalsOf = {
        ...(win32.ordinals ? win32.ordinals() : {}),
        ...(audio.ordinals?.() ?? {}),
        ...(input.ordinals?.() ?? {}),
        ...(core.api('media').ordinals?.() ?? {}),
    };
    // The drawing APIs are libraries like any other as far as a program is
    // concerned: it imports Direct3DCreate8 exactly as it imports CreateFileA,
    // and nothing about how they are reached should differ.
    const allLibraries = {
        ...win32.libraries(),
        ...graphics.libraries?.() ?? {},
        ...audio.libraries?.() ?? {},
        ...input.libraries?.() ?? {},
        ...core.api('media').libraries?.() ?? {},
    };
    /**
     * The names answered from this engine's table even beside a file the
     * program brought: the KnownDLLs, and the redistributable runtimes the
     * layers stand in for (`answeredByEngine`).
     *
     * Everything else this engine provides -- `d3dx9_*`, `d3d9`, `ddraw`,
     * `dinput8`, `comctl32`, `version` -- is put aside when the program brought
     * its own file of that name, because that file is what a real loader maps.
     * Both the import walk and the run-time LoadLibrary path ask this question,
     * so they cannot disagree about which of the two wins.
     */
    const isKnownDll = answeredByEngine(
        /** @type {() => string[]} */ (win32.knownDlls)?.() ?? [],
        [
            ...(/** @type {() => string[]} */ (audio.runtimes)?.() ?? []),
            ...(/** @type {() => string[]} */ (core.api('media').runtimes)?.() ?? []),
        ]);
    /**
     * An export that is code of its own, with the traps it jumps to registered
     * and the jumps to them for the loader to fill in.
     *
     * @param {any} fn @param {string} qualified  `DLL!Name`.
     */
    const codeExport = (fn, qualified)=>{
        /** @type {{ at: number, target: number }[]} */
        const jumps = [];
        const code = fn.code({
            /** @param {any} trap */
            register: trap=>bridge.register(qualified, trap),
            /** @param {number} at @param {number} target */
            jump: (at, target)=>void jumps.push({ at, target }),
        });
        return { code, jumps };
    };
    // Each system module where the one before it ends, at the granularity
    // every image is placed at: the window they share is the room left for
    // the libraries a program brings, and a module is a few pages -- a
    // megabyte apart, sixty of them left a third of the window to those.
    let systemModulesEnd = MODULE_BASE;
    Object.entries(allLibraries).forEach(([name, table])=>{
        // A library imported by number has to be synthesised with the numbers
        // the program compiled against; one we assigned ourselves would bind to
        // a different function, silently.
        /** @type {Record<number, string>} */
        const byOrdinal = ordinalsOf[name] ?? {};
        const declared = new Map(Object.entries(byOrdinal)
            .map(([ordinal, exported])=>[exported, Number(ordinal)]));

        const exports = Object.entries(table).map(([exported, fn])=>({
            name: exported,
            ordinal: declared.get(exported),
            // An export is a function that is code of its own, a variable the
            // program reads through its address, a trap into the host, or
            // guest code that decides for itself when to trap: the builder
            // hands such an entry the means to register the traps it falls
            // back to. Code of its own that hands a call to the host jumps to
            // a trap answering as the export, and named as it; the jump's
            // displacement is the loader's, which places the code.
            // A variable may hold other exports' addresses: a vtable's slots.
            ...fn.code ? codeExport(fn, `${name}!${exported}`) : fn.data ? {
                data: fn.data(), pointers: fn.pointers, entry: fn.entry,
            } : {
                target: fn.guest
                    ? fn.guest({
                        /** @param {string} label @param {any} trap */
                        register: (label, trap)=>bridge.register(label, trap),
                    })
                    : bridge.register(`${name}!${exported}`, fn),
            },
        }));

        const base = systemModulesEnd;
        // A table with a DllMain is a module with an entry point, run when a
        // program first loads it -- which is how a library the program did not
        // import announces itself to the one that asked for it.
        const placed = loader.synthesise({
            name, base, exports, entryPoint: 'DllMain' in table ? 'DllMain' : undefined,
        });
        systemModulesEnd = base + Math.ceil(placed.size / LIBRARY_ALIGN) * LIBRARY_ALIGN;

        // An export's address is its trampoline inside the module, and that is
        // what both the import table and GetProcAddress hand out -- so a program
        // comparing the two finds them equal, as it does on Windows.
        const addresses = new Map(exports.map(entry=>[entry.name, placed.addressOf(entry.name)]));
        const ordinals = new Map([...addresses]
            .map(([exported, address])=>[placed.ordinalOf(exported), address]));
        for (const [exported, address] of addresses)
        {
            bridge.label(Number(address), `${name}!${exported}`);
        }
        // An export whose code writes what another thread's entry into the
        // host reads, and never waits, runs unbroken (the kernel's atomicCode).
        for (const entry of exports)
        {
            if (table[entry.name]?.unbroken && 'code' in entry)
            {
                core.api('kernel').atomicCode(Number(addresses.get(entry.name)), entry.code.length);
            }
        }

        const record = {
            name,
            base,
            size: placed.size,
            /** @param {string} exported */
            addressOf: exported=>addresses.get(exported) ?? null,
            /** @param {number} ordinal */
            addressOfOrdinal: ordinal=>ordinals.get(ordinal) ?? null,
            entryPoint: placed.entryPoint,
            // Not until a program asks for it: a synthesised module exists
            // from the first instruction, but its entry point is a promise
            // to whoever loads it, and runs on that caller's thread.
            attached: false,
            loaded: false,
            /** @returns {number | Promise<number>} */
            release: ()=>releaseLibrary(record),
        };
        byName.set(moduleKeyOf(name), record);
        byBase.set(base, record);
    });
    for (const name of ALWAYS_LOADED)
    {
        markLoaded(byName.get(name) ?? null);
        const always = byName.get(name);
        if (always)
        {
            always.pinned = true;
        }
    }

    /**
     * An import's address, wherever the library that provides it came from.
     *
     * By ordinal as well as by name, because a library may be imported either
     * way and some are imported only by number -- a descriptor that gives an
     * ordinal and no name is not exotic, it is how a whole class of libraries
     * has always been linked against.
     *
     * @param {string} dll
     * @param {string | null} name
     * @param {number | null} ordinal
     */
    const resolveImport = (dll, name, ordinal)=>{
        const module = findModule(dll);
        if (!module)
        {
            return null;
        }
        markLoaded(module);
        module.pinned = true;
        const address = name !== null
            ? module.addressOf(name)
            : ordinal === null ? null : module.addressOfOrdinal(ordinal);
        return address === null ? null : watched(dll, name, ordinal, address);
    };

    /**
     * Which imports to stand in front of, and what each one's arguments are.
     * One stub per import, kept because a library is imported by many others
     * and a second stub for the same function would report the same call twice.
     *
     * @type {Map<string, number>}
     */
    const watches = new Map();

    /**
     * Puts a watch in front of an import when the caller asked for one.
     *
     * Only a guest module's exports are worth watching: a call into one of our
     * own is already a trap and already recorded, and pointing a watch at a
     * stub would trap twice for one call.
     *
     * @param {string} dll @param {string | null} name
     * @param {number | null} ordinal @param {number} address
     * @returns {number}
     */
    const watched = (dll, name, ordinal, address)=>{
        if (!options.watchImport)
        {
            return address;
        }
        const asked = options.watchImport(dll, name, ordinal);
        if (!asked)
        {
            return address;
        }
        return installWatch(`${dll}!${name ?? `#${ordinal}`}`, asked.args * 4, address,
            asked.strings ?? []);
    };

    /**
     * A watch stub in front of `target`, one per label.
     *
     * @param {string} label @param {number} argBytes @param {number} target
     * @param {(number | string)[]} [strings]  Which arguments to report as C strings.
     * @returns {number} the stub's address, to be called in place of the target
     */
    const installWatch = (label, argBytes, target, strings = [])=>{
        const already = watches.get(label);
        if (already !== undefined)
        {
            return already;
        }
        const stub = bridge.watch(label, {
            argBytes,
            target,
            // The call is about to reach the real function, which will leave
            // its own result in EAX; nothing here answers it. What this does
            // instead is arrange to be told what that answer was, by sending
            // the function home through a stub of ours.
            /** @param {number[]} _args @param {{ callerStack: number, freeStack: number }} frame */
            handler: (_args, frame)=>{
                const esp = frame.callerStack >>> 0;
                // Read now, while the arguments are still there: a name built
                // on the caller's stack is gone by the time the answer comes.
                /** @param {string | number} where */
                const pointerOf = where=>{
                    if (String(where).startsWith('@'))
                    {
                        // `@hex`: an address of its own, a program's global.
                        return parseInt(String(where).slice(1), 16) >>> 0;
                    }
                    // ECX is untouched by the stub; EDX was spent on the trap
                    // and sits in the block the stub saved, third from the top.
                    return where === 'ecx'
                        ? cpu.readReg32('ecx') >>> 0
                        : where === 'edx'
                            ? memory.readU32((frame.freeStack >>> 0) + 20) >>> 0
                            : memory.readU32(esp + 4 + Number(where) * 4) >>> 0;
                };
                const named = strings.map(where=>{
                    // `ecx*104` is the object's own bytes rather than a string,
                    // `[ecx.88]*64` those of the object a field of it points
                    // at, and `@hex` stands for an address of the program's
                    // own: what a method was handed, read while it runs.
                    const bytes = /^(\[)?(ecx|edx|\d+|@[0-9a-f]+)(?:\.(\d+)\])?\*(\d+)$/.exec(String(where));
                    if (bytes)
                    {
                        let at = pointerOf(bytes[2]);
                        if (bytes[1])
                        {
                            at = memory.readU32(at + Number(bytes[3])) >>> 0;
                        }
                        try
                        {
                            return `0x${at.toString(16)}:`
                                + [...memory.readBytes(at, Number(bytes[4]))]
                                    .map(b=>b.toString(16).padStart(2, '0')).join('');
                        }
                        catch {
                            return `0x${at.toString(16)}:unmapped`;
                        }
                    }
                    const pointer = pointerOf(where);
                    try
                    {
                        return memory.readCString(pointer, 260);
                    }
                    catch {
                        return `0x${pointer.toString(16)}`;
                    }
                });
                pending.push({ label, esp, returnTo: memory.readU32(esp), named,
                    thread: kernel.currentThread() });
                memory.writeU32(esp, catcher());
                return 0;
            },
        });
        watches.set(label, stub);
        return stub;
    };

    /**
     * Watched calls that have not returned yet, innermost last, each with the
     * thread that made it.
     *
     * A stack rather than a map, because a return address is not enough to tell
     * two calls apart and the answer is wanted per call; and searched for the
     * returning thread's own innermost call, because threads interleave inside
     * watched calls -- a worker woken by one runs before it returns -- and a
     * return taken from another thread's frame sends this one into that
     * thread's caller.
     *
     * @type {{ label: string, esp: number, returnTo: number, named: string[],
     *     thread: any }[]}
     */
    const pending = [];

    /** @type {number | null} */
    let catcherStub = null;

    /**
     * Where a watched function returns to instead of its caller: a stub that
     * reports the answer and then sends it the rest of the way.
     *
     * Reached by the callee's own `ret`, so the return address is gone from the
     * stack by the time this runs and has to be put back for the stub's own
     * `ret` to find. EAX is the answer and is preserved into ECX by the stub,
     * because the trap needs EAX to say which stub fired.
     */
    const catcher = ()=>{
        catcherStub ??= bridge.register('<watch-return>', {
            argBytes: 0,
            preserveResult: true,
            handler: ()=>{
                const answer = cpu.readReg32('ecx') >>> 0;
                const thread = kernel.currentThread();
                let at = pending.length - 1;
                while (at >= 0 && pending[at].thread !== thread)
                {
                    at--;
                }
                if (at < 0)
                {
                    return answer;
                }
                const [frame] = pending.splice(at, 1);
                events.emit('guest-return', frame.named.length
                    ? { name: frame.label, strings: frame.named, result: answer }
                    : { name: frame.label, result: answer });
                const esp = (cpu.readReg32('esp') >>> 0) - 4;
                memory.writeU32(esp, frame.returnTo);
                cpu.writeReg32('esp', esp);
                return answer;
            },
        });
        return catcherStub;
    };

    /**
     * Libraries that could not be given room. Remembered, because asking
     * again cannot change the answer; a library that was merely not there
     * is not, since a program puts one in place and asks again -- an
     * installer does exactly that with a library it brought.
     *
     * @type {Set<string>}
     */
    const absentLibraries = new Set();
    /** Where the next runtime library goes. Set once the shipped ones are placed. */
    let nextLibraryBase = 0;

    /**
     * FreeLibrary: gives back one of the references LoadLibrary took on a
     * library the program loaded by name. The last one tells its DllMain,
     * on the thread that asked, and unloads it -- a library read off the
     * volume is unmapped and forgotten, one of ours stops being loaded. A
     * library something imports is pinned and never unloaded.
     *
     * @param {any} held
     * @returns {number | Promise<number>}
     */
    const releaseLibrary = held=>{
        if (held.pinned || !(held.references > 0))
        {
            return 1;
        }
        held.references--;
        if (held.references > 0)
        {
            return 1;
        }
        const unload = ()=>{
            threadBlocks?.removeModule(held.base);
            const at = attachOrder.indexOf(held);
            if (at >= 0)
            {
                attachOrder.splice(at, 1);
            }
            if (held.file)
            {
                byName.delete(moduleKeyOf(held.name));
                byBase.delete(held.base);
                memory.unregister(held.name);
            }
            else
            {
                held.loaded = false;
                held.attached = false;
            }
            events.emit('library-unloaded', { name: held.name, base: held.base });
            return 1;
        };
        if (held.entryPoint && held.entryPoint !== held.base && held.attached !== false)
        {
            return win32.callEntryPoint({
                entry: held.entryPoint, base: held.base, reason: DLL_PROCESS_DETACH, reserved: 0,
                thread: kernel.currentThread(),
            }).then(unload);
        }
        return unload();
    };

    /** The libraries this build synthesises, as opposed to ones a program brings. */
    const systemLibraries = new Set(Object.keys(allLibraries).map(moduleKeyOf));

    /**
     * Those of them that are Windows' own, by file name: a copy an installation
     * left in system32 would be mapped in place of the engine's, so a bottle
     * carries none (`@bottlify/installer`'s `collect`). The redistributables a
     * table only stands in for -- the D3DX helpers -- are not among them.
     */
    const redistributables = new Set(
        (/** @type {() => string[]} */ (win32.redistributables)?.() ?? []).map(moduleKeyOf));
    const windowsLibraries = Object.keys(allLibraries)
        .filter(name=>!redistributables.has(moduleKeyOf(name)));

    // Where a call to an import nothing claims lands. The branch that returns
    // and the branch that faults are made in `createMissingImports`; what it
    // needs from this closure is the evidence that decides between them.
    const { bind: missingImport, calls: missingCalls } = createMissingImports({
        register: (name, spec)=>bridge.register(name, spec),
        events,
        journal,
        classify: (dll, name)=>{
            const own = !systemLibraries.has(moduleKeyOf(dll)) && findModule(dll) !== null;
            // A name a library the program brought does not export is a
            // mismatch between two of its own files, not a gap in this build:
            // it is reported as the program's own. The full list of what
            // nothing claims is already said at bind time, as
            // `import-unresolved`; the call is the one that matters.
            return {
                own,
                ...missingImportCall(name,
                    { own, cdeclLibrary: win32.libraryConvention(dll) === 'cdecl' }),
            };
        },
        fault: (label, frame)=>{
            // The argument bytes are what nobody knows; the words above
            // the return address are the next best thing, since a reader
            // who knows the function can count them.
            const esp = frame.callerStack >>> 0;
            const words = [0, 1, 2, 3].map(word=>{
                const held = memory.readU32(esp + 4 + word * 4) >>> 0;
                return `0x${held.toString(16).padStart(8, '0')}`;
            });
            const from = describeAddress({ cpu, memory, kernel, bridge }, frame.hostReturn);
            cpu.raiseFault({
                name: 'unimplemented import',
                eip: frame.hostReturn,
                calledFrom: frame.hostReturn,
                detail: `unimplemented import ${label}, called from ${from};`
                    + ` argument bytes unknown, the stack holds ${words.join(' ')}`,
            });
            // The stub's `ret` goes into the park loop, whose halt ends
            // the slice before the caller runs another instruction.
            kernel.holdThread();
            return 0;
        },
    });

    // Binds the sidecar's entries for one image, once the sidecar is set up
    // (below); until then a library loaded at run time has nothing to bind.
    /** @type {((image: { name: string, base: number, sizeOfImage: number,
     *   timeDateStamp: number }) => void) | null} */
    let bindSidecar = null;

    /**
     * LoadLibrary, for a library nothing has loaded yet.
     *
     * Synchronous unless a PE actually has to be read, because the dispatcher
     * treats a promise as "park the guest thread" and the two cheap answers --
     * already here, known absent -- must not cost that.
     *
     * `flags` are LoadLibraryEx's. With DONT_RESOLVE_DLL_REFERENCES the library
     * is mapped and becomes a module, but nothing it imports is loaded or bound
     * and its entry point never runs -- and a later LoadLibrary hands back that
     * same module as it is, as Wine's loader test has it. A program, as against
     * a library, is loaded the same way whatever the flags say.
     *
     * @param {string} requested  The name as asked for, with or without its extension.
     * @param {number} [flags]
     * @param {any} [thread]  Whose LoadLibrary this answers, for a library loaded
     *     as another's dependency: by then the processor is someone else's.
     * @returns {number | Promise<number>}
     */
    const loadLibraryAtRuntime = (requested, flags = 0, thread = undefined)=>{
        const name = withLibraryExtension(requested);
        if ((flags & LOAD_AS_DATA) !== 0)
        {
            return loadAsData(name, flags);
        }
        // Read now, before anything is awaited: this is the thread whose
        // LoadLibrary call is being answered, and it is the one whose stack the
        // library's entry point has to run on -- the dependencies' entry points
        // too, which are loaded after awaits, when the thread on the processor
        // is any other.
        const asked = thread ?? kernel.currentThread();
        const unresolved = (flags & DONT_RESOLVE_DLL_REFERENCES) !== 0;
        const key = name.toLowerCase().replace(/\.dll$/, '');
        if (absentLibraries.has(key))
        {
            return 0;
        }
        // A KnownDLL is always ours, and a file of that name beside the
        // program is ignored; for every other name the program's own file wins
        // and our table is only the fallback. So the file is looked for before
        // the table is consulted, save for a library already mapped out of one,
        // which is what a second LoadLibrary must get back.
        //
        // A library already here is handed back rather than loaded again, which
        // is what Windows does: LoadLibrary on a loaded module raises its
        // reference count and returns the handle it already has.
        //
        // Loading it twice is not merely wasteful. A program that asks for the
        // same library in a loop -- and they do, because asking is how a
        // program checks something is there -- gets a second copy of the image
        // at a second address every time: its exports resolve to code whose
        // globals are not the ones the first copy's callers hold, the address
        // space fills until there is no room left, and re-reading, re-parsing,
        // re-mapping and re-binding a megabyte of library is most of what the
        // machine then does with its time.
        const loaded = findModule(name);
        const candidates = searchesBesideProgram(isKnownDll(name), Boolean(loaded?.file))
            ? libraryCandidates(name, options.imagePath ?? 'C:\\app.exe',
                filesystem.currentDirectory(), { ours: loaded !== null })
            : [];
        if (candidates.length > 0)
        {
            // Looked for before anything is awaited: a title probes for
            // hardware support once a frame by asking for a library that does
            // not exist, and a probe that has to wait is a stall per frame. The
            // volume's index answers at once, and answers afresh each time, so a
            // library put in place since the last ask is found.
            const wanted = candidates.find(candidate=>{
                try
                {
                    const entry = filesystem.stat(candidate);
                    return entry && !entry.directory;
                }
                catch {
                    return false;
                }
            });
            if (wanted !== undefined)
            {
                return (async()=>{
                    const file = await readWholeFile(filesystem, blocks, wanted);
                    if (!file)
                    {
                        events.emit('library-missing', { name, path: wanted });
                        return 0;
                    }

                    let image;
                    try
                    {
                        image = parsePe(file);
                    }
                    catch (e){
                        // A file that is not an image -- a program does load
                        // one, by mistake or to find out -- is a library it
                        // cannot have, not a fault in the machine: the load
                        // fails and the program is told, as Windows tells it.
                        events.emit('library-missing', {
                            name, path: wanted, reason: /** @type {Error} */ (e).message,
                        });
                        return 0;
                    }
                    const place = placeLibrary(image, { next: nextLibraryBase, ...librarySpace });
                    if ('refused' in place)
                    {
                        absentLibraries.add(key);
                        events.emit('libraries-missing', { names: [name], reason: place.refused });
                        return 0;
                    }

                    const base = place.base;
                    const mapped = loader.map(file, { base, name });
                    const { exports } = readExports(file, image);
                    const addresses = new Map(exports
                        .filter(entry=>entry.name !== null && entry.forwards === null)
                        .map(entry=>[String(entry.name), base + entry.rva]));
                    const ordinals = new Map(exports
                        .filter(entry=>entry.forwards === null)
                        .map(entry=>[entry.ordinal, base + entry.rva]));

                    // Only a library's imports are resolved and its entry
                    // point run: a program loaded by name is mapped for what
                    // it holds, and its entry point is its main.
                    const inert = unresolved || !image.library;
                    const held = {
                        name, base, size: image.sizeOfImage,
                        /** @param {string} exported */
                        addressOf: exported=>addresses.get(exported) ?? null,
                        /** @param {number} ordinal */
                        addressOfOrdinal: ordinal=>ordinals.get(ordinal) ?? null,
                        entryPoint: mapped.record.entryPoint,
                        // As above: resources come from the file, so a library
                        // loaded at run time has to keep its own.
                        file,
                        image,
                        path: wanted,
                    };
                    // Registered before its own imports are bound, so a library
                    // that imports back into itself -- or into one still being
                    // loaded -- finds an address rather than nothing.
                    Object.assign(held, {
                        references: 1,
                        /** @returns {number | Promise<number>} */
                        release: ()=>releaseLibrary(held),
                    }, inert ? { inert, attached: false } : {});
                    byName.set(moduleKeyOf(name), held);
                    byBase.set(base, held);
                    // Joins PEB->Ldr's own module list the same moment: a
                    // program that walks it right after this LoadLibraryA
                    // returns is not told the library it just asked for was
                    // never loaded.
                    threadBlocks?.addModule(held);
                    if (image.relocatable)
                    {
                        nextLibraryBase = base
                            + Math.ceil(image.sizeOfImage / LIBRARY_ALIGN) * LIBRARY_ALIGN;
                    }

                    // Its own libraries first, then binding.
                    //
                    // The order is the whole of it. A library brought in by
                    // this one is where half of this one's imports come from, so
                    // binding before they are loaded leaves every one of those
                    // slots unclaimed -- and a program that calls through such a
                    // slot does not fail at the call, it runs whatever bytes the
                    // slot happened to name. What is seen is an invalid opcode
                    // at an address belonging to nothing.
                    if (!inert)
                    {
                        // A library one of whose own libraries is nowhere --
                        // not on the volume, not one the engine provides --
                        // is refused whole, with ERROR_MOD_NOT_FOUND, as
                        // Windows refuses it: a program asking at run time is
                        // asking whether it may have the library, and a "yes"
                        // whose imports fault when called takes away the
                        // fallback it has for "no" (its own resources, another
                        // renderer).
                        /** @type {string[]} */
                        const absent = [];
                        /** @type {any[]} */
                        const brought = [];
                        for (const dependency of readImports(file, image))
                        {
                            if (findModule(dependency.dll) === null)
                            {
                                const got = await loadLibraryAtRuntime(dependency.dll, 0, asked);
                                if (got === 0)
                                {
                                    absent.push(dependency.dll);
                                }
                                else
                                {
                                    brought.push(byBase.get(got));
                                }
                            }
                        }
                        if (absent.length > 0)
                        {
                            threadBlocks?.removeModule(base);
                            byName.delete(moduleKeyOf(name));
                            byBase.delete(base);
                            memory.unregister(name);
                            for (const other of brought)
                            {
                                if (other)
                                {
                                    await releaseLibrary(other);
                                }
                            }
                            events.emit('libraries-missing', {
                                names: [name], reason: `it imports ${absent.join(', ')}`,
                            });
                            return 0;
                        }

                        loader.bind(mapped, resolveImport, missingImport);
                        // Both tables, and in this order: the delay-load pass
                        // adds to what the first one recorded rather than
                        // replacing it.
                        loader.bindDelayed(mapped, resolveImport, missingImport);
                    }
                    // Before DllMain: a sidecar entry for this library patches
                    // its code, which must happen before any of it has run
                    // or been compiled.
                    bindSidecar?.({
                        // By file name, as the sidecar names an image; the
                        // program may have asked for the library by path.
                        name: name.slice(
                            Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1),
                        base, sizeOfImage: image.sizeOfImage,
                        timeDateStamp: image.timeDateStamp,
                    });

                    if (!inert && held.entryPoint && held.entryPoint !== base)
                    {
                        // On the thread that asked for the library, which by
                        // now is not the one on the processor: mapping it
                        // awaited a file and a range request, and the loop gave
                        // every other thread its turns while that was
                        // outstanding. Running a DllMain on whoever happens to
                        // be current builds its frame on a stranger's stack.
                        await bridge.callGuest({
                            entry: held.entryPoint,
                            args: [base, DLL_PROCESS_ATTACH, 0],
                            thread: asked,
                        });
                        attachOrder.push(held);
                    }
                    events.emit('library-loaded', { name, base });
                    return base;
                })();
            }
        }
        if (loaded)
        {
            markLoaded(loaded);
            loaded.references = (loaded.references ?? 0) + 1;
            // One of ours asked for unresolved is left unattached, and a later
            // load attaches it: its entry point is our own setup, which the
            // rest of it relies on.
            if (loaded.attached !== false || !loaded.entryPoint || loaded.inert || unresolved)
            {
                return loaded.base;
            }
            // Its first LoadLibrary: the entry point runs now, on the thread
            // that asked, exactly as a library read off the volume gets its
            // DllMain above. Marked first, so a load the entry point itself
            // provokes does not run it twice.
            loaded.attached = true;
            return bridge.callGuest({
                entry: loaded.entryPoint,
                args: [loaded.base, DLL_PROCESS_ATTACH, 0],
                thread: asked,
            }).then(()=>{
                attachOrder.push(loaded);
                return loaded.base;
            });
        }
        // Said out loud, because this is the failure a program reports as
        // "could not open" and then exits on. Without it the only trace is a
        // zero, and a zero says nothing about which path was tried -- which is
        // the whole question.
        events.emit('library-missing', {
            name,
            path: isKnownDll(name) ? 'KnownDLLs' : candidates.join(';'),
        });
        return 0;
    };

    /**
     * FreeLibrary on a data file's handle: the last one unmaps the view.
     *
     * @param {number} handle
     */
    const releaseData = handle=>{
        const held = dataFiles.get(handle);
        if (!held)
        {
            return 0;
        }
        held.references--;
        if (held.references === 0)
        {
            dataFiles.delete(handle);
            if (held.region)
            {
                memory.unregister(held.region);
            }
        }
        return 1;
    };

    /**
     * LoadLibraryEx with a flag that loads a library as data, for its
     * resources: nothing in it is bound or run.
     *
     * A library already loaded as a module is answered with its module handle,
     * and counted, as Wine's loader test has it. Any other is mapped apart and
     * is no module -- GetModuleHandle does not find it -- and its handle is its
     * base with a low bit set: one for a view of the file as it lies on disk,
     * two for one laid out as an image (LOAD_LIBRARY_AS_IMAGE_RESOURCE). Each
     * such load is a view of its own.
     *
     * @param {string} name
     * @param {number} flags
     * @returns {number | Promise<number>}
     */
    const loadAsData = (name, flags)=>{
        const loaded = findModule(name);
        if (loaded && loaded.loaded !== false)
        {
            loaded.references = (loaded.references ?? 0) + 1;
            return loaded.base;
        }
        const layout = (flags & LOAD_LIBRARY_AS_IMAGE_RESOURCE) !== 0 ? 2 : 1;
        /**
         * @param {any} held  What was mapped, and where.
         * @returns {number}
         */
        const record = held=>{
            const handle = (held.base | layout) >>> 0;
            dataFiles.set(handle, {
                ...held, references: 1, release: ()=>releaseData(handle),
            });
            return handle;
        };
        const wanted = libraryCandidates(name, options.imagePath ?? 'C:\\app.exe',
            filesystem.currentDirectory())
            .find(candidate=>{
                try
                {
                    const entry = filesystem.stat(candidate);
                    return entry && !entry.directory;
                }
                catch {
                    return false;
                }
            });
        if (wanted === undefined)
        {
            // One of ours nothing has loaded: there is no file to view, and
            // the image it has holds no resources.
            if (loaded)
            {
                return record({ name, base: loaded.base, file: null, image: null,
                    flat: false, region: null });
            }
            events.emit('library-missing', { name, path: 'as data' });
            return 0;
        }
        return (async()=>{
            const file = await readWholeFile(filesystem, blocks, wanted);
            let image;
            try
            {
                image = file ? parsePe(file) : null;
            }
            catch {
                image = null;
            }
            if (!file || !image)
            {
                events.emit('library-missing', { name, path: wanted, reason: 'not an image' });
                return 0;
            }
            const bytes = layout === 1 ? file : mapImage(file, image.imageBase).bytes;
            const size = Math.ceil(bytes.length / PAGE_SIZE) * PAGE_SIZE;
            const place = placeLibrary({ relocatable: true, imageBase: 0, sizeOfImage: size },
                { next: nextLibraryBase, ...librarySpace });
            if ('refused' in place)
            {
                events.emit('libraries-missing', { names: [name], reason: place.refused });
                return 0;
            }
            const region = `${name} as data at 0x${place.base.toString(16)}`;
            memory.register({
                name: region, base: place.base, size,
                kind: memory.RegionKind.IMAGE, access: memory.Access.READ_WRITE,
            });
            memory.writeBytes(place.base, bytes);
            // Read-only once filled, as a view of a data file is mapped.
            memory.protect(region, memory.Access.READ);
            return record({ name, base: place.base, file, image, flat: layout === 1, region,
                path: wanted });
        })();
    };

    // Where a library may go: above the program's own image, which is not in
    // the map yet, and below the stack pool; and nowhere anything is mapped.
    const librarySpace = {
        floor: mainImage.imageBase + mainImage.sizeOfImage,
        limit: STACK_POOL_START,
        /** @param {number} base @param {number} size */
        holder: (base, size)=>memory.list().find((/** @type {any} */ region)=>
            base < region.base + region.size && region.base < base + size) ?? null,
        /**
         * A span of the heap's arena that nothing has been given -- at a base
         * for a library that can only live there, anywhere for one the
         * modules' space has no room for: the heap gives it up and its region
         * is cut around it, the part above it a region of its own.
         *
         * @param {number | null} wanted @param {number} size
         */
        claim: (wanted, size)=>{
            const heap = core.api('win32').heap();
            const base = wanted === null
                ? heap.allocate(size, { alignment: LIBRARY_ALIGN, owner: 'image' })
                : heap.allocateAt(wanted, size, { owner: 'image' }) ? wanted : 0;
            const region = base === 0 ? undefined : memory.find(base);
            if (!region || !region.name.startsWith('heap')
                || base + size > region.base + region.size)
            {
                return 0;
            }
            const end = base + size;
            const regionEnd = region.base + region.size;
            memory.unregister(region.name);
            const { kind, access } = region;
            if (base > region.base)
            {
                memory.register({ name: region.name, base: region.base,
                    size: base - region.base, kind, access });
            }
            if (regionEnd > end)
            {
                memory.register({ name: `heap@${end.toString(16)}`, base: end,
                    size: regionEnd - end, kind, access });
            }
            return base;
        },
    };

    // The libraries the program brought with it, before the program itself.
    //
    // Every one is mapped before any is bound, because they import each other:
    // binding the first needs the second's exports, which need the second's
    // base. And they are bound after the program is mapped and known by name,
    // because a library may import from the program that loads it.
    const shipped = await mapShippedLibraries({
        executable: options.executable,
        imagePath: options.imagePath ?? 'C:\\app.exe',
        filesystem, loader, blocks, events,
        isSystem: (/** @type {string} */ name)=>findModule(name) !== null,
        isKnownDll,
        byName, byBase,
        // Straight after the system modules, which is the first address nothing
        // else has claimed, and up to the pool of thread stacks.
        base: systemModulesEnd,
        ...librarySpace,
    });
    // Where a library asked for later goes: after the ones that came with the
    // program, or after the system modules when there were none.
    nextLibraryBase = shipped.reduce(
        (highest, library)=>Math.max(highest, library.base + library.size), systemModulesEnd);

    const image = loader.load(options.executable, { resolveImport, missing: missingImport });

    // An executable exports too: a library a program ships imports from the
    // program that loads it, by name or by ordinal, and is bound to those
    // addresses the way it is bound to any other module's.
    //
    // Read out of the mapping when asked, as Windows reads them, never out of
    // the file at load: an executable may carry its table encoded and write it
    // out in place before it asks for its own exports. Read again whenever the
    // directory's head has changed since; one the image could not hold is no
    // exports at all, said once.
    const ownImage = parsePe(options.executable);
    const ownDirectory = ownImage.directories[DIR_EXPORT];
    /** @type {{ head: string, byName: Map<string, number>, byOrdinal: Map<number, number> } | null} */
    let ownTable = null;
    let ownRefusal = '';
    const ownExports = ()=>{
        if (!ownDirectory || ownDirectory.size === 0)
        {
            return null;
        }
        const head = [...memory.readBytes(image.base + ownDirectory.address, 40)].join(',');
        if (ownTable?.head !== head)
        {
            const parsed = parseExportDirectory((rva, length)=>(rva >= ownImage.sizeOfImage ? null
                : memory.readBytes(image.base + rva, Math.min(length, ownImage.sizeOfImage - rva))),
            ownDirectory);
            if (parsed.refused !== null && parsed.refused !== ownRefusal)
            {
                ownRefusal = parsed.refused;
                events.emit('exports-refused', { name: mainModule.path, reason: parsed.refused });
            }
            const resolved = parsed.exports.filter(entry=>entry.forwards === null);
            ownTable = {
                head,
                byName: new Map(resolved.filter(entry=>entry.name !== null)
                    .map(entry=>[String(entry.name), image.base + entry.rva])),
                byOrdinal: new Map(resolved.map(entry=>[entry.ordinal, image.base + entry.rva])),
            };
        }
        return ownTable;
    };
    mainModule = {
        name: 'app.exe',
        base: image.base,
        /** @param {string} exported */
        addressOf: exported=>ownExports()?.byName.get(exported) ?? null,
        /** @param {number} ordinal */
        addressOfOrdinal: ordinal=>ownExports()?.byOrdinal.get(ordinal) ?? null,
        // Kept because a program reads its own resources, and a resource
        // directory is read out of the file rather than out of the mapping.
        file: options.executable,
        image: ownImage,
        // The same answer whether a program asks by null handle or by its own
        // image base, which are the two ways of asking the same question. A
        // program that asks the second way and is told a system directory goes
        // looking for its own data there.
        path: options.imagePath ?? 'C:\\app.exe',
    };
    byBase.set(image.base, mainModule);
    // Known by its file name as well: a program that loads or asks for a
    // handle to its own image by name -- the way it reaches its own resources
    // -- is handed the mapping it is running from, as Windows hands back a
    // module already loaded, rather than a second copy at the one base an
    // image without relocations can take.
    byName.set(moduleKeyOf(mainModule.path), mainModule);
    for (const library of shipped)
    {
        loader.bind(library.mapped, resolveImport, missingImport);
        loader.bindDelayed(library.mapped, resolveImport, missingImport);
    }

    // What the process that asked for this one wrote into it before it existed.
    // This is the first moment at which the addresses those writes name mean
    // anything, because it is the first moment the image is there.
    if (options.patches && options.patches.length > 0)
    {
        const { applied, refused } = placePatches(
            options.patches, image.base, mainModule.image.sizeOfImage);
        for (const patch of applied)
        {
            memory.writeBytes(patch.address, patch.bytes);
        }
        events.emit('process-patched', {
            applied: applied.length,
            refused: refused.map(patch=>
                `${patch.address.toString(16)}+${patch.bytes.length}`),
        });
    }

    // Somewhere to put what a process needs before it starts: thread-local
    // blocks, and the stub that sets them up -- and, ahead of that, a site
    // hook's trampoline, which needs guest heap room before TLS does. Its own
    // span rather than the guest heap, because the heap is the program's and
    // this is written before the program exists to allocate from it.
    const STARTUP_ARENA = 0x100000;
    // After the libraries, like one more of them -- and so only where one
    // would fit: below the thread stacks and on nothing mapped. When the
    // libraries reach the stacks, any gap in the modules' space will do.
    const arenaSpan = { relocatable: true, imageBase: 0, sizeOfImage: STARTUP_ARENA };
    let arenaPlace = placeLibrary(arenaSpan, { next: nextLibraryBase, ...librarySpace });
    if ('refused' in arenaPlace)
    {
        arenaPlace = placeLibrary(arenaSpan, {
            ...librarySpace,
            next: Math.ceil(librarySpace.floor / LIBRARY_ALIGN) * LIBRARY_ALIGN,
        });
    }
    if ('refused' in arenaPlace)
    {
        throw new Error('no room below the thread stacks for what the process needs to start');
    }
    const startupArena = arenaPlace.base;
    memory.register({
        name: 'process-startup', base: startupArena, size: STARTUP_ARENA,
        // Executable because the stub that runs before the program lives here
        // too, and it is guest code.
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    nextLibraryBase = Math.max(nextLibraryBase, startupArena + STARTUP_ARENA);

    let scratch = startupArena;
    /** @param {number} size */
    const allocateFromHeap = size=>{
        const at = scratch;
        // Aligned, because a thread-local block holds whatever the compiler put
        // in it and some of that wants alignment the program never restates.
        scratch += size + 15 & ~15;
        if (scratch > startupArena + STARTUP_ARENA)
        {
            throw new Error('process startup needs more room than it was given');
        }
        return at;
    };

    // How many calls a site kernel issued through `frame.gl` -- read by the
    // diagnostics below whether or not this run binds any sidecar at all, so
    // it always answers a number rather than being missing from the report.
    const glCounters = { calls: 0 };

    // A bundle's sidecar, applied once the image it targets is at its real
    // address. The engine names nothing here: `hooks.json` carries the image,
    // the RVAs and the kernel name, and `hooks.mjs` -- the bundle's own code
    // -- is what a kernel does. This layer only loads the module, gives it a
    // bounds-checked view of guest memory, and wires a hook's outcome to the
    // bridge's own EIP redirect.
    if (options.sidecarHooks)
    {
        const kernelModule = await import(
            /* webpackIgnore: true */
            URL.createObjectURL(
                new Blob([options.sidecarHooks.source], { type: 'text/javascript' })));
        const kernels = kernelModule.kernels ?? {};
        const imagePath = options.imagePath ?? 'C:\\app.exe';
        const imageName = imagePath.slice(
            Math.max(imagePath.lastIndexOf('\\'), imagePath.lastIndexOf('/')) + 1);
        const guestView = createGuestView(/** @type {GuestMemory} */ (memory));
        // Resolved against the graphics seam the first time a kernel actually
        // asks, not at bind time (`resolveOpenglEntry`): a build with no
        // OpenGL layer (a Direct3D title) still binds every kernel.
        const kernelGl = createKernelGl(
            resolveOpenglEntry(/** @type {{ opengl: () => ReturnType<
                typeof import('./layers/graphics/opengl/exports.js').createOpengl> }} */ (
                    core.api('graphics'))),
            journalCall, ()=>journal.enabled('call.gpu', journal.Level.TRACE), glCounters);
        const spec = options.sidecarHooks.spec;
        /**
         * @param {{ name: string, base: number, sizeOfImage: number, timeDateStamp: number }}
         *     target the image, as placed
         */
        bindSidecar = target=>{
            const result = loader.bindHooks(
                spec,
                target,
                /** @param {{ name: string, argBytes: number, target: number, handler: Function,
                 *   site?: undefined }
                 *   | { name: string, site: true, trampoline: number, resume: number,
                 *   stackAdjust: number, handler: Function }} hookOptions */
                hookOptions=>hookOptions.site
                    ? bridge.siteHook(hookOptions.name, hookOptions)
                    : bridge.hook(hookOptions.name, hookOptions),
                /** @param {import('./layers/loader/internal/hooks.js').HookEntry
                 *   | import('./layers/loader/internal/hooks.js').SiteHookEntry} entry */
                entry=>resolveKernel(entry, target.base),
                allocateFromHeap);
            events.emit('hooks-bound', { image: target.name, ...result });
        };
        /**
         * @param {import('./layers/loader/internal/hooks.js').HookEntry
         *   | import('./layers/loader/internal/hooks.js').SiteHookEntry} entry
         * @param {number} base the base of the image the entry names
         */
        const resolveKernel = (entry, base)=>{
            const kernelFn = kernels[entry.kernel];
            if (!kernelFn)
            {
                return null;
            }
            const guest = {
                ...guestView, mismatch: ()=>bridge.reportHookMismatch(entry.kernel),
            };
            const site = Boolean(entry.site);
            // Built once per bound entry rather than once per call: the
            // base and the GL handle are the same on every call a given
            // site makes, so only the kernel's own arguments change.
            const frame = site ? { base, gl: kernelGl } : undefined;
            return (/** @type {number[] | Record<string, number>} */ argsOrRegisters)=>{
                // Guard and fall through, the discipline every guest-code
                // replacement in this engine keeps: a kernel is the
                // bundle's own code, on the bundle's own data, and a bug
                // in it is not a reason to bring the run down when the
                // guest's own function is right there to fall back on.
                let handled;
                // A GL call the kernel already issued through `frame.gl`
                // before it threw is not undone -- the guest's own
                // function then runs the whole pass again on top of it --
                // so `hook-error`'s payload says how many, rather than
                // leaving that silent.
                const glCallsBefore = glCounters.calls;
                try
                {
                    // A site kernel gets a third argument, `frame`, with
                    // the image base -- so it can follow a data pointer
                    // the sidecar gave it as an RVA -- distinct from the
                    // dispatcher's own call frame, which a site hook has
                    // no real use for (there was no call to marshal).
                    handled = site
                        ? kernelFn(guest, argsOrRegisters, frame)
                        : kernelFn(guest, argsOrRegisters);
                }
                catch (e){
                    events.emit('hook-error', {
                        kernel: entry.kernel,
                        message: e instanceof Error ? e.message : String(e),
                        glCalls: glCounters.calls - glCallsBefore,
                    });
                    return false;
                }
                // `oracle` never skips the guest's own code, whatever the
                // kernel decided: that is the whole of the differential
                // guard, and it is the sidecar's flag, not the kernel's.
                // A site hook has no in-browser oracle; its `mode` is always
                // `replace`.
                return entry.mode === 'oracle' ? false : handled;
            };
        };
        bindSidecar({
            name: imageName, base: image.base,
            sizeOfImage: mainModule.image.sizeOfImage,
            timeDateStamp: mainModule.image.timeDateStamp,
        });
        // Libraries the bundle shipped and the image imported statically are
        // already placed by now; a runtime load binds itself as it maps.
        for (const held of byBase.values())
        {
            if (held.image && held.base !== image.base)
            {
                bindSidecar({
                    name: held.name.slice(
                        Math.max(held.name.lastIndexOf('\\'), held.name.lastIndexOf('/')) + 1),
                    base: held.base,
                    sizeOfImage: held.image.sizeOfImage,
                    timeDateStamp: held.image.timeDateStamp,
                });
            }
        }
    }

    const stubs = cpu.thunkImage();
    memory.register({
        // Sized to what the table may grow to rather than to what it holds
        // now. Slots go on being taken for the life of the process -- one per
        // method of every COM interface a program asks for, one per import
        // nothing claims -- and each is written straight into the guest, which
        // needs somewhere inside the map to write to.
        name: 'thunks', base: thunkBase, size: cpu.layout.thunkCapacity,
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    memory.writeBytes(thunkBase, stubs);
    // Read-execute from the guest's side. Later slots are written from ours,
    // which does not go through this permission -- so a guest writing here is
    // still corruption and is still refused.
    memory.protect('thunks', memory.Access.READ_EXECUTE);

    // Thread-local storage, for every image that declares any.
    //
    // The block is filled here, on the host, because it is only bytes; the slot
    // number has to come from the guest's own TlsAlloc, because a runtime later
    // reads it with TlsGetValue and the two have to be talking about the same
    // pool. So the stub does the asking and this does the filling.
    const withTls = [mainModule, ...shipped].map(held=>{
        const directory = held.file ? readTls(held.file, held.image ?? parsePe(held.file)) : null;
        if (!directory)
        {
            return held;
        }
        const size = directory.templateSize + directory.zeroFillSize;
        const blockAddress = allocateFromHeap(size);
        memory.writeBytes(blockAddress, new Uint8Array(size));
        memory.writeBytes(blockAddress, directory.template);

        return {
            ...held,
            tls: {
                indexAddress: held.base + directory.indexRva,
                blockAddress,
                callbacks: directory.callbackRvas.map(rva=>held.base + rva),
            },
        };
    });

    // Every library the program brought with it is attached before the program
    // runs, on the process's first thread, in dependency order -- which is what
    // a real loader does and where a library expects to build the state its
    // exports assume. It is guest code because the calls belong on a guest
    // stack; the stub's last instruction enters the program.
    const kernel32 = findModule('kernel32');
    const startup = synthesiseProcessInit({
        libraries: withTls.filter(held=>held !== mainModule || held.tls),
        entryPoint: image.entryPoint,
        tlsApi: kernel32 && {
            alloc: kernel32.addressOf('TlsAlloc') ?? 0,
            set: kernel32.addressOf('TlsSetValue') ?? 0,
        },
    });
    for (const name of startup.attached)
    {
        const held = shipped.find(library=>library.name === name);
        if (held)
        {
            attachOrder.push(held);
        }
    }
    // Inside the same span the blocks came from, rather than beside it: it is
    // written once, before anything runs, and giving it a region of its own
    // only creates a boundary two allocations can land on either side of.
    const start = startup.attached.length === 0 && startup.tlsImages === 0
        ? image.entryPoint
        : (()=>{
            const at = allocateFromHeap(startup.bytes.length);
            memory.writeBytes(at, startup.bytes);
            events.emit('libraries-attached', {
                names: startup.attached,
                tlsImages: startup.tlsImages,
            });
            return at;
        })();

    memory.writeU32(entryVector, start);

    // What FS points at. A program reaches this in code its compiler emitted
    // rather than code anybody wrote -- a thread-local variable is an index off
    // FS:[0x2c], an exception handler's prologue writes FS:[0] -- so a thread
    // running without one reads linear address 0x2c, finds nothing, and carries
    // on with a null.
    const process = createProcessBlocks({
        allocate: allocateFromHeap,
        writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
        processId: options.processId ?? FIRST_PROCESS_ID,
        version: windowsVersion(options.windows),
        imageBase: image.base,
        processHeap: allLibraries['KERNEL32.dll']?.GetProcessHeap?.handler([]) ?? 0,
        imagePath: options.imagePath ?? 'C:\\app.exe',
        // Quoted, and this is not cosmetic: a program is handed one string and
        // argv[0] ends at the first space, so an unquoted path with a space in
        // it hands the rest of the path to the program as its first argument.
        // A line chosen by whoever started this process wins, because a child
        // is entitled to the arguments its parent gave it.
        commandLine: options.commandLine ?? `"${options.imagePath ?? 'C:\\app.exe'}"`,
        currentDirectory: filesystem.currentDirectory(),
        standardHandles: { input: 0, output: 0, error: 0 },
        // Every module loaded by the time the first instruction runs: the
        // system libraries it imports and theirs, everything the program
        // shipped, and the program's own image -- PEB->Ldr walked before a
        // program calls a single import of its own finds all of them, never
        // an empty list. A system library loaded later joins it then.
        modules: [...byBase.values()].filter(held=>held.loaded !== false)
            .map(held=>held === mainModule ? {
                ...held, entryPoint: image.entryPoint, size: mainModule.image.sizeOfImage,
            } : held),
    });
    threadBlocks = process;

    // The program's first thread. Everything after this runs under the
    // scheduler, including the main thread -- there is no privileged path.
    // Its id the one the parent was told, for a child.
    const mainThread = kernel.createThread({
        entry: start,
        stackTop: initialStack,
        stackLimit: initialStack - stackSize,
        name: 'main',
        id: options.mainThreadId,
        // A program whose entry point returns ends as one that called
        // ExitThread with its answer, as Windows' process start routine sees to.
        returnTo: win32.threadReturn(),
    });
    mainThread.tebAddress = process.createThreadBlock({
        id: mainThread.id,
        stackBase: initialStack,
        stackLimit: initialStack - stackSize,
    }).teb;

    /** The mixer, when this build has one. Read once; it does not change. */
    const sound = core.api('audio')?.output?.() ?? null;

    /**
     * Whether anything is reading the other end of the ring.
     *
     * A track's play position is what the device consumed, so with nothing
     * consuming there is no position to report -- and a film paced by one that
     * never moves would be a still picture.
     */
    const soundIsHeard = core.api('audio')?.available?.() === true;

    /**
     * Where a film's frames go, and its sound.
     *
     * The graph decodes and hands a frame back; showing one is this layer's
     * business because win32 may not reach graphics. The pixels are copied into
     * guest memory rather than handed over as a view: presenting takes a
     * surface the guest owns, which is also what a real video renderer writes
     * into -- the window's own bits.
     *
     * @type {{ address: number, bytes: number, pixels: Uint8Array } | null}
     */
    let filmSurface = null;

    /**
     * The track a film's sound goes to, opened at the film's own rate, with
     * everything ever written to it -- which, less what has been played, is how
     * much sound the picture is ahead of.
     */
    /** @type {{ track: any, sampleRate: number, channels: number,
     *           written: number } | null} */
    let filmTrack = null;

    /** Which film that track is playing, so that the next one gets a fresh one. */
    let filmPlaying = 0;
    /** When a film last handed anything over: one that did, recently, is still owed ticks. */
    let filmTickedAt = -Infinity;
    const FILM_ACTIVE_MS = 500;

    /**
     * Milliseconds of the running film's sound handed over and not played yet.
     *
     * The graph holds the picture back while more is owed than a film may lead
     * its sound by, which is what keeps the two together. Null wherever nobody
     * can say: no mixer, nothing draining it, or a film that has yet to hand
     * over a first block of sound -- and then nothing holds the picture back.
     *
     * @returns {number | null}
     */
    const filmSoundOwedMs = ()=>(sound && filmTrack && soundIsHeard
        ? Math.max(0, filmTrack.written - filmTrack.track.played())
            * 1000 / sound.sampleRate
        : null);

    /**
     * Why a decoded frame did not reach the screen.
     *
     * One counter per way out, because "the film decoded and nothing was shown"
     * is five different faults wearing the same face, and a report that only
     * says nothing arrived cannot tell them apart.
     */
    const film = {
        ticks: 0, frames: 0, silent: 0, hidden: 0, offScreen: 0, noScreen: 0, noRoom: 0,
        shown: 0,
        // How far the picture is ahead of the sound, in milliseconds of the
        // film's own timeline. A film has one timeline and two ways to advance
        // along it, and nothing else in a report says whether they agree.
        driftMs: 0, worstDriftMs: 0, soundMs: 0, queuedMs: 0,
        // The film's sound its track would not take: heard as a gap.
        refusedMs: 0,
    };

    /** @param {{ hwnd: number, width: number, height: number, bgra: Uint8Array | null,
     *            window?: { left: number, top: number, width: number, height: number,
     *                       visible: boolean, fullScreen: boolean },
     *            audio: Int16Array[], sampleRate: number, channels: number,
     *            positionMs: number, film: number } | null} shown */
    /** @param {any} shown  What a filter graph handed back for this tick. */
    const showVideoFrame = shown=>{
        if (!shown)
        {
            return;
        }
        film.ticks++;
        filmTickedAt = clockSource();
        if (shown.film !== filmPlaying)
        {
            // A new film gets a track of its own: what the last one left queued
            // is not played over it, and the position its picture follows
            // starts again at zero rather than at the end of the one before.
            filmPlaying = shown.film;
            filmTrack?.track.close();
            filmTrack = null;
        }
        if (shown.audio.length > 0 && sound)
        {
            // A film carries its own rate and its own channel count, and they
            // are not the device's: a track opened at the wrong one plays the
            // whole cinematic at the wrong pitch.
            if (!filmTrack || filmTrack.sampleRate !== shown.sampleRate
                || filmTrack.channels !== shown.channels)
            {
                filmTrack = {
                    track: sound.open({
                        sampleRate: shown.sampleRate,
                        channels: shown.channels,
                        bitsPerSample: 16,
                    }),
                    sampleRate: shown.sampleRate,
                    channels: shown.channels,
                    written: 0,
                };
            }
            const fed = feedFilmSound(filmTrack.track, shown.audio, shown.channels,
                shown.sampleRate, sound.sampleRate);
            filmTrack.written += fed.offered;
            film.refusedMs += Math.round(fed.refused * 1000 / sound.sampleRate);
        }
        if (filmTrack && sound)
        {
            film.soundMs = Math.round(filmTrack.track.played() * 1000 / sound.sampleRate);
            film.queuedMs = Math.round(filmSoundOwedMs() ?? 0);
            film.driftMs = Math.round(shown.positionMs) - film.soundMs;
            film.worstDriftMs = Math.max(film.worstDriftMs, film.driftMs);
        }
        if (!shown.bgra)
        {
            film.silent++;
            return;
        }
        film.frames++;
        if (!isShown(shown))
        {
            film.hidden++;
            return;
        }
        const screen = core.api('graphics');
        if (!screen?.present)
        {
            film.noScreen++;
            return;
        }
        // On the screen the program asked for, never on one the size of the
        // film. A cinematic is authored at its own dimensions and they are
        // rarely the display's -- letting them through resizes the surface
        // everything else is drawn on, and a display does not change shape
        // because a film started. So a film with the screen to itself is
        // fitted into it and centred, with the margins left black, which is
        // what a video renderer does with a destination rectangle it does not
        // fill; one whose video window the program placed in a window of its
        // own goes where SetWindowPosition put it inside that window's client
        // area, and is shown as that window's picture.
        const shape = screen.screen();
        const width = shape.width;
        const height = shape.height;
        const placement = placementOf(shown,
            (/** @type {number} */ hwnd)=>win32.clientRect(hwnd), shape);
        if (placement && !placement.visible)
        {
            film.offScreen++;
            return;
        }
        const needed = width * height * 4;
        if (!filmSurface || filmSurface.bytes < needed)
        {
            const address = win32.heap().allocate(needed);
            if (address === 0)
            {
                film.noRoom++;
                return;
            }
            filmSurface = { address, bytes: needed, pixels: new Uint8Array(needed) };
        }
        film.shown++;
        const surface = filmSurface;
        if (placement)
        {
            stretchFrame(shown, surface.pixels, width, height, placement);
        }
        else
        {
            fitFrame(shown, surface.pixels, width, height);
        }
        memory.writeBytes(surface.address, surface.pixels);
        screen.present({
            buffer: surface.address,
            width,
            height,
            pitch: width * 4,
            bitCount: 32,
            palette: null,
        }, placement ? shown.hwnd >>> 0 : 0);
    };

    /** The guest's own clock, and the host clock it is credited from. */
    const clock = core.api('kernel').clock;
    const clockSource = ()=>Date.now();
    /**
     * Longer than this between two credits is a stall, not the program's time.
     * Generous next to a turn -- a slice is a few milliseconds and a yield less
     * -- and short next to anything a person would notice as the page hanging.
     */
    const CLOCK_CREDIT_CAP_MS = 250;
    const creditClock = clockCredit(clockSource, clock, CLOCK_CREDIT_CAP_MS);
    kernel.refreshClockWith?.(()=>creditClock());

    const breathe = createMacrotask();
    const jsSampler = options.sampleJs ? createJsSampler() : null;
    const pacing = options.pacing ?? pagePacing({
        macrotask: breathe,
        hidden: options.pageHidden ?? pageIsHidden,
        pendingMs: options.pendingYieldMs,
    });

    /**
     * Wall milliseconds until the guest's own next deadline: the soonest of a
     * thread's timed wait, a queue timer, and -- while a film or a track is
     * open -- the next look a device needs. Null when it has none.
     */
    const nextDeadlineMs = ()=>{
        /** @type {number | null} */
        let soonest = null;
        for (const due of [kernel.nextDeadline(), win32.queue?.()?.nextTimerDue?.() ?? null])
        {
            if (due !== null && (soonest === null || due < soonest))
            {
                soonest = due;
            }
        }
        let wall = soonest === null ? null : Math.max(0, soonest - clock.virtualTime());
        const feeding = clockSource() - filmTickedAt < FILM_ACTIVE_MS
            || (sound?.diagnostics().tracks ?? 0) > 0;
        if (feeding && (wall === null || wall > DEVICE_LOOK_MS))
        {
            wall = DEVICE_LOOK_MS;
        }
        return wall;
    };

    /**
     * Pausing is a gate rather than a flag polled in a loop: a paused caller
     * waits on a promise that resuming resolves, so nothing spins.
     *
     * @type {{ gate: Promise<void>, open: () => void } | null}
     */
    let paused = null;
    /**
     * Stops handing out turns without ending anything; `resumeRun` continues
     * from the same place, since no thread's state was touched.
     */
    const pauseRun = ()=>{
        if (paused)
        {
            return;
        }
        /** @type {() => void} */
        let open = ()=>{};
        const gate = new Promise(resolve=>{
            open = ()=>resolve(undefined);
        });
        paused = { gate, open };
    };
    const resumeRun = ()=>{
        if (!paused)
        {
            return;
        }
        paused.open();
        paused = null;
    };

    // attachLog is sugar over the registry: the same subscription, remembered
    // by the sink the caller gave, so detaching still takes what it was given.
    // The map is handed in across a replacement: a subscription made before the
    // handover has to be removable after it, and a fresh map would forget it.
    /** @type {Map<Function, (payload: any) => void>} */
    const logSinks = options.logSinks ?? new Map();

    /**
     * Announces a failure the program itself cannot see, and hands back what to
     * throw. A handler may answer with an error of its own to throw instead.
     *
     * The trace is taken here rather than by whoever catches it: by then the
     * machine has moved on, and the registers that say where it went wrong are
     * gone. It is attached to the error too, so a caller that only catches the
     * throw still has it.
     *
     * @param {string} reason
     * @param {any} error
     * @returns {any}
     */
    const fail = (reason, error)=>{
        // The exception frame, when there is one. Without it the report names
        // the ROM stub the processor is standing in rather than the instruction
        // that faulted, and every register it prints is read from a machine
        // that has already left the scene.
        const trace = captureTrace({ cpu, memory, kernel, bridge, fault: cpu.fault?.() ?? null });
        const text = formatTrace(trace);
        const thrown = error instanceof Error ? error : new Error(String(error));
        Object.assign(thrown, { reason, trace, traceText: text });
        return events.emit('error', { reason, error: thrown, trace, text }) ?? thrown;
    };

    /**
     * Ends the run because a child is to take this process's place.
     *
     * Reached from the two places a parent can be finished: it exited, or it is
     * waiting on a handle only the replacement could ever signal. Nothing is
     * torn down here -- `run` returns and the caller above rebuilds, which is
     * the one place in the engine that owns a process lifecycle.
     *
     * @param {any} request
     */
    const handOver = request=>{
        events.emit('process-replace', {
            image: request.imagePath,
            commandLine: request.commandLine,
            patches: request.patches.length,
        });
        if (options.refuseReplacement)
        {
            throw fail('process-replacement-refused', new Error(
                `refusing to replace this process with ${request.imagePath}`));
        }
    };

    /** This process's memory, once it has gone (`spareMemory`). @type {{ memory: WebAssembly.Memory, guestEnd: number } | null} */
    let spare = null;

    return {
        /** Where the program was mapped and where it starts. */
        image,

        /**
         * Runs the program to completion, one scheduler turn at a time.
         *
         * Turns rather than a free-running emulator: a turn is where a thread
         * can be preempted, where a blocked one is put back on the road, and
         * where "nothing can run" becomes visible instead of looking like work.
         *
         * @param {Object} [runOptions]
         * @param {number} [runOptions.maxTurns]
         *     Turns in which the guest ran something. A turn that ran nothing
         *     is the machine waiting -- on a fetch, on a timer -- and waiting
         *     is not the work this bounds: with a yield every turn, a wait of
         *     a few seconds is tens of thousands of such turns.
         * @param {number | null} [runOptions.timeoutMs]
         *     Wall milliseconds the run may take, whatever it did with them.
         *     The bound for a program that only waits: the turn budget never
         *     runs out on a machine that does nothing, so a caller that needs
         *     a windowed program with an empty queue to come back at all
         *     bounds it here.
         * @returns {Promise<number>} the guest's exit code
         */
        async run({ maxTurns = 200000, timeoutMs = null } = {}){
            let worked = 0;
            const startedAt = clockSource();
            // Read at the top of a turn, where a bounded wait has just
            // returned: a machine sleeping between looks overruns by one
            // look at most.
            const expired = ()=>timeoutMs !== null && clockSource() - startedAt >= timeoutMs;
            // How many turns in a row have retired nothing. This is what tells
            // a machine waiting on its own next instruction from one waiting on
            // the host, which are the same shape from here and want opposite
            // waits.
            let spun = 0;
            /** When the sound was last pumped (`SOUND_PUMP_MS`). */
            let pumpedAt = -Infinity;
            while (worked < maxTurns && !expired())
            {
                if (paused)
                {
                    await paused.gate;
                }

                // A turn is a phase, and everything inside it is a phase of its
                // own. Not decoration: a region nobody opened a phase around
                // measures nothing, so unaccounted time reads as no cost at all
                // and the largest item in a run can be the one item nobody
                // bracketed. `turn` is what the rest is checked against -- the
                // sum of its occurrences is the run -- and its own self time is
                // the loop's overhead and nothing else.
                journal.begin('turn', journal.PhaseKind.HOST);
                try
                {
                    // What passed since the last slice ended -- the yield, the
                    // pump, the cursors, the polls -- is the program's time as
                    // much as the slice was, and it is credited before the
                    // sound is pumped so that a cursor read there is current.
                    creditClock();

                    // One yield per turn, so a host function suspended on a
                    // guest callback can make progress between them. Without it
                    // the loop never returns to the event loop on its normal
                    // path and such a handler would be resumed exactly never.
                    //
                    // Bracketed because that handler runs here: whatever a
                    // resumed host call then does is this turn's cost, and it is
                    // charged to nothing if nobody opened a phase around it.
                    journal.begin('microtasks', journal.PhaseKind.HOST);
                    await Promise.resolve();
                    journal.end('microtasks');

                    // And a real one when the host says so, because that one
                    // is a microtask and microtasks do not let anything else
                    // happen. A program running hot never leaves the microtask
                    // queue, so nothing outside gets a turn: a click on a pause
                    // button is not delivered, a timer does not fire, a
                    // presented frame is not composed, and a page looks hung
                    // while the guest is working perfectly. When is the host's
                    // call -- by what is pending and by a clock, never by turn:
                    // a trip round the event loop is paid for whatever the
                    // browser runs in the gap, and one per turn was the largest
                    // host phase of a run.
                    //
                    // Sound is written ahead before the turn yields to the
                    // browser, not after: the device reads on a thread of its
                    // own, and a yield is where the browser may take the thread
                    // to compose a frame or collect its garbage. Topping the
                    // ring up first is what keeps it from draining empty in that
                    // gap -- heard as a click in otherwise steady sound.
                    //
                    // Once a SOUND_PUMP_MS, though, not once a turn: a ring
                    // topped up a millisecond ago is as full as it gets, and
                    // a machine whose threads wait out a deadline turns --
                    // and yields -- tens of thousands of times a second, a
                    // pump each, 8 % of a game's thread, all doing nothing.
                    //
                    // A caller parked on a queue of the guest's own is a
                    // suspended call too, but the guest answers it, at the look
                    // every turn gives it below: what is left waits on the
                    // host. Counted before the look, when every such caller is
                    // parked rather than halfway through looking.
                    const queued = idlers.length;
                    const onHost = Math.max(0, bridge.suspended() - queued);
                    const turnYield = pacing.yield({
                        suspended: onHost, fetching, idlers: queued, spun,
                    });
                    const pumpAt = performance.now();
                    if (sound && pumpAt - pumpedAt >= SOUND_PUMP_MS)
                    {
                        pumpedAt = pumpAt;
                        journal.begin('pump', journal.PhaseKind.HOST);
                        sound.pump();
                        journal.end('pump');
                    }
                    if (turnYield)
                    {
                        journal.begin('yield', journal.PhaseKind.HOST);
                        await turnYield;
                        journal.end('yield');
                    }

                    // And devices that keep a cursor are moved on, whether or not
                    // the guest asked anything. A program is entitled to hand a
                    // buffer to a device and then spin on the flag the device sets
                    // in it -- the flag is the contract, and a real device honours
                    // it from its own clock. A cursor advanced only when the guest
                    // calls in is a cursor that never advances for such a program,
                    // and the spin is then forever: the machine is running, the
                    // clock is running, and the one thing that would end it is
                    // waiting for a call that will not come.
                    journal.begin('waveTick', journal.PhaseKind.HOST);
                    win32.waveTick?.();
                    journal.end('waveTick');

                    // And a film, for the same reason: nothing inside the guest
                    // advances one. A program that plays a cinematic hands the
                    // graph a file and then sits in its message loop until it is
                    // told the film ended.
                    journal.begin('videoTick', journal.PhaseKind.HOST);
                    showVideoFrame(win32.videoTick?.(clockSource(), filmSoundOwedMs()));
                    journal.end('videoTick');

                    // And a turn is also when anything waiting for something to
                    // arrive -- a message loop with an empty queue -- gets to look
                    // again. Taken as a batch: a waiter that goes back to waiting
                    // must not be released twice by its own turn.
                    if (idlers.length > 0)
                    {
                        journal.begin('idlers', journal.PhaseKind.HOST);
                        const waiting = idlers;
                        idlers = [];
                        for (const release of waiting)
                        {
                            release();
                        }
                        await Promise.resolve();
                        journal.end('idlers');
                    }

                    // Still waiting after being let look, or a host call
                    // suspended on something outside the microtask queue -- a
                    // fetch, a file read -- means the machine has nothing to do
                    // until the host gets a turn. A microtask does not give it
                    // one, so this is the one place the loop hands it back.
                    //
                    // Through the unclamped yield while the guest is still
                    // getting work done, and on a timer once it has stopped.
                    // A program sitting in its own message loop takes this
                    // branch on most turns while running perfectly well, and a
                    // zero timeout is clamped to four milliseconds and more once
                    // they nest -- so this branch, the one for a machine with
                    // nothing to do, was the largest cost in a run by far,
                    // bigger than every host call and all the emulation
                    // together. The timer is kept for the case it is right for,
                    // which is a machine that really can do nothing until the
                    // host answers.
                    const wait = idleWait({ fetching, idlers: queued, suspended: onHost, spun });
                    if (wait)
                    {
                        journal.begin(wait.phase, journal.PhaseKind.HOST);
                        creditClock();
                        // A caller sitting on an empty message queue is waiting
                        // for two things: something posted from outside, which
                        // nobody can predict, and a timer of its own, whose due
                        // time is written down in the queue. Moving the clock to
                        // it -- never past the host's, as everywhere else -- is
                        // the difference between finding out and looking to see.
                        // Looking cost several thousand clamped timeouts a run.
                        const due = wait.timer && fetching === 0
                            ? win32.queue?.()?.nextTimerDue?.() ?? null
                            : null;
                        if (due !== null && clock.skipTo(due) > 0)
                        {
                            journal.end(wait.phase);
                            continue;
                        }
                        // Whichever comes first: the range request answering,
                        // or the timer coming round again.
                        //
                        // Not the request alone, however much cheaper that
                        // reads. A thread waiting on the network is not the
                        // only thread there is, and waiting for the answer
                        // stops the machine for the whole of a request that can
                        // take four seconds -- measured at two and a half times
                        // the wall clock of looking again and finding work.
                        //
                        // And a host call answering ends the wait at once:
                        // when every thread is parked on the host, that is
                        // the only event that can put one back on the
                        // processor, and sleeping through it costs the whole
                        // of the look interval for every call the guest makes.
                        /** @type {Promise<void>[]} */
                        const wakes = [];
                        if (fetched && wait.timer)
                        {
                            wakes.push(fetched);
                        }
                        if (wait.timer && bridge.suspended() > 0)
                        {
                            wakes.push(bridge.answered());
                        }
                        await pacing.wait({
                            timer: wait.timer, sleep: wait.timer,
                            deadlineMs: nextDeadlineMs(), wakes,
                        });
                        // This time passed for the guest too, and it is the only
                        // time nothing credits. A thread suspended on a host call
                        // is parked on `hlt` and still counts as runnable, so the
                        // scheduler never reaches the branch that moves the clock
                        // to the next deadline -- and the clock is otherwise
                        // credited only for turns the guest actually ran. A
                        // machine that idles for most of its wall time then holds
                        // its own clock nearly still, and every timed wait in the
                        // guest waits far longer than it asked for: a sleep, a
                        // timeout, a WM_TIMER, a wave cursor. The wait that would
                        // end the idling is itself the thing the idling stops
                        // from expiring. In full: a wait this long was asked
                        // for, and a cap here would make it end early.
                        creditClock(Infinity);
                        journal.end(wait.phase);
                    }

                    // What the machine's state says before it is given another
                    // slice: a failed host call, a pending replacement, an exit,
                    // a fault. Each is a call across a layer boundary and there
                    // are four of them per turn, so they are worth a phase of
                    // their own rather than an unmeasured constant.
                    journal.begin('poll', journal.PhaseKind.HOST);
                    const failure = bridge.failure();
                    let replacing = kernel.processes.pending();
                    // Where processes run at once, a child starts now, beside
                    // this one, rather than waiting to take its place.
                    if (replacing && options.beside)
                    {
                        kernel.processes.started(replacing);
                        options.beside(replacing);
                        replacing = null;
                    }
                    const code = win32.exitCode();
                    const fault = cpu.fault();
                    journal.end('poll');

                    if (failure)
                    {
                        throw fail('host-call', failure);
                    }

                    if (code !== null)
                    {
                        // A parent that exits after starting a child has handed
                        // over; it has not finished. Saying so as an exit would
                        // report the launcher's code as the program's.
                        if (replacing)
                        {
                            handOver(replacing);
                            return code;
                        }
                        events.emit('exit', { code });
                        return code;
                    }

                    // A processor exception stops the machine rather than raising
                    // anything: the report cannot be thrown from where it is
                    // noticed, so it is left here to be found. Checked before the
                    // next turn, because from outside a halted processor and a
                    // program that finished look exactly alike.
                    if (fault)
                    {
                        const error = new Error(fault.text);
                        Object.assign(error, { code: 'GUEST_FAULT', fault });
                        throw fail('guest-fault', error);
                    }

                    // A parent polling a child that has not run -- its exit
                    // code, a wait that does not block -- in a loop that never
                    // blocks is waiting on it: the child runs now, beside it,
                    // as it would once the parent blocked on its handle.
                    if (replacing?.polled && win32.childWaitedOn(replacing))
                    {
                        events.emit('process-child', {
                            image: replacing.imagePath,
                            commandLine: replacing.commandLine,
                        });
                        return 0;
                    }

                    let step;
                    try
                    {
                        // The one measurement that separates emulation from our
                        // own code. Host calls trap out from inside this and open
                        // their own phase, so what is left as this phase's self
                        // time is the guest actually executing -- which is the
                        // number every question about speed starts from.
                        journal.begin('guest', journal.PhaseKind.GUEST);
                        const compiledBefore = import.meta.BOTTLIFY_DIAGNOSTICS !== false
                            ? cpu.compiledModules() : 0;
                        step = kernel.runOnce();
                        // Compiling happens inside the slice, on the way to a
                        // hot page, and is the guest's time only by position.
                        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                        {
                            journal.compiled(cpu.compiledModules() - compiledBefore);
                        }
                        // Where the guest stood when its slice ran out. Sampled
                        // here because this is the only boundary the host owns: a
                        // program that decides something inside its own code makes
                        // no call to record, and the instruction pointer is the
                        // only thing that says which code that was.
                        if (options.sample && step.ran)
                        {
                            // With what the turn actually retired. A sample per
                            // turn weights every thread the same, and a parked
                            // one retires two instructions and a busy one a
                            // hundred thousand -- so an unweighted profile
                            // reads as though the machine spends its life in
                            // the park loop.
                            options.sample(cpu.eip(), step.instructions ?? 1);
                        }
                    }
                    catch (e){
                        // A fault inside the guest, or inside a host function
                        // answering it. Either way the program cannot be told, and
                        // the state that explains it is about to be lost.
                        journal.end('guest');
                        throw fail('guest', e);
                    }
                    journal.end('guest', { instructions: step.instructions ?? 0 });

                    // A slice that ended on a host call: an answer due in a few
                    // microtasks -- a host call running guest code builds its
                    // frame a promise or two later -- is let arrive now. The loop
                    // otherwise awaits only when nothing is ready, and a thread
                    // parked on an answer already made waited until every other
                    // thread had nothing to do.
                    if (step.ran?.awaitingHost)
                    {
                        let tick = 0;
                        while (tick < HOST_ANSWER_TICKS && step.ran.awaitingHost)
                        {
                            await null;
                            tick++;
                        }
                        kernel.noteHostAnswer?.(tick, !step.ran.awaitingHost);
                    }

                    spun = step.instructions === 0 ? spun + 1 : 0;

                    // The guest ran for real, so its clock moves. Nothing else in
                    // the engine does this, and without it the clock only ever
                    // advanced when a program waited -- so a program that does not
                    // wait sees no time pass at all. That is not a small error: a
                    // frame loop concludes its frame took no time, a timed wait
                    // never expires, and a device whose cursor runs on the clock
                    // never finishes a buffer, which strands a program spinning on
                    // the flag that buffer would have set.
                    //
                    // Credited from the host's wall clock rather than from retired
                    // instructions, because what a program is measuring is how long
                    // its own work took, and on a machine this slow that really is
                    // the wall time. A slow machine is a slow machine; a machine
                    // where no time passes is a broken one.
                    creditClock();

                    if (step.ran)
                    {
                        worked++;
                    }
                    if (!step.ran)
                    {
                        // Nobody is ready. When a child is waiting to be started
                        // that is not a deadlock but its turn: the parent has not
                        // exited, so it is not finished -- blocked on the child's
                        // handle, sleeping between polls of its exit code, or idle
                        // in its message loop -- and the child runs beside it,
                        // the parent going on afterwards, which the caller above
                        // arranges. Only a wait for all of a set the child cannot
                        // answer alone still hands the parent over.
                        if (replacing)
                        {
                            if (win32.childWaitedOn(replacing))
                            {
                                events.emit('process-child', {
                                    image: replacing.imagePath,
                                    commandLine: replacing.commandLine,
                                });
                                return 0;
                            }
                            handOver(replacing);
                            return 0;
                        }
                        // Nothing ready is not the same as nothing to wait
                        // for. A thread parked on a host call that has not
                        // answered is deliberately not a candidate -- that is
                        // what lets the scheduler move the clock -- so a turn
                        // where only such threads exist means the machine is
                        // waiting on us, and the wait above is where that is
                        // paid for.
                        if (bridge.suspended() > 0 || fetching > 0 || idlers.length > 0)
                        {
                            continue;
                        }
                        // Or every thread is in a timed wait and the clock has
                        // caught up with the host's, so the only thing left to
                        // do is let real time reach the deadline. That is a
                        // machine waiting, not a machine stuck, and the two look
                        // identical from here without asking.
                        const waitingOnTime = kernel.nextDeadline() !== null
                            || (win32.queue?.()?.nextTimerDue?.() ?? null) !== null;
                        if (waitingOnTime)
                        {
                            journal.begin('idle-deadline', journal.PhaseKind.HOST);
                            await pacing.wait({
                                timer: false, sleep: true,
                                deadlineMs: nextDeadlineMs(), wakes: [],
                            });
                            journal.end('idle-deadline');
                            continue;
                        }
                        // Or another process of the run is running beside this
                        // one, and what every thread here waits on -- a child's
                        // exit, an object it sets -- is its to answer.
                        if (options.othersRunning?.())
                        {
                            journal.begin('idle-host-wait', journal.PhaseKind.HOST);
                            await pacing.wait({
                                timer: true, sleep: true, deadlineMs: null, wakes: [],
                            });
                            journal.end('idle-host-wait');
                            continue;
                        }
                        // Either everything finished without the program exiting,
                        // or every thread is waiting on something no one will
                        // signal -- and the diagnostics name what.
                        const waiting = kernel.diagnosticsSnapshot().waiting;
                        if (waiting.length > 0)
                        {
                            throw fail('deadlock',
                                new Error(`deadlock: ${waiting.join('; ')}`));
                        }
                        throw fail('no-threads',
                            new Error('every thread ended without the process exiting'));
                    }
                }
                finally
                {
                    journal.end('turn');
                }
            }
            throw fail('runaway', new Error(worked < maxTurns
                ? `program did not finish within ${timeoutMs} ms`
                : `program did not finish within ${maxTurns} turns`));
        },

        /** The program's first thread. */
        mainThread,

        /**
         * The run as a session that can be replayed, when one was recorded.
         *
         * Everything `replaySession` needs and nothing else: the order of
         * events at the bridge, and the threads with the stacks they were
         * given. Written to a file, this is a failure that took a person a
         * minute of clicking turned into a test that runs in a second.
         */
        /** @returns {{ threads: any[], events: any[] }} */
        recordedSession(){
            const recorded = bridge.recorded();
            const named = new Set(recorded.map((/** @type {any} */ one)=>one.thread));
            return {
                threads: kernel.threads()
                    .filter((/** @type {any} */ one)=>named.has(one.name))
                    .map((/** @type {any} */ one)=>({
                        name: one.name, stackTop: one.stackTop, stackLimit: one.stackLimit,
                    })),
                events: recorded,
            };
        },

        /**
         * Stops handing out turns without ending anything; `resume` continues
         * from the same place, since no thread's state was touched.
         */
        pause: pauseRun,
        resume: resumeRun,
        stop: ()=>cpu.stop(),

        /**
         * Answers a message box the page was shown. A program's own boxes are
         * dialogs on its desktop, answered there as a person answers them, and
         * the engine's own notice waits on nothing -- so no box is ever
         * standing here to be answered.
         *
         * @param {number} id   The id the `message-box` event carried.
         * @param {number} button
         * @returns {boolean} Whether a box was standing under that id: never.
         */
        answerMessageBox(id, button){
            void id;
            void button;
            return false;
        },

        /**
         * Watches, answers, or swallows something the program did.
         *
         * Handlers run in registration order and the first to return anything
         * other than `undefined` decides and stops the rest -- so observing and
         * intercepting are the same mechanism, and a handler that returns
         * nothing has not intervened.
         *
         * What is emitted today: `output` ({ handle, text }) for a write to a
         * standard handle, `debug` ({ text }) for the program's own tracing,
         * `error` ({ reason, error }) for a failure the program cannot see,
         * and `exit` ({ code }) when it ends.
         *
         * @param {string} name
         * @param {(payload: any) => any} handler
         * @returns {() => void} stops this handler
         */
        on: (name, handler)=>events.on(name, handler),
        /** @param {string} name @param {(payload: any) => any} handler */
        off: (name, handler)=>events.off(name, handler),

        /**
         * The emulator's account of where the guest ran, by the address of
         * every compiled block and interpreted instruction, weighted by the
         * instructions retired there. A sample taken where a turn stops lands
         * on whatever stopped it; this is kept by the code as it runs, and is
         * the only honest answer to "which of the program's own instructions
         * is the time going to". Costs a call per block while it is kept, so
         * it is started for a measurement and stopped after.
         */
        guestProfile: {
            /**
             * What a profiler build of the emulator counted since it started:
             * its event counters by name and retired instructions by opcode.
             * Null in a build without the profiler; a window is two readings.
             */
            instructionStats: ()=>core.api('cpu').profile?.instructionStats() ?? null,
            available: ()=>Boolean(core.api('cpu').profile?.available()),
            /** @param {{ keepCode?: boolean }} [how] Kept code makes
             * the account the interpreter's own instructions. */
            start: how=>Boolean(core.api('cpu').profile?.start(how)),
            stop: ()=>core.api('cpu').profile?.stop(),
            /**
             * @returns {{ entries: { address: number, instructions: number, hits: number }[],
             *     dropped: number } | null}
             */
            read: ()=>core.api('cpu').profile?.read() ?? null,
        },

        /**
         * The journal: everything the engine reported, in one ordered stream.
         *
         * Every event the engine emits is written here as it happens, under its
         * own name as the category, so a reader that wants the whole story does
         * not have to know the names in advance and subscribe to each. That is
         * the point of it: a program's behaviour is the interleaving, and three
         * separate views of three kinds of event cannot be interleaved after
         * the fact.
         *
         * `drain(since, limit)` reads forward and says where to resume, which
         * is what a live view polls with; `recent(count)` reads the tail
         * without moving anything, which is what a snapshot of a failure wants.
         * `setLevel` decides how much is kept, per category.
         */
        log: {
            /**
             * A record from outside the engine, into the same journal: what
             * the host's own GPU device reported about a frame, which a reader
             * of the run's log must see beside the frame it dropped.
             *
             * @param {'error' | 'warn' | 'info'} level
             * @param {string} category @param {string} text
             */
            write: (level, category, text)=>core.api('log').write(level, category, '{0}', text),
            /** @param {number} [since] @param {number} [limit] */
            drain: (since, limit)=>core.api('log').drain(since, limit),
            /** @param {number} [count] */
            recent: count=>core.api('log').recent(count),
            /** The journal this machine writes into, for the next process of the run to share. */
            journal: ()=>core.api('log').journal?.() ?? null,
            /** @param {string} category @param {string | number} level */
            setLevel: (category, level)=>core.api('log').setLevel(category, level),
            /** @param {string | number} level */
            setDefaultLevel: level=>core.api('log').setDefaultLevel(level),
            /**
             * The topics a reader can switch on, for one offering a filter.
             * Named here rather than discovered from what has been logged, so a
             * filter can offer a topic before anything in it has happened.
             *
             * Most are the areas a host call is filed under; `input.press` is
             * not a call at all but the other end of the same question -- what
             * arrived from outside, as against what the program asked.
             */
            areas: ()=>[
                ...['cpu', 'gpu', 'audio', 'video', 'input', 'net', 'com', 'hook']
                    .map(area=>`call.${area}`),
                'input.press',
                'input.message',
            ],

            /**
             * Where a frame's time went: every phase by self time, the slowest
             * frames, and the share of each that was ours rather than the
             * guest's.
             *
             * @param {number} [worst] How many of the slowest frames to name.
             */
            profile: worst=>core.api('log').profile(worst),

            /** @param {number} [count] The most recent frames, one row each. */
            frames: count=>core.api('log').frames(count),

            /**
             * The journal's block and every layer's tables, for a reader on
             * another thread. Handed over once: everything above is then read
             * there, out of this memory, and this thread is never asked for a
             * record, a frame or a counter again.
             *
             * @returns {import('./layers/log/internal/reader.js').LogMemory}
             */
            memory: ()=>core.api('log').memory(),
        },

        /** @param {(handle: number, text: string) => void} sink */
        attachLog(sink){
            /** @param {any} payload */
            const handler = payload=>{
                sink(payload.handle, payload.text);
            };
            logSinks.set(sink, handler);
            events.on('output', handler);
        },
        /** @param {(handle: number, text: string) => void} sink */
        detachLog(sink){
            const handler = logSinks.get(sink);
            if (handler)
            {
                events.off('output', handler);
                logSinks.delete(sink);
            }
        },

        /**
         * Puts a message in the guest's queue: a keystroke, a mouse move, a
         * request to close. This is the seam the input layer will post through,
         * and the way a test drives a program that is waiting for a user.
         *
         * @param {{ hwnd?: number, message: number, wParam?: number, lParam?: number }} message
         */
        post(message){
            win32.queue().post({
                hwnd: message.hwnd ?? foreground(),
                message: message.message,
                wParam: message.wParam ?? 0,
                lParam: message.lParam ?? 0,
            });
        },

        /**
         * Input, which a program reads two ways at once: `attach` listens to
         * the viewport the game draws into and turns what happens there into
         * both a window message and a change of DirectInput state.
         *
         * `send` is the same road without a browser on it, for a test or a
         * recorded session; `poll` reads what has no events of its own -- a
         * gamepad -- and belongs on whatever already runs once a frame, since
         * a scheduler turn is far too often to ask.
         */
        input: {
            /** @param {any} canvas @param {{ pointerLock?: boolean }} [inputOptions] */
            attach: (canvas, inputOptions)=>input.attach(canvas, inputOptions),
            detach: ()=>input.detach(),
            /** @param {any} event */
            send: event=>input.send(event),
            poll: ()=>input.poll(),
            route: ()=>createInputRoute(event=>input.send(event)),
        },

        /**
         * A window on the running machine, for a tool that has to look at it.
         *
         * Deliberately narrow and read-only: what a diagnostic needs is to see
         * what a program was given, and everything else it might ask for is
         * already an event or a diagnostics counter.
         */
        debug: {
            /** @param {number} address @param {number} length */
            read: (address, length)=>memory.readBytes(address >>> 0, length),
            /**
             * Whether a system library this build makes exports a name, or a
             * number when there is no name: what an import table is checked
             * against without running the program (tools/import-audit.mjs).
             * Null for a library this build does not make.
             *
             * @param {string} dll @param {string | null} name @param {number | null} [ordinal]
             */
            exported: (dll, name, ordinal = null)=>{
                const module = systemLibraries.has(moduleKeyOf(dll)) ? findModule(dll) : null;
                if (!module)
                {
                    return null;
                }
                return (name !== null ? module.addressOf(name)
                    : module.addressOfOrdinal(ordinal ?? -1)) !== null;
            },
            /**
             * The desktop the window manager paints into, or null before any
             * window has drawn: for a tool that writes the screen to a file.
             *
             * @returns {{ width: number, height: number, pitch: number,
             *     bytes: Uint8Array } | null}
             */
            desktop: ()=>{
                const surface = core.api('graphics').gdiDrawing().desktop();
                return surface
                    ? { width: surface.width, height: surface.height, pitch: surface.pitch,
                        bytes: surface.bytes.subarray(surface.offset,
                            surface.offset + surface.pitch * surface.height) }
                    : null;
            },
            /** Every live window, children included, as the window manager lists them. */
            windows: ()=>win32.windows(),
            ...liveDumpOf(options.device?.worker, {
                pause: pauseRun,
                resume: resumeRun,
                paused: ()=>paused !== null,
            }),
            /** @param {string} name */
            register: name=>cpu.readReg32(name),
            eip: ()=>cpu.eip(),
            /**
             * Every image mapped so far and where: for a tool that watches a
             * routine in a library the program imported, which was mapped
             * before the run and so never announced itself as loaded.
             *
             * @returns {{ name: string, base: number, size: number }[]}
             */
            modules: ()=>[...new Set(byName.values())].map(module=>({
                // The program's own image by its file, which is the name a
                // tool asks for it by; its record's own name is a stand-in.
                name: module === mainModule
                    ? String(mainModule.path).split(/[\\/]/).pop() ?? module.name
                    : module.name,
                base: module.base,
                size: module.size ?? 0,
            })),
            /**
             * Which image an address belongs to, or null: a stack of return
             * addresses is a list of numbers until each is given its module.
             *
             * @param {number} address
             */
            moduleAt: address=>{
                const at = address >>> 0;
                for (const module of byName.values())
                {
                    if (at >= module.base && at < module.base + (module.size ?? 0))
                    {
                        return { name: module.name, base: module.base, offset: at - module.base };
                    }
                }
                return null;
            },
            /**
             * A watch in front of a routine nothing imports, so a call the
             * program makes into its own code appears in the trace with its
             * arguments and its answer.
             *
             * The routine's opening instructions, whose lengths the caller
             * read off a disassembly, move to a trampoline that ends in a
             * jump back, and the entry becomes a jump into a watch stub whose
             * target is the trampoline. They must hold no relative branch. A
             * diagnostic, and a rewrite of the program's code: for a run
             * under observation, never for one that is meant to be faithful.
             *
             * @param {number} address
             * @param {{ label: string, argBytes: number, lengths: number[],
             *     strings?: (number | string)[] }} how
             */
            hook: (address, { label, argBytes, lengths, strings = [] })=>{
                const displaced = lengths.reduce((sum, n)=>sum + n, 0);
                const at = address >>> 0;
                const region = memory.find(at);
                if (!region)
                {
                    throw new Error(`hook: nothing is mapped at 0x${at.toString(16)}`);
                }
                const moved = memory.readBytes(at, displaced).slice();
                if (!relocatablePrefix(moved, lengths))
                {
                    throw new Error(`hook: the first ${displaced} bytes at 0x${at.toString(16)}`
                        + ' cannot be moved (too few, or a relative branch among them)');
                }
                const trampoline = allocateFromHeap(displaced + 5);
                memory.writeBytes(trampoline, moved);
                memory.writeBytes(trampoline + displaced,
                    jumpBytes(trampoline + displaced, at + displaced));
                const stub = installWatch(label, argBytes, trampoline, strings);
                const patch = new Uint8Array(displaced).fill(0x90);
                patch.set(jumpBytes(at, stub));
                // Opened for the write and put back exactly as it was: an image
                // whose data the program writes is mapped writable, and leaving
                // it read-only would fault the program's next store.
                const before = region.access;
                memory.protect(region.name, memory.Access.READ_WRITE_EXECUTE);
                memory.writeBytes(at, patch);
                memory.protect(region.name, before);
                return { stub, trampoline };
            },
        },

        /**
         * The sound this process is making, for whoever is playing it.
         *
         * `memory()` is what goes to an audio worklet: shared memory, so the
         * two sides never wait for each other -- `{ table }` when this
         * process has a shared table, `{ control, samples }` when it has the
         * engine backend's ring instead. `ring()`/`table()` are the live
         * object itself, for a caller on this same thread (this process's own
         * `run` below calls `pump` once a scheduler turn; a test harness
         * without shared memory reads `ring()` directly).
         */
        audio: {
            /** A span of the output's arena for a process beside this one. @param {number} bytes */
            lend: bytes=>core.api('audio').output().lend?.(bytes) ?? -1,
            /** @param {number} offset @param {number} bytes */
            takeBack: (offset, bytes)=>core.api('audio').output().takeBack?.(offset, bytes),
            ring: ()=>core.api('audio').output().ring,
            table: ()=>core.api('audio').output().table,
            memory: ()=>core.api('audio').output().memory,
            format: ()=>{
                const mixer = core.api('audio').output();
                return { sampleRate: mixer.sampleRate, channels: mixer.channels };
            },
        },

        /**
         * The decoder this machine uses, for the process that takes its place.
         *
         * A machine is a process; the decoder is not. Handed on, the rebuilt
         * machine's first cinematic does not wait for a second instantiation
         * of the same binary, and nothing outside the machine that wants one
         * decoder for the run has to reach into a module to find it.
         */
        media: {
            instance: ()=>core.api('media').instance?.() ?? null,
        },

        /** The registry the program reads and writes; it outlives the process. */
        registry: ()=>win32.registry(),

        /**
         * The libraries this build synthesises as Windows' own, by file name
         * (`windowsLibraries`): what a bottle does not carry out of system32.
         *
         * @returns {string[]}
         */
        systemLibraries: ()=>[...windowsLibraries],

        /**
         * The session: everything the program has written, and the way to put
         * files in from outside.
         */
        session: {
            /** @returns {{ path: string, bytes: Uint8Array }[]} */
            export: ()=>filesystem.export(),
            /** @returns {string[]} The empty directories it made, which `export` cannot carry. */
            directories: ()=>filesystem.exportDirectories(),
            /**
             * @param {{ path: string, bytes?: Uint8Array, delete?: boolean }[]} changes
             * @param {{ quiet?: boolean }} [how]
             */
            apply: (changes, how)=>filesystem.apply(changes, how),
            /** @returns {number} */
            generation: ()=>filesystem.generation(),
            /** @param {number} mark */
            changesSince: mark=>filesystem.changesSince(mark),
            /**
             * Whether another process's session is on the same drives as this
             * one's: the run's, where what one writes the other reads.
             *
             * @param {any} other
             */
            shares: other=>filesystem.runVolume() !== null
                && other?.runVolume?.() === filesystem.runVolume(),
            /** The run's drives this session is on, or null for this process's own. */
            runVolume: ()=>filesystem.runVolume(),
        },

        /**
         * The volume as the program sees it, read from outside while it runs:
         * a directory's entries and a file's bytes, the bundle, the system
         * volume and what the program wrote alike.
         */
        files: {
            /**
             * @param {string} path
             * @returns {{ name: string, path: string, directory: boolean, size: number,
             *     modified: number }[]}
             */
            list: path=>filesystem.list(path).map((/** @type {any} */ entry)=>({
                name: entry.name, path: entry.path, directory: entry.directory === true,
                size: entry.size ?? 0, modified: entry.modified ?? 0 })),
            /**
             * The whole file. Bytes of the bundle not fetched yet read as what
             * the bundle's reader answers for them.
             *
             * @param {string} path
             * @returns {Uint8Array}
             */
            read: path=>{
                const handle = filesystem.open(path,
                    { read: true, shareRead: true, shareWrite: true });
                try
                {
                    return filesystem.read(handle, filesystem.size(handle));
                }
                finally
                {
                    filesystem.close(handle);
                }
            },
            /**
             * A directory made from outside, as a person makes one in Explorer
             * beside the running program: what an installer expects to find
             * and a disc or an earlier step did not leave.
             *
             * @param {string} path
             * @returns {boolean} true when it was made, false when it was there.
             */
            createDirectory: path=>filesystem.createDirectory(path),
            /**
             * A file or a directory with everything in it, removed from outside: a
             * setting the program saved and would read back, taken away so it asks
             * again.
             *
             * @param {string} path
             * @returns {boolean} true when there was something to remove.
             */
            remove: function remove(path){
                const entry = filesystem.stat(path);
                if (!entry)
                {
                    return false;
                }
                if (entry.directory)
                {
                    for (const child of filesystem.list(path))
                    {
                        remove(child.path);
                    }
                    filesystem.removeDirectory(path);
                }
                else
                {
                    filesystem.deleteFile(path);
                }
                return true;
            },
            /**
             * A file written whole from outside, replacing one of that name.
             *
             * @param {string} path @param {Uint8Array} bytes
             */
            write: (path, bytes)=>{
                const handle = filesystem.open(path,
                    { read: false, write: true, disposition: 'create-always' });
                if (!handle)
                {
                    throw new Error(`${path} could not be created`);
                }
                try
                {
                    filesystem.write(handle, bytes);
                }
                finally
                {
                    filesystem.close(handle);
                }
            },
        },

        /**
         * What the translator has made of this bundle's code, as the seed a
         * bundle carries (`attachTranslations`); null without a translating
         * engine or a store. Asked before `dispose`, which takes the
         * translator away.
         *
         * @returns {Promise<Uint8Array | null>}
         */
        exportTranslations: ()=>cpu.exportTranslations(),

        /**
         * A worker of the run's translation pool, lent to this process: the
         * port is the process's end of the worker's, and the token names it
         * when the pool asks for it back (`recallTranslator`). A machine whose
         * engine takes none tells the worker so at once.
         *
         * @param {MessagePort} port @param {number} token
         */
        lendTranslator(port, token){
            const adapter = portTranslator(port);
            if (cpu.attachTranslator(adapter))
            {
                lentTranslators.set(token, adapter);
            }
            else
            {
                adapter.terminate();
            }
        },

        /** @param {number} token */
        recallTranslator(token){
            const adapter = lentTranslators.get(token);
            if (adapter !== undefined)
            {
                lentTranslators.delete(token);
                cpu.detachTranslator(adapter);
            }
        },

        exitCode: ()=>win32.exitCode(),

        /**
         * The child that is to take this process's place, once `run` has
         * returned. Null while the program is still its own.
         */
        replacement: ()=>kernel.processes.pending(),

        /**
         * Whether that child runs beside this process rather than in its
         * place: whenever this process has not exited. It goes on afterwards.
         *
         * @param {any} request
         */
        waitingOn: (/** @type {any} */ request)=>win32.childWaitedOn(request),

        /**
         * A child that ran beside this process has exited with this code: the
         * threads waiting on it wake. The screen is the run's presenter's to
         * compose again, from the pictures of the processes left.
         *
         * @param {any} request @param {number} code
         */
        childExited(/** @type {any} */ request, /** @type {number} */ code){
            win32.childExited(request, code);
        },

        /**
         * Ends this process from outside, as its parent's TerminateProcess
         * does: the run sees the code at the machine's next turn.
         *
         * @param {number} code
         */
        terminate: (/** @type {number} */ code)=>win32.terminate(code),

        /**
         * A file off this process's volume, waited for if it is not here yet.
         * How the caller reads a child's image before this process -- and the
         * volume with it -- is torn down.
         *
         * @param {string} path
         */
        readImage: path=>readProgramImage(filesystem, blocks, path),

        diagnostics: ()=>[
            ...core.diagnostics(),
            // The run's windows, where this thread keeps them (`manager.js`).
            ...options.system?.windows?.manager ? [{ name: 'windows', status: 'ready',
                metrics: options.system.windows.manager.diagnostics() }] : [],
            {
                name: 'js',
                version: '0.1.0',
                status: 'ready',
                metrics: jsSampler?.snapshot()
                    ?? { measured: false, reason: 'off: the sampleJs option' },
            },
            {
                name: 'app',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    ...events.diagnostics(),
                    bundle: {
                        ...bundleReads, distinct: blocksSeen.size, ahead: blocks?.ahead() ?? 0,
                        refetched: blocks?.refetched().blocks ?? 0,
                        refetchedBytes: blocks?.refetched().bytes ?? 0,
                        ranges: blocks?.ranges().requests ?? 0,
                        rangeBytes: blocks?.ranges().bytes ?? 0,
                        // zstd blocks decoded for guest reads, and the time it took:
                        // a bundle mounted on this thread's; one a process in a
                        // worker reads across its link decodes on the system's.
                        decoded: blocks?.decoded?.().blocks ?? 0,
                        decodedBytes: blocks?.decoded?.().bytes ?? 0,
                        decodeMs: Math.round(blocks?.decoded?.().ms ?? 0),
                    },
                    film: { ...film },
                    // Which of the program's own code the machine is spent on
                    // is not here: the kernel publishes its page counts and the
                    // memory layer its regions, and whoever reads them sums and
                    // sorts on their own thread. A table computed on this one
                    // is a reader's work done by the program.
                    unimplementedCalls: Object.fromEntries(missingCalls),
                    // What was said as a divergence, the first of them: a
                    // consumer that listened for none has no other record of
                    // what this build accepted and did not do, and the journal
                    // has long since let go of a line said once.
                    divergences: [...divergences].slice(0, DIVERGENCES_KEPT),
                    // The guest-to-guest calls a watch was put in front of, by label.
                    watches: [...watches.keys()],
                    // How many calls a site kernel issued through `frame.gl`,
                    // read beside the bridge's own per-hook rows: these calls
                    // never cross the bridge, so they are not in `hooks` at all.
                    kernelGlCalls: glCounters.calls,
                    // Whether the guest's memory is shared with other threads, and
                    // how many processes run at once (`mode.js`).
                    mode: options.mode ?? null,
                    concurrency: options.concurrency ?? 1,
                    // What was asked for and not had, when the run fell back.
                    fallback: options.fallback ?? null,
                    // What a pacing that counts said of the run: in the workers
                    // mode, the page's messages read between turns, the yields
                    // to the event loop, and the sleeps on the doorbell.
                    pacing: /** @type {any} */ (pacing).counts?.() ?? null,
                },
            },
        ],

        /**
         * Where the machine is standing, right now, asked from outside.
         *
         * The same report a failure carries, except that nothing has failed. A
         * run that stops without stopping -- a call that never answers, a
         * window procedure that never returns -- produces no error to attach a
         * trace to, and the call log is no help either: a call is written when
         * it returns, so the one holding everything is the one call absent from
         * it. This is the only way to see it.
         *
         * @returns {string}
         */
        trace: ()=>formatTrace(captureTrace({ cpu, memory, kernel, bridge })),

        /**
         * Everything the engine can say about the run in one answer, for a
         * report a person saves with one click: every layer's diagnostics,
         * the phase profile and the last frames, where the machine stands, and
         * the guest's code around the addresses it spent itself at -- the bytes
         * a question about the translator's code for them is answered from.
         * A request, not for polling: it reads guest memory and describes
         * every layer.
         *
         * The devices drawing in the graphics worker answer what they are
         * asked a message later, so they are asked once and waited for --
         * no longer than `REPORT_WAIT_MS` -- before the tables are read: read
         * at once, the first report of a run would say nothing of them.
         */
        async report(){
            // A build without the graphics layer, or with its stub, has no
            // worker to wait for.
            const answeredByGraphics = async()=>{
                try
                {
                    await core.api('graphics').answered();
                }
                catch {
                    // Nothing was asked of anything that could answer.
                }
            };
            this.diagnostics();
            /** @type {ReturnType<typeof setTimeout> | undefined} */
            let timer;
            await Promise.race([
                answeredByGraphics(),
                new Promise(resolve=>{
                    timer = setTimeout(resolve, REPORT_WAIT_MS);
                }),
            ]);
            clearTimeout(timer);
            const diagnostics = this.diagnostics();
            const cpuTable = diagnostics.find((/** @type {any} */ table)=>table.name === 'cpu');
            /** @type {{ address: number, instructions: number }[]} */
            const top = cpuTable?.metrics?.samples?.top ?? [];
            /** @type {Set<number>} */
            const pages = new Set();
            for (const sample of top.slice(0, HOT_CODE_SAMPLES))
            {
                // The page the address is on and the one after: a region the
                // translator formed there runs on past the page's end.
                pages.add((sample.address & ~0xfff) >>> 0);
                pages.add(((sample.address & ~0xfff) + 0x1000) >>> 0);
            }
            /** @type {{ address: number, base64: string }[]} */
            const hotCode = [];
            for (const page of [...pages].sort((left, right)=>left - right))
            {
                try
                {
                    const bytes = memory.readBytes(page, 0x1000);
                    let text = '';
                    for (let at = 0; at < bytes.length; at++)
                    {
                        text += String.fromCharCode(bytes[at]);
                    }
                    hotCode.push({ address: page, base64: btoa(text) });
                }
                catch {
                    // A page nothing is mapped at: the sample was in code the
                    // program has since let go of.
                }
            }
            const log = core.api('log');
            return {
                diagnostics,
                profile: log.profile(20),
                frames: log.frames(240),
                trace: this.trace(),
                hotCode,
            };
        },
        /**
         * This process's memory for the next one to take, once it has gone,
         * with how much of it the guest may have written; null before then
         * and under an engine that keeps none.
         *
         * @returns {{ memory: WebAssembly.Memory, guestEnd: number } | null}
         */
        spareMemory: ()=>spare,
        dispose(){
            // Read while the machine stands: the arena's mark is the last
            // thing that says where the guest wrote.
            const memoryLeft = cpu.wasmMemory?.() ?? null;
            const guestEnd = win32.heap?.()?.handedTo?.();
            // What the program wrote last is saved now rather than after it
            // settles: the machine it was written on is about to go.
            saver?.flush();
            stopSavingRegistry();
            // Before the graph goes: the background filler would otherwise go
            // on asking for blocks nobody can put anywhere. A run's bundle is
            // the run's to stop, after its last process.
            if (!options.system)
            {
                blocks?.stop();
            }
            breathe.close();
            jsSampler?.stop();
            return core.dispose().then(()=>{
                if (ownsTranslationStore)
                {
                    translationStore?.close?.();
                }
                spare = memoryLeft && typeof guestEnd === 'number'
                    ? { memory: memoryLeft, guestEnd } : null;
            });
        },
    };
}

/**
 * How long a report waits for the graphics worker's devices to say what they
 * counted: a worker that is far behind, or gone, leaves their tables as they
 * were rather than holding the report.
 */
const REPORT_WAIT_MS = 1000;

/** How many divergences a run's diagnostics list, in the order they were said. */
const DIVERGENCES_KEPT = 128;

/**
 * How many replacement requests are remembered.
 *
 * The ring exists because a replacement erases its own evidence: the machine it
 * was asked for in is gone, and every log and counter in it with it. A launcher
 * that re-execs in a loop would otherwise leave nothing but its last iteration.
 */
const REPLACEMENT_HISTORY = 16;

/** The engine's own end-of-game box: MB_OK with MB_ICONINFORMATION. */
const EXIT_NOTICE_TYPE = 0x40;

/**
 * What of a run's options never goes to a process in a worker of its own:
 * the system's -- its drives, session, bundle, devices and bus -- which the
 * process reaches across its link, and what a process is handed of its own.
 */
const SYSTEM_OPTIONS = new Set(['system', 'relay', 'pacing', 'device', 'bundle', 'storage',
    'discs', 'files', 'seed', 'events', 'spawned', 'logSinks', 'win32', 'watchImport', 'hooks',
    'executable', 'standardFiles', 'fallback', 'graphics', 'audio', 'cork', 'log', 'com']);

/**
 * A value as it crosses to another thread's start: data -- numbers, strings,
 * bytes, arrays and plain objects of those -- and nothing that is a function
 * or an object of a class, which a structured clone refuses or empties.
 *
 * @param {any} value @param {number} [depth]
 * @returns {any}
 */
function portable(value, depth = 0){
    if (value === null || typeof value !== 'object')
    {
        return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer
        || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer))
    {
        return value;
    }
    if (depth > 8)
    {
        return undefined;
    }
    if (Array.isArray(value))
    {
        return value.map(item=>portable(item, depth + 1) ?? null);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype)
    {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item])=>
        [key, portable(item, depth + 1)]).filter(([, item])=>item !== undefined));
}

/**
 * The run's options a process in a worker of its own starts with: the
 * engine, the mode, the Windows, the display, the knobs, the decoders'
 * binaries.
 *
 * @param {AppOptions} options
 */
function portableOptions(options){
    return portable(Object.fromEntries(Object.entries(options)
        .filter(([key])=>!SYSTEM_OPTIONS.has(key))));
}

/**
 * The table of the journal a machine writes on this thread: the system's,
 * where the program's own journal is in a worker and its table is `log`.
 *
 * @param {any[]} tables
 */
const journalOf = tables=>tables.find(table=>table.name === 'system-log')
    ?? tables.find(table=>table.name === 'log');

/**
 * The call areas a run's journal starts with switched off; see `buildApp`.
 */
const CALLS_OFF = Object.freeze({
    'call.cpu': 'off', 'call.gpu': 'off', 'call.audio': 'off', 'call.video': 'off',
    'call.input': 'off', 'call.net': 'off', 'call.com': 'off', 'call.hook': 'off',
});

/**
 * The run's system where every process of it stands in a worker of its own
 * (`concurrency` above 1): this thread runs no program. What a process's
 * machine is to the page -- its log, its sound, its input, its files and
 * registry, the calls that look inside a running program -- this answers in
 * that shape. The journal, the sound output, the volume, the bundle and the
 * registry are the system's own, made here before any process; what only a
 * process has is asked of the run's first process across its link, and the
 * page's input goes to the process started last of those standing, as it
 * goes to a child the moment it starts.
 *
 * @param {{ options: AppOptions, events: any, system: any, translationStore: any,
 *     now: () => number,
 *     across: () => { image: string, id: number, link: ReturnType<typeof openLink> }[],
 *     libraries: () => string[] }} deps
 *     `across`: the processes standing in workers, oldest first; `libraries`:
 *     the system libraries the run's own program knew, once it is over
 */
async function buildSystemHost(deps){
    const { options, events, system, translationStore, now, across, libraries } = deps;
    const core = await assembleModules({
        ...Object.fromEntries(defaultModules().map(module=>[module.name, false])),
        log: { categories: { ...CALLS_OFF, ...options.log?.categories },
            capacity: options.log?.capacity, bytes: options.log?.bytes, now },
        filesystem: { volume: system.volume },
    });
    const filesystem = core.api('filesystem');
    const journal = core.api('log');
    journalEvents(events, journal.journal?.() ?? journal);
    system.registry = createRunRegistry({
        windows: options.windows,
        directx: options.graphicsApi
            ? GRAPHICS_CHOICES[options.graphicsApi].directx ?? undefined : undefined,
        processorMhz: CORK_TSC_MHZ,
        processorName: processorName(SETTINGS),
    });
    system.windows = createWindowDirectory();
    const { seeded, saver, stopSavingRegistry } = await openSession({ options, events,
        filesystem, registry: system.registry, inherited: false });
    // Cork's own decoder reads the bundle's blocks: no processor is asked.
    const blocks = await mountBundle({ options, cpu: null, events, translationStore });
    system.bundle = blocks;
    await furnishVolume({ options, events, filesystem, blocks, seeded,
        registry: system.registry });
    // The output every process plays into, each in a span of its arena lent
    // it; the page's worklet reads the table.
    const given = options.audio?.memory;
    const output = createMixer({ shared: true, sampleRate: options.audio?.sampleRate,
        memory: given && 'table' in given ? given : undefined });

    /** The run's own program: the first process standing. */
    const first = ()=>across()[0] ?? null;
    /**
     * What only a process has, asked of the run's own program.
     *
     * @param {string} path  a member of its machine, `debug.read`
     * @param {any[]} [args]
     */
    const ask = (path, args = [])=>{
        const process = first();
        return process
            ? process.link.call('facade', 'call', [path, args]).then(eventFrom)
            : Promise.reject(new Error(`${path}: no process of the run stands`));
    };
    /** Every process standing, told the same. @param {string} method */
    const tellAll = method=>{
        for (const process of across())
        {
            process.link.call('control', method, []).catch(()=>{});
        }
    };
    /** Whether the run was last told to pause, for a tool that must draw a frame. */
    let pausedByCaller = false;
    /** The canvas the page's pointer is measured on, once attached. @type {any} */
    let viewport = null;
    /**
     * The run's own program's tables, as it last answered or as it ended:
     * what a reader of the run's diagnostics wants of its processor, its
     * pacing and its devices is there, not on this thread.
     *
     * @type {any[]}
     */
    let programTables = [];
    /**
     * The tables this thread keeps for the run -- its journal, its sound
     * output, the window manager -- under the names a program's own tables
     * have where it runs on this thread. The program's journal and sound
     * (its phases, frames, pumps, buffers) are what a reader of a run wants
     * under those names, as with one process; this thread's go beside them,
     * always under the name given here, so a name says whose table it is.
     */
    const ownTables = new Map([['log', 'system-log'], ['audio', 'system-audio'],
        ['windows', 'windows']]);

    return {
        log: {
            /** @param {'error' | 'warn' | 'info'} level @param {string} category @param {string} text */
            write: (level, category, text)=>journal.write(level, category, '{0}', text),
            /** @param {number} [since] @param {number} [limit] */
            drain: (since, limit)=>journal.drain(since, limit),
            /** @param {number} [count] */
            recent: count=>journal.recent(count),
            journal: ()=>journal.journal?.() ?? null,
            /** @param {string} category @param {string | number} level */
            setLevel: (category, level)=>journal.setLevel(category, level),
            /** @param {string | number} level */
            setDefaultLevel: level=>journal.setDefaultLevel(level),
            /** @param {number} [worst] */
            profile: worst=>journal.profile(worst),
            /** @param {number} [count] */
            frames: count=>journal.frames(count),
            memory: ()=>journal.memory(),
        },
        audio: {
            /** @param {number} bytes */
            lend: bytes=>output.lend(bytes),
            /** @param {number} offset @param {number} bytes */
            takeBack: (offset, bytes)=>output.takeBack(offset, bytes),
            table: ()=>output.table,
            memory: ()=>output.memory,
            format: ()=>({ sampleRate: output.sampleRate, channels: output.channels }),
        },
        media: { instance: ()=>null },
        input: {
            /** @param {any} canvas */
            attach: canvas=>{
                viewport = canvas;
                return null;
            },
            detach: ()=>{
                viewport = null;
            },
            /** @param {any} event */
            send: event=>{
                // To the process of the window the run's manager says should
                // have it (`inputTarget`, where `routedInput` explains the rest).
                const standing = across();
                const manager = system.windows?.manager;
                const target = manager?.inputTarget(event) ?? null;
                if (target === null && manager?.topLevel().some((/** @type {any} */ state)=>state.visible))
                {
                    return false;
                }
                const process = standing.find(each=>each.id === target) ?? standing.at(-1);
                process?.link.call('input', 'send', [event, viewport
                    ? { width: viewport.width, height: viewport.height } : null]).catch(()=>{});
                return Boolean(process);
            },
            poll: ()=>{},
            /** @returns {ReturnType<typeof createInputRoute>} */
            route(){
                return createInputRoute(event=>this.send(event));
            },
        },
        pause: ()=>{
            pausedByCaller = true;
            tellAll('pause');
        },
        resume: ()=>{
            pausedByCaller = false;
            tellAll('resume');
        },
        paused: ()=>pausedByCaller,
        stop: ()=>tellAll('stop'),
        answerMessageBox: ()=>false,
        on: (/** @type {string} */ name, /** @type {(payload: any) => any} */ handler)=>
            events.on(name, handler),
        off: (/** @type {string} */ name, /** @type {(payload: any) => any} */ handler)=>
            events.off(name, handler),
        /** @param {(handle: number, text: string) => void} sink */
        attachLog(sink){
            events.on('output', (/** @type {any} */ payload)=>sink(payload.handle, payload.text));
        },
        guestProfile: {
            instructionStats: ()=>ask('guestProfile.instructionStats'),
            available: ()=>ask('guestProfile.available'),
            /** @param {any} how */
            start: how=>ask('guestProfile.start', [how]),
            stop: ()=>ask('guestProfile.stop'),
            read: ()=>ask('guestProfile.read'),
        },
        debug: {
            /** @param {number} address @param {number} length */
            read: (address, length)=>ask('debug.read', [address, length]),
            modules: ()=>ask('debug.modules'),
            /** @param {number} address */
            moduleAt: address=>ask('debug.moduleAt', [address]),
            windows: ()=>ask('debug.windows'),
            desktop: ()=>ask('debug.desktop'),
            /** @param {number} address @param {any} how */
            hook: (address, how)=>ask('debug.hook', [address, how]),
            ...liveDumpOf(options.device?.worker, {
                pause: ()=>{
                    pausedByCaller = true;
                    tellAll('pause');
                },
                resume: ()=>{
                    pausedByCaller = false;
                    tellAll('resume');
                },
                paused: ()=>pausedByCaller,
            }),
        },
        trace: ()=>ask('trace'),
        report: ()=>ask('report'),
        recordedSession: ()=>ask('recordedSession'),
        registry: ()=>system.registry,
        // Asked while the program stands; once it is over, what it knew.
        systemLibraries: ()=>(across().length > 0 ? ask('systemLibraries') : libraries()),
        session: {
            export: ()=>filesystem.export(),
            directories: ()=>filesystem.exportDirectories(),
            /** @param {any[]} changes @param {{ quiet?: boolean }} [how] */
            apply: (changes, how)=>filesystem.apply(changes, how),
            generation: ()=>filesystem.generation(),
            /** @param {number} mark */
            changesSince: mark=>filesystem.changesSince(mark),
            runVolume: ()=>filesystem.runVolume(),
        },
        files: {
            /** @param {string} path */
            list: path=>filesystem.list(path).map((/** @type {any} */ entry)=>({
                name: entry.name, path: entry.path, directory: entry.directory === true,
                size: entry.size ?? 0, modified: entry.modified ?? 0 })),
            /** @param {string} path */
            read: path=>{
                const handle = filesystem.open(path,
                    { read: true, shareRead: true, shareWrite: true });
                try
                {
                    return filesystem.read(handle, filesystem.size(handle));
                }
                finally
                {
                    filesystem.close(handle);
                }
            },
        },
        /** @param {string} path */
        readImage: path=>readProgramImage(filesystem, blocks, path),
        /**
         * The program's tables as it last answered -- asked again now, for the
         * next reader -- with the journal and the sound output this thread
         * keeps for the run.
         */
        diagnostics: ()=>{
            first()?.link.call('report', 'diagnostics', []).then(tables=>{
                if (Array.isArray(tables))
                {
                    programTables = tables;
                }
            }, ()=>{});
            const own = [...core.diagnostics(),
                { name: 'audio', status: 'ready', metrics: output.diagnostics() },
                { name: 'windows', status: 'ready',
                    metrics: system.windows.manager.diagnostics() }];
            const theirs = programTables.filter(table=>ownTables.get(table.name) !== table.name);
            const named = new Set(theirs.map(table=>table.name));
            return [...own.map(table=>({ ...table, name: ownTables.get(table.name) ?? table.name }))
                .filter(table=>!named.has(table.name)), ...theirs];
        },
        /** The program's tables as it ended. @param {any[] | undefined} tables */
        ended: tables=>{
            if (Array.isArray(tables))
            {
                programTables = tables;
            }
        },
        dispose(){
            tellAll('stop');
            saver?.flush();
            stopSavingRegistry();
            return core.dispose();
        },
    };
}

/**
 * What of a run's volume lives in memory every thread holds, where there is
 * shared memory: a word per drive letter, raised by every change to the
 * drive, under which a process in a worker of its own keeps what it read of
 * the drive; and the sharing every open is settled against, which that
 * process settles its own opens in (`volume-link.js`). A run without shared
 * memory has no process across a link, and keeps neither.
 *
 * @returns {{ revisions?: Int32Array, sharing?: any, sharingMemory?: SharedArrayBuffer }}
 */
function volumeMemory(){
    if (typeof SharedArrayBuffer !== 'function')
    {
        return {};
    }
    const sharingMemory = createSharingMemory();
    return { revisions: new Int32Array(new SharedArrayBuffer(26 * 4)),
        sharing: openSharedSharing(sharingMemory), sharingMemory };
}

/**
 * A running program's frames written down on asking, by the devices the
 * graphics worker plays: `dumpFrames(n)` has the next n frames with draws
 * written down, every draw with its shaders, stages and state, and
 * `dumped()` is the last of them as the worker sent it -- from the device
 * that drew it, which a diagnostics table read a report later need not be.
 *
 * @param {any} worker  the graphics worker, when the run has one
 * @param {{ pause: () => void, resume: () => void, paused: () => boolean }} [control]
 *     the run's pause, which `pick` holds while it takes a frame apart
 */
function liveDumpOf(worker, control){
    /** @type {{ lines: string[], frame: number } | null} */
    let last = null;
    let listening = false;
    /** @param {number} [frames] */
    const dumpFrames = (frames = 1)=>{
        if (!worker)
        {
            throw new Error('dumpFrames: this run draws without a graphics worker');
        }
        if (!listening)
        {
            listening = true;
            worker.addEventListener('message', (/** @type {{ data: any }} */ event)=>{
                if (event.data?.type === 'dumped')
                {
                    last = { lines: event.data.lines, frame: event.data.frame };
                }
            });
        }
        worker.postMessage({ type: 'debug', dumpFrames: frames });
        return frames;
    };
    return {
        dumpFrames,
        /**
         * How the worker's devices take buffer locks from now on: '' as the
         * program asked, 'rename' renaming at every one.
         *
         * @param {string} [mode]
         */
        bufferLocks: (mode = '')=>{
            if (!worker)
            {
                throw new Error('bufferLocks: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', bufferLocks: mode });
            return mode;
        },
        /**
         * Drops every draw that samples one of these textures from now on --
         * `t12,t40` as a frame dump names them, '' none -- so two frames
         * differ by those draws and nothing else.
         *
         * @param {string} [ids]
         */
        skipTexture: (ids = '')=>{
            if (!worker)
            {
                throw new Error('skipTexture: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', skipTexture: ids });
            return ids;
        },
        /**
         * Keeps the first `count` draws of every frame from now on and drops
         * the rest, -1 none dropped: halving it finds the draw that painted a
         * part of the picture, numbered as a frame dump numbers them.
         *
         * @param {number} [count]
         */
        maxDraws: (count = -1)=>{
            if (!worker)
            {
                throw new Error('maxDraws: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', maxDraws: count });
            return count;
        },
        /**
         * How the worker's devices answer occlusion counts from now on: ''
         * as counted, 'visible' as if every sample passed -- what a program
         * culls by its counts shows up.
         *
         * @param {string} [mode]
         */
        occlusion: (mode = '')=>{
            if (!worker)
            {
                throw new Error('occlusion: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', occlusion: mode });
            return mode;
        },
        dumped: ()=>last,
        /**
         * Shows the last frame again and again, the program paused, so a cut
         * (`maxDraws`) is seen on a picture that holds still; false stops it.
         *
         * @param {boolean} [on]
         */
        freeze: (on = true)=>{
            if (!worker)
            {
                throw new Error('freeze: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', freeze: on });
            return on;
        },
        /**
         * Which draw painted a pixel of the picture: the program is paused and
         * the graphics worker plays its last frame again cut after fewer and
         * fewer draws, reading the pixel back each time, halving to the first
         * count at which it is as the scene leaves it (before the frame's
         * post-processing). The centre -- a crosshair -- by default; the run
         * is left paused as it was found.
         *
         * @param {number} [x] @param {number} [y]  the shown frame's pixels
         * @param {{ tolerance?: number, depth?: number }} [options]  how far a
         *     channel may differ and still be the same pixel; how many of the
         *     draws that changed it to list, latest first (4)
         */
        pick: async(x, y, options = {})=>{
            if (!worker)
            {
                throw new Error('pick: this run draws without a graphics worker');
            }
            const wasPaused = control?.paused() ?? true;
            if (!wasPaused)
            {
                control?.pause();
                // The frames on their way when it paused land first.
                await new Promise(done=>setTimeout(done, 400));
            }
            try
            {
                return await new Promise((resolve, reject)=>{
                    const hear = (/** @type {{ data: any }} */ event)=>{
                        if (event.data?.type !== 'picked')
                        {
                            return;
                        }
                        worker.removeEventListener('message', hear);
                        if (event.data.error)
                        {
                            reject(new Error(event.data.error));
                        }
                        else
                        {
                            resolve(event.data.result);
                        }
                    };
                    worker.addEventListener('message', hear);
                    worker.postMessage({ type: 'debug',
                        pick: { x, y, tolerance: options.tolerance, depth: options.depth } });
                });
            }
            finally
            {
                if (!wasPaused)
                {
                    control?.resume();
                }
            }
        },
    };
}

/**
 * createApp — the consumer-facing entry point.
 *
 * One machine running at a time, and a process lifecycle over the top: when
 * the program starts a child and then waits on it, the child runs on a
 * machine of its own built beside the parent's, and the parent goes on with
 * the child's exit code and whatever it wrote; when the program starts a child
 * and exits, the machine is torn down and rebuilt on the child's image. A
 * parent that runs genuinely alongside its child -- both executing at once --
 * is not covered.
 *
 * @param {AppOptions} options
 * @returns {Promise<any>} an AppController
 */
export async function createApp(options){
    // Refused before anything is built: a machine made to the wrong Windows
    // fails later somewhere that says nothing about why.
    windowsVersion(options.windows);
    // Settled once, here, so every process the run makes is built in it.
    options = withRunMode(options);
    options = { ...options, processId: options.processId ?? runProcessId() };
    graphicsChoice(options.graphicsApi);
    emulatorOf(options);
    // Both outlive every process: subscriptions a caller made before the first
    // child existed still have to fire for the last one, and the record of what
    // asked for a replacement is worthless if it dies with the asker.
    const events = createEvents();
    // A process in a worker of its own tells the run's bus what happens to
    // it: the page subscribes there, on the thread that started it.
    if (options.relay)
    {
        events.onAny(options.relay);
    }
    // A run asked for more than this page allows starts all the same, as
    // much as it allows, and says so: the first subscriber hears it.
    if (options.fallback)
    {
        events.emit('fallback', { ...options.fallback, mode: options.mode,
            concurrency: options.concurrency });
    }
    /** @type {any[]} */
    const requested = [];

    /** @param {any} request */
    const remember = request=>{
        requested.push(request);
        if (requested.length > REPLACEMENT_HISTORY)
        {
            requested.shift();
        }
    };

    // The log's reader surface outlives the process it was made against, for
    // the same reason `events` does. A page that raised a level, attached a
    // sink or holds a drain cursor did so before the handover and must not have
    // to notice it: the machine is rebuilt, the log is not.
    const logSinks = new Map();
    // A named mutex, event, semaphore, timer or file mapping outlives the
    // process that named it too: the single-instance idiom this exists for is
    // exactly a parent naming an object and a child -- what a replacement
    // makes of this same process -- discovering it by that name.
    /** @type {Map<string, { kind: string, object: any }>} */
    const namedObjects = new Map();
    /**
     * What every process of the run shares (`win32`'s `system`): the named
     * objects, and the registry -- the first process's hive, the one each
     * later process is handed rather than a copy of it.
     *
     * @type {{ namedObjects: Map<string, any>, registry: any, bundle: any, windows: any,
     *     ids: { thread: number, process: number },
     *     volume: { drives: Map<string, any>, volumes: Map<string, any>,
     *         writables: Map<string, any>, watchers: Set<Function>, revisions?: Int32Array,
     *         sharing?: any, sharingMemory?: SharedArrayBuffer } }}
     */
    // A process in a worker of its own is handed the run's across a link
    // (`system-link.js`), and joins it rather than making one.
    const system = options.system ?? { namedObjects, registry: null, bundle: null, windows: null,
        ids: { thread: 1, process: 0x2000 },
        volume: { drives: new Map(), volumes: new Map(), writables: new Map(),
            watchers: new Set(), ...volumeMemory() } };
    /**
     * A process id and its first thread's, from the run's, for a process no
     * parent was told of: a class's server, which COM starts.
     */
    const newProcessIds = ()=>{
        const processId = system.ids.process;
        // Eight, as the kernel's process table steps: a process and its thread.
        system.ids.process += 8;
        return { processId, mainThreadId: processId + 1 };
    };
    /** @type {Map<string, string | number>} */
    const logLevels = new Map();
    /** @type {string | number | null} */
    let logDefaultLevel = null;
    let logSequence = 0;
    /** The journal every process of the run writes into; the first one's. @type {any} */
    let runJournal = null;
    // The journal's own clock, one for the run. A process's guest clock is
    // not it: each machine has its own, a parent's stands still while the
    // child beside it runs, and a replacement's starts again from zero.
    const journalOrigin = performance.now();
    const journalClock = ()=>performance.now() - journalOrigin;
    // The sound output's storage outlives the process for the same reason, and
    // for one more: the page was handed it before any of this ran and builds
    // its audio graph over that memory once. A rebuilt machine has to mix into
    // the same storage rather than make new storage nobody reads --
    // `{ table }` with a shared track table, `{ control, samples }` with the
    // engine backend's ring.
    /** @type {any} */
    let audioMemory = null;
    // The decoded binary's instance outlives the process too: a machine is a
    // process, the decoder is a service of the run. The child attaches to the
    // parent's compiled module and linear memory, so the first cinematic after
    // a swap does not wait for another instantiation.
    /** @type {any} */
    let mediaInstance = null;
    // The presenter is a service of the run too, and for the same reason: a
    // machine is a process, but the canvas it draws into is not. Made once
    // here -- from the GPU the worker opened and the canvas the device carries
    // -- and handed to every machine, so a replacement does not reconfigure
    // the canvas or clear the frame the parent last presented.
    /** @type {any} */
    const presenter = options.graphics?.presenter ?? (options.device
        ? createPresenter({
            device: options.device.device,
            queue: options.device.queue,
            screen: options.device.screen,
            canvas: options.device.canvas,
            now: options.device.now,
            maxFps: options.maxFps ?? SETTINGS.frame.maxFps,
            // One bound for the run: every machine's frames go onto one queue.
            maxFrameLatency: options.graphics?.maxFrameLatency,
            // A build with no canvas but with a sink of its own -- a test
            // harness reading the frame back -- still gets its frames.
            presentTo: options.device.presentTo,
            // The host's own record of the frames: it owns the canvas and the
            // counts a page reads, and a frame reaching the canvas is the one
            // thing it cannot compute for itself.
            onFrame: options.device.onFrame,
            onPresented: options.device.onPresented,
            onPresentFailed: options.device.onPresentFailed,
            // The run's windows, by which the screen is composed of every
            // process's picture while more than one has a window showing.
            windows: ()=>{
                const manager = system.windows?.manager;
                return manager ? manager.topLevel().map((/** @type {any} */ state)=>({
                    processId: state.processId, rect: state.rect, visible: state.visible,
                    parent: state.parent })) : [];
            },
            foreground: ()=>{
                const manager = system.windows?.manager;
                const hwnd = manager?.foreground() ?? 0;
                return hwnd !== 0 ? manager.get(hwnd)?.processId ?? null : null;
            },
        })
        // A process in a worker of its own has no GPU: its surfaces' pictures
        // go to the thread that has one, as bytes, each burst as it flushes.
        : options.graphics?.display ? createPresenter({ sendFrame: options.graphics.display })
            : null);

    // The translation store is the run's as well: a child's machine is built
    // beside its paused parent's, and a second store opened on the same
    // directory cannot write while the first holds its records file's
    // synchronous handle -- the child stopped at its first append.
    const runStoreSpec = options.cork?.config?.store === undefined ? 'local'
        : options.cork.config.store;
    const translationStore = await resolveTranslationStore(runStoreSpec,
        options.bundle?.id ?? options.id ?? 'bundle');

    const translationPool = await openTranslationPool(options);
    /** What a machine's translator is told where the run lends it its translators. */
    const lentConfig = translationPool ? { worker: true, translators: 0 } : {};

    /** @param {any} [extra] */
    const machine = extra=>({
        ...options,
        cork: { ...options.cork, config: { ...options.cork?.config, store: translationStore,
            ...lentConfig } },
        events,
        spawned: remember,
        logSinks,
        system,
        log: {
            ...options.log, sequenceBase: logSequence, ...runJournal ? { journal: runJournal } : {},
            now: journalClock,
        },
        audio: { ...options.audio, memory: audioMemory },
        media: { ...options.media, instance: mediaInstance },
        graphics: { ...options.graphics, presenter },
        ...extra,
    });

    // Processes that run at once: a class served by an executable is made in
    // a process of its own, started beside the one that asked for it and
    // running alongside it for as long as anything holds one of its objects.
    // The table of their class objects is the run's, as the service control
    // manager's is the machine's; their files and registry are the run's
    // (`system`), so what one writes the others read at once.
    /** @type {Map<unknown, any>} */
    const processes = new Map();
    /** @type {Map<any, unknown>} */
    const names = new Map();
    /**
     * Which image each machine was built for, for `standing()`: weak, so a
     * machine whose process is over goes, its gigabyte of memory with it.
     *
     * @type {WeakMap<any, string>}
     */
    const images = new WeakMap();
    /** Each machine's process id, as GetCurrentProcessId answers it. @type {WeakMap<any, number>} */
    const processIds = new WeakMap();
    /** @type {Set<Promise<unknown>>} */
    const servers = new Set();
    /** @type {Set<any>} */
    const serving = new Set();
    /** @type {any} */
    let runOptionsNow;
    /** The machines of the run not yet retired. @type {Set<any>} */
    const standing = new Set();
    /** Whether the run's processes run at once, each beside its parent (`mode.js`). */
    const processesAtOnce = (options.concurrency ?? 1) > 1;
    /**
     * Whether every process of the run stands in a worker of its own, its
     * first one too: where processes run at once, on cork, this thread is the
     * system alone and runs no program (`buildSystemHost`).
     */
    const rootAcross = processesAtOnce && !options.system
        && (options.engine ?? DEFAULT_ENGINE) === 'cork';
    /** @type {import('./layers/win32/ole32/remote.js').ClassTableHooks} */
    const serveHere = {
        launch: (request, process)=>{
            const parent = processes.get(process);
            if (!parent)
            {
                return null;
            }
            const exited = startServer(parent, request);
            servers.add(exited);
            exited.finally(()=>servers.delete(exited));
            return { exited };
        },
    };
    // A process in a worker of its own uses the run's table, the system's,
    // across its link (`com-link.js`); a server it starts runs in a worker of
    // its own while the run has room, and beside it here otherwise.
    const classTable = options.system?.com
        ? remoteClassTable(options.system.com, serveHere)
        : createClassTable(serveHere);

    /**
     * The memory of the last process to go, for the next one built: a gone
     * process's memory waits for a garbage collection nothing prompts, and a
     * parent that starts one short-lived child after another -- a compiler a
     * shader at a time -- would hold one memory per child until the page ran
     * out. Taken once.
     *
     * @type {{ memory: WebAssembly.Memory, guestEnd: number } | null}
     */
    let spareMemory = null;
    /** @param {any} gone  a machine disposed */
    const keepMemory = gone=>{
        spareMemory = gone?.spareMemory?.() ?? spareMemory;
    };

    /**
     * A machine for a process, named to the class table.
     *
     * @param {any} [extra]
     */
    const build = async extra=>{
        const process = {};
        /** The machine, once built: what its children are started beside. @type {any} */
        let self = null;
        const reusedMemory = spareMemory;
        spareMemory = null;
        const built = await buildApp(machine({ ...extra, reusedMemory,
            com: { table: classTable, process },
            // With concurrency a child runs from CreateProcess on, beside
            // its parent, as on Windows; otherwise it waits for the parent to
            // have nothing left to run, and runs in its place.
            beside: processesAtOnce
                ? (/** @type {any} */ request)=>startBeside(self, request) : undefined,
            terminate: processesAtOnce ? terminateBeside : undefined,
            // Only where processes run at once: one run in its parent's place
            // has the parent paused, which wakes nothing. A process that joined
            // the run's system from a worker of its own is never the run's only
            // one -- its parent at least stands -- so what it waits on is
            // another's to answer, and the run, not it, says when it is over.
            othersRunning: processesAtOnce
                ? ()=>Boolean(options.system) || starting > 0 || across > 0
                    || [...standing].some(other=>other !== self)
                : undefined }));
        self = built;
        standing.add(built);
        processes.set(process, built);
        names.set(built, process);
        images.set(built, extra?.imagePath ?? '');
        // The run's first process has no extra and the run's own id
        // (`runProcessId`), as the machine it is built with numbers it.
        const id = extra?.processId ?? options.processId ?? FIRST_PROCESS_ID;
        processIds.set(built, id);
        translationPool?.addProcess(id, {
            lend: (port, token)=>built.lendTranslator(port, token),
            recall: token=>built.recallTranslator(token),
        }).catch(()=>{});
        return built;
    };

    /**
     * A process is over: everything its proxies held goes back -- which is
     * what lets a server it was using see its last client go.
     *
     * @param {any} ended
     */
    const retire = async ended=>{
        standing.delete(ended);
        translationPool?.removeProcess(processIds.get(ended)
            ?? options.processId ?? FIRST_PROCESS_ID);
        await classTable.ended(names.get(ended));
        processes.delete(names.get(ended));
        names.delete(ended);
    };

    /** @type {any} */
    /** The system libraries the run's own program knew, once it is over. @type {string[]} */
    let rootLibraries = [];
    let current = rootAcross
        ? await buildSystemHost({ options, events, system, translationStore, now: journalClock,
            across: ()=>[...standingAcross], libraries: ()=>rootLibraries })
        : await build();
    // What every process's devices present comes back from the run's
    // graphics worker to the machine that opened it; where no process stands
    // on this thread, the system takes those frames to the run's presenter.
    const shownHere = rootAcross && presenter && options.device?.worker && options.device.device
        ? connectGraphicsWorker({ worker: options.device.worker, device: options.device.device,
            presentTo: frame=>presenter.show(frame) })
        : null;
    // The first process's journal is the run's: every process built after it,
    // beside it or in its place, writes there, and a reader of the facade's
    // log sees them all in one order on one clock.
    runJournal = current.log.journal?.() ?? null;

    // Read from the machine that made it, while it still stands, and handed to
    // every rebuild from here on.
    try
    {
        audioMemory = current.audio.memory();
    }
    catch {
        // A build with no sound layer has no storage to carry, and that is
        // not a fault: the rebuilt machine runs without one too.
        audioMemory = null;
    }

    /** What a caller holds. Rebound to the live process on every replacement. */
    const facade = /** @type {any} */ ({});

    /** Puts the levels the page set at run time back onto a rebuilt journal. */
    const replayLogLevels = ()=>{
        if (logDefaultLevel !== null)
        {
            current.log.setDefaultLevel(logDefaultLevel);
        }
        for (const [category, level] of logLevels)
        {
            current.log.setLevel(category, level);
        }
    };

    /**
     * Remembers a level set through the facade before passing it to the live
     * journal, so a replacement can be given it again.
     */
    const bindLogLevels = ()=>{
        const live = facade.log;
        facade.log = {
            ...live,
            /** @param {string} category @param {string | number} level */
            setLevel(category, level){
                logLevels.set(category, level);
                return live.setLevel(category, level);
            },
            /** @param {string | number} level */
            setDefaultLevel(level){
                logDefaultLevel = level;
                return live.setDefaultLevel(level);
            },
        };
    };

    /**
     * How deep in `own.run` the run is: a child that runs beside its waiting
     * parent is run through it too, and its exit is not the end of the game.
     */
    /** The page's own line of processes: the program it started, and what replaces it. */
    const mainLine = {
        get current(){
            return current;
        },
        set current(running){
            current = running;
        },
        main: true,
    };
    /** The image of the process running now, the one whose exit ends the game. */
    let imagePath = options.imagePath ?? 'C:\\app.exe';

    /**
     * Tells the player the game is over when it ended by itself with code 0:
     * otherwise the canvas just stops changing, which reads as a hang. The box
     * is the engine's, not the program's -- the process is gone, and nothing
     * waits on its answer -- so it carries id 0, which no program's box does,
     * and `exit` for a page that draws it differently.
     *
     * @param {number} code
     */
    const noticeExit = code=>{
        if (options.exitNotice === false || code !== 0 || (current.exitCode?.() ?? code) !== 0)
        {
            return;
        }
        events.emit('message-box', {
            id: 0,
            text: 'The game has finished and its process has stopped.',
            caption: imagePath.split(/[\\/]/).pop(),
            type: EXIT_NOTICE_TYPE,
            buttons: [{ id: 1, label: 'OK' }],
            defaultButton: 1,
            icon: 'information',
            trace: null,
            exit: { code },
        });
    };

    /**
     * The journal's sequence as the live machine has written it, for the
     * machine built next to continue from.
     */
    const noteLogSequence = ()=>{
        const written = journalOf(current.diagnostics())?.metrics?.journal?.written;
        if (typeof written === 'number')
        {
            logSequence = written;
        }
    };

    /**
     * The executable a server's command line names: quoted, the text inside
     * the quotes; unquoted, the shortest run of words up to a space that is a
     * file, as CreateProcess reads a command line without quotes.
     *
     * @param {any} parent @param {string} command
     * @returns {Promise<{ path: string, image: Uint8Array } | null>}
     */
    const serverImage = async(parent, command)=>{
        const text = command.trim();
        /** @type {string[]} */
        const candidates = [];
        if (text.startsWith('"'))
        {
            const end = text.indexOf('"', 1);
            candidates.push(end > 0 ? text.slice(1, end) : text.slice(1));
        }
        else
        {
            for (let at = text.indexOf(' '); at > 0; at = text.indexOf(' ', at + 1))
            {
                candidates.push(text.slice(0, at));
            }
            candidates.push(text);
        }
        for (const path of candidates.flatMap(one=>(/\.[^\\.]+$/.test(one)
            ? [one] : [one, `${one}.exe`])))
        {
            const image = await parent.readImage(path).catch(()=>null);
            if (image)
            {
                return { path, image };
            }
        }
        return null;
    };

    /**
     * The sound a process started beside `parent` plays into: the run's
     * output, its slots taken as free ones come, and a span of the parent's
     * arena lent for its voices' mirrors -- the largest of four, two, one or
     * half a mebibyte the parent has free, or none, its buffers then played
     * through queues. Given back once the process is gone and has closed
     * what it held.
     *
     * @param {any} parent
     * @param {number} [largest]  the most it is lent
     */
    const lendSound = (parent, largest = 4 << 20)=>{
        let bytes = largest;
        let span = -1;
        for (; bytes >= 512 << 10 && span < 0; bytes /= 2)
        {
            span = parent.audio?.lend?.(bytes) ?? -1;
        }
        bytes *= 2;
        return {
            options: { ...options.audio, memory: audioMemory,
                beside: { arena: span >= 0 ? [span, bytes] : null } },
            giveBack(){
                if (span >= 0)
                {
                    try
                    {
                        parent.audio.takeBack(span, bytes);
                    }
                    catch {
                        // The parent went before the process it lent to.
                    }
                    span = -1;
                }
            },
        };
    };

    /** The tables `ownSound` has named to the page so far. */
    let soundTables = 0;
    /**
     * The sound of a process started beside another on this thread: a table
     * of its own, which the page is told of and mixes with the run's
     * (`sound-table`), and forgets once the process is gone
     * (`sound-table-closed`) -- two processes' sound as two films' playing
     * at once. On the run's table a process beside another was built as the
     * one in its place, and closed every track it found open there: the
     * parent's music went silent at its first child.
     */
    const ownSound = ()=>{
        const id = ++soundTables;
        let told = false;
        return {
            options: { ...options.audio, memory: undefined, beside: undefined },
            /** @param {any} built */
            announce(built){
                const memory = built?.audio?.memory?.();
                if (memory && 'table' in memory)
                {
                    told = true;
                    events.emit('sound-table', { id, table: memory.table });
                }
            },
            giveBack(){
                if (told)
                {
                    told = false;
                    events.emit('sound-table-closed', { id });
                }
            },
        };
    };

    /**
     * Starts a class's server beside the process that asked for it, with
     * `-Embedding` after its command line as COM starts one, and runs it
     * alongside every other process until it exits. The page sees and
     * drives the server while it stands, as it does a child run beside its
     * parent.
     *
     * @param {any} parent @param {{ command: string, clsid: string }} request
     * @returns {Promise<number>} its exit code
     */
    const startServer = async(parent, request)=>{
        const found = await serverImage(parent, request.command);
        const sound = ownSound();
        if (!found)
        {
            events.emit('divergence', { api: 'COM',
                detail: `the server ${request.command} of ${request.clsid} is not on the volume` });
            return -1;
        }
        const server = await build({
            executable: found.image,
            imagePath: found.path,
            commandLine: `${request.command.trim()} -Embedding`,
            ...newProcessIds(),
            audio: sound.options,
        });
        sound.announce(server);
        // A line of processes of its own: a server that starts a child and
        // waits on it, or hands over to another image, is run the way the
        // program the page started is.
        const line = { current: server, main: false };
        serving.add(line);
        noteMachines();
        events.emit('process-server', { image: found.path, clsid: request.clsid });
        stand(server);
        bindLogLevels();
        let code = -1;
        try
        {
            code = await runProcesses(runOptionsNow, line, true);
        }
        catch (e){
            events.emit('error', { reason: 'server', error: e });
        }
        await retire(line.current);
        serving.delete(line);
        noteMachines();
        await line.current.dispose();
        keepMemory(line.current);
        sound.giveBack();
        stand(current);
        bindLogLevels();
        events.emit('process-server-exit', { image: found.path, code });
        return code;
    };

    /**
     * Runs a child on a machine of its own while its parent waits on it, and
     * gives the parent back what the child left: the files it wrote, the
     * registry it changed, and its exit code, which wakes the parent's wait.
     *
     * The parent's machine is left standing, paused where it blocked; the
     * child's is built beside it, run through `own.run` -- so a child that
     * starts children of its own is handled the same way -- and disposed.
     * This is how a parent that goes on after its child works: an installer
     * that runs a setup stage and then finishes, a launcher that waits for the
     * game to close.
     *
     * @param {{ current: any, main: boolean }} line  The processes this one is of.
     * @param {any} parent @param {any} request @param {any} runOptions
     */
    const runBeside = async(line, parent, request, runOptions)=>{
        const image = await parent.readImage(request.imagePath);
        if (!image)
        {
            throw new Error(`cannot start ${request.imagePath}: it is not on the volume`);
        }
        noteLogSequence();
        mediaInstance = parent.media.instance() ?? mediaInstance;
        const sound = ownSound();
        line.current = await build({
            executable: image,
            imagePath: request.imagePath,
            commandLine: request.commandLine,
            patches: request.patches,
            processId: request.id,
            mainThreadId: request.threadId,
            standardFiles: request.standardFiles,
            startDirectory: request.startDirectory,
            audio: sound.options,
        });
        sound.announce(line.current);
        replayLogLevels();
        stand(line.current);
        bindLogLevels();
        events.emit('process-started', { image: request.imagePath, sequenceBase: logSequence });
        const parentImage = imagePath;
        if (line.main)
        {
            imagePath = request.imagePath;
        }

        // The parent runs nothing until its child is done: a message sent to
        // its windows meanwhile would wait for ever, and is refused instead.
        system.windows?.hold(processIds.get(parent), true);
        let code;
        try
        {
            code = await runProcesses(runOptions, line, true);
        }
        finally
        {
            system.windows?.hold(processIds.get(parent), false);
        }
        imagePath = parentImage;

        // What an installer's second stage laid down is what the first stage
        // goes on to find: its drives and its registry are the parent's own,
        // the run's, so what it wrote is there already.
        const child = line.current;
        await retire(child);
        noteLogSequence();
        mediaInstance = child.media.instance() ?? mediaInstance;
        await child.dispose();
        keepMemory(child);
        sound.giveBack();

        line.current = parent;
        replayLogLevels();
        stand(parent);
        bindLogLevels();
        // Its picture goes with it: no window of the run is drawn from it.
        presenter?.forget?.(request.id);
        parent.childExited(request, code);
        events.emit('process-resumed', { image: request.imagePath, code });
    };

    /**
     * The children running beside their parents, with concurrency: each
     * one's run, until it exits.
     *
     * @type {Set<Promise<number>>}
     */
    const besides = new Set();
    /** Children asked for whose machines are not built yet. */
    let starting = 0;
    /** Children running in workers of their own. */
    let across = 0;
    /**
     * Whether the next child runs in a worker of its own: while fewer than
     * the run's concurrency run at once, the first on this thread. One past
     * it takes turns beside its parent here, slower and as correct. A process
     * that joined another run's system from a worker starts its children
     * beside it, in its worker: the run's processes are counted by the run.
     */
    const inWorker = ()=>!options.system
        && across < (options.concurrency ?? 1) - (rootAcross ? 0 : 1);
    /**
     * The children standing in workers of their own, each with the way its
     * diagnostics are asked for across its link.
     *
     * @type {Set<{ image: string, id: number, link: ReturnType<typeof openLink>,
     *     diagnostics: () => Promise<any> }>}
     */
    const standingAcross = new Set();

    /**
     * The page's input, where the run's window manager says it goes: a
     * pointer to the process of the window under it or holding the mouse,
     * the keyboard to the process of the window with the focus. Where no
     * window has it -- the desktop under the pointer, no window in the
     * foreground -- no program is sent it, as on Windows. Only a run with no
     * window showing has the page for its console: the newest process in a
     * worker of its own has it, else the process the facade speaks for.
     *
     * @param {any} machineInput  the input of the process the facade speaks for
     */
    const routedInput = machineInput=>({
        ...machineInput,
        /** @param {any} event */
        send: event=>{
            const manager = system.windows?.manager;
            const target = manager?.inputTarget(event) ?? null;
            if (target === null && manager?.topLevel().some((/** @type {any} */ state)=>state.visible))
            {
                return false;
            }
            for (const built of target === null ? [] : processes.values())
            {
                if (processIds.get(built) === target)
                {
                    return built.input.send(event);
                }
            }
            const inWorkers = [...standingAcross];
            const process = inWorkers.find(each=>each.id === target) ?? inWorkers.at(-1);
            if (process)
            {
                process.link.call('input', 'send', [event, null]).catch(()=>{});
                return true;
            }
            return machineInput.send(event);
        },
        // A route a tool queues clicks and keys on goes the same way: built
        // on the machine's own send, it took every press to the process the
        // facade speaks for, whichever program's window was under it.
        route(){
            return createInputRoute(event=>this.send(event));
        },
    });

    /**
     * The run's windows as a tool reads them (`debug.windows`): every
     * process's, as the run's window manager has them, the topmost top-level
     * window first and each followed by its children -- where the facade's
     * one process would show only its own. Null where the run keeps none.
     */
    const runWindows = ()=>{
        const manager = system.windows?.manager;
        if (!manager)
        {
            return null;
        }
        /** @param {number} value */
        const hex = value=>`0x${(value >>> 0).toString(16)}`;
        /** @type {any[]} */
        const listed = [];
        /** @param {any} state */
        const add = state=>{
            listed.push({
                hwnd: hex(state.hwnd), processId: state.processId,
                x: state.rect.left, y: state.rect.top, width: state.rect.right - state.rect.left,
                height: state.rect.bottom - state.rect.top,
                rect: state.rect, client: state.client, region: state.region,
                visible: state.visible, enabled: state.enabled, className: state.className,
                title: state.title,
                parent: state.parent || state.owner ? hex(state.parent || state.owner) : null,
                child: state.parent !== 0, style: hex(state.style), exStyle: hex(state.exStyle),
            });
            manager.children(state.hwnd).forEach(add);
        };
        manager.topLevel().forEach(add);
        return listed;
    };

    /**
     * The screen as a tool reads it (`debug.desktop`), as the presenter shows
     * it: while windows of more than one process show, every process on this
     * thread's desktop composed by the run's windows (`compose.js`); while one
     * process's do, that process's desktop. Its own for the facade's process
     * when the run keeps no windows, or the picture is not on this thread --
     * a process in a worker of its own sends its picture to the presenter.
     *
     * @param {() => any} own  the desktop of the process the facade speaks for
     */
    const runDesktop = own=>{
        const manager = system.windows?.manager;
        const placed = manager ? manager.topLevel() : [];
        if (!manager)
        {
            return own();
        }
        /** @type {Map<number, { width: number, height: number, pitch: number, bytes: Uint8Array }>} */
        const layers = new Map();
        for (const built of standing)
        {
            const id = processIds.get(built);
            const picture = id === undefined ? null : built.debug?.desktop?.() ?? null;
            if (id !== undefined && picture && typeof picture.then !== 'function')
            {
                layers.set(id, picture);
            }
        }
        if (!needsComposing(placed))
        {
            const showing = placed.find((/** @type {any} */ state)=>state.visible
                && layers.has(state.processId))?.processId;
            return (showing === undefined ? null : layers.get(showing)) ?? own();
        }
        const foreground = manager.get(manager.foreground() ?? 0)?.processId ?? null;
        const base = baseOf(placed, layers, foreground);
        const first = base === null ? null : layers.get(base);
        if (base === null || !first)
        {
            return own();
        }
        const screen = { width: first.width, height: first.height, pitch: first.width * 4,
            bytes: new Uint8Array(first.width * first.height * 4) };
        for (const copy of compositionPlan({ windows: placed, layers, base, screen }))
        {
            const layer = /** @type {{ pitch: number, bytes: Uint8Array }} */ (
                layers.get(copy.source));
            for (let row = 0; row < copy.height; row++)
            {
                const from = (copy.y + row) * layer.pitch + copy.x * 4;
                screen.bytes.set(layer.bytes.subarray(from, from + copy.width * 4),
                    (copy.toY + row) * screen.pitch + copy.toX * 4);
            }
        }
        return screen;
    };

    /**
     * The facade speaks for this process from now on, its input routed and a
     * tool's view of the windows and the screen the run's.
     *
     * @param {any} speaking
     */
    const stand = speaking=>{
        Object.assign(facade, speaking, own);
        facade.input = routedInput(speaking.input);
        if (speaking.debug)
        {
            facade.debug = { ...speaking.debug,
                windows: ()=>runWindows() ?? speaking.debug.windows(),
                desktop: ()=>runDesktop(()=>speaking.debug.desktop()) };
        }
    };

    /**
     * Runs a child in a worker of its own: its machine there, the run's
     * system half answered from here across a link (`system-link.js`), its
     * output the run's. Its exit code is the answer.
     *
     * @param {{ readImage: (path: string) => Promise<Uint8Array | null>,
     *     sound: () => ({ options: any, giveBack: () => void } | null) }} from
     *     its parent, as the run reaches it: where its image is read, and the
     *     sound it lends
     * @param {any} request
     * @param {{ link: ReturnType<typeof openLink> | null, code: number | null }} [reach]
     *     how its parent's TerminateProcess reaches it: given its link once
     *     there is one, and the code it was ended with before then
     * @returns {Promise<{ code: number, diagnostics?: any, systemLibraries?: string[] }>}
     *     its exit code, its layers' diagnostics as it ended, and the system
     *     libraries it knew
     */
    const runAcross = async(from, request, reach)=>{
        const image = await from.readImage(request.imagePath).catch(()=>null);
        if (!image)
        {
            events.emit('divergence', { api: 'process',
                detail: `${request.imagePath} is not on the volume, and did not start` });
            return { code: 2 };
        }
        const memory = createLinkMemory();
        // Its classes, served to and from every other process of the run.
        const com = comHandlers(/** @type {any} */ (classTable), {
            call: (method, args)=>link.call('com', method, args),
            launch: serverAcross,
        });
        const { dispose: forgetObjects, ...objects } = objectHandlers({
            table: system.namedObjects,
            wake: (token, result)=>link.call('kernel', 'wake', [token, result]) });
        const link = openLink(memory.a, {
            ...systemHandlers(/** @type {any} */ (system),
                (target, method, args)=>link.callWaiting(target, method, args)),
            ...objects,
            com: com.handlers,
            // The run's translation store, which only this thread can hold open.
            ...translationStore ? storeHandlers(translationStore) : {},
            process: {
                output: (/** @type {number} */ handle, /** @type {string} */ text)=>
                    events.emit('output', { handle, text }),
            },
            // Everything else that happens to it, for the page subscribed here.
            events: {
                emit: (/** @type {string} */ name, /** @type {any} */ payload)=>{
                    events.emit(name, eventFrom(payload));
                },
            },
            // Its own children, which the run starts, counted with the rest.
            processes: {
                start: (/** @type {any} */ asked)=>startAcrossFor(link, asked),
                terminate: (/** @type {number} */ id, /** @type {number} */ code)=>
                    terminateBeside({ id }, code),
            },
            // The parent's open files the child writes its output and error
            // into: one position, the parent's, which the child's writes move.
            standard: {
                /** @param {'output' | 'error'} which */
                position: which=>request.standardFiles?.[which]?.position ?? 0,
                /** @param {'output' | 'error'} which @param {number} at */
                setPosition: (which, at)=>{
                    const file = request.standardFiles?.[which];
                    if (file)
                    {
                        file.position = at;
                    }
                },
            },
        });
        const answering = link.serve();
        if (reach)
        {
            reach.link = link;
            if (reach.code !== null)
            {
                terminateAcross(link, reach.code);
            }
        }
        // Its own way in to the run's graphics worker, where its Direct3D
        // devices draw; what they present comes back here, to the run's
        // presenter, as every root's frames do.
        const graphicsWorker = options.device?.worker;
        const graphics = graphicsWorker ? new MessageChannel() : null;
        if (graphics)
        {
            graphicsWorker.postMessage({ type: 'client', port: graphics.port2 }, [graphics.port2]);
        }
        // And the pictures of its own surfaces -- a DirectDraw primary, the
        // desktop its windows are drawn on -- which come in as the graphics
        // worker's frames do and are shown by the run's presenter.
        const display = presenter && options.device?.device ? new MessageChannel() : null;
        const shown = display ? connectGraphicsWorker({ worker: portEnd(display.port1),
            device: options.device.device,
            presentTo: frame=>presenter.show({ ...frame, source: request.id }) }) : null;
        // Its sound goes onto the run's table, in a span its parent lends it,
        // where the table is shared memory a worker can be handed; elsewhere
        // the run's sound is mixed on this thread, and the child has none.
        const sound = from.sound();
        const worker = await openProcessWorker();
        translationPool?.addProcess(request.id, {
            lend: (port, token)=>worker.post({ type: 'translator', port, token }, [port]),
            recall: token=>worker.post({ type: 'recall', token }),
        }).catch(()=>{});
        // The page's input reaches it as the run routes it (`routedInput`).
        const asked = { image: request.imagePath, id: request.id, link,
            diagnostics: ()=>link.call('report', 'diagnostics', []) };
        standingAcross.add(asked);
        events.emit('process-started', { image: request.imagePath, sequenceBase: logSequence,
            worker: true });
        try
        {
            return await new Promise((resolve, reject)=>{
                worker.onMessage(data=>{
                    if (data?.type === 'exited')
                    {
                        resolve({ code: data.code, diagnostics: data.diagnostics,
                            systemLibraries: data.systemLibraries });
                    }
                    else if (data?.type === 'failed')
                    {
                        reject(Object.assign(new Error(data.message),
                            { diagnostics: data.diagnostics }));
                    }
                });
                worker.onLost(reason=>reject(new Error(reason)));
                // The graphics layer's knobs, not the run's presenter or a
                // callback: neither crosses, and the child shows nothing itself.
                const knobs = Object.fromEntries(Object.entries(options.graphics ?? {})
                    .filter(([key, value])=>key !== 'presenter' && typeof value !== 'function'));
                worker.post({
                    type: 'start',
                    end: memory.b,
                    volume: { revisions: system.volume.revisions ?? null,
                        sharing: system.volume.sharingMemory ?? null },
                    // The run's foreground window, focus and captured window,
                    // read where the run keeps them.
                    windowCells: system.windows?.cells ?? null,
                    graphics: graphics?.port1 ?? null,
                    display: display?.port2 ?? null,
                    options: {
                        ...portableOptions(options),
                        executable: image,
                        imagePath: request.imagePath,
                        commandLine: request.commandLine,
                        startDirectory: request.startDirectory,
                        patches: request.patches,
                        processId: request.id,
                        mainThreadId: request.threadId,
                        // Named, not handed: the position stays here.
                        standardFiles: request.standardFiles && Object.fromEntries(
                            Object.entries(request.standardFiles).filter(([, file])=>file)
                                .map(([which, file])=>[which, { path: file.path }])),
                        // The run tells the player the game is over, once.
                        exitNotice: false,
                        log: { categories: options.log?.categories,
                            capacity: options.log?.capacity, bytes: options.log?.bytes },
                        graphics: knobs,
                        audio: sound ? Object.fromEntries(Object.entries(sound.options)
                            .filter(([, value])=>typeof value !== 'function')) : undefined,
                        // The translator's store is the run's, asked across the
                        // link; the doorbell is this thread's.
                        cork: { config: { ...options.cork?.config, ...lentConfig,
                            store: translationStore ? 'run' : null, doorbell: undefined } },
                    },
                    run: { maxTurns: runOptionsNow?.maxTurns, timeoutMs: runOptionsNow?.timeoutMs },
                }, [...graphics ? [graphics.port1] : [], ...display ? [display.port2] : []]);
            });
        }
        finally
        {
            standingAcross.delete(asked);
            translationPool?.removeProcess(request.id);
            forgetObjects();
            await com.gone();
            link.close();
            await answering;
            worker.terminate();
            sound?.giveBack();
            shown?.dispose();
            display?.port1.close();
            presenter?.forget?.(request.id);
        }
    };
    /**
     * The children running beside their parents, by process id, from the
     * moment each is asked for: how its parent's TerminateProcess reaches it
     * wherever it runs, holding the code until it can take it.
     *
     * @type {Map<number, { terminate: (code: number) => void }>}
     */
    const reachable = new Map();

    /**
     * Tells a process in a worker of its own its parent ended it.
     *
     * @param {ReturnType<typeof openLink>} link @param {number} code
     */
    const terminateAcross = (link, code)=>{
        link.call('control', 'terminate', [code]).catch(()=>{
            // Gone already: its exit is on its way to its parent.
        });
    };

    /** The code the last of the run's processes beside another exited with. */
    let lastBesideCode = 0;
    /**
     * Tells the pacing the run shares how many machines take turns on this
     * thread: one of several may not block the thread to wait, which would
     * stop the others with it.
     */
    const noteMachines = ()=>{
        options.pacing?.machines?.(1 + besides.size + serving.size);
    };

    /**
     * Runs a child in a worker of its own, counted among the run's, and tells
     * `exited` its code when it is gone.
     *
     * @param {Parameters<typeof runAcross>[0]} from @param {any} request
     * @param {((code: number, ended: { systemLibraries?: string[] }) => void) | null}
     *     exited  its parent's; null for the run's own program, which resumes
     *     nothing
     * @param {(ended: { code: number, diagnostics?: any, systemLibraries?: string[] })
     *     => void} [over]
     *     told as it ends, whoever it was
     */
    const startAcross = (from, request, exited, over)=>{
        across++;
        /** @type {{ link: ReturnType<typeof openLink> | null, code: number | null }} */
        const reach = { link: null, code: null };
        reachable.set(request.id, { terminate: code=>{
            reach.code = code;
            if (reach.link)
            {
                terminateAcross(reach.link, code);
            }
        } });
        const running = (async()=>{
            /** @type {{ code: number, diagnostics?: any, systemLibraries?: string[] }} */
            let ended;
            try
            {
                ended = await runAcross(from, request, reach);
            }
            catch (e){
                events.emit('error', { reason: 'process', error: e });
                ended = { code: -1, diagnostics: /** @type {any} */ (e)?.diagnostics };
            }
            finally
            {
                across--;
                reachable.delete(request.id);
            }
            const { code, diagnostics } = ended;
            lastBesideCode = code;
            over?.(ended);
            if (exited)
            {
                exited(code, ended);
                events.emit('process-resumed', { image: request.imagePath, code, diagnostics });
            }
            return code;
        })();
        besides.add(running);
        noteMachines();
        running.finally(()=>{
            besides.delete(running);
            noteMachines();
        });
    };

    /**
     * A class's server a process in a worker of its own asked COM for,
     * started in a worker of its own while the run has room for one, with
     * `-Embedding` as COM starts one; null when there is no room, and the
     * process starts it beside itself.
     *
     * @param {{ command: string, clsid: string }} request
     * @returns {{ exited: Promise<number> } | null}
     */
    const serverAcross = request=>{
        if (!inWorker())
        {
            return null;
        }
        const exited = (async()=>{
            const found = await serverImage(current, request.command);
            if (!found)
            {
                events.emit('divergence', { api: 'COM',
                    detail: `the server ${request.command} of ${request.clsid}`
                        + ' is not on the volume' });
                return -1;
            }
            const { processId, mainThreadId } = newProcessIds();
            events.emit('process-server', { image: found.path, clsid: request.clsid });
            return new Promise(resolve=>{
                startAcross({ readImage: path=>current.readImage(path),
                    sound: ()=>lendSound(current) },
                { imagePath: found.path, commandLine: `${request.command.trim()} -Embedding`,
                    id: processId, threadId: mainThreadId }, null, ended=>{
                    events.emit('process-server-exit', { image: found.path, code: ended.code });
                    resolve(ended.code);
                });
            });
        })();
        return { exited };
    };

    /**
     * A child a process in a worker of its own asked for, started in a worker
     * of its own while the run has room for one; its parent is asked across
     * its link for the position of the files it handed on, and told when it
     * is gone. False when there is no room: the parent runs it
     * beside itself, in its own worker.
     *
     * @param {ReturnType<typeof openLink>} link  the parent's
     * @param {any} asked  the child, as values
     * @returns {boolean}
     */
    const startAcrossFor = (link, asked)=>{
        if (!inWorker())
        {
            return false;
        }
        /** @param {string} which */
        const handedOn = which=>({
            path: asked.standardFiles[which].path,
            get position(){
                return link.callWaiting('parent', 'position', [asked.id, which]);
            },
            set position(at){
                link.callWaiting('parent', 'setPosition', [asked.id, which, at]);
            },
        });
        const request = { ...asked, standardFiles: asked.standardFiles && Object.fromEntries(
            Object.keys(asked.standardFiles).map(which=>[which, handedOn(which)])) };
        startAcross({
            // Read from the run's volume, where the parent found it: a launcher
            // that starts its game and exits is gone before the game's image
            // would come back from it.
            readImage: path=>current.readImage(path),
            // Lent by the parent, and taken back there when it hears the
            // child is gone.
            sound: ()=>(asked.arena ? { options: { ...options.audio, memory: audioMemory,
                beside: { arena: asked.arena } }, giveBack(){} } : null),
        }, request, code=>{
            link.call('parent', 'exited', [asked.id, code]).catch(()=>{
                // The parent went first: nothing of it waits on the code.
            });
        });
        return true;
    };

    /**
     * The children this process, joined to the run from a worker of its own,
     * had the run start in workers of their own: by process id, each with
     * the machine that asked and the sound it lent.
     *
     * @type {Map<number, { parent: any, request: any,
     *     sound: { giveBack: () => void } | null }>}
     */
    const childrenAcross = new Map();
    options.system?.processes?.answer({
        /** @param {number} id @param {'output' | 'error'} which */
        position: (id, which)=>childrenAcross.get(id)?.request.standardFiles?.[which]
            ?.position ?? 0,
        /** @param {number} id @param {'output' | 'error'} which @param {number} at */
        setPosition: (id, which, at)=>{
            const file = childrenAcross.get(id)?.request.standardFiles?.[which];
            if (file)
            {
                file.position = at;
            }
        },
        /** @param {number} id @param {number} code */
        exited: (id, code)=>{
            const child = childrenAcross.get(id);
            if (!child)
            {
                return;
            }
            childrenAcross.delete(id);
            child.sound?.giveBack();
            child.parent.childExited(child.request, code);
        },
    });

    /**
     * Starts a child at once, beside the parent that asked for it, and runs
     * it alongside every other process until it exits: concurrency's
     * CreateProcess, as on Windows. The parent goes on running; a thread of
     * its waiting on the child, polling its exit code, or waiting on an
     * object the child sets, is answered as the child goes. The page sees
     * and drives the child while it stands, as it does one run in its
     * parent's place.
     *
     * @param {any} parent @param {any} request
     */
    const startBeside = (parent, request)=>{
        const shared = audioMemory && 'table' in audioMemory
            && typeof SharedArrayBuffer === 'function'
            && audioMemory.table instanceof SharedArrayBuffer;
        if (inWorker())
        {
            startAcross({
                readImage: path=>parent.readImage(path),
                sound: ()=>(shared ? lendSound(parent) : null),
            }, request, code=>parent.childExited(request, code));
            return;
        }
        // A process that joined the run's system from a worker of its own has
        // the run start its child, which counts the workers; the sound it
        // plays into is this process's to lend, and to take back when the
        // run says the child has gone.
        const processesAcross = options.system?.processes;
        if (processesAcross)
        {
            const sound = shared ? lendSound(parent) : null;
            // Known before it is asked for: the run may ask for the position of
            // a file it was handed before the call that starts it returns.
            childrenAcross.set(request.id, { parent, request, sound });
            const placed = processesAcross.start({
                imagePath: request.imagePath,
                commandLine: request.commandLine,
                startDirectory: request.startDirectory,
                patches: request.patches,
                id: request.id,
                threadId: request.threadId,
                standardFiles: request.standardFiles && Object.fromEntries(
                    Object.entries(request.standardFiles).filter(([, file])=>file)
                        .map(([which, file])=>[which, { path: file.path }])),
                arena: sound?.options.beside.arena ?? null,
            });
            if (placed)
            {
                return;
            }
            childrenAcross.delete(request.id);
            sound?.giveBack();
        }
        // Running from the moment it is asked for, not from when its machine
        // is built: a parent that waits on it at once is waiting on something
        // that will answer, not stuck.
        starting++;
        /** @type {{ line: { current: any } | null, code: number | null }} */
        const reach = { line: null, code: null };
        reachable.set(request.id, { terminate: code=>{
            if (reach.line)
            {
                reach.line.current.terminate(code);
            }
            else
            {
                reach.code = code;
            }
        } });
        const running = (async()=>{
            /** @type {any} */
            let child = null;
            const sound = ownSound();
            try
            {
                const image = await parent.readImage(request.imagePath);
                if (!image)
                {
                    events.emit('divergence', { api: 'process',
                        detail: `${request.imagePath} is not on the volume, and did not start` });
                }
                else
                {
                    noteLogSequence();
                    mediaInstance = parent.media.instance() ?? mediaInstance;
                    child = await build({
                        executable: image,
                        imagePath: request.imagePath,
                        commandLine: request.commandLine,
                        patches: request.patches,
                        processId: request.id,
                        mainThreadId: request.threadId,
                        standardFiles: request.standardFiles,
                        startDirectory: request.startDirectory,
                        audio: sound.options,
                    });
                    sound.announce(child);
                }
            }
            catch (e){
                events.emit('error', { reason: 'process', error: e });
            }
            finally
            {
                starting--;
            }
            if (!child)
            {
                reachable.delete(request.id);
                sound.giveBack();
                parent.childExited(request, 2);
                return 2;
            }
            replayLogLevels();
            stand(child);
            bindLogLevels();
            events.emit('process-started', { image: request.imagePath,
                sequenceBase: logSequence });
            const line = { current: child, main: false };
            reach.line = line;
            if (reach.code !== null)
            {
                child.terminate(reach.code);
            }
            let code = -1;
            try
            {
                code = await runProcesses(runOptionsNow, line, true);
            }
            catch (e){
                events.emit('error', { reason: 'process', error: e });
            }
            finally
            {
                reachable.delete(request.id);
            }
            const ended = line.current;
            await retire(ended);
            noteLogSequence();
            mediaInstance = ended.media.instance() ?? mediaInstance;
            await ended.dispose();
            keepMemory(ended);
            sound.giveBack();
            // The page sees whoever stands in the main line again.
            replayLogLevels();
            stand(mainLine.current);
            bindLogLevels();
            presenter?.forget?.(request.id);
            parent.childExited(request, code);
            lastBesideCode = code;
            events.emit('process-resumed', { image: request.imagePath, code });
            return code;
        })();
        besides.add(running);
        noteMachines();
        running.finally(()=>{
            besides.delete(running);
            noteMachines();
        });
    };

    /**
     * A parent's TerminateProcess on a child running beside it: ended where
     * it runs -- on this thread, in a worker of its own, or through the run
     * for a process that joined it from a worker -- and its parent told as
     * any child's exit is told. False for a child the run does not have.
     *
     * @param {{ id: number }} request @param {number} code
     * @returns {boolean}
     */
    function terminateBeside(request, code){
        const child = reachable.get(request.id);
        if (child)
        {
            child.terminate(code >>> 0);
            return true;
        }
        if (childrenAcross.has(request.id))
        {
            return options.system?.processes?.terminate?.(request.id, code) === true;
        }
        return false;
    }

    /**
     * Runs the live process, and each child that takes its place or runs
     * beside it, until one exits with nothing left to run.
     *
     * @param {any} runOptions
     * @param {{ current: any, main: boolean }} [line]  The line of processes:
     *        the page's, or a server's.
     * @param {boolean} [nested]  Run for a parent waiting on it.
     * @returns {Promise<number>} the last program's exit code
     */
    const runProcesses = async(runOptions, line = mainLine, nested = false)=>{
        while (true)
        {
            const code = await line.current.run(runOptions);
            const request = line.current.replacement();
            if (!request)
            {
                // Run out: nothing it holds wakes another process now.
                standing.delete(line.current);
                if (line.main && !nested)
                {
                    // Its servers end with it: its references go back, and
                    // what they write before they stop is its to keep.
                    const ending = line.current;
                    await classTable.ended(names.get(ending));
                    while (servers.size > 0)
                    {
                        await Promise.allSettled([...servers]);
                    }
                    // A launcher that started its game and went is not the
                    // end of the run: the game is, and its code is the run's.
                    if (besides.size > 0)
                    {
                        while (besides.size > 0)
                        {
                            await Promise.allSettled([...besides]);
                        }
                        noticeExit(lastBesideCode);
                        return lastBesideCode;
                    }
                    noticeExit(code);
                }
                return code;
            }

            if (line.current.waitingOn(request))
            {
                await runBeside(line, line.current, request, runOptions);
                continue;
            }

            // Read before the tear-down. What the process wrote stays on the
            // run's drives when it goes: an extractor that unpacked its
            // payload and then started it leaves the payload where the child
            // finds it.
            const child = await line.current.readImage(request.imagePath);
            // The sequence the journal reached, read while the machine that
            // wrote it still stands. The child's journal continues from
            // here, so the cursor a reader is holding points into it rather
            // than past the end of a block that started over.
            const written = journalOf(line.current.diagnostics())?.metrics?.journal?.written;
            if (typeof written === 'number')
            {
                logSequence = written;
            }
            // Likewise read while it stands: the decoder the parent made is
            // handed to the child so the same compiled module and linear
            // memory serve both, and only the parent still holds it.
            mediaInstance = line.current.media.instance() ?? mediaInstance;
            await retire(line.current);
            await line.current.dispose();
            keepMemory(line.current);

            if (!child)
            {
                throw new Error(
                    `cannot start ${request.imagePath}: it is not on the volume`);
            }

            line.current = await build({
                executable: child,
                imagePath: request.imagePath,
                commandLine: request.commandLine,
                startDirectory: request.startDirectory,
                patches: request.patches,
                processId: request.id,
                mainThreadId: request.threadId,
            });
            if (line.main)
            {
                imagePath = request.imagePath;
            }
            replayLogLevels();
            stand(line.current);
            bindLogLevels();
            // The child's journal is a fresh block, continuing the parent's
            // sequence. Whoever holds a reader of its own -- the page's
            // keeper -- is told where it starts so it can be handed the
            // block: a drain cursor taken before the swap is above zero and
            // below the child's first record, and only this says so.
            events.emit('process-started', {
                image: request.imagePath,
                sequenceBase: logSequence,
            });
        }
    };

    /**
     * Runs the run's program in a worker of its own, and every process it
     * starts, until the last of them is gone; the code is the last one's, as
     * a launcher that started its game and went leaves the game's.
     */
    const runRoot = async()=>{
        rootLibraries = [];
        startAcross({
            readImage: async()=>options.executable,
            // Half the output's arena: the rest is for what it starts.
            sound: ()=>lendSound(current, 8 << 20),
        }, {
            imagePath,
            commandLine: options.commandLine,
            // The id it has in its worker, where none was handed in, as a
            // process built here has: its windows and its frames are told
            // apart by it.
            id: options.processId ?? FIRST_PROCESS_ID,
        }, null, ended=>{
            rootLibraries = ended.systemLibraries ?? [];
            current.ended(ended.diagnostics);
        });
        while (besides.size > 0)
        {
            await Promise.allSettled([...besides]);
        }
        noticeExit(lastBesideCode);
        return lastBesideCode;
    };

    const own = {
        /**
         * The run's translation pool as it stands: its workers, the idle ones,
         * how many work for each process, and its journal of joins and leaves;
         * null where the run has none.
         */
        translationPool: ()=>translationPool?.diagnostics() ?? null,
        /**
         * Every process standing, each with its image and its own diagnostics:
         * the facade speaks for one of them, and an install several processes
         * deep that waits on itself shows nothing through one.
         *
         * @returns {Promise<{ image: string, diagnostics: any }[]>}
         */
        async standing(){
            const machines = new Set([...rootAcross ? [] : [current], ...processes.values()]);
            return Promise.all([
                ...[...machines].map(async made=>({
                    image: images.get(made) || imagePath,
                    diagnostics: await made.diagnostics(),
                })),
                // A child in a worker of its own answers at its next look at
                // its link; one that ends meanwhile answers nothing.
                ...[...standingAcross].map(async child=>({
                    image: child.image,
                    diagnostics: await child.diagnostics().catch(()=>null),
                })),
            ]);
        },

        /**
         * Runs the program, and whatever replaces it, to completion.
         *
         * @param {Object} [runOptions]
         * @param {number} [runOptions.maxTurns]
         * @returns {Promise<number>} the last program's exit code
         */
        async run(runOptions){
            runOptionsNow = runOptions;
            return rootAcross ? runRoot() : runProcesses(runOptions);
        },

        /**
         * Ends this program, and with it the run's presenter: the canvas and
         * the texture a replacement draws into are released here and nowhere
         * earlier, because the process that takes this one's place still needs
         * them.
         */
        dispose: ()=>Promise.all([...serving].map(line=>line.current.dispose()))
            .then(()=>current.dispose())
            .then(()=>{
                system.bundle?.stop();
                // The run's store outlives each machine it was handed to, and
                // goes with the last of them.
                if (runStoreSpec === 'local')
                {
                    translationStore?.close?.();
                }
            })
            .finally(()=>{
                spareMemory = null;
                shownHere?.dispose();
                presenter?.dispose?.();
                translationPool?.dispose();
            }),

        /**
         * The presenter this run draws through: the canvas, the format it was
         * configured in, the pacer and the texture the primary is copied into.
         * Shared by every machine the run is rebuilt on, which is what keeps
         * the last frame of one process on the canvas until the next presents.
         */
        presenter: ()=>presenter,

        /**
         * The last few replacement requests, each with the guest's stack at the
         * call that made it -- kept out here so that honouring one does not
         * take the record of it away.
         */
        replacements: ()=>[...requested],
    };

    stand(current);
    bindLogLevels();
    return facade;
}
