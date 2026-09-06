/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { assembleModules } from './core.js';
import { createEvents } from './events.js';
import { captureTrace, formatTrace } from './trace.js';
import { inflateRaw, resolveStorage } from './storage.js';
import { openBundle } from './layers/filesystem/internal/bundle/format.js';
import { createBundleSource } from './layers/filesystem/internal/bundle/source.js';
import { crc32 } from './layers/filesystem/internal/bundle/crc32.js';
import { createBlockCache, resolveBlockStore }
    from './layers/filesystem/internal/bundle/cache.js';

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
 * @typedef {Object} AppOptions
 * @property {Uint8Array} executable      The program to run.
 * @property {Object} v86                 Emulator artifacts.
 * @property {string} v86.moduleUrl
 * @property {ArrayBuffer} v86.wasmBytes
 * @property {number} [stackSize]
 * @property {number} [heapSize]     Bytes the guest's heap may allocate out of.
 * @property {string} [imagePath]    What the program believes it was loaded from.
 * @property {any} [storage]
 *           Where the session comes from and goes: a provider with `load` and
 *           `save`, a function that only loads, or the string `local`.
 * @property {string} [id]           Names the session when storage does not.
 * @property {Object} [bundle]       A .btl mounted as the volume's read-only source.
 * @property {(offset: number, length: number) => Promise<Uint8Array>} bundle.fetch
 *           Brings a byte range of the bundle in, from wherever it is kept.
 * @property {any} [bundle.store]  Where fetched blocks are kept. `'local'` is
 *           the default and means this machine; a synchronous store of your own
 *           is used as given; anything falsy keeps nothing, and a block the
 *           reader has let go is then fetched again.
 * @property {string} [bundle.id]  Names this bundle's cache. Two bundles sharing
 *           a name would read each other's blocks, so it has to be the bundle's.
 * @property {string} [bundle.indexSha256]  From the manifest. Checked against
 *           the index this bundle actually carries, which is what makes the
 *           per-block checksums inside it worth trusting.
 * @property {Object} [bundle.retry] How hard to try when that fetch fails.
 * @property {number} [bundle.retry.attempts]     Including the first. Default 6.
 * @property {number} [bundle.retry.baseDelayMs]  Doubled each attempt. Default 250.
 * @property {number} [bundle.retry.maxDelayMs]   Ceiling for that. Default 10000.
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
 * @returns {Promise<((needed: any[]) => Promise<void>) | null>}
 */
async function mountBundle({ options, cpu, filesystem, events }){
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

    /**
     * A block, turned back into bytes, without awaiting anything.
     *
     * zstd is decoded here because the emulator carries a decoder that answers
     * synchronously. Deflate has no synchronous decoder in a browser at all, so
     * a deflate block is inflated when it is *fetched* -- which is already an
     * asynchronous step -- and by the time a read reaches it, it is plain. That
     * is why codec 1 is passed through rather than refused.
     *
     * @param {number} codec
     * @param {Uint8Array} bytes
     * @param {number | null} expectedLength
     */
    const decode = (codec, bytes, expectedLength)=>{
        if (codec === 2)
        {
            return cpu.decompressZstd(bytes, expectedLength ?? 0);
        }
        return bytes;
    };

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
        name: options.bundle.id ?? options.id ?? 'bundle',
        blockSize: bundle.blockSize,
        blockCount: bundle.blockCount,
    });

    const source = createBundleSource({
        bundle,
        /** @param {number} index */
        readBlock: index=>cache.read(index, storedLength(bundle.block(index))),
        decode,
    });

    filesystem.mount('C', { source });
    events.emit('bundle', {
        files: bundle.files.length,
        blockSize: bundle.blockSize,
        blocks: bundle.blockCount,
        cached: cache.diagnostics().resident,
        backed: cache.backed,
    });

    /** @param {any[]} needed */
    return async needed=>{
        for (const block of needed)
        {
            if (cache.has(block.index))
            {
                continue;
            }
            const expected = bundle.block(block.index).crc;
            const raw = await fetchRange(block.offset, block.packed, bytes=>{
                if (expected === null)
                {
                    return null;
                }
                const found = crc32(bytes);
                return found === expected
                    ? null
                    : `block ${block.index} arrived damaged (checksum ${found}, `
                        + `expected ${expected})`;
            });
            // Inflated here, once, rather than on every read: this is the only
            // place a deflate block can be decoded at all, since the read side
            // is synchronous and the browser's inflate is not.
            cache.put(block.index,
                bundle.block(block.index).codec === 1 ? await inflateRaw(raw) : raw);
        }
        // Once per batch, not once per block: losing the record of a block that
        // is already on disk costs one refetch, and writing it every time would
        // cost far more than that.
        await cache.persist();
    };
}

/**
 * @param {AppOptions} options
 * @returns {Promise<any>} an AppController
 */
