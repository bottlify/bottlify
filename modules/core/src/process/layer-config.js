/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import {
    DEFAULT_INITIAL_STACK, DEFAULT_THUNK_BASE, DEFAULT_THUNK_CAPACITY,
} from '../layers/cpu/module.js';
import { KUSER, SHARED_USER_DATA } from '../layers/win32/kernel32/shared-data.js';
import { corkArtifacts, engineVersion } from './system-host.js';
import { SETTINGS, processorName } from '../settings.js';
import { TEB, TEB64 } from '../layers/win32/kernel32/teb.js';
import { moduleKeyOf, readWholeFile, resourceOfImage, withLibraryExtension } from './libraries.js';
import { GRAPHICS_CHOICES } from '../layers/graphics/choice.js';
import { CORK_TSC_MHZ } from '../layers/cpu/internal/cork-host.js';
import { DIR_EXCEPTION } from '../layers/loader/internal/pe.js';
import { captureTrace, formatTrace } from '../trace.js';
import { ENGINE_CODE_BYTES, FIRST_PROCESS_ID } from './process-layout.js';
import { allocateCleared, reusedRanges, TRACED_KEPT } from './process-layout.js';
import {
    compatibilityOf, imageInMemory, readImageNow, resourceLookup, versionResourceOf,
} from './image-resources.js';

/**
 * The configuration each layer of a process is made with (`assembleModules`):
 * what the layers are told of the process - its memory, its windows, its
 * bottle, its run - each a setting or a function the layer asks when it needs
 * the answer. Read once, when the process's machine is assembled (`app.js`).
 */

/**
 * @param {Record<string, any> & { options: import('../app-options.js').ProcessOptions }} deps
 *     the process's parts it reads, by the names `app.js` gives them; asked for,
 *     since they are made or set later (the layers among them, made by this
 *     configuration):
 *     `blocks`, `bridge`, `broughtCopies`, `builtLibraries`, `cpu`, `exportOf`, `filesystem`,
 *     `idlers`, `imageInformation`, `journal`, `kernel`, `loadErrors`, `loadLibraryAtRuntime`,
 *     `loaderLock`, `mainModule`, `memory`, `moduleUnderContext`, `resolveImport`,
 *     `systemLibraries`, `threadBlocks`, `win32`, `core`
 */
