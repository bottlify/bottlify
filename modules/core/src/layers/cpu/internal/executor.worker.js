/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An executor of a process in a worker of its own: a cork host over the
 * process's shared memory, at the executor's own state page and tables
 * (`executorLayout`), running the slices the process's thread asks for.
 *
 * It has no handlers of its own. A trap or a fault is the process's to answer
 * -- Win32 and the kernel live there -- so it is said on the channel and the
 * slice waits, in the middle of the instruction that raised it, for the reply
 * (`executor-channel.js`). Between slices it waits without blocking, so the
 * translations its runtime asked for come back meanwhile.
 *
 * The same file runs under a page's `Worker` and Node's `worker_threads`.
 */

import { createCorkHost } from './cork-host.js';
import { SPIN_MS, Said, Turn, Word, channelOf, waitWhile } from './executor-channel.js';
import { UNBROKEN_STEP, UNBROKEN_STEPS, unbrokenTable } from './unbroken.js';

/**
 * What the process sends once: where the engine is, the host's configuration,
 * the memory and the channel.
 *
 * @typedef {Object} ExecutorStart
 * @property {string} engineUrl
 * @property {Omit<import('./cork-host.js').CorkHostConfig, 'engine' | 'memory'>} config
 * @property {WebAssembly.Memory} memory
 * @property {SharedArrayBuffer} channel
 * @property {SharedArrayBuffer} bell  the process's word for all its executors' turns
 * @property {SharedArrayBuffer | ArrayBuffer} [unbroken]  the routines no slice ends inside
 * @property {boolean} [store]  the process answers for the run's translation store
 */

/** How long the executor waits in place for the next slice before its event loop does. */
const IDLE_MS = 2;
/** The longest it goes from slice to slice without a turn of its event loop. */
const YIELD_MS = 4;
/**
 * The longest it keeps a thread past its slice without a word to the process,
 * while nothing waits for an executor (`goOn`): what the process knows of the
 * thread -- the time it took, the instructions it retired, which a slice's end
 * counts in a word -- is never older than this.
 */
const CHAIN_MS = 250;
/**
 * How long it keeps a thread past its slice while other ready threads wait
 * for an executor (`hold`), unless the process asks for it at once: its turn.
 */
const HOLD_MS = 1;
/**
 * The longest a chain goes without asking its translator for what its
 * interpreters found hot: asked after every slice, a quantum of 40 µs, it took
 * a twelfth of a lone thread's time on its own executor.
 */
const FEED_MS = 1;

/** The executor's host, once started. @type {any} */
let running = null;

/** The store's answers awaited, by the ask's id. @type {Map<number, (bytes: Uint8Array | null) => void>} */
const storeAnswers = new Map();
let storeAsks = 0;

/**
 * The run's translation store as this executor reaches it: through the
 * process, which holds it -- a directory store's records file takes one
 * handle, the process's. A lookup is answered on the process's event loop,
 * a turn or a few later, and the runtime interprets meanwhile as it does
 * while any store answers late; a record goes and is not waited on.
 *
 * @param {(message: any, transfer?: any[]) => void} send
 * @returns {import('../engine.js').TranslationStore}
 */
function processStore(send){
    return {
        get: key=>new Promise(resolve=>{
            const id = ++storeAsks;
            storeAnswers.set(id, resolve);
            send({ type: 'store', id, method: 'get', key });
        }),
        put(key, bytes, options){
            // The bytes are the store's from the call on (`TranslationStore`):
            // a record that is the whole of its buffer goes without a copy.
            const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                && bytes.buffer instanceof ArrayBuffer;
            send({ type: 'store', method: 'put', key, bytes, options },
                whole ? [bytes.buffer] : []);
            return Promise.resolve();
        },
        touch: key=>send({ type: 'store', method: 'touch', key }),
    };
}

/**
 * Where the executor's time went since it started, in milliseconds: in slices
 * (`slicesMs`, which holds `answerWaitMs`, waiting there for the process to
 * answer a trap or a fault, and `inChainYieldMs`, its event loop's turns while
 * it keeps the thread), and waiting for the next slice (`idleMs`) -- what tells
 * an executor kept running from one kept waiting on the process. `ends` counts
 * why its slices ended.
 */
const spent = { startedAt: 0, slicesMs: 0, answerWaitMs: 0, idleMs: 0, slices: 0, traps: 0,
    faults: 0, yieldMs: 0, feedMs: 0, asyncWaits: 0, inChainYieldMs: 0,
    ends: { halted: 0, stopped: 0, faulted: 0, released: 0, turned: 0, chained: 0 } };

