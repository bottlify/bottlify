/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The process's side of an executor in a worker of its own
 * (`executor.worker.js`): it asks for a slice and answers what the slice
 * raises, with the process's own host and handlers.
 *
 * A trap or a fault on another executor is answered as if it had happened on
 * this one: the process's state block is set aside, the other executor's block
 * put in its place, the handler run -- Win32, the kernel, whatever reads and
 * writes "the processor" through the host -- and the two put back. A block is
 * every register, the flags and their record, x87 and SSE: what a handler
 * reads is the executor's, and what it writes reaches the executor before its
 * slice goes on. Guest memory is one for both, so arguments, structures and
 * stacks need no carrying.
 */

import { CHANNEL_BYTES, Said, Turn, Word, channelOf, waitWhile } from './executor-channel.js';

/**
 * A worker, as a page's `Worker` or Node's `worker_threads` makes one.
 *
 * @param {URL} url
 */
async function openWorker(url){
    if (typeof globalThis.Worker === 'function')
    {
        const worker = new globalThis.Worker(url, { type: 'module' });
        return {
            post: (/** @type {any} */ message)=>worker.postMessage(message),
            onMessage: (/** @type {(data: any) => void} */ handler)=>worker.addEventListener(
                'message', (/** @type {any} */ event)=>handler(event.data)),
            // The page's worker runs nothing more once terminated: there is no
            // exit to wait for.
            terminate: async()=>worker.terminate(),
        };
    }
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(url);
    return {
        post: (/** @type {any} */ message)=>worker.postMessage(message),
        onMessage: (/** @type {(data: any) => void} */ handler)=>worker.on('message', handler),
        terminate: async()=>{
            await worker.terminate();
        },
    };
}

/**
 * What a slice on another executor ended with.
 *
 * @typedef {Object} RemoteSlice
 * @property {number} instructions  retired
 * @property {boolean} halted
 * @property {any | null} fault  a fault no handler took, as the executor's host recorded it
 */

/**
 * The word a process waits on for all its executors: each rings it at the end
 * of every turn of its own, so one wait covers every channel.
 */
export function createBell(){
    // The count of turns rung, then whether an executor may go on with its
    // thread past a slice: 1 on, 0 not, 2 for a turn's length (`goOn`, `hold`).
    const buffer = new SharedArrayBuffer(8);
    const word = new Int32Array(buffer);
    return {
        buffer,
        /** The count now: what a wait is from. */
        rung: ()=>Atomics.load(word, 0),
        /**
         * Waits until the bell rings past `seen`, at most `ms`.
         * @param {number} seen @param {number} [ms]
         */
        wait(seen, ms = Infinity){
            waitWhile(word, 0, seen, ms);
        },
        /**
         * The same wait without blocking: for a caller whose other wake comes
         * through the event loop, which a blocking wait holds back.
         *
         * @param {number} seen @param {number} ms
         * @returns {Promise<void>}
         */
        waitAsync(seen, ms){
            const waiting = /** @type {any} */ (Atomics).waitAsync(word, 0, seen, ms);
            return waiting.async ? waiting.value.then(()=>{}) : Promise.resolve();
        },
        /**
         * Whether no ready thread waits for an executor: then one whose slice
         * ends with its thread still running goes on with it, a slice after
         * another, without a word to the process -- which a round trip a
         * quantum cost as much as the quantum's own work.
         *
         * @param {boolean} on
         */
        goOn(on){
            Atomics.store(word, 1, on ? 1 : 0);
        },
        /**
         * Ready threads wait for an executor, none of them at once: one whose
         * slice ends with its thread still running goes on with it until it has
         * held it a turn (`executorHoldMs`), as a processor keeps a thread to
         * its quantum's end -- given back after every slice, a thread past the
         * executors cost a round trip through the process each quantum, and
         * four threads on two executors ran barely faster than on one.
         */
        hold(){
            Atomics.store(word, 1, 2);
        },
    };
}

/**
 * Opens executor `index` of the process whose first executor is `host`.
 *
 * @param {{ host: any, index: number, engineUrl: string,
 *     config: Omit<import('./cork-host.js').CorkHostConfig, 'engine' | 'memory' | 'executor'>,
 *     workerUrl?: URL, bell?: ReturnType<typeof createBell>,
 *     unbroken?: SharedArrayBuffer | ArrayBuffer,
 *     store?: import('../engine.js').TranslationStore | null }} options
 *     host: the process's cork host, made for `config.executors`; config: the configuration
 *     it was made with; bell: the one its executors share, when it waits on several;
 *     unbroken: the routines no slice ends inside (`unbroken.js`), the process's table;
 *     store: the run's translation store, which the executor's translator asks through here
 */
