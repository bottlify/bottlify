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
 * The log is asked for, not read here. The engine publishes its journal and
 * its tables into shared memory; a worker of its own -- the keeper -- is
 * handed that block, polls it before it laps, keeps the history, works out the
 * derived views, and answers every read this page makes. Nothing a reader does
 * reaches the engine's thread, and this thread holds no reader and no poll of
 * its own: it is a relay between whoever calls `app.log.*` and the keeper.
 *
 * Where the origin has no shared memory the block cannot cross, and the page
 * relays the engine's own `log.drain` answers to the keeper instead, so the
 * history is still the keeper's and this thread never keeps the log either.
 * `log.reading()` says which of the two a run ended up on.
 */

import { createDomInput } from '../layers/input/dom.js';
import { serveKeeper, MIRROR_MS, MIRROR_LIMIT, MIRROR_CAPACITY } from './keeper.js';

/**
 * The keeper, in a worker of its own. A test can hand in its own port instead
 * of a real worker; without `Worker` -- a thread-hosted run, a headless one --
 * the same keeper is served over a `MessageChannel` on this thread, which is
 * the engine's own fallback.
 *
 * @param {any} [given]
 * @returns {{ port: any, close: () => void }}
 */
function openKeeper(given){
    if (given)
    {
        return { port: given, close(){} };
    }
    if (typeof Worker === 'function')
    {
        const worker = new Worker(new URL('./log.worker.js', import.meta.url),
            { type: 'module' });
        return { port: worker, close: ()=>worker.terminate() };
    }
    const channel = new MessageChannel();
    const serving = serveKeeper(/** @type {any} */ (channel.port2));
    return {
        port: channel.port1,
        close(){
            serving.close();
            channel.port1.close();
            channel.port2.close();
        },
    };
}

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
 * @property {any} [keeper]
 *     The log keeper's port, when a test supplies one. Absent, a worker is
 *     created the way the engine's is.
 */

/**
 * @param {RemoteAppOptions} wiring
 * @returns {Promise<any>} the controller, shaped like an AppController where
 *     it can be and answering with promises where it cannot
 */