/**
 * @param {ExecutorStart} start
 * @param {(message: any, transfer?: any[]) => void} send
 */
async function serve({ engineUrl, config, memory, channel: buffer, bell, unbroken, store }, send){
    const engine = await import(engineUrl);
    const host = createCorkHost({ ...config, engine, memory,
        ...(store === true ? { cork: { ...config.cork, store: processStore(send) } } : {}) });
    running = host;
    const bellWords = new Int32Array(bell);
    const routines = unbroken === undefined ? null : unbrokenTable(unbroken);
    // The pacing the config names (`EngineConfig`), these defaults otherwise.
    const spinMs = config.cork?.spinMs ?? SPIN_MS;
    const idleMs = config.cork?.executorIdleMs ?? IDLE_MS;
    const yieldMs = config.cork?.executorYieldMs ?? YIELD_MS;
    const holdMs = config.cork?.executorHoldMs ?? HOLD_MS;
    const channel = channelOf(buffer, bellWords, spinMs);
    const { words } = channel;
    /**
     * A slice, its run of guest code counted (`Word.EPOCH`).
     * @param {number} budget
     */
    const runSlice = budget=>{
        Atomics.add(words, Word.EPOCH, 1);
        const retired = host.runSlice(budget);
        Atomics.add(words, Word.EPOCH, 1);
        return retired;
    };
    /**
     * A run that ended inside a routine no slice ends inside runs on to its
     * end, as on the process's own executor: the thread goes back to the
     * process next, and taken off in the middle of a record it would hold back
     * every record after it until it ran again.
     *
     * @returns {number} the instructions it ran
     */
    const runOut = ()=>{
        if (routines === null || routines.size() === 0)
        {
            return 0;
        }
        let retired = 0;
        for (let step = 0; step < UNBROKEN_STEPS && !host.halted() && !host.stopRequested()
            && host.fault() === null && routines.inside(host.eip()); step++)
        {
            retired += runSlice(UNBROKEN_STEP);
        }
        return retired;
    };
    host.onTrap((/** @type {number} */ value)=>{
        const asked = performance.now();
        Atomics.add(words, Word.EPOCH, 1);
        channel.say(Turn.TRAP, value);
        // The process's slice ends at its next back edge to answer, not at its
        // next crossing or its end.
        host.interruptProcess();
        channel.await(Turn.TRAP);
        Atomics.add(words, Word.EPOCH, 1);
        spent.answerWaitMs += performance.now() - asked;
        spent.traps++;
        const flags = channel.flags();
        if ((flags & Said.HALTED) !== 0)
        {
            host.halt();
        }
        if ((flags & Said.STOPPED) !== 0)
        {
            host.stop();
        }
    });
    host.onFault((/** @type {any} */ fault)=>{
        const asked = performance.now();
        channel.write(fault);
        channel.say(Turn.FAULT);
        host.interruptProcess();
        channel.await(Turn.FAULT);
        spent.answerWaitMs += performance.now() - asked;
        spent.faults++;
        return (channel.flags() & Said.CLAIMED) !== 0;
    });
    send({ type: 'ready' });
    // A turn of the event loop that waits for no timer: node's setImmediate,
    // or a message to itself. Not the message in node: its first message event
    // loads its fetch, http2 and TLS modules, 50 ms the first thread placed here
    // lost in its first chain.
    /** @type {() => Promise<void>} */
    let yieldTurn;
    if (typeof setImmediate === 'function')
    {
        yieldTurn = ()=>new Promise(resolve=>setImmediate(resolve));
    }
    else
    {
        const ping = new MessageChannel();
        /** @type {(() => void) | null} */
        let pinged = null;
        ping.port1.onmessage = ()=>pinged?.();
        yieldTurn = ()=>new Promise(resolve=>{
            pinged = /** @type {() => void} */ (resolve);
            ping.port2.postMessage(0);
        });
    }
    let yieldedAt = performance.now();
    spent.startedAt = yieldedAt;
    for (;;)
    {
        const idleFrom = performance.now();
        let state = Atomics.load(words, 0);
        if (state !== Turn.RUN && state !== Turn.CLOSE)
        {
            // The process mostly asks again soon after a slice's end, and a
            // wake through the event loop costs more: a short wait in place first.
            waitWhile(words, 0, state, idleMs, spinMs);
            state = Atomics.load(words, 0);
        }
        while (state !== Turn.RUN && state !== Turn.CLOSE)
        {
            // `waitAsync`: the event loop goes on meanwhile, and the
            // translations the runtime asked for come back through it.
            spent.asyncWaits++;
            const waiting = /** @type {any} */ (Atomics).waitAsync(words, 0, state);
            if (waiting.async)
            {
                await waiting.value;
            }
            state = Atomics.load(words, 0);
            yieldedAt = performance.now();
        }
        if (performance.now() - yieldedAt >= yieldMs)
        {
            // Asked again and again without a pause: a turn of the event loop
            // all the same, now and then, or no translation would ever land.
            const yieldFrom = performance.now();
            await yieldTurn();
            yieldedAt = performance.now();
            spent.yieldMs += yieldedAt - yieldFrom;
        }
        if (state === Turn.CLOSE)
        {
            return;
        }
        const budget = channel.value();
        const chained = performance.now();
        spent.idleMs += chained - idleFrom;
        spent.slices++;
        let retired = 0;
        try
        {
            // Slice after slice of the same thread while nothing else waits for
            // an executor (`goOn`), its stop, halt or fault ending it. The event
            // loop's turn due now and then is taken in between with the thread
            // kept: the slice's end would cost a round trip through the process,
            // which takes it only between its own turns -- a quarter of the
            // executor's time where nothing else waited (7-Zip's benchmark).
            let fedAt = chained;
            for (;;)
            {
                retired += runSlice(budget);
                const now = performance.now();
                const go = Atomics.load(bellWords, 1);
                const end = host.halted() ? 'halted' : host.stopRequested() ? 'stopped'
                    : host.fault() !== null ? 'faulted'
                        : go === 0 ? 'released'
                            : go === 2 && now - chained >= holdMs ? 'turned'
                                : now - chained >= CHAIN_MS ? 'chained' : null;
                if (end !== null)
                {
                    spent.ends[end]++;
                    retired += end === 'released' || end === 'turned' || end === 'chained'
                        ? runOut() : 0;
                    break;
                }
                if (now - yieldedAt >= yieldMs)
                {
                    await yieldTurn();
                    yieldedAt = performance.now();
                    spent.inChainYieldMs += yieldedAt - now;
                }
                if (now - fedAt >= FEED_MS)
                {
                    fedAt = now;
                    host.cork().translatePending().catch(()=>{});
                }
            }
        }
        catch (e){
            send({ type: 'failed', message: String(/** @type {any} */ (e)?.stack ?? e) });
            throw e;
        }
        spent.slicesMs += performance.now() - chained;
        const fault = host.fault();
        if (fault !== null)
        {
            channel.write(fault);
            host.clearFault();
        }
        channel.say(Turn.DONE, retired, (host.halted() ? Said.HALTED : 0)
            | (fault !== null ? Said.FAULTED : 0));
        // Taken now, so this executor is given its next thread now.
        host.interruptProcess();
        // The executor's own feed, as the process's is once a frame: what its
        // interpreters found hot is formed while it waits for the next slice.
        const feedFrom = performance.now();
        host.cork().translatePending().catch(()=>{});
        spent.feedMs += performance.now() - feedFrom;
    }
}

