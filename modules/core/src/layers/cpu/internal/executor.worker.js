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
import { Said, Turn, channelOf } from './executor-channel.js';

/**
 * What the process sends once: where the engine is, the host's configuration,
 * the memory and the channel.
 *
 * @typedef {Object} ExecutorStart
 * @property {string} engineUrl
 * @property {Omit<import('./cork-host.js').CorkHostConfig, 'engine' | 'memory'>} config
 * @property {WebAssembly.Memory} memory
 * @property {SharedArrayBuffer} channel
 */

/** The executor's host, once started. @type {any} */
let running = null;

/**
 * @param {ExecutorStart} start
 * @param {(message: any) => void} send
 */
async function serve({ engineUrl, config, memory, channel: buffer }, send){
    const engine = await import(engineUrl);
    const host = createCorkHost({ ...config, engine, memory });
    running = host;
    const channel = channelOf(buffer);
    host.onTrap((/** @type {number} */ value)=>{
        channel.say(Turn.TRAP, value);
        channel.await(Turn.TRAP);
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
        channel.write(fault);
        channel.say(Turn.FAULT);
        channel.await(Turn.FAULT);
        return (channel.flags() & Said.CLAIMED) !== 0;
    });
    send({ type: 'ready' });
    const { words } = channel;
    for (;;)
    {
        let state = Atomics.load(words, 0);
        while (state !== Turn.RUN && state !== Turn.CLOSE)
        {
            // `waitAsync`: the event loop goes on meanwhile, and the
            // translations the runtime asked for come back through it.
            const waiting = /** @type {any} */ (Atomics).waitAsync(words, 0, state);
            if (waiting.async)
            {
                await waiting.value;
            }
            state = Atomics.load(words, 0);
        }
        if (state === Turn.CLOSE)
        {
            return;
        }
        let retired;
        try
        {
            retired = host.runSlice(channel.value());
        }
        catch (e){
            send({ type: 'failed', message: String(/** @type {any} */ (e)?.stack ?? e) });
            throw e;
        }
        const fault = host.fault();
        if (fault !== null)
        {
            channel.write(fault);
            host.clearFault();
        }
        channel.say(Turn.DONE, retired, (host.halted() ? Said.HALTED : 0)
            | (fault !== null ? Said.FAULTED : 0));
        // The executor's own feed, as the process's is once a frame: what its
        // interpreters found hot is formed while it waits for the next slice.
        host.cork().translatePending().catch(()=>{});
    }
}

/**
 * @param {(handler: (data: any) => void) => void} listen
 * @param {(message: any) => void} send
 */
function bind(listen, send){
    listen(data=>{
        if (data?.type === 'start')
        {
            serve(data, send).catch(e=>send({ type: 'failed',
                message: String(e?.stack ?? e) }));
        }
        else if (data?.type === 'diagnostics')
        {
            // Between slices: what its translator did, for the process's account.
            send({ type: 'diagnostics', id: data.id,
                value: running?.cork().diagnostics() ?? null });
        }
    });
}

if (typeof self !== 'undefined' && typeof (/** @type {any} */ (self)).postMessage === 'function')
{
    const scope = /** @type {any} */ (self);
    bind(handler=>{
        scope.onmessage = (/** @type {{ data: any }} */ event)=>handler(event.data);
    }, message=>scope.postMessage(message));
}
else
{
    const { parentPort, isMainThread } = await import('node:worker_threads');
    if (!isMainThread && parentPort)
    {
        bind(handler=>parentPort.on('message', handler),
            message=>parentPort.postMessage(message));
    }
}
