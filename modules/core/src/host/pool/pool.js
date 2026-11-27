/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's pool of translation workers. A process is lent its first worker at
 * its start, whatever the run holds: one left waiting for a lend interprets
 * nearly all it runs (a 3DMark06 CPU test thread on an executor the pool had no
 * worker for ran at 59 M instructions a second, against 1182 M with one). More
 * join it while its translation lags and leave when it subsides, as the driver
 * decides (`driver.js`), while the run has fewer than `capacity` (the host's
 * cores): those only speed translation up, and the cores are shared among
 * however many processes there are, as Windows shares its processors. A
 * process whose workers sat idle for `restAfterMs` -- one waiting on a pipe, a
 * service between requests -- gives back its first too, and translates on its
 * own thread until it is lent one again: when it says it emitted there
 * (`PoolProcess.demand`). A process that cannot say keeps its first to its exit. A
 * worker works for one process at a time, over a port of its own: the pool
 * hands one end to the worker and the other to the process, whose runtime takes
 * it as a translator (`attachTranslator`) and gives it back when asked
 * (`detachTranslator`). A worker that works for no process sleeps in the pool,
 * holding nothing of any process -- what translation keeps is the process's
 * arena, not the worker's -- and one sleeper is kept: the others go, each a
 * heap of its own (some 55 MB in a browser).
 *
 * Each worker adds the microseconds it works to a cell of shared memory, so the
 * driver reads how busy each was over a window without asking. Every decision
 * is kept in the pool's journal.
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
 * @property {() => number} [demand]  the milliseconds it has emitted on its own
 *     thread, ever: a rise while it has no worker asks for one. Without it the
 *     process keeps its first worker to its exit.
 */

/**
 * @typedef {Object} PoolEntry
 * @property {PoolWorker} worker
 * @property {Int32Array} busy  the time it worked (tenths of a millisecond) and the regions it
 *     emitted, ever,
 *     and when the batch it is on began (milliseconds since the pool's epoch; 0: none)
 * @property {number} seen  the microseconds when the driver last read them, the batch under
 *     way counted as far as it had gone
 * @property {number} emitted  the regions when the driver last read them
 * @property {number} share  its busy share of the last window
 * @property {number | null} process  the process it works for, or null
 * @property {number} token
 * @property {boolean} promised  taken for a process and not lent yet
 */

/**
 * @param {{ open: () => Promise<PoolWorker>, perProcess: number, capacity?: number,
 *     windowMs?: number, restAfterMs?: number, now?: () => number, journalSize?: number,
 *     driver?: Partial<import('./driver.js').DriverSettings> }} options
 *     open: a new translation worker; perProcess: workers at most for one process (the
 *     host's concurrency); capacity: workers the run holds at most before one joins a
 *     process (perProcess when not given); a process's first is lent past it;
 *     windowMs: how often the driver reads the workers; restAfterMs: how long a process's
 *     workers sit idle before it gives back its first
 */