/**
 * @param {(handler: (data: any) => void) => void} listen
 * @param {(message: any, transfer?: any[]) => void} send
 */
function bind(listen, send){
    listen(data=>{
        if (data?.type === 'start')
        {
            serve(data, send).catch(e=>send({ type: 'failed',
                message: String(e?.stack ?? e) }));
        }
        else if (data?.type === 'store')
        {
            storeAnswers.get(data.id)?.(data.bytes ?? null);
            storeAnswers.delete(data.id);
        }
        else if (data?.type === 'diagnostics')
        {
            // Between slices: what its translator did, for the process's account.
            send({ type: 'diagnostics', id: data.id,
                value: running === null ? null : { ...running.cork().diagnostics(),
                    spent: { ...spent, wallMs: performance.now() - spent.startedAt } } });
        }
    });
}

if (typeof self !== 'undefined' && typeof (/** @type {any} */ (self)).postMessage === 'function')
{
    const scope = /** @type {any} */ (self);
    bind(handler=>{
        scope.onmessage = (/** @type {{ data: any }} */ event)=>handler(event.data);
    }, (message, transfer = [])=>scope.postMessage(message, transfer));
}
else
{
    const { parentPort, isMainThread } = await import('node:worker_threads');
    if (!isMainThread && parentPort)
    {
        bind(handler=>parentPort.on('message', handler),
            (message, transfer = [])=>parentPort.postMessage(message, transfer));
    }
}