export async function createRemoteExecutor({ host, index, engineUrl, config,
    workerUrl = new URL('./executor.worker.js', import.meta.url), bell = createBell(),
    unbroken = undefined, store = null })
{
    const memory = host.wasmMemory();
    if (typeof SharedArrayBuffer !== 'function' || !(memory.buffer instanceof SharedArrayBuffer))
    {
        throw new Error('executor: another executor needs the process\'s memory shared');
    }
    const buffer = new SharedArrayBuffer(CHANNEL_BYTES);
    const channel = channelOf(buffer, null, config.cork?.spinMs);
    const worker = await openWorker(workerUrl);
    /** @type {string | null} */
    let failed = null;
    /** Diagnostics asked for and not yet answered, by id. @type {Map<number, (value: any) => void>} */
    const asked = new Map();
    let asks = 0;
    /**
     * What the executor's translator asks of the run's store: a record looked
     * up is answered with a copy (the store may keep the bytes it read), one
     * put or touched is the store's from here on.
     *
     * @param {{ id?: number, method: string, key: string, bytes?: Uint8Array,
     *     options?: { needs?: string } }} ask
     */
    const answerStore = ask=>{
        if (store === null)
        {
            if (ask.method === 'get')
            {
                worker.post({ type: 'store', id: ask.id, bytes: null });
            }
            return;
        }
        if (ask.method === 'put' && ask.bytes instanceof Uint8Array)
        {
            Promise.resolve(store.put(ask.key, ask.bytes, ask.options)).catch(()=>{});
            return;
        }
        if (ask.method === 'touch')
        {
            store.touch?.(ask.key);
            return;
        }
        const now = store.getNow?.(ask.key);
        // An answer to an executor closed meanwhile goes nowhere.
        Promise.resolve(now !== undefined ? now : store.get(ask.key)).catch(()=>null)
            .then(bytes=>worker.post({ type: 'store', id: ask.id, bytes })).catch(()=>{});
    };
    await new Promise((resolve, reject)=>{
        worker.onMessage(data=>{
            if (data?.type === 'ready')
            {
                resolve(undefined);
            }
            else if (data?.type === 'failed')
            {
                failed = data.message;
                reject(new Error(`executor ${index}: ${data.message}`));
            }
            else if (data?.type === 'diagnostics')
            {
                asked.get(data.id)?.(data.value);
                asked.delete(data.id);
            }
            else if (data?.type === 'store')
            {
                answerStore(data);
            }
        });
        worker.post({ type: 'start', engineUrl, memory, channel: buffer, bell: bell.buffer,
            unbroken, store: store !== null, config: { ...config, executor: index } });
    });
    const own = /** @type {Uint8Array} */ (host.block());
    const theirs = new Uint8Array(memory.buffer, host.executorBase(index), own.length);
    const aside = new Uint8Array(own.length);
    // The retired-instruction word in a block is the executor's, not the
    // thread's (`restoreBlockContext` leaves it where it is for the same
    // reason): carried across with the rest, the process's own count, folded
    // in a handler -- a frame presented inside another executor's call --
    // read the other executor's word and jumped by its difference.
    const { counter, regs } = host.blockLayout();
    const counterAt = counter - regs;
    /**
     * Every byte of a block into another but the retired-instruction word.
     *
     * @param {Uint8Array} to @param {Uint8Array} from
     */
    const carry = (to, from)=>{
        if (counterAt < 0)
        {
            to.set(from);
            return;
        }
        to.set(from.subarray(0, counterAt));
        to.set(from.subarray(counterAt + 4), counterAt + 4);
    };

    /**
     * Runs `handler` as if on this host, over the executor's block; answers the
     * reply's flags, what the handler did to the turn.
     *
     * @param {() => number} handler  answers flags of its own to add
     */
    const answer = handler=>{
        aside.set(own);
        carry(own, theirs);
        const halted = host.halted();
        const stopped = host.stopRequested();
        host.setHaltedFlag(0);
        host.setStopRequested(false);
        let flags = 0;
        try
        {
            flags = handler();
        }
        finally
        {
            flags |= (host.halted() ? Said.HALTED : 0) | (host.stopRequested() ? Said.STOPPED : 0);
            carry(theirs, own);
            carry(own, aside);
            host.setHaltedFlag(halted ? 1 : 0);
            host.setStopRequested(stopped);
        }
        return flags;
    };

    /** Whether a slice is out: started and its end not yet taken. */
    let running = false;
    /** Whether an answer halted or stopped the slice's thread: its end is coming, not yet taken. */
    let ending = false;
    /** What the process's side said last, which the executor's next turn ends.
     * @type {number} */
    let mine = Turn.IDLE;
    /** What the slices taken so far retired, together. */
    let retiredTaken = 0;

    const executor = {
        index,
        /** Whether a slice is out. */
        busy: ()=>running,
        /**
         * Whether an answer given to its slice halted or stopped the thread and
         * the slice's end has not been taken: the end is coming, and until it is
         * taken the thread's state is the executor's, not the process's.
         */
        ending: ()=>ending,
        /**
         * Starts a slice of at most `budget` instructions on the executor's
         * block, the thread it holds; `step` answers what it raises.
         *
         * @param {number} budget
         */
        start(budget){
            if (failed !== null)
            {
                throw new Error(`executor ${index}: ${failed}`);
            }
            if (running)
            {
                throw new Error(`executor ${index}: busy with a slice`);
            }
            running = true;
            mine = Turn.RUN;
            Atomics.store(channel.words, Word.RETIRED, 0);
            channel.say(Turn.RUN, budget);
        },
        /**
         * Answers what the executor raised since the last step, if anything:
         * a trap or a fault, with `around` run about the answer (the process
         * makes the executor's thread its current one there); the slice's end
         * as its record, once.
         *
         * @param {(reply: () => void) => void} [around]
         * @returns {RemoteSlice | null}
         */
        step(around = reply=>reply()){
            if (!running)
            {
                return null;
            }
            const state = Atomics.load(channel.words, 0);
            if (state === mine)
            {
                return null;
            }
            if (state === Turn.TRAP)
            {
                const value = channel.value() >>> 0;
                /** @type {number} */
                let flags = 0;
                around(()=>{
                    flags = answer(()=>{
                        host.raiseTrap(value);
                        return 0;
                    });
                });
                ending ||= (flags & (Said.HALTED | Said.STOPPED)) !== 0;
                mine = Turn.REPLY;
                channel.say(Turn.REPLY, 0, flags);
                return null;
            }
            if (state === Turn.FAULT)
            {
                const fault = channel.read();
                /** @type {number} */
                let flags = 0;
                around(()=>{
                    flags = answer(()=>(host.offerFault(fault) ? Said.CLAIMED : 0));
                });
                ending ||= (flags & (Said.HALTED | Said.STOPPED)) !== 0;
                mine = Turn.REPLY;
                channel.say(Turn.REPLY, 0, flags);
                return null;
            }
            if (state !== Turn.DONE)
            {
                return null;
            }
            running = false;
            ending = false;
            mine = Turn.IDLE;
            const flags = channel.flags();
            const instructions = channel.value() >>> 0;
            retiredTaken += instructions;
            return {
                instructions,
                halted: (flags & Said.HALTED) !== 0,
                fault: (flags & Said.FAULTED) !== 0 ? channel.read() : null,
            };
        },
        /**
         * Runs a slice to its end, answering what it raises.
         *
         * @param {number} budget
         * @returns {RemoteSlice}
         */
        runSlice(budget){
            executor.start(budget);
            for (;;)
            {
                const seen = bell.rung();
                const ended = executor.step();
                if (ended !== null)
                {
                    return ended;
                }
                bell.wait(seen);
            }
        },
        /**
         * Runs `work` as if on this host, over the executor's block: how the
         * process puts a thread on it, or reads one off.
         *
         * @param {() => void} work
         */
        onBlock(work){
            answer(()=>{
                work();
                return 0;
            });
        },
        /** The executor's block: the state of the thread it runs. */
        block: ()=>theirs,
        /** Its runs of guest code so far, odd while one is on (`Word.EPOCH`). */
        epoch: ()=>Atomics.load(channel.words, Word.EPOCH),
        /** What the slice out has retired so far; 0 with none out (`Word.RETIRED`). */
        retiredSoFar: ()=>(running ? Atomics.load(channel.words, Word.RETIRED) >>> 0 : 0),
        /** What it has retired since it opened: the slices taken, and the one out so far. */
        retired: ()=>retiredTaken + executor.retiredSoFar(),
        /**
         * Its translator's diagnostics, answered between slices.
         * @returns {Promise<Record<string, any> | null>}
         */
        diagnostics(){
            const id = ++asks;
            return new Promise(resolve=>{
                asked.set(id, resolve);
                worker.post({ type: 'diagnostics', id });
            });
        },
        /**
         * Ends the executor; resolved once its worker can no longer touch the
         * process's memory, which a later process may then be given.
         * @returns {Promise<void>}
         */
        close(){
            channel.say(Turn.CLOSE);
            return worker.terminate();
        },
    };
    return executor;
}
