/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's pool of translation workers (roadmap/v2, stage 2). Each process
 * has a worker of the pool from its start to its exit; more join it while its
 * translation lags and leave when it subsides, as the driver decides
 * (`driver.js`). A worker works for one process at a time, over a port of
 * its own: the pool hands one end to the worker and the other to the process,
 * whose runtime takes it as a translator (`attachTranslator`) and gives it
 * back when asked (`detachTranslator`). A worker that works for no process
 * sleeps in the pool, holding nothing of any process -- what translation
 * keeps is the process's arena, not the worker's.
 *
 * Each worker adds the microseconds it works to a cell of shared memory, so
 * the driver reads how busy each was over a window without asking. Every
 * decision is kept in the pool's journal.
 */

import { createDriverState, decide } from './driver.js';

/**
 * @typedef {Object} PoolWorker  A worker the pool opened.
 * @property {(message: any, transfer: any[]) => void} post
 * @property {() => void} terminate
 */

/**
 * @typedef {Object} PoolProcess  How the pool reaches one process.
 * @property {(port: MessagePort, token: number) => void} lend  the port is the
 *     process's end of a worker's; the token names it when it is asked back
 * @property {(token: number) => void} recall  the worker named by the token is
 *     asked back: the runtime takes no batch through it from then on
 */

/**
 * @typedef {Object} PoolEntry
 * @property {PoolWorker} worker
 * @property {Int32Array} busy  the microseconds it worked, and the regions it emitted, ever
 * @property {number} seen  the microseconds when the driver last read them
 * @property {number} emitted  the regions when the driver last read them
 * @property {number} share  its busy share of the last window
 * @property {number | null} process  the process it works for, or null
 * @property {number} token
 */

/**
 * @param {{ open: () => Promise<PoolWorker>, perProcess: number, windowMs?: number,
 *     now?: () => number, journalSize?: number,
 *     driver?: Partial<import('./driver.js').DriverSettings> }} options
 *     open: a new translation worker; perProcess: workers at most for one process (the
 *     host's concurrency); windowMs: how often the driver reads the workers
 */
