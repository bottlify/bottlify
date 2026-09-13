/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page's end of the wire: an application that runs in a worker, held
 * through the same handle a page would hold a local one by.
 *
 * What stays on the page is what only a page has: the canvas the frames land
 * in (transferred to the worker as an OffscreenCanvas once and never touched
 * per frame), the DOM events a person produces, the audio context that reads
 * the ring, and whether anybody is looking. Everything else is a request over
 * the port, and answers when the worker answers -- so `diagnostics()` is a
 * promise here, and `run()` settles when the program has ended.
 *
 * The log is read here, not asked for. The engine publishes its journal and
 * its tables into shared memory and that memory crosses once, in the answer
 * that starts the program; from then on records, frames, phases, counters and
 * the kernel's tables are decoded on this thread, and nothing a reader does
 * reaches the engine's. What remains a request is what only the engine can
 * do: change the writer's gate, and describe itself cold (`diagnostics`).
 *
 * Where the origin has no shared memory the block cannot cross, and the same
 * answers come back over the port instead -- the page then keeps a mirror of
 * the ring so that `recent` and `drain` still answer without waiting. A flood
 * laps the ring between two refreshes, and a reader slower than the mirror is
 * lapped by the mirror: both leave holes in the sequence the mirror holds, and
 * a drain counts every sequence it was asked for and cannot hand over, so
 * `lost` is exact whichever side lost it. `log.reading()` says which of the
 * two a run ended up on.
 */

import { createDomInput } from '../layers/input/dom.js';
import { createLogReader } from '../layers/log/reader.js';

/** How often the page reads what the engine has written since its last look. */
const MIRROR_MS = 200;
/** How many records one look may carry. */
const MIRROR_LIMIT = 4000;
/** How many records the journal holds when the run named no capacity of its own. */
const MIRROR_CAPACITY = 4096;

/**
 * @typedef {Object} RemoteAppOptions
 * @property {any} worker
 *     The worker running `engine.worker.js`, or any port that answers like it.
 *     The caller's to end: disposing the application leaves the worker ready
 *     for another, in the same canvas.
 * @property {import('./messages.js').StartOptions} options
 * @property {any} [canvas]
 *     The canvas the frames land in. Its control is transferred to the worker,
 *     so nothing on the page may draw to it afterwards -- and it can be
 *     transferred once, so a later program in the same canvas is started with
 *     the same worker and no canvas at all.
 * @property {any[]} [transfer]
 *     Buffers in `options` to hand over rather than copy: the image, the
 *     emulator's binary, the decoder's.
 */

/**
 * @param {RemoteAppOptions} how
 * @returns {Promise<any>} the controller, shaped like an AppController where
 *     it can be and answering with promises where it cannot
 */