export function createTranslatorPool({ open, perProcess, capacity, windowMs = 500,
    restAfterMs = 5000, now = ()=>performance.now(), journalSize = 256, driver = {} })
{
    const most = Math.max(1, capacity ?? perProcess);
    /** A share this low is a worker with nothing to do, as the driver counts it. */
    const idleShare = driver.idleBelow ?? 0.02;
    /** @type {PoolEntry[]} */
    const entries = [];
    /**
     * By process: how it is reached, its workers (its first first), the
     * workers opening for it, since when all of them were idle, whether it
     * waits for one, and its demand as last read.
     *
     * @type {Map<number, { reach: PoolProcess, workers: PoolEntry[], joining: number,
     *     idleSince: number | null, wanting: boolean, demandSeen: number,
     *     started: boolean }>}
     */
    const processes = new Map();
    const state = createDriverState();
    /** @type {{ at: number, kind: string, process: number, workers: number }[]} */
    const journal = [];
    const counts = { opened: 0, joins: 0, leaves: 0, lent: 0, rests: 0, closed: 0,
        refused: 0 };
    let tokens = 0;
    let disposed = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    let timer = null;
    let lastAt = now();
    /** The pool's clock as every thread reads it: what a worker's batch start is counted from. */
    const epoch = performance.timeOrigin + performance.now();
    const sinceEpoch = ()=>performance.timeOrigin + performance.now() - epoch;
    /** The microseconds a worker has worked, the batch under way included. @param {PoolEntry} entry */
    const workedOf = entry=>{
        const done = Atomics.load(entry.busy, 0) * 100;
        const began = Atomics.load(entry.busy, 2);
        return done + (began > 0 ? Math.max(0, (sinceEpoch() - began) * 1000) : 0);
    };

    /** @param {string} kind @param {number} process */
    const note = (kind, process)=>{
        journal.push({ at: Math.round(now()), kind, process,
            workers: processes.get(process)?.workers.length ?? 0 });
        if (journal.length > journalSize)
        {
            journal.shift();
        }
    };

    /** Workers opening, counted against the run's capacity before they are there. */
    let opening = 0;
    /**
     * A worker no process has, or a new one: for a process's first always, for
     * one joining while the run has fewer than its capacity; null when it has
     * them all at work.
     *
     * @param {boolean} first
     * @returns {Promise<PoolEntry | null>}
     */
    const take = async first=>{
        const idle = entries.find(entry=>entry.process === null && !entry.promised);
        if (idle !== undefined)
        {
            return idle;
        }
        if (!first && entries.length + opening >= most)
        {
            counts.refused++;
            return null;
        }
        opening++;
        let worker;
        try
        {
            worker = await open();
        }
        finally
        {
            opening--;
        }
        const cell = new SharedArrayBuffer(16);
        worker.post({ busy: { buffer: cell, index: 0, epoch } }, []);
        /** @type {PoolEntry} */
        const entry = { worker, busy: new Int32Array(cell), seen: 0, emitted: 0, share: 0,
            process: null, token: 0, promised: false };
        entries.push(entry);
        counts.opened++;
        return entry;
    };

    /** @param {PoolEntry} entry @param {number} id */
    const lend = (entry, id)=>{
        entry.promised = false;
        const at = processes.get(id);
        if (at === undefined || disposed)
        {
            return;
        }
        at.wanting = false;
        at.idleSince = null;
        const channel = new MessageChannel();
        entry.process = id;
        entry.token = ++tokens;
        entry.seen = workedOf(entry);
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

    /** Sleeping workers past one go: each holds a heap of its own. */
    const trim = ()=>{
        let kept = 0;
        for (let i = 0; i < entries.length; i++)
        {
            if (entries[i].process !== null || entries[i].promised)
            {
                continue;
            }
            if (kept === 0)
            {
                kept++;
                continue;
            }
            entries[i].worker.terminate();
            entries.splice(i, 1);
            i--;
            counts.closed++;
        }
    };

    /**
     * A worker for a process with none: a free one, or one opened for it.
     *
     * @param {number} id
     */
    const lendFirst = id=>{
        const at = processes.get(id);
        if (at === undefined || at.joining > 0)
        {
            return Promise.resolve();
        }
        at.joining++;
        at.wanting = true;
        return take(true).then(entry=>{
            at.joining--;
            if (entry === null)
            {
                return;
            }
            entry.promised = true;
            lend(entry, id);
            note(at.started ? 'lend' : 'start', id);
            at.started = true;
        }, ()=>{
            at.joining--;
        });
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
                // A batch that ended between the two reads is counted the next
                // window; the count never goes back.
                const value = Math.max(entry.seen, workedOf(entry));
                const worked = value - entry.seen;
                entry.seen = value;
                entry.share = Math.min(1, worked / 1000 / span);
                const regions = Atomics.load(entry.busy, 1);
                emitted += (regions - entry.emitted) | 0;
                entry.emitted = regions;
                return entry.share;
            });
            // A worker still opening for it has not worked yet: the process is
            // sampled again once it is there. One with none is not the driver's.
            if (joining === 0 && shares.length > 0)
            {
                samples.push({ id, shares, rate: emitted / span * 1000 });
            }
        }
        // Rests and wants: a process whose workers all sat idle long enough
        // gives back its first too; one with none that emitted on its own
        // since the last look asks for one.
        for (const [id, at] of processes)
        {
            const demand = at.reach.demand;
            if (demand === undefined)
            {
                if (at.workers.length === 0 && at.joining === 0)
                {
                    at.wanting = true;
                }
                continue;
            }
            if (at.workers.length === 0)
            {
                const value = demand();
                if (value > at.demandSeen)
                {
                    at.wanting = true;
                }
                at.demandSeen = value;
                continue;
            }
            if (at.joining > 0 || at.workers.some(entry=>entry.share >= idleShare))
            {
                at.idleSince = null;
                continue;
            }
            at.idleSince ??= ended;
            if (ended - at.idleSince >= restAfterMs)
            {
                for (const entry of [...at.workers])
                {
                    giveBack(entry);
                }
                at.idleSince = null;
                at.demandSeen = demand();
                counts.rests++;
                note('rest', id);
            }
        }
        for (const decision of decide(state, samples, ended,
            { perProcess, capacity: most, ...driver }))
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
                take(false).then(entry=>{
                    at.joining--;
                    if (entry !== null)
                    {
                        entry.promised = true;
                        lend(entry, id);
                        note('join', id);
                    }
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
        for (const [id, at] of processes)
        {
            if (at.wanting && at.workers.length === 0)
            {
                lendFirst(id);
            }
        }
        trim();
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
            processes.set(id, { reach, workers: [], joining: 0, idleSince: null, wanting: true,
                demandSeen: 0, started: false });
            timer ??= setInterval(tick, windowMs);
            /** @type {any} */ (timer).unref?.();
            await lendFirst(id);
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
                // Its runtime is gone and never says it is done with the
                // port: the worker lets go of what it served it, or it kept
                // the process's port and what it built for it until lent again.
                entry.worker.post({ forget: true }, []);
            }
            processes.delete(id);
            // A worker it gave back goes to one that waits for it.
            for (const [other, each] of processes)
            {
                if (each.wanting && each.workers.length === 0)
                {
                    lendFirst(other);
                }
            }
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
                capacity: most,
                idle: entries.filter(entry=>entry.process === null).length,
                waiting: [...processes.values()].filter(at=>at.workers.length === 0).length,
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
