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
 * The journal is the one thing kept in step on this side. A reader polls it
 * synchronously, so the page keeps a mirror that follows the worker's ring
 * a few times a second; `log.recent` and `log.drain` read the mirror, and a
 * mirror that falls behind reads as the gap the ring would have shown.
 */

import { createDomInput } from '../layers/input/dom.js';

/** How often the journal mirror asks the worker for what was written. */
const MIRROR_MS = 200;
/** How many records one refresh may carry across. */
const MIRROR_LIMIT = 4000;
/** How many the mirror keeps when the run named no capacity of its own. */
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

    // The journal, kept in step. Records carry their own sequence, so the
    // mirror's drain answers exactly as the ring's would for what it holds.
    const capacity = options.log?.capacity || MIRROR_CAPACITY;
    /** @type {any[]} */
    let records = [];
    let next = 0;
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
    const mirror = setInterval(refresh, MIRROR_MS);

    /** What an exit left behind, once there has been one. @type {any} */
    let left = null;

    /** @type {ReturnType<typeof createDomInput> | null} */
    let dom = null;
    /** @type {Map<(handle: number, text: string) => void, () => void>} */
    const sinks = new Map();

    return {
        /**
         * Runs the program to completion. Resolves with its exit code once
         * the journal mirror has caught up, so a tail read right after is the
         * tail.
         *
         * @param {{ maxTurns?: number }} [runOptions]
         * @returns {Promise<number>}
         */
        async run(runOptions){
            left = await request('run', [runOptions]);
            await refresh();
            return left.code;
        },
        pause: ()=>request('pause'),
        resume: ()=>request('resume'),
        stop: ()=>request('stop'),
        /**
         * Every layer's table, or one layer's by name -- the cheap read for
         * a poll after a few counters.
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
            /** @param {number} [count] */
            recent: (count = 100)=>records.slice(Math.max(0, records.length - count)),
            /** @param {number} [since] @param {number} [limit] */
            drain(since = 0, limit = 1000){
                const oldest = records.length > 0 ? records[0].sequence : next;
                const from = Math.max(since, oldest);
                const taken = [];
                for (const record of records)
                {
                    if (record.sequence >= from && taken.length < limit)
                    {
                        taken.push(record);
                    }
                }
                const end = taken.length > 0 ? taken[taken.length - 1].sequence + 1 : from;
                return { records: taken, from, next: end, lost: 0 };
            },
            /** @param {string} category @param {string | number} level */
            setLevel: (category, level)=>request('log.setLevel', [category, level]),
            /** @param {string | number} level */
            setDefaultLevel: level=>request('log.setDefaultLevel', [level]),
            areas: ()=>['cpu', 'gpu', 'audio', 'video', 'input', 'net', 'com']
                .map(area=>`call.${area}`),
            /** @param {number} [worst] */
            profile: worst=>request('log.profile', [worst]),
            /** @param {number} [count] */
            frames: count=>request('log.frames', [count]),
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
