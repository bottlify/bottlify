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

import { CHANNEL_BYTES, Said, Turn, channelOf } from './executor-channel.js';

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
            terminate: ()=>worker.terminate(),
        };
    }
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(url);
    return {
        post: (/** @type {any} */ message)=>worker.postMessage(message),
        onMessage: (/** @type {(data: any) => void} */ handler)=>worker.on('message', handler),
        terminate: ()=>void worker.terminate(),
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
 * Opens executor `index` of the process whose first executor is `host`.
 *
 * @param {{ host: any, index: number, engineUrl: string,
 *     config: Omit<import('./cork-host.js').CorkHostConfig, 'engine' | 'memory' | 'executor'>,
 *     workerUrl?: URL }} options
 *     host: the process's cork host, made for `config.executors`; config: the configuration
 *     it was made with
 */
export async function createRemoteExecutor({ host, index, engineUrl, config,
    workerUrl = new URL('./executor.worker.js', import.meta.url) })
{
    const memory = host.wasmMemory();
    if (!(memory.buffer instanceof SharedArrayBuffer))
    {
        throw new Error('executor: another executor needs the process\'s memory shared');
    }
    const buffer = new SharedArrayBuffer(CHANNEL_BYTES);
    const channel = channelOf(buffer);
    const worker = await openWorker(workerUrl);
    /** @type {string | null} */
    let failed = null;
    /** Diagnostics asked for and not yet answered, by id. @type {Map<number, (value: any) => void>} */
    const asked = new Map();
    let asks = 0;
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
        });
        worker.post({ type: 'start', engineUrl, memory, channel: buffer,
            config: { ...config, executor: index } });
    });
    const own = /** @type {Uint8Array} */ (host.block());
    const theirs = new Uint8Array(memory.buffer, host.executorBase(index), own.length);
    const aside = new Uint8Array(own.length);

    /**
     * Runs `handler` as if on this host, over the executor's block; answers the
     * reply's flags, what the handler did to the turn.
     *
     * @param {() => number} handler  answers flags of its own to add
     */
    const answer = handler=>{
        aside.set(own);
        own.set(theirs);
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
            theirs.set(own);
            own.set(aside);
            host.setHaltedFlag(halted ? 1 : 0);
            host.setStopRequested(stopped);
        }
        return flags;
    };

    return {
        index,
        /**
         * Runs a slice of at most `budget` instructions on the executor, answering
         * every trap and fault it raises meanwhile; the executor's block holds the
         * thread it runs.
         *
         * @param {number} budget
         * @returns {RemoteSlice}
         */
        runSlice(budget){
            if (failed !== null)
            {
                throw new Error(`executor ${index}: ${failed}`);
            }
            channel.say(Turn.RUN, budget);
            /** @type {number} */
            let mine = Turn.RUN;
            for (;;)
            {
                const state = channel.await(mine);
                if (state === Turn.TRAP)
                {
                    const value = channel.value() >>> 0;
                    channel.say(Turn.REPLY, 0, answer(()=>{
                        host.raiseTrap(value);
                        return 0;
                    }));
                }
                else if (state === Turn.FAULT)
                {
                    const fault = channel.read();
                    channel.say(Turn.REPLY, 0,
                        answer(()=>(host.offerFault(fault) ? Said.CLAIMED : 0)));
                }
                else if (state === Turn.DONE)
                {
                    const flags = channel.flags();
                    return {
                        instructions: channel.value() >>> 0,
                        halted: (flags & Said.HALTED) !== 0,
                        fault: (flags & Said.FAULTED) !== 0 ? channel.read() : null,
                    };
                }
                mine = Turn.REPLY;
            }
        },
        /** The executor's block: the state of the thread it runs. */
        block: ()=>theirs,
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
        close(){
            channel.say(Turn.CLOSE);
            worker.terminate();
        },
    };
}