export async function layerConfig(deps){
    const {
        HEAP_BASE, HEAP_SIZE, STACK_POOL_BASE, STACK_POOL_SIZE, STACK_POOL_START, areaOfCall,
        callerImage, dataFiles, deviceCursor, display, dllNotifications, engineArea,
        engineCode, events, exitsAtFrameStart, fetchBundleBlocks, findModule, foreground, framed,
        giveBackBlocks, handed, heapAtFrameStart, heapReadable, heapUsed, holdBlock, imagesTold,
        interpretedAtFrameStart, journalCall, lastCreated, lastErrorOfWin32, layerTraces, long,
        mainImage, mainStack, memorySize, modules, mouseHeld, options, processBits, ramLimit,
        programLoaded, reportDivergence, retiredAtFrameStart, runPresenter, showCursor,
        systemCursor, threadLocalImages, threadLocals, threadStackSize, translateAtFrameStart,
        translationStore, withoutThreadCalls, workerAtFrameStart, workerFrameTimes,
        writtenAtFrameStart,
    } = deps;
    // Asked for: made or set after this configuration is read.
    const {
        blocks, bridge, broughtCopies, builtLibraries, core, cpu, exportOf, filesystem, idlers,
        imageInformation, journal, kernel, loadErrors, loadLibraryAtRuntime, loaderLock,
        mainModule, memory, moduleUnderContext, resolveImport, systemLibraries, threadBlocks,
        win32,
    } = deps;
    // A frame runs from one present to the next: it is closed and the next
    // opened where this process's frame is shown (`presentTo`), or, for a
    // process in a worker of its own whose frames another thread shows, where
    // the graphics worker says it played one (`framePlayed`). Closed nowhere,
    // such a process's journal had no frames, and a tool reading a game's slow
    // frames read none.
    const closeFrame = ()=>{
        // The first present has none to close. Closing one anyway is counted as
        // an imbalance and was the one this engine reported on every run.
        if (!framed.value)
        {
            return;
        }
        // What the frame retired, and how much of it the interpreter ran: a
        // frame of ordinary slices that all ran slowly is a compiler that had
        // thrown its code away, and nothing else in the frame says so.
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
        {
            journal().note('instructions',
                cpu().instructionCount() - retiredAtFrameStart.value);
            journal().note('interpreted',
                cpu().interpretedSteps() - interpretedAtFrameStart.value);
            // Translating on this thread, inside the guest's slices: only where
            // it is measured (the translator's `timings`).
            const translated = cpu().translateMs();
            if (translated !== null)
            {
                journal().note('translateMs',
                    Math.round(translated - translateAtFrameStart.value));
            }
            // Translated code leaving for the runtime, each a dispatch.
            journal().note('exits', cpu().translatedExits() - exitsAtFrameStart.value);
            journal().note('hostWrittenBytes',
                cpu().hostWrittenBytes() - writtenAtFrameStart.value);
            // Only where the heap can be read: a worker has no
            // performance.memory, and a zero there is no measurement.
            if (heapReadable())
            {
                journal().note('heapDelta', heapUsed() - heapAtFrameStart.value);
            }
            // What the graphics worker finished while this frame ran: why a
            // present held on its GPU waited - a frame's pipelines and replay,
            // the GPU's own drawing, or the worker busy.
            const worker = workerFrameTimes();
            if (worker !== null)
            {
                const from = workerAtFrameStart.value
                    ?? { frames: 0, toQueueMs: 0, gpuMs: 0, replayMs: 0 };
                journal().note('gfxFrames', worker.frames - from.frames);
                journal().note('gfxToQueueMs', Math.round(worker.toQueueMs - from.toQueueMs));
                journal().note('gfxGpuMs', Math.round(worker.gpuMs - from.gpuMs));
                journal().note('gfxReplayMs', Math.round(worker.replayMs - from.replayMs));
            }
        }
        // Run in every build: the frame's samplers feed the translator.
        journal().endFrame();
    };
    const openFrame = ()=>{
        journal().beginFrame();
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
        {
            retiredAtFrameStart.value = cpu().instructionCount();
            interpretedAtFrameStart.value = cpu().interpretedSteps();
            translateAtFrameStart.value = cpu().translateMs() ?? 0;
            exitsAtFrameStart.value = cpu().translatedExits();
            writtenAtFrameStart.value = cpu().hostWrittenBytes();
            heapAtFrameStart.value = heapUsed();
            workerAtFrameStart.value = workerFrameTimes();
        }
        framed.value = true;
    };
    return {
        kernel: {
            // How many guest instructions a thread runs before the next one
            // gets a turn. Lowering it is how a sampled profile gets enough
            // points to say anything; raising it costs nothing but resolution.
            quantum: options.quantum,
            // Spread over the executors, or for a debugging run kept on the
            // process's own (the kernel's `placement`).
            placement: options.cpu?.placement,
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
                // In a gone process's memory, where its stacks' bytes end: each
                // stack zeroed below it as it is taken. The whole pool where that
                // process's lay elsewhere.
                ...options.reusedMemory ? { dirtyTo: options.reusedMemory.stacks
                    && options.reusedMemory.stacks.from === STACK_POOL_BASE
                    ? options.reusedMemory.stacks.to
                    : STACK_POOL_BASE + STACK_POOL_SIZE } : {},
            },
            // The run's thread and process ids, which every process numbers
            // its own from (`system`).
            ids: options.system?.ids,
            // Every process the run's processes on this thread started, by id.
            processDirectory: options.system?.processDirectory,
            // A process across a link reaches the run's named objects there.
            remoteObjects: options.system?.objects ?? null,
        },
        cpu: {
            // An image past 4 GiB: the RAM the wide window holds, the image in it.
            memorySize: programLoaded.wide === undefined ? memorySize
                : programLoaded.wide.window - 4096,
            // What the program may be given of it: its RAM (`AppOptions.memorySize`).
            ramLimit,
            ...(engineArea ? { engineArea } : {}),
            ...(options.memoryBudget ? { memoryBudget: options.memoryBudget,
                memoryCredit: options.memoryCredit, memoryHolder: options.memoryHolder,
                ...options.cpu?.guestCharge ? { guestCharge: options.cpu.guestCharge } : {} }
                : {}),
            reused: options.reusedMemory ? { ...options.reusedMemory,
                written: reusedRanges(options.reusedMemory, {
                    // The thunk table, and the first thread's stack under it to
                    // the initial stack where it lies there.
                    below: Math.min(mainImage.imageBase, mainStack.initialStack === undefined
                        ? DEFAULT_INITIAL_STACK : DEFAULT_THUNK_BASE + DEFAULT_THUNK_CAPACITY),
                    mainStack: mainStack.initialStack === undefined ? null
                        : [STACK_POOL_START, STACK_POOL_BASE],
                    heapBase: HEAP_BASE }) } : undefined,
            initialStack: mainStack.initialStack,
            // The first 64 KiB, which Windows never maps: every access there
            // faults, as PECompact2's deliberate store through NULL needs to
            // reach the handler it installed and the .NET runtime's JIT, which
            // emits no null test, needs a field read through NULL to become its
            // NullReferenceException (decisions.md A79).
            closedBelow: 0x10000,
            // The system's shared page in a RAM short of it, read where RAM keeps
            // it (`sharedPageAt`).
            readThrough: memorySize > SHARED_USER_DATA && engineArea === undefined ? []
                : [[SHARED_USER_DATA, SHARED_USER_DATA + KUSER.SIZE]],
            // Nothing runs there all the same: a call through a null pointer
            // faults, as on Windows, rather than sliding through the zeroes.
            noExecuteBelow: 0x10000,
            executors: options.cpu?.cores ?? 1,
            bits: processBits,
            // An image past 4 GiB: the wide window, its RAM the whole of it.
            ...programLoaded.wide === undefined ? {} : { window: programLoaded.wide.window,
                codeBase: programLoaded.wide.codeBase,
                // The image's low dword span: a handler's pointer into it lands there.
                hostAlias: { at: programLoaded.imageBase % 2 ** 32,
                    size: programLoaded.sizeOfImage } },
            // Not for a process started beside another: its executors open as its
            // threads want them (`startedBeside`), each another executor's pages
            // the memory reaches and a worker -- a launcher's every short child
            // opened all of them at its start.
            eagerExecutors: options.cpu?.eager === true && options.startedBeside !== true,
            executorTranslators: options.cpu?.executorTranslators,
            ...(options.cpu?.executorWorker ? { executorWorker: options.cpu.executorWorker } : {}),
            // An executor whose worker went is a loss of the run's (`executorsLost`).
            divergence: reportDivergence,
            learnExecutors: options.startedBeside !== true,
            // The threads holding the guest's memory bring JavaScriptCore's
            // collections forward (`gc-nudge.js`): by default there only.
            gcNudge: options.cpu?.gcNudge,
            engineUrl: corkArtifacts(options.cork).moduleUrl,
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
            lastError: ()=>lastErrorOfWin32(),
            // Where the reader above finds it for a thread with a block,
            // read there directly.
            lastErrorOffset: (long ? TEB64 : TEB).LAST_ERROR,
            // Costly and off unless asked for; see the dispatcher.
            traceStrings: options.traceStrings ?? false,
            callPhases: options.profileCalls ?? false,
            driveGuestCalls: options.driveGuestCalls ?? true,
            record: options.record ?? 0,
            onCall: (/** @type {any} */ call)=>{
                journalCall(call);
                if (options.onCall)
                {
                    // Every process of a run hands its calls to the one sink,
                    // and names its first thread "main": a call says whose
                    // image made it, beside the thread the bridge names.
                    call.image = callerImage;
                    call.process = options.processId ?? FIRST_PROCESS_ID;
                    options.onCall(call);
                }
            },
            // Which calls the sink above keeps: every one for a caller's own
            // sink, the traced ones otherwise. The bridge asks once for each
            // function and again when a level moves, and calls the sink for
            // those alone.
            wantsCall: (/** @type {string} */ name)=>options.onCall !== undefined
                || journal().enabled(areaOfCall({ name }), journal().Level.TRACE),
        },
        filesystem: {
            // The run's drives, as one Windows has one volume: a process after
            // the first stands on the first one's, its writes and all, rather
            // than on a copy of it.
            volume: options.system?.volume,
        },
        media: {
            // The decoder, handed down rather than fetched: this layer is one
            // module over one wasm blob, and which blob is
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
                core().api('memory').readBytes(address, length),
            writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
                core().api('memory').writeBytes(address, bytes),
            allocate: (/** @type {number} */ bytes)=>core().api('win32').heap().allocate(bytes),
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
            now: options.log?.now ?? (()=>core().api('kernel').clock.virtualTime()),
        },
        audio: {
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core().api('bridge').publishInterface(object, iid),
            divergence: reportDivergence,
            // The guest's clock, never the host's. A program that fills a sound
            // buffer reads how far playback has got and compares it with a time
            // it took from somewhere else; two clocks make it disagree with
            // itself about whether it is behind.
            now: ()=>core().api('kernel').clock.virtualTime(),
            allocate: (/** @type {number} */ bytes)=>core().api('win32').heap().allocate(bytes),
            // A guest buffer a handler fills on the program's behalf -- a
            // segment's bytes read out of its stream -- goes back to the same
            // heap it came from.
            free: (/** @type {number} */ address)=>core().api('win32').heap().free(address),
            // How DirectMusic's loader reads a wave a segment names. The
            // loader knows the file's name and not where the volume keeps it,
            // and the layer that answers for the volume is below audio, so
            // the reader is handed down as a thunk the same way the mixer is
            // handed to win32. It waits for the bundle's blocks as a program's
            // image does.
            readFile: (/** @type {string} */ path)=>readWholeFile(core().api('filesystem'),
                { fetch: fetchBundleBlocks }, path),
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
            // A 64-bit process's DirectSound structures and out pointers.
            ...long ? { pointerSize: 8 } : {},
            // Whose call a sound provider is answering, read before it awaits
            // anything: a callback into the guest after an await has to name
            // the thread whose call it continues.
            currentThread: ()=>core().api('kernel').currentThread(),
            // An export's address, of a library the program ships or of one we
            // synthesised. A provider announces itself through the library
            // that loaded it, and hands that library its own entry points.
            /** @param {string} dll @param {string} name */
            resolveImport: (dll, name)=>resolveImport()(dll, name, null),
            // Setting an event belongs to the kernel, which sits below this
            // layer and cannot be reached from it, so it is handed down the way
            // the wave notifier's is. A stale handle is the program's mistake
            // and not ours to fault on.
            signal: (/** @type {number} */ handle)=>{
                try
                {
                    const kernelNow = core().api('kernel');
                    kernelNow.setEvent(kernelNow.handles.resolve(handle, 'event'));
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
                core().api('bridge').publishInterface(object, iid),
            // A 64-bit process's DirectInput structures and out pointers.
            ...long ? { pointerSize: 8 } : {},
            /** @param {boolean} held */
            mouseHeld: held=>{
                mouseHeld.value = held;
                showCursor();
            },
            divergence: reportDivergence,
            cursorMoved: (/** @type {number} */ x, /** @type {number} */ y)=>
                events.emit('cursor-moved', { x, y }),
            // The event SetEventNotification names, set when the device takes
            // input -- the kernel's, handed down as the sound layer's is.
            signal: (/** @type {number} */ handle)=>{
                try
                {
                    const kernelNow = core().api('kernel');
                    kernelNow.setEvent(kernelNow.handles.resolve(handle, 'event'));
                }
                catch (e){
                    void e;
                }
            },
            now: ()=>core().api('kernel').clock.virtualTime(),
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
             * @param {import('../layers/input/router.js').PressRecord} press
             */
            trace: press=>{
                if (!journal().enabled('input.press', journal().Level.TRACE))
                {
                    return;
                }
                journal().write('trace', 'input.press', '{0} {1} at={2} {3}',
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
            // A 64-bit process's structures, and none of the layer's i386 code.
            ...long ? {
                pointerSize: 8,
                // A float a method answers goes to XMM0 at 64 bits, which the
                // bridge leaves as the handler set it.
                floatResult: (/** @type {number} */ value)=>{
                    const bits = new DataView(new ArrayBuffer(4));
                    bits.setFloat32(0, value, true);
                    core().api('cpu').writeXmm(0, Uint32Array.of(bits.getUint32(0, true), 0, 0, 0));
                },
            } : {},
            choice: options.graphicsApi,
            // Whose frames this machine's devices present: the run's screen
            // is composed of every process's picture by its windows.
            processId: options.processId ?? FIRST_PROCESS_ID,
            // The display's raster -- the vertical blank, the scan line --
            // runs on the guest's clock, which only this assembly can reach:
            // a program times its spin on the blank with its own timers.
            guestNow: ()=>core().api('kernel').clock.virtualTime(),
            // A device call that waits on the display -- a Present beat-synced
            // to the retrace -- stops the calling thread until that moment of
            // the guest's clock and returns what its call answers then.
            /** @param {number} deadline @param {number} result */
            waitUntil: (deadline, result)=>{
                const kernelNow = core().api('kernel');
                const thread = kernelNow.currentThread();
                kernelNow.block(thread, 'the vertical blank', { deadline, result });
                return core().api('bridge').park(thread);
            },
            // Where a COM interface goes when a program asks for one. Without
            // it the drawing entry points refuse rather than publishing into
            // nowhere, which is what a build with no bridge should do.
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core().api('bridge').publishInterface(object, iid),
            unpublishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core().api('bridge').unpublishInterface(object, iid),
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
            // Where the graphics worker played a present of a process whose frames
            // another thread shows: its frame ends there.
            framePlayed: ()=>{
                closeFrame();
                openFrame();
            },
            device: options.device
                ? {
                    ...options.device,
                    // The profile the adapter is shown with (`seam/adapter.js`).
                    adapter: options.gpuProfile && options.gpuProfile !== 'host'
                        ? { ...options.device.adapter, profile: options.gpuProfile }
                        : options.device.adapter,
                    /** @param {any} frame */
                    presentTo: frame=>{
                        closeFrame();
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
                        openFrame();
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
                    // A device's mode is a resolution change like one
                    // ChangeDisplaySettings makes, and resets the cursor's
                    // clip as that does: a program clips to its full-screen
                    // mode and leaves the clip there when the device goes.
                    if (display.width !== width || display.height !== height)
                    {
                        win32().user32?.('ClipCursor')?.handler([0]);
                    }
                    display.width = width;
                    display.height = height;
                    // A fullscreen device takes the window it presents into
                    // with it, as the real one does: placed at the origin, the
                    // mode's size, and told so. A window left at its old size
                    // has the program clipping its cursor to a corner of the
                    // picture -- the picture fills the mode, the window does not.
                    if (where.fullscreen && where.window)
                    {
                        win32().placeWindow(where.window, 0, 0, width, height,
                            { announce: where.announce === true });
                    }
                }
            },
            // Where a locked surface or vertex buffer's bytes live. A lock
            // hands the program an address it writes through and the unlock
            // reads those bytes back, so it has to be memory the guest can
            // reach -- an address invented for the purpose is one the program
            // writes into nothing and we read nothing out of -- and on the
            // boundary a driver keeps (`RESOURCE_ALIGNMENT`).
            allocate: (/** @type {number} */ bytes, /** @type {boolean | undefined} */ cleared)=>
                allocateCleared(win32().heap(), (address, value, length)=>
                    core().api('memory').fillBytes(address, value, length), bytes,
                cleared !== false),
            // The guest code the seams write, on pages nothing else is handed.
            // None of it waits, and some of it writes records other threads'
            // entries into the host read, so no slice ends inside it -- but in
            // what says it may (`unbroken` false): a copy longer than the steps
            // that finish a routine run.
            allocateCode: (/** @type {number} */ bytes, unbroken = true)=>{
                const at = win32().heap().allocateCode(bytes);
                if (at !== 0 && unbroken)
                {
                    core().api('kernel').atomicCode(at, bytes);
                }
                return at;
            },
            // What wglGetProcAddress answers for a name OPENGL32 exports
            // itself: the export's own address, the one an import bound to.
            /** @param {string} name */
            exportAddress: name=>findModule('OPENGL32.dll')?.addressOf(name) ?? 0,
            // Any module's export, for a seam that writes into its own code.
            /** @param {string} module @param {string} name */
            moduleExportAddress: (module, name)=>findModule(module)?.addressOf(name) ?? 0,
            // And back again when the last reference to a resource goes. The
            // arena is the same one the program's own allocator draws from, and
            // GlobalMemoryStatus reports what is left of it -- so a texture
            // whose pixels are never given back does not only cost address
            // space, it tells the program it is running out of memory.
            free: (/** @type {number} */ address)=>win32().heap().free(address),
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
                const rect = win32().clientRect(hwnd);
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
                deviceCursor.value = cursor;
                showCursor();
            },
            // A device's SetCursorPosition puts the system's cursor where
            // SetCursorPos does, and reads it to leave one there alone.
            /** @param {number} x @param {number} y */
            placeCursor: (x, y)=>core().api('input')?.place?.(x, y),
            cursorAt: ()=>core().api('input')?.cursor?.() ?? null,
        },
        win32: {
            // A 64-bit process's structures hold 8-byte pointers.
            bits: processBits,
            // Where the guest code the engine writes itself goes: a span of its
            // own after the system modules (`engineCode`), not the program's heap.
            engineCode: (/** @type {number} */ bytes)=>engineCode.take(bytes),
            enginePart: ()=>engineCode.part,
            engineHolds: (/** @type {number} */ address)=>address >= engineCode.end - ENGINE_CODE_BYTES
                && address < engineCode.end,
            // And the machine it runs on (`AppOptions.machine`).
            machine: long ? 'amd64' : options.machine ?? 'x86',
            // And the one its volume was laid out for (`AppOptions.layout`).
            layout: long ? 'amd64' : options.layout ?? options.machine ?? 'x86',
            // The Windows the machine is, and what the program says it knows,
            // which is all Windows 10 needs to decide what to tell it.
            windows: options.windows,
            // A resource of an image on the volume, read as data: an
            // assembly's manifest in a DLL that CreateActCtx and the private
            // assembly search read.
            fileResource: async(/** @type {string} */ path, /** @type {number} */ type,
                /** @type {number | null} */ id)=>resourceOfImage(
                await readWholeFile(core().api('filesystem'), blocks(), path), type, id),
            directx: options.graphicsApi
                ? GRAPHICS_CHOICES[options.graphicsApi].directx ?? undefined : undefined,
            compatibility: compatibilityOf(options.executable),
            // The speed the registry reports: the rate the engine's rdtsc
            // advances at.
            processorMhz: CORK_TSC_MHZ,
            processorName: processorName(SETTINGS, await engineVersion(options.cork)),
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
            // The process block, made once the image is placed: what a call
            // its parent makes in it reads with no thread of its own running.
            processBlock: ()=>threadBlocks()?.peb ?? 0,
            // SECTION_IMAGE_INFORMATION of the program's image, from its own
            // headers and what is mapped of it now (ProcessImageInformation).
            imageInformation: ()=>imageInformation()?.() ?? null,
            // The handles a parent's CreateProcess handed down: the objects
            // themselves on this thread; across, stand-ins of its pipe ends and
            // its open files as values, their position the parent's.
            inheritedHandles: handed.inherited,
            standardHandles: handed.standard,
            startup: options.startup,
            // A child's variables, as its parent handed them on; absent, the
            // machine's own.
            environment: options.environment,
            parentProcessId: options.parentProcessId,
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
            // Off only for a gate's second path (`handleWords`).
            handleWords: options.win32?.handleWords,
            // The Steam account the embedder signed in with and the games it
            // owns: the run's Steam client answers a game for it.
            steam: options.win32?.steam,
            // What the program is told its display is, handed to the libraries
            // that answer for one as well as to the layer that draws on it.
            screen: display,
            desktop: options.desktop,
            // The system cursor, from user32's own state -- ShowCursor's count
            // and a null SetCursor; a device's shown cursor goes over it.
            /** @param {any} cursor */
            reportCursor: cursor=>{
                systemCursor.value = cursor;
                showCursor();
            },
            // Sound leaves through the audio layer's mixer, and win32 sits
            // below it. Handed down as a thunk and asked for only when a
            // program opens a device: audio is created after win32, and a build
            // with nothing draining the ring answers null, which is what keeps
            // the wave cursor on the clock rather than stalling it against a
            // device nobody is listening to.
            output: ()=>{
                const audio = core().api('audio');
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
                    size: ()=>core().api('graphics').opengl().pixelFormat.size(),
                    count: ()=>core().api('graphics').opengl().pixelFormat.count(),
                    /** @param {Uint8Array} bytes */
                    choose: bytes=>core().api('graphics').opengl().pixelFormat.choose(bytes),
                    /** @param {number} index @param {number} bytes */
                    describe: (index, bytes)=>
                        core().api('graphics').opengl().pixelFormat.describe(index, bytes),
                    /** @param {number} hdc @param {number} index */
                    set: (hdc, index)=>core().api('graphics').opengl().pixelFormat.set(hdc, index),
                    /** @param {number} hdc */
                    get: hdc=>core().api('graphics').opengl().pixelFormat.get(hdc),
                },
                /** @param {number} hdc */
                swapBuffers: hdc=>core().api('graphics').opengl().swapBuffers(hdc),
                // GDI's drawing, and the pixels a context over a bitmap in
                // guest memory draws into. Every draw a program makes through
                // a device context lands here or fails.
                /** @param {{ objects: any, metrics: (font: number) => any }} drawing */
                createDrawing: drawing=>core().api('graphics').gdiDrawing().create(drawing),
                /** @param {any} dc @param {any} bitmap */
                surfaceFor: (dc, bitmap)=>core().api('graphics').gdiDrawing()
                    .surfaceFor(dc, bitmap),
                // The font engine's measurements, so what a program lays out
                // against is what the same engine draws.
                /** @param {import('../layers/win32/gdi32/structs.js').LogFontFields} font */
                fontMetrics: font=>core().api('graphics').gdiDrawing().fontMetrics(font),
                /**
                 * @param {number} code
                 * @param {import('../layers/win32/gdi32/structs.js').LogFontFields} font
                 */
                glyph: (code, font)=>core().api('graphics').gdiDrawing().glyph(code, font),
                /**
                 * @param {import('../layers/win32/gdi32/structs.js').LogFontFields} font
                 * @param {string} text
                 */
                textWidth: (font, text)=>core().api('graphics').gdiDrawing().textWidth(font, text),
                /** A program's own font, AddFontMemResourceEx's. @param {string} family @param {Uint8Array} bytes */
                addFont: (family, bytes)=>core().api('graphics').gdiDrawing()
                    .addFont(family, bytes),
                // The desktop every window context draws into, shown after
                // a paint pass. The window manager decides when a pass is
                // over; the graphics layer owns the surface and the screen.
                presentDesktop: (/** @type {any} */ dc)=>core().api('graphics').gdiDrawing()
                    .presentDesktop(dc),
                // The display's gamma ramp, which the presenter shows every
                // frame through, whichever API set it last.
                /** @param {any} ramp */
                setGammaRamp: ramp=>core().api('graphics').gdiDrawing().setDisplayGamma(ramp),
                gammaRamp: ()=>core().api('graphics').gdiDrawing().displayGamma(),
                appliesGamma: ()=>core().api('graphics').gdiDrawing().appliesGamma(),
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
                    const media = core().api('media');
                    if (!media?.available?.())
                    {
                        return null;
                    }
                    try
                    {
                        const bytes = await readWholeFile(filesystem(), blocks(), path);
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
            cursor: ()=>core().api('input')?.cursor?.() ?? { x: 0, y: 0 },
            // The cursor space a program declares with ClipCursor: the input
            // layer scales pointer motion into it, so a menu built for a smaller
            // logical screen than the backbuffer tracks the pointer exactly.
            /** @param {{ left: number, top: number, right: number, bottom: number } | null} rect */
            clipCursor: rect=>core().api('input')?.clip?.(rect),
            /** @param {number} x @param {number} y */
            placeCursor: (x, y)=>core().api('input')?.place?.(x, y),
            // What SendInput puts into the stream goes into the input layer's
            // router, the same place a real event from the page goes: a move
            // becomes a message and a DirectInput delta both, or neither.
            /** @param {any} event */
            sendInput: event=>core().api('input')?.send?.(event),
            /** @param {number} key */
            keyState: key=>core().api('input')?.keyState?.(key) ?? 0,
            /** @param {number} key */
            asyncKeyState: key=>core().api('input')?.asyncKeyState?.(key) ?? 0,
            // The whole keyboard, as GetKeyboardState fills its caller's array
            // and SetKeyboardState writes back: the same state GetKeyState
            // reads one key at a time, so the two can never disagree.
            keyboardState: ()=>core().api('input')?.keyboardState?.() ?? null,
            /** @param {Uint8Array} bytes */
            setKeyboardState: bytes=>core().api('input')?.setKeyboardState?.(bytes),
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
            // A runtime the machine lacks, which the embedder mounts as a
            // layer from the next start on: a Framework setup asked for it.
            /** @param {string} layer */
            onLayerNeeded: layer=>events.emit('layer-needed', { layer }),
            // A box the program shows as it goes down (`user32/fatal.js`), for
            // the page to put in front of the person: drawn in the guest it may
            // never reach the screen. The layers' last traces carry the
            // exception's account.
            /** @param {{ text: string, caption: string, type: number }} notice */
            onProgramError: notice=>events.emit('program-error', {
                ...notice, trace: layerTraces.slice(-40).join('\n') }),
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
            onTrace: text=>{
                layerTraces.push(text);
                if (layerTraces.length > TRACED_KEPT)
                {
                    layerTraces.shift();
                }
                events.emit('debug', { text });
            },
            registers: {
                /** @param {string} name */
                read: name=>core().api('cpu').readReg32(name),
                /** @param {string} name @param {number} value */
                write: (name, value)=>core().api('cpu').writeReg32(name, value),
                /** A long-mode thread's registers whole (`longState`). */
                long: ()=>core().api('cpu').longState(),
                /**
                 * Sets an XMM register's lanes, where an x64 function answers
                 * a float or a double.
                 *
                 * @param {number} index @param {Uint32Array} words
                 */
                writeXmm: (index, words)=>core().api('cpu').writeXmm(index, words),
                /**
                 * An XMM register's lanes, where a 32-bit runtime's SSE2
                 * entries take their argument.
                 *
                 * @param {number} index
                 */
                readXmm: index=>core().api('cpu').readXmm(index),
            },
            // A C runtime returns a double on the floating-point stack, not in
            // a register, so the functions that do are exported only when this
            // is here to leave one there.
            fpu: {
                /** @param {number} value */
                setResult: value=>core().api('cpu').fpu.setResult(value),
                /** @param {number} index */
                get: index=>core().api('cpu').fpu.get(index),
                pop: ()=>core().api('cpu').fpu.pop(),
                // The x87's words, for the runtime's floating-point functions
                // a 64-bit process runs as host handlers rather than code.
                controlWord: ()=>core().api('cpu').fpu.controlWord(),
                /** @param {number} word */
                setControlWord: word=>core().api('cpu').fpu.setControlWord(word),
                statusWord: ()=>core().api('cpu').fpu.statusWord(),
                clearExceptions: ()=>core().api('cpu').fpu.clearExceptions(),
                mxcsr: ()=>core().api('cpu').fpu.mxcsr(),
                /** @param {number} word */
                setMxcsr: word=>core().api('cpu').fpu.setMxcsr(word),
                // A thread's x87 and SSE state as FNSAVE's and FXSAVE's images,
                // which a CONTEXT's floating-point groups are.
                /** @param {any} [context] */
                images: context=>core().api('cpu').fpu.images?.(context) ?? null,
                /** @param {any} context @param {any} images */
                restore: (context, images)=>core().api('cpu').fpu.restore?.(context, images)
                    ?? false,
            },
            // The machine's RAM as the program is told it (`AppOptions.memorySize`).
            ramLimit,
            // In a gone process's memory, where the bytes it left end: each block
            // zeroed below it as it is handed out (`createHeapAllocator`).
            arena: { base: HEAP_BASE, size: HEAP_SIZE,
                ...options.reusedMemory ? { dirtyTo: options.reusedMemory.guestEnd } : {} },
            modules: {
                /**
                 * A module the process has loaded: one synthesised but not yet
                 * imported or loaded is not there to be asked about.
                 *
                 * @param {string | null} name
                 */
                find: name=>{
                    const module = moduleUnderContext()(name);
                    return module?.loaded === false ? null : module;
                },
                /** @param {number} base */
                byBase: modules.atBase,
                /** Every module the process has loaded, in the order it loaded them. */
                list: modules.loaded,
                /**
                 * The module an address lies in, or null: what a program asks
                 * GetModuleHandleEx of an address in its own code.
                 *
                 * @param {number} address
                 */
                containing: modules.containing,
                /**
                 * The image an address lies in, its base and size and its
                 * exception directory, for the x64 unwinder (`imageOf`): the
                 * `.pdata` table is an RVA and a size in the fourth data
                 * directory, read off the image a module carries.
                 *
                 * @param {number} address
                 */
                imageOf: address=>{
                    const at = address >>> 0;
                    for (const module of modules.all())
                    {
                        if (module.loaded === false || !module.image
                            || at < module.base || at >= module.base + (module.size ?? 0))
                        {
                            continue;
                        }
                        const directory = module.image.directories?.[DIR_EXCEPTION];
                        return {
                            base: module.base,
                            size: module.size ?? 0,
                            table: directory && directory.size > 0
                                ? { address: directory.address, size: directory.size } : null,
                        };
                    }
                    return null;
                },
                imagePath: ()=>options.imagePath ?? 'C:\\app.exe',
                dllNotifications,
                /**
                 * @param {string} name @param {number} [flags]
                 * @param {import('../layers/win32/kernel32/modules.js').LibrarySearch | null} [search]
                 */
                load: (name, flags, search)=>loadLibraryAtRuntime()(name, flags, undefined, 0,
                    search),
                /**
                 * GetProcAddress's answer: the export followed through its
                 * forwarders (`exportOf`), a forwarder's target loaded as the
                 * calling thread waits.
                 *
                 * @param {any} module @param {string | null} name
                 * @param {number | null} ordinal
                 */
                exportOf: (module, name, ordinal)=>exportOf()(module, name, ordinal,
                    (/** @type {string} */ library, /** @type {any} */ from)=>deps
                        .loadLibraryAtRuntime()(library, 0, kernel().currentThread(),
                            from.base ?? 0)),
                /** @param {string} name */
                loadError: name=>loadErrors().get(withLibraryExtension(name).toLowerCase()
                    .replace(/\.dll$/, '')) ?? null,
                /** @param {number} handle */
                dataFile: handle=>dataFiles.get(handle >>> 0) ?? null,
                /**
                 * What a thread's start and end are told of, image by image in
                 * load order (`imagesTold`); none for one that asked not to be.
                 */
                threadCalls: ()=>imagesTold()
                    .filter((/** @type {any} */ each)=>!withoutThreadCalls.has(each.base)),
                /**
                 * What the process's end is told of, the other way round: the
                 * last image attached first, each one's TLS callbacks still
                 * before its entry point, and the program's own last (decisions
                 * A50).
                 */
                processDetach: ()=>imagesTold().reverse(),
                /**
                 * DisableThreadLibraryCalls. An image with static thread-local
                 * storage goes on being told: its callbacks build each thread's
                 * thread-local objects, and the call is documented to make no
                 * optimisation for it.
                 *
                 * @param {number} base
                 */
                disableThreadCalls: base=>{
                    if (!threadLocalImages.has(base >>> 0))
                    {
                        withoutThreadCalls.add(base >>> 0);
                    }
                },
                loaderLock: ()=>loaderLock(),
                /** @param {any} asked */
                resolved: asked=>events.emit('resolved', asked),
                ...resourceLookup(()=>mainModule(), { get: modules.atBase }, dataFiles,
                    (address, length)=>core().api('memory').readBytes(address, length),
                    (address, length)=>core().api('memory').window(address, length)),
                /**
                 * The version resource of a file on the volume, by path: what
                 * an installer compares before it replaces a shared component.
                 *
                 * @param {string} path
                 */
                versionInfo: path=>versionResourceOf(filesystem(), path, blocks()),
                /**
                 * Where the program found the copy of a library the table
                 * answers in its place (`broughtCopies`), or null.
                 *
                 * @param {string} name
                 */
                broughtLibrary: name=>broughtCopies().get(moduleKeyOf(name)) ?? null,
                /**
                 * A whole file off the volume, waited for.
                 *
                 * @param {string} path
                 */
                readFile: path=>readWholeFile(filesystem(), blocks(), path),
                /**
                 * Whether a library is one this build synthesises, which has
                 * a version though no file.
                 *
                 * @param {string} name
                 */
                systemLibrary: name=>systemLibraries().has(moduleKeyOf(name)),
                /**
                 * Every library this build synthesises, whichever layer
                 * answers for it: what a setup finds in the system folder.
                 */
                systemLibraries: ()=>Object.keys(builtLibraries() ?? {}),
                /**
                 * A synthesised library's image, which its file holds where it
                 * stands in its folder (`withSystemLibraries`): read out of
                 * the guest's memory where it lies whole, rather than a copy
                 * of every library kept for a file few programs read.
                 *
                 * @param {string} name
                 */
                systemImage: name=>{
                    const module = modules.named(moduleKeyOf(name));
                    module?.place?.();
                    return module && !module.fromFile ? imageInMemory(/** @type {any} */ (memory()), module) : null;
                },
            },
            commandLine: options.commandLine,
            // The service the manager started this process for (a class's LocalService).
            ...options.service ? { service: options.service } : {},
            // Every child a program asks for, while the stack that asked is
            // still standing. Kept by the caller above this, because honouring
            // one of these tears the machine down and takes the logs with it.
            /** @param {any} request */
            spawned: request=>{
                // The image as it is now (`readImageNow`), for every way the
                // child is started to take before it reads the volume again.
                request.image ??= readImageNow(filesystem(), request.imagePath);
                events.emit('process-create', {
                    image: request.imagePath,
                    commandLine: request.commandLine,
                    suspended: request.suspended,
                });
                options.spawned?.({
                    imagePath: request.imagePath,
                    commandLine: request.commandLine,
                    suspended: request.suspended,
                    trace: formatTrace(captureTrace({ cpu: cpu(), memory: memory(),
                        kernel: kernel(), bridge: bridge(), traced: ()=>layerTraces.slice() })),
                });
                // Started at CreateProcess, beside this process, as on Windows:
                // a parent reaches into it before its next turn, and one made
                // suspended is there to be written into, its first thread
                // waiting for ResumeThread.
                if (options.beside && !request.completed)
                {
                    kernel().processes.started(request);
                    options.beside(request);
                }
            },
            // A child running beside this process, ended where it runs.
            terminate: (/** @type {any} */ request, /** @type {number} */ code)=>
                options.terminate?.(request, code) ?? false,
            // And a call made in it, answered where it runs: null for a
            // child the run does not have.
            askChild: (/** @type {any} */ request, /** @type {any} */ call)=>
                options.askChild?.(request, call) ?? null,
            // Its parent's ear when the parent debugs it (`debug-events.js`).
            debugger: options.debugger ?? null,
            /** @param {any} thread */
            threadBlock: thread=>{
                if (!threadBlocks())
                {
                    return;
                }
                giveBackBlocks();
                holdBlock(thread, threadBlocks().createThreadBlock({
                    id: thread.id, stackBase: thread.stackBase ?? thread.stackTop,
                    stackLimit: thread.stackLimit,
                    locals: threadLocals(),
                }));
            },
            idle: ()=>new Promise(resolve=>idlers().push(()=>resolve(undefined))),
            fetchBlocks: fetchBundleBlocks,
            /** @param {number} hwnd */
            created: hwnd=>{
                lastCreated.value = hwnd;
            },
        },
    };
}