export function createTranslatorPool({ open, perProcess, windowMs = 500,
    now = ()=>performance.now(), journalSize = 256, driver = {} })
{
    /** @type {PoolEntry[]} */
    const entries = [];
    /** By process: how it is reached, and its workers, its first first. */
    /** @type {Map<number, { reach: PoolProcess, workers: PoolEntry[], joining: number }>} */
    const processes = new Map();
    const state = createDriverState();
    /** @type {{ at: number, kind: string, process: number, workers: number }[]} */
    const journal = [];
    const counts = { opened: 0, joins: 0, leaves: 0, lent: 0 };
    let tokens = 0;
    let disposed = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    let timer = null;
    let lastAt = now();

    /** @param {string} kind @param {number} process */
    const note = (kind, process)=>{
        journal.push({ at: Math.round(now()), kind, process,
            workers: processes.get(process)?.workers.length ?? 0 });
        if (journal.length > journalSize)
        {
            journal.shift();
        }
    };

    /** A worker no process has, or a new one. @returns {Promise<PoolEntry>} */
    const take = async()=>{
        const idle = entries.find(entry=>entry.process === null);
        if (idle !== undefined)
        {
            return idle;
        }
        const worker = await open();
        const cell = new SharedArrayBuffer(8);
        worker.post({ busy: { buffer: cell, index: 0 } }, []);
        /** @type {PoolEntry} */
        const entry = { worker, busy: new Int32Array(cell), seen: 0, emitted: 0, share: 0,
            process: null, token: 0 };
        entries.push(entry);
        counts.opened++;
        return entry;
    };

    /** @param {PoolEntry} entry @param {number} id */
    const lend = (entry, id)=>{
        const at = processes.get(id);
        if (at === undefined || disposed)
        {
            return;
        }
        const channel = new MessageChannel();
        entry.process = id;
        entry.token = ++tokens;
        entry.seen = Atomics.load(entry.busy, 0);
        entry.emitted = Atomics.load(entry.busy, 1);
        at.workers.push(entry);
        entry.worker.post({ serve: channel.port1 }, [channel.port1]);
        at.reach.lend(channel.port2, entry.token);
        counts.lent++;
    };

    /** @param {PoolEntry} entry */
    const giveBack = entry=>{
        const id = entry.process;
        if (id === null)
        {
            return;
        }
        const at = processes.get(id);
        if (at !== undefined)
        {
            at.workers = at.workers.filter(one=>one !== entry);
            at.reach.recall(entry.token);
        }
        entry.process = null;
    };

    /** Idle workers past the pool's ceiling go: perProcess × the processes, at least one. */
    const trim = ()=>{
        const ceiling = Math.max(1, perProcess * processes.size);
        for (let i = entries.length - 1; i >= 0 && entries.length > ceiling; i--)
        {
            if (entries[i].process === null)
            {
                entries[i].worker.terminate();
                entries.splice(i, 1);
            }
        }
    };

    /** One window: how busy each process's workers were, and what the driver decides. */
    const tick = ()=>{
        const ended = now();
        const span = Math.max(1, ended - lastAt);
        lastAt = ended;
        /** @type {import('./driver.js').ProcessSample[]} */
        const samples = [];
        for (const [id, { workers, joining }] of processes)
        {
            let emitted = 0;
            const shares = workers.map(entry=>{
                const value = Atomics.load(entry.busy, 0);
                const worked = (value - entry.seen) | 0;
                entry.seen = value;
                entry.share = Math.min(1, worked / 1000 / span);
                const regions = Atomics.load(entry.busy, 1);
                emitted += (regions - entry.emitted) | 0;
                entry.emitted = regions;
                return entry.share;
            });
            // A worker still opening for it has not worked yet: the process is
            // sampled again once it is there.
            if (joining === 0)
            {
                samples.push({ id, shares, rate: emitted / span * 1000 });
            }
        }
        for (const decision of decide(state, samples, ended, { perProcess, ...driver }))
        {
            const id = decision.process;
            const at = processes.get(id);
            if (at === undefined)
            {
                continue;
            }
            if (decision.kind === 'join')
            {
                counts.joins++;
                at.joining++;
                take().then(entry=>{
                    at.joining--;
                    lend(entry, id);
                    note('join', id);
                }, ()=>{
                    at.joining--;
                });
                continue;
            }
            // The least busy of those that joined; never its first.
            const leaving = at.workers.slice(1).sort((a, b)=>a.share - b.share)[0];
            if (leaving !== undefined)
            {
                counts.leaves++;
                giveBack(leaving);
                note('leave', id);
            }
        }
    };

    return {
        /**
         * A process starts: it is lent its first worker, and the driver reads
         * its workers from now on.
         * @param {number} id @param {PoolProcess} reach
         */
        async addProcess(id, reach){
            if (disposed || processes.has(id))
            {
                return;
            }
            processes.set(id, { reach, workers: [], joining: 0 });
            timer ??= setInterval(tick, windowMs);
            /** @type {any} */ (timer).unref?.();
            const entry = await take();
            lend(entry, id);
            note('start', id);
        },
        /**
         * A process is over: its workers go back to the pool, and those past
         * the pool's lower ceiling go.
         * @param {number} id
         */
        removeProcess(id){
            const at = processes.get(id);
            if (at === undefined)
            {
                return;
            }
            for (const entry of [...at.workers])
            {
                entry.process = null;
            }
            processes.delete(id);
            state.lowSince.delete(id);
            note('exit', id);
            trim();
            if (processes.size === 0 && timer !== null)
            {
                clearInterval(timer);
                timer = null;
            }
        },
        /** One window now, for a test that drives the clock. */
        tick,
        diagnostics(){
            return {
                workers: entries.length,
                idle: entries.filter(entry=>entry.process === null).length,
                byProcess: Object.fromEntries([...processes].map(([id, { workers }])=>
                    [id, workers.length])),
                ...counts,
                journal: journal.slice(-32),
            };
        },
        dispose(){
            disposed = true;
            if (timer !== null)
            {
                clearInterval(timer);
                timer = null;
            }
            for (const entry of entries)
            {
                entry.worker.terminate();
            }
            entries.length = 0;
            processes.clear();
        },
    };
}

/**
 * The runtime's side of a worker the pool lent: the port's messages are the
 * worker's, and giving it back tells the worker it is done with this process.
 *
 * @param {MessagePort} port
 * @returns {import('../../layers/cpu/engine.js').TranslatorPort}
 */
export function portTranslator(port){
    return {
        post: (message, transfer)=>port.postMessage(message, transfer),
        onMessage: handler=>{
            if ('on' in port && typeof /** @type {any} */ (port).on === 'function')
            {
                /** @type {any} */ (port).on('message', handler);
            }
            else
            {
                port.onmessage = event=>handler(event.data);
            }
            port.start?.();
        },
        // A lent worker that dies is the pool's to see; the port says nothing.
        onLost: ()=>{},
        terminate: ()=>{
            port.postMessage({ done: true });
            port.close();
        },
    };
}