export async function createApp(options){
    const events = createEvents();

    // The address space above the program: a heap first, then the system
    // modules one after another. Both sit well clear of an executable's own
    // preferred base (0x400000) and inside the memory the emulator was given,
    // which is what an address beyond it fails against.
    const HEAP_BASE = 0x01000000;
    const HEAP_SIZE = options.heapSize ?? 0x00800000;
    const MODULE_BASE = 0x02000000;
    const MODULE_STRIDE = 0x00100000;

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
    /** @type {any} */
    let mainModule = null;

    /** @param {string | null} name */
    const findModule = name=>{
        if (name === null || name === '')
        {
            return mainModule;
        }
        // A name may arrive with or without its extension, and case never
        // matters: the same library is asked for both ways in one program.
        const wanted = name.toLowerCase().replace(/\.dll$/, '');
        return byName.get(wanted) ?? null;
    };

    // Where input goes when nobody says otherwise: the most recently created
    // window, which is what a person would be looking at.
    let foreground = 0;

    // Filled in once the emulator is up and a bundle, if any, is mounted. win32
    // is built before that and is handed the lookup rather than the answer.
    /** @type {((needed: any[]) => Promise<void>) | null} */
    let blocks = null;

    // A call that is waiting -- a message loop with an empty queue -- is let go
    // once per scheduler turn to look again.
    /** @type {(() => void)[]} */
    let idlers = [];

    const core = await assembleModules({
        win32: {
            /** @param {number} handle @param {string} text */
            onOutput: (handle, text)=>events.emit('output', { handle, text }),
            /** @param {string} text */
            onTrace: text=>events.emit('debug', { text }),
            arena: { base: HEAP_BASE, size: HEAP_SIZE },
            modules: {
                /** @param {string | null} name */
                find: name=>findModule(name),
                /** @param {number} base */
                byBase: base=>byBase.get(base >>> 0) ?? null,
                imagePath: ()=>options.imagePath ?? 'C:\\app.exe',
            },
            idle: ()=>new Promise(resolve=>idlers.push(()=>resolve(undefined))),
            /** @param {any[]} needed */
            fetchBlocks: needed=>blocks ? blocks(needed) : Promise.resolve(),
            /** @param {number} hwnd */
            created: hwnd=>{
                foreground = hwnd;
            },
        },
    });

    const filesystem = core.api('filesystem');
    const storage = resolveStorage(options.storage, options.id ?? 'session');

    // Seeded before the program's first instruction, and awaited: a save that
    // arrives after the program has looked for it is a save that was not there.
    const seeded = await storage.load();
    if (seeded.length > 0)
    {
        filesystem.apply(seeded);
    }

    // One way out. What the program writes is announced once the writes settle;
    // nothing is ever pulled back in while it runs.
    const persist = storage.save;
    if (persist)
    {
        filesystem.onChanged((/** @type {any[]} */ changes)=>{
            events.emit('session', { changes });
            Promise.resolve(persist(filesystem.export(), changes)).catch(
                (/** @type {Error} */ error)=>{
                    events.emit('error', { reason: 'session-save', error });
                });
        });
    }

    const cpu = core.api('cpu');
    const memory = core.api('memory');
    const kernel = core.api('kernel');
    const loader = core.api('loader');
    const win32 = core.api('win32');
    const bridge = core.api('bridge');

    await cpu.boot(options.v86);

    // Mounted after the emulator is up, because the decoder for a compressed
    // block is inside it: zstd is the only decompressor available here that
    // answers a guest's read without a promise.
    blocks = await mountBundle({ options, cpu, filesystem, events });

    const { entryVector, initialStack, thunkBase } = cpu.layout;
    const stackSize = options.stackSize ?? 0x10000;

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

    // Every system module exists in guest memory before the program's first
    // instruction, not when something first asks for it. An address taken early
    // has to be the address that works later (§13.3), and a module conjured on
    // demand cannot promise that.
    Object.entries(win32.libraries()).forEach(([name, table], index)=>{
        const exports = Object.entries(table).map(([exported, fn])=>({
            name: exported,
            target: bridge.register(`${name}!${exported}`, fn),
        }));

        const base = MODULE_BASE + index * MODULE_STRIDE;
        const placed = loader.synthesise({ name, base, exports });

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

        const record = {
            name,
            base,
            size: placed.size,
            /** @param {string} exported */
            addressOf: exported=>addresses.get(exported) ?? null,
            /** @param {number} ordinal */
            addressOfOrdinal: ordinal=>ordinals.get(ordinal) ?? null,
        };
        byName.set(name.toLowerCase().replace(/\.dll$/, ''), record);
        byBase.set(base, record);
    });

    const image = loader.load(options.executable, {
        resolveImport: (/** @type {string} */ dll, /** @type {string | null} */ name)=>{
            const module = findModule(dll);
            return module && name ? module.addressOf(name) : null;
        },
    });

    mainModule = {
        name: 'app.exe',
        base: image.base,
        addressOf: ()=>null,
        addressOfOrdinal: ()=>null,
    };
    byBase.set(image.base, mainModule);

    const stubs = cpu.thunkImage();
    memory.register({
        name: 'thunks', base: thunkBase, size: stubs.length,
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    memory.writeBytes(thunkBase, stubs);
    // Written once; from here a write into the stubs would be corruption.
    memory.protect('thunks', memory.Access.READ_EXECUTE);

    memory.writeU32(entryVector, image.entryPoint);

    // The program's first thread. Everything after this runs under the
    // scheduler, including the main thread -- there is no privileged path.
    const mainThread = kernel.createThread({
        entry: image.entryPoint,
        stackTop: initialStack,
        name: 'main',
    });

    /**
     * Pausing is a gate rather than a flag polled in a loop: a paused caller
     * waits on a promise that resuming resolves, so nothing spins.
     *
     * @type {{ gate: Promise<void>, open: () => void } | null}
     */
    let paused = null;

    // attachLog is sugar over the registry: the same subscription, remembered
    // by the sink the caller gave, so detaching still takes what it was given.
    /** @type {Map<Function, (payload: any) => void>} */
    const logSinks = new Map();

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
        const trace = captureTrace({ cpu, memory, kernel, bridge });
        const text = formatTrace(trace);
        const thrown = error instanceof Error ? error : new Error(String(error));
        Object.assign(thrown, { reason, trace, traceText: text });
        return events.emit('error', { reason, error: thrown, trace, text }) ?? thrown;
    };

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
         * @returns {Promise<number>} the guest's exit code
         */
        async run({ maxTurns = 200000 } = {}){
            for (let turn = 0; turn < maxTurns; turn++)
            {
                if (paused)
                {
                    await paused.gate;
                }

                // One yield per turn, so a host function suspended on a guest
                // callback can make progress between them. Without it the loop
                // never returns to the event loop on its normal path and such a
                // handler would be resumed exactly never.
                await Promise.resolve();

                // And a turn is also when anything waiting for something to
                // arrive -- a message loop with an empty queue -- gets to look
                // again. Taken as a batch: a waiter that goes back to waiting
                // must not be released twice by its own turn.
                if (idlers.length > 0)
                {
                    const waiting = idlers;
                    idlers = [];
                    for (const release of waiting)
                    {
                        release();
                    }
                    await Promise.resolve();
                }

                // Still waiting after being let look, or a host call suspended
                // on something outside the microtask queue -- a fetch, a file
                // read -- means the machine has nothing to do until the host
                // gets a turn. A microtask does not give it one, so this is the
                // one place the loop hands it back, and it costs nothing
                // precisely because the guest is not running.
                if (idlers.length > 0 || bridge.suspended() > 0)
                {
                    await new Promise(resolve=>setTimeout(resolve, 0));
                }

                const failure = bridge.failure();
                if (failure)
                {
                    throw fail('host-call', failure);
                }

                const code = win32.exitCode();
                if (code !== null)
                {
                    events.emit('exit', { code });
                    return code;
                }

                let step;
                try
                {
                    step = kernel.runOnce();
                }
                catch (e){
                    // A fault inside the guest, or inside a host function
                    // answering it. Either way the program cannot be told, and
                    // the state that explains it is about to be lost.
                    throw fail('guest', e);
                }

                if (!step.ran)
                {
                    // Nobody is ready. Either everything finished without the
                    // program exiting, or every thread is waiting on something
                    // no one will signal -- and the diagnostics name what.
                    const waiting = kernel.diagnosticsSnapshot().waiting;
                    if (waiting.length > 0)
                    {
                        throw fail('deadlock', new Error(`deadlock: ${waiting.join('; ')}`));
                    }
                    throw fail('no-threads',
                        new Error('every thread ended without the process exiting'));
                }
            }
            throw fail('runaway',
                new Error(`program did not finish within ${maxTurns} turns`));
        },

        /** The program's first thread. */
        mainThread,

        /**
         * Stops handing out turns without ending anything; `resume` continues
         * from the same place, since no thread's state was touched.
         */
        pause(){
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
        },
        resume(){
            if (!paused)
            {
                return;
            }
            paused.open();
            paused = null;
        },
        stop: ()=>cpu.stop(),

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
                hwnd: message.hwnd ?? foreground,
                message: message.message,
                wParam: message.wParam ?? 0,
                lParam: message.lParam ?? 0,
            });
        },

        /** The registry the program reads and writes; it outlives the process. */
        registry: ()=>win32.registry(),

        /**
         * The session: everything the program has written, and the way to put
         * files in from outside.
         */
        session: {
            /** @returns {{ path: string, bytes: Uint8Array }[]} */
            export: ()=>filesystem.export(),
            /** @param {{ path: string, bytes?: Uint8Array, delete?: boolean }[]} changes */
            apply: changes=>filesystem.apply(changes),
        },

        exitCode: ()=>win32.exitCode(),
        diagnostics: ()=>[
            ...core.diagnostics(),
            { name: 'app', version: '0.1.0', status: 'ready', metrics: events.diagnostics() },
        ],
        dispose: ()=>core.dispose(),
    };
}