export async function createRemoteApp({ worker, options, canvas, transfer = [] }){
    let nextId = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (e: Error) => void }>} */
    const pending = new Map();
    // One shared word, added to before every post, so the worker can tell a
    // message is waiting without yielding to find out. Only where the origin
    // has shared memory; elsewhere the worker looks on a clock instead.
    const signal = typeof SharedArrayBuffer === 'function'
        && /** @type {any} */ (globalThis).crossOriginIsolated !== false
        ? new Int32Array(new SharedArrayBuffer(4))
        : null;
    /** What crossed the port, by kind: the cost of the page's own tooling, counted. */
    const traffic = { input: 0, request: 0, visibility: 0, answer: 0, event: 0 };
    /** @param {any} message @param {any[]} [handOver] */
    const send = (message, handOver)=>{
        if (signal)
        {
            Atomics.add(signal, 0, 1);
        }
        traffic[/** @type {keyof typeof traffic} */ (message.type)]++;
        worker.postMessage(message, handOver);
    };
    /** @type {Map<string, Set<(payload: any) => void>>} */
    const handlers = new Map();
    /** The frame's own pixels, which is the space a pointer position lives in. */
    let frame = { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
    let frames = 0;
    let gone = false;

    /**
     * @param {string} method
     * @param {unknown[]} [args]
     * @param {any[]} [handOver]
     * @returns {Promise<any>}
     */
    const request = (method, args = [], handOver = [])=>new Promise((resolve, reject)=>{
        if (gone)
        {
            reject(new Error(`${method}: the worker is gone`));
            return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        /** @type {import('./messages.js').RequestMessage} */
        const message = { type: 'request', id, method, args };
        send(message, handOver);
    });

    /** @param {import('./messages.js').Failure} failure */
    const rebuild = failure=>Object.assign(new Error(failure.message), {
        reason: failure.reason,
        traceText: failure.traceText,
        stack: failure.stack ?? undefined,
    });

    /** @param {Error} why */
    const abandon = why=>{
        gone = true;
        for (const [id, waiting] of pending)
        {
            pending.delete(id);
            waiting.reject(why);
        }
    };

    worker.onmessage = (/** @type {{ data: import('./messages.js').FromEngine }} */ { data })=>{
        const message = data;
        traffic[message.type]++;
        if (message.type === 'answer')
        {
            const waiting = pending.get(message.id);
            if (!waiting)
            {
                return;
            }
            pending.delete(message.id);
            if (message.error)
            {
                waiting.reject(rebuild(message.error));
            }
            else
            {
                waiting.resolve(message.result);
            }
            return;
        }
        if (message.type === 'event')
        {
            if (message.name === 'frame')
            {
                const payload = /** @type {import('./messages.js').FramePayload} */ (message.payload);
                frame = { width: payload.width, height: payload.height };
                frames = payload.presented;
            }
            for (const handler of handlers.get(message.name) ?? [])
            {
                handler(message.payload);
            }
        }
    };
    worker.onerror = (/** @type {any} */ event)=>{
        abandon(new Error(`the engine worker failed: ${event?.message ?? event}`));
    };

    // Whether anybody is looking: engine pacing, never something the guest is
    // told. Posted once now and on every change, from the page that knows.
    const page = /** @type {any} */ (globalThis).document;
    /** @type {(() => void) | null} */
    let stopWatching = null;
    if (page && typeof page.addEventListener === 'function')
    {
        const tell = ()=>{
            /** @type {import('./messages.js').VisibilityMessage} */
            const message = { type: 'visibility', hidden: Boolean(page.hidden) };
            send(message);
        };
        tell();
        page.addEventListener('visibilitychange', tell);
        stopWatching = ()=>page.removeEventListener('visibilitychange', tell);
    }

    const offscreen = canvas?.transferControlToOffscreen?.() ?? canvas ?? null;
    /** @type {import('./messages.js').Started} */
    const started = await request('start',
        [{ ...options, signal: signal ? signal.buffer : undefined }, offscreen],
        [...transfer, ...(offscreen && offscreen !== canvas ? [offscreen] : [])]);

    // The log, read on this thread out of the memory that crossed at start.
    // Absent -- no shared memory on this origin -- the mirror below stands in.
    const reader = started.log ? createLogReader({ memory: started.log }) : null;
    const capacity = options.log?.capacity || MIRROR_CAPACITY;

    // The journal, kept in step. Records carry their own sequence, so the
    // mirror's drain answers exactly as the ring's would for what it holds.
    /** @type {any[]} */
    let records = [];
    let next = 0;
    let mirrorLost = 0;
    let refreshing = false;
    const refresh = async()=>{
        if (refreshing || gone)
        {
            return;
        }
        refreshing = true;
        try
        {
            const answer = await request('log.drain', [next, MIRROR_LIMIT]);
            mirrorLost += answer.lost;
            records = records.concat(answer.records);
            if (records.length > capacity)
            {
                records = records.slice(records.length - capacity);
            }
            next = answer.next;
        }
        catch {
            // The worker is gone or going: the mirror keeps what it has.
        }
        finally
        {
            refreshing = false;
        }
    };
    // The page's own cadence either way: a poll of the reader is what counts
    // exactly how far it was lapped and what hands records to its subscribers,
    // and it reads memory rather than asking anybody for anything.
    const catchUp = reader ? async()=>{
        reader.poll(MIRROR_LIMIT);
    } : refresh;
    const mirror = setInterval(catchUp, MIRROR_MS);

    /** What an exit left behind, once there has been one. @type {any} */
    let left = null;

    /** @type {ReturnType<typeof createDomInput> | null} */
    let dom = null;
    /** @type {Map<(handle: number, text: string) => void, () => void>} */
    const sinks = new Map();

    return {
        /**
         * Runs the program to completion. Resolves with its exit code once
         * this side's last look at the journal is done, so a tail read right
         * after is the tail.
         *
         * @param {{ maxTurns?: number }} [runOptions]
         * @returns {Promise<number>}
         */
        async run(runOptions){
            left = await request('run', [runOptions]);
            await catchUp();
            return left.code;
        },
        pause: ()=>request('pause'),
        resume: ()=>request('resume'),
        stop: ()=>request('stop'),
        /**
         * Every layer's table, or one layer's by name: the cold description of
         * where the engine stands, and the only way to see a layer that
         * publishes no table of its own.
         *
         * Deliberately a request, and deliberately not for a poll -- answering
         * it is the engine's thread describing itself instead of running the
         * program. What a poll wants is under `log`, read here.
         *
         * @param {string} [layer]
         * @returns {Promise<any[]>}
         */
        diagnostics: layer=>request('diagnostics', layer === undefined ? [] : [layer]),
        /** Messages by kind since the start, both ways. */
        traffic: ()=>({ ...traffic }),
        /** @returns {Promise<string>} */
        trace: ()=>request('trace'),
        /** @returns {Promise<{ count: number, history: import('./messages.js').Presented[] }>} */
        presented: ()=>request('presented'),

        /**
         * The emulator's account of where the guest ran, by address, weighted by
         * the instructions retired there. The same surface the local controller
         * offers, because the run worth profiling is the one a page drives.
         *
         * Costs a call per compiled block while it is kept, so it is started for
         * a measurement and stopped after.
         */
        guestProfile: {
            /** @returns {Promise<boolean>} */
            available: ()=>request('guestProfile.available'),
            /** @returns {Promise<{ counters: Record<string, number>,
             *     opcodes: { kind: string, is0f: boolean, opcode: number, isMem: boolean,
             *         group: number, count: number }[] } | null>} */
            instructionStats: ()=>request('guestProfile.instructionStats'),
            /**
             * @param {{ keepCode?: boolean }} [how] Kept code makes the account
             *     the interpreter's own instructions.
             * @returns {Promise<boolean>}
             */
            start: how=>request('guestProfile.start', [how]),
            /** @returns {Promise<{ entries: { address: number, instructions: number,
             *     hits: number }[], dropped: number } | null>} */
            read: ()=>request('guestProfile.read'),
            /** @returns {Promise<void>} */
            stop: ()=>request('guestProfile.stop'),
        },
        /** Frames shown, as of the last frame event. */
        frames: ()=>frames,

        /**
         * @param {string} name
         * @param {(payload: any) => void} handler
         * @returns {() => void}
         */
        on(name, handler){
            let set = handlers.get(name);
            if (!set)
            {
                set = new Set();
                handlers.set(name, set);
                if (name !== 'frame')
                {
                    request('on', [name]).catch(()=>{});
                }
            }
            set.add(handler);
            return ()=>set?.delete(handler);
        },

        /**
         * What the program writes to its standard handles, as it writes it.
         *
         * @param {(handle: number, text: string) => void} sink
         */
        attachLog(sink){
            /** @param {{ handle: number, text: string }} payload */
            const handler = payload=>sink(payload.handle, payload.text);
            sinks.set(sink, this.on('output', handler));
        },
        /** @param {(handle: number, text: string) => void} sink */
        detachLog(sink){
            sinks.get(sink)?.();
            sinks.delete(sink);
        },

        log: {
            /**
             * Which of the two ways the log is being read: from the memory the
             * engine writes into, or by asking the engine. A panel shows it
             * because the difference is visible in everything else -- without
             * shared memory every figure below costs the running program.
             *
             * @returns {'shared' | 'requests'}
             */
            reading: ()=>reader ? 'shared' : 'requests',
            /**
             * The memory a reader is built over, for a consumer that wants one
             * of its own -- a worker of its own, a view that polls at its own
             * rate. Null where nothing could be shared.
             */
            memory: ()=>started.log ?? null,

            /** @param {number} [count] */
            recent: (count = 100)=>reader
                ? reader.recent(count)
                : records.slice(Math.max(0, records.length - count)),
            /** @param {number} [since] @param {number} [limit] */
            drain(since = 0, limit = 1000){
                if (reader)
                {
                    return reader.drain(since, limit);
                }
                const taken = [];
                for (const record of records)
                {
                    if (record.sequence >= since && taken.length < limit)
                    {
                        taken.push(record);
                    }
                }
                const oldest = records.length > 0 ? records[0].sequence : next;
                const from = taken.length > 0 ? taken[0].sequence : Math.max(since, oldest);
                const end = taken.length > 0 ? taken[taken.length - 1].sequence + 1 : from;
                // Every sequence from `since` up to where this read ends that
                // is not in what it hands over was written over somewhere.
                const lost = Math.max(0, end - since - taken.length);
                return { records: taken, from, next: end, lost };
            },
            /**
             * A level is the writer's gate, so changing one is a request: only
             * the thread that keeps a record can be told what to keep.
             *
             * @param {string} category @param {string | number} level
             */
            setLevel: (category, level)=>request('log.setLevel', [category, level]),
            /** @param {string | number} level */
            setDefaultLevel: level=>request('log.setDefaultLevel', [level]),
            // The same list the engine answers with. Kept here because the
            // page offers the filter before a run exists to be asked.
            areas: ()=>[
                ...['cpu', 'gpu', 'audio', 'video', 'input', 'net', 'com']
                    .map(area=>`call.${area}`),
                'input.press',
            ],

            /** @param {number} [worst] */
            profile: worst=>reader ? reader.profile(worst) : request('log.profile', [worst]),
            /** @param {number} [count] */
            frames: count=>reader ? reader.frames(count) : request('log.frames', [count]),
            /** @param {string} layer @returns {Record<string, number> | Promise<any>} */
            counters: layer=>reader ? reader.counters(layer) : request('log.counters', [layer]),
            /**
             * One published table, read where it lies. Shared memory only:
             * a table is its buffer, and a copy of it is a table that has
             * stopped moving, which is worse than no answer at all.
             *
             * @param {string} layer @param {string} name
             */
            table: (layer, name)=>reader ? reader.table(layer, name) : null,
            /**
             * What a word id in a table means. Shared memory only, for the
             * same reason as `table`.
             *
             * @param {number} id
             */
            word: id=>reader ? reader.word(id) : `#${id}`,
            threads: ()=>reader ? reader.threads() : request('log.threads'),
            guestByModule: ()=>reader
                ? reader.guestByModule()
                : request('log.guestByModule'),
            /**
             * The journal itself: how much has been written, how much it
             * holds, how much was lapped before this reader saw it, and how
             * much a level refused.
             */
            stats(){
                if (!reader)
                {
                    return request('log.counters', ['log']).then(own=>({
                        written: next, capacity, lost: mirrorLost, rejected: own.rejected ?? 0,
                    }));
                }
                // `written` is the last record's sequence plus one rather than
                // a counter of its own: the sequence is what the ring
                // publishes, and one decoded record is the cost of asking.
                const tail = reader.recent(1);
                return {
                    written: tail.length > 0 ? tail[0].sequence + 1 : 0,
                    capacity,
                    lost: reader.lost(),
                    rejected: reader.counters('log').rejected ?? 0,
                };
            },
        },

        audio: {
            ring: ()=>{
                if (!started.audio)
                {
                    throw new Error('this run has no sound ring');
                }
                return { memory: started.audio.memory };
            },
            format: ()=>{
                if (!started.audio)
                {
                    throw new Error('this run has no sound ring');
                }
                return { sampleRate: started.audio.sampleRate, channels: started.audio.channels };
            },
        },
        adapter: started.adapter,

        /**
         * Input: the page captures, the worker consumes. Keyboard and mouse
         * are the only browser signals that cross, and they cross as the
         * router's own events; the worker never sees a DOM event.
         */
        input: {
            /** @param {any} viewport */
            attach(viewport){
                dom?.detach();
                dom = createDomInput({
                    canvas: viewport,
                    send: event=>{
                        /** @type {import('./messages.js').InputMessage} */
                        const message = { type: 'input', event };
                        send(message);
                    },
                    // The page's canvas is a placeholder once its control is
                    // transferred, and its size attributes stay where the
                    // page left them; the frame's size is what the worker said.
                    resolution: ()=>frame,
                });
                request('input.attach').catch(()=>{});
                return dom;
            },
            detach(){
                dom?.detach();
                dom = null;
                request('input.detach').catch(()=>{});
            },
            /** @param {import('../layers/input/router.js').HostInputEvent} event */
            send(event){
                /** @type {import('./messages.js').InputMessage} */
                const message = { type: 'input', event };
                send(message);
            },
            poll: ()=>dom?.poll(),
        },

        /**
         * What the program wrote, as of its exit. Synchronous, like the local
         * controller's, because it is read the moment the run reports an
         * exit; before that there is nothing to read.
         */
        session: {
            export(){
                if (!left)
                {
                    throw new Error('the program has not exited yet');
                }
                return left.files;
            },
        },
        registry: ()=>({
            toJSON(){
                if (!left)
                {
                    throw new Error('the program has not exited yet');
                }
                return left.registry;
            },
        }),

        async dispose(){
            clearInterval(mirror);
            stopWatching?.();
            dom?.detach();
            dom = null;
            try
            {
                await request('dispose');
            }
            finally
            {
                abandon(new Error('the engine was disposed'));
            }
        },
    };
}