export async function createRemoteApp(wiring){
    const { worker, options, canvas, transfer = [], keeper: givenKeeper } = wiring;
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
    const traffic = { input: 0, request: 0, visibility: 0, answer: 0, event: 0, 'log-memory': 0 };
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

    // The log keeper: a worker that owns the log, so this thread holds no
    // reader and polls nothing. Every read below is a request to it, and the
    // memory the engine publishes crosses to it as a share, not a copy.
    const keeper = openKeeper(givenKeeper);
    let keeperId = 0;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (e: Error) => void }>} */
    const keeperPending = new Map();
    /** Subscriptions this page has made, by id, for records as they arrive. */
    /** @type {Map<number, (records: any[]) => void>} */
    const subscriptions = new Map();
    /** The block of the current process, for a consumer wanting its own reader. */
    /** @type {any} */
    let latestLog = null;

    /**
     * @param {string} name
     * @param {unknown[]} [args]
     * @returns {Promise<any>}
     */
    const ask = (name, args = [])=>new Promise((resolve, reject)=>{
        if (gone)
        {
            reject(new Error(`${name}: the keeper is gone`));
            return;
        }
        const id = ++keeperId;
        keeperPending.set(id, { resolve, reject });
        keeper.port.postMessage({ type: 'request', id, name, args });
    });

    keeper.port.onmessage = (/** @type {{ data: any }} */ { data })=>{
        if (data.type === 'answer')
        {
            const waiting = keeperPending.get(data.id);
            if (!waiting)
            {
                return;
            }
            keeperPending.delete(data.id);
            if (data.error)
            {
                waiting.reject(rebuild(data.error));
            }
            else
            {
                waiting.resolve(data.value);
            }
            return;
        }
        if (data.type === 'records')
        {
            subscriptions.get(data.id)?.(data.records);
            return;
        }
        // A `lost` message is information for whoever subscribed; the total is
        // read back through a `lost` request when a caller asks for stats.
    };

    worker.onmessage = (/** @type {{ data: import('./messages.js').FromEngine }} */ { data })=>{
        const message = data;
        traffic[message.type]++;
        if (message.type === 'log-memory')
        {
            // The next block of a rebuilt process: hand it to the keeper, which
            // finishes with the old one and continues from where the sequence
            // left off. This is the only message the keeper is fed on a normal
            // run; records themselves never cross.
            latestLog = message.memory;
            keeper.port.postMessage({ type: 'attach', memory: message.memory,
                sequenceBase: message.sequenceBase });
            return;
        }
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
        [...transfer, ...(offscreen && offscreen !== canvas ? [offscreen] : []),
            ...(options.audio?.port && !transfer.includes(options.audio.port)
                ? [options.audio.port] : [])]);

    // The first block, handed to the keeper. On an origin without shared
    // memory there is nothing to hand over, and the keeper is fed below by
    // relaying the engine's own answers.
    latestLog = started.log;
    if (started.log)
    {
        keeper.port.postMessage({ type: 'attach', memory: started.log, sequenceBase: 0 });
    }
    const capacity = options.log?.capacity || MIRROR_CAPACITY;

    // Without a block to read, the engine's own reader still holds the ring.
    // One `log.drain` per cadence is relayed to the keeper, which keeps the
    // history; this thread holds none of it.
    let feedNext = 0;
    let feeding = false;
    const feed = async()=>{
        if (feeding || gone)
        {
            return;
        }
        feeding = true;
        try
        {
            const answer = await request('log.drain', [feedNext, MIRROR_LIMIT]);
            feedNext = answer.next;
            if (answer.records.length > 0 || answer.lost > 0)
            {
                keeper.port.postMessage({ type: 'feed', records: answer.records,
                    next: answer.next, lost: answer.lost });
            }
        }
        catch {
            // The worker is gone or going: the keeper keeps what it has.
        }
        finally
        {
            feeding = false;
        }
    };
    const feeder = started.log ? null : setInterval(feed, MIRROR_MS);
    if (!started.log)
    {
        // One look now, so a read made before the first cadence has something
        // to answer with.
        await feed();
    }

    /** What an exit left behind, once there has been one. @type {any} */
    let left = null;

    /** @type {ReturnType<typeof createDomInput> | null} */
    let dom = null;
    /** @type {Map<(handle: number, text: string) => void, () => void>} */
    const sinks = new Map();

    return {
        /**
         * Runs the program to completion. Resolves with its exit code once
         * this side's last relay to the keeper is done, so the keeper holds
         * the tail when this resolves.
         *
         * @param {{ maxTurns?: number }} [runOptions]
         * @returns {Promise<number>}
         */
        async run(runOptions){
            left = await request('run', [runOptions]);
            if (feeder)
            {
                await feed();
            }
            return left.code;
        },
        pause: ()=>request('pause'),
        resume: ()=>request('resume'),
        stop: ()=>request('stop'),
        /**
         * Answers the message box the page was shown, with the id of the
         * button the person pressed. The thread parked inside MessageBox
         * resumes with it; a box nobody answers stays up.
         *
         * @param {number} id @param {number} button
         * @returns {Promise<boolean>} whether a box was standing under that id.
         */
        answerMessageBox: (id, button)=>request('answerMessageBox', [id, button]),
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
        /**
         * Everything the engine can say about the run in one answer -- every
         * layer's diagnostics, the phase profile, the last frames, where the
         * machine stands, the threads, the guest's time by module and its code
         * around the hottest addresses -- for a report saved with one click.
         * A request, not for polling.
         *
         * @returns {Promise<any>}
         */
        report: ()=>request('report'),
        /** Messages by kind since the start, both ways. */
        traffic: ()=>({ ...traffic }),
        /** @returns {Promise<string>} */
        trace: ()=>request('trace'),
        /** The volume as the program sees it (the local controller's `files`), asked of the worker. */
        files: {
            /** @param {string} path @returns {Promise<any[]>} */
            list: path=>request('files.list', [path]),
            /** @param {string} path @returns {Promise<Uint8Array>} */
            read: path=>request('files.read', [path]),
            /** @param {string} path @returns {Promise<boolean>} */
            createDirectory: path=>request('files.createDirectory', [path]),
            /** @param {string} path @returns {Promise<boolean>} */
            remove: path=>request('files.remove', [path]),
            /** @param {string} path @param {Uint8Array} bytes @returns {Promise<void>} */
            write: (path, bytes)=>request('files.write', [path, bytes]),
        },
        /** Guest memory and the images mapped (the local controller's `debug`), asked of the worker. */
        debug: {
            /** @param {number} address @param {number} length @returns {Promise<Uint8Array>} */
            read: (address, length)=>request('debug.read', [address, length]),
            /** @returns {Promise<{ name: string, base: number, size: number }[]>} */
            modules: ()=>request('debug.modules'),
        },
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
            reading: ()=>started.log ? 'shared' : 'requests',
            /**
             * The block of the current process, for a consumer that wants a
             * reader of its own. It follows a replacement: the page is handed
             * the next block and forwards it to the keeper, and this is the
             * latest one. Null where nothing could be shared.
             *
             * A consumer that wants to follow the log rather than build a
             * reader over one block asks the keeper instead.
             */
            memory: ()=>latestLog,

            /** @param {number} [count] */
            recent: (count = 100)=>ask('recent', [count]),
            /** @param {number} [since] @param {number} [limit] */
            drain: (since = 0, limit = 1000)=>ask('drain', [since, limit]),
            /**
             * A level is the writer's gate, so changing one is a request to
             * the engine: only the thread that keeps a record can be told what
             * to keep.
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
                'input.message',
            ],

            /** @param {number} [worst] */
            profile: worst=>started.log ? ask('profile', [worst])
                : request('log.profile', [worst]),
            /** @param {number} [count] */
            frames: count=>started.log ? ask('frames', [count])
                : request('log.frames', [count]),
            /** @param {string} layer */
            counters: layer=>started.log ? ask('counters', [layer])
                : request('log.counters', [layer]),
            /**
             * One published table, as the keeper read it. Shared memory only:
             * a table is its buffer, and what crosses here is a snapshot of
             * the rows at the moment asked, not a view that keeps moving.
             *
             * @param {string} layer @param {string} name
             */
            table: (layer, name)=>started.log ? ask('table', [layer, name])
                : Promise.resolve(null),
            /**
             * What a word id in a table means. Shared memory only, for the
             * same reason as `table`.
             *
             * @param {number} id
             */
            word: id=>started.log ? ask('word', [id]) : Promise.resolve(`#${id}`),
            threads: ()=>started.log ? ask('threads') : request('log.threads'),
            guestByModule: ()=>started.log ? ask('guestByModule')
                : request('log.guestByModule'),
            /**
             * The journal itself: how much has been written, how much it
             * holds, how much was lapped before the keeper saw it, and how
             * much a level refused.
             */
            async stats(){
                // `written` is the last record's sequence plus one rather than
                // a counter of its own: the sequence is what the ring
                // publishes, and one decoded record is the cost of asking.
                const [tail, lost, own] = await Promise.all([
                    ask('recent', [1]),
                    ask('lost'),
                    started.log ? ask('counters', ['log']) : request('log.counters', ['log']),
                ]);
                return {
                    written: tail.length > 0 ? tail[0].sequence + 1 : 0,
                    capacity,
                    lost,
                    rejected: own.rejected ?? 0,
                };
            },
        },

        audio: {
            /** `{ table }` or `{ control, samples }`; see `Started` in messages.js. */
            memory: ()=>{
                if (!started.audio)
                {
                    throw new Error('this run has no sound output');
                }
                return started.audio.memory;
            },
            format: ()=>{
                if (!started.audio)
                {
                    throw new Error('this run has no sound output');
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
            /**
             * @param {any} viewport
             * @param {{ pointerLock?: boolean }} [mode]
             */
            attach(viewport, mode){
                dom?.detach();
                dom = createDomInput({
                    canvas: viewport,
                    pointerLock: mode?.pointerLock ?? false,
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
        /** The libraries the engine synthesises as Windows' own, as of the exit. */
        systemLibraries(){
            if (!left)
            {
                throw new Error('the program has not exited yet');
            }
            return left.systemLibraries ?? [];
        },

        async dispose(){
            if (feeder)
            {
                clearInterval(feeder);
            }
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
            // The keeper is this side's to end, whatever the engine does: its
            // port is closed so a thread-hosted one stops polling, and every
            // request still waiting on it is refused rather than left hanging.
            keeper.port.onmessage = null;
            keeper.close();
            for (const [id, waiting] of keeperPending)
            {
                keeperPending.delete(id);
                waiting.reject(new Error('the log keeper was disposed'));
            }
        },
    };
}
