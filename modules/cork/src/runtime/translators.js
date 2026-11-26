/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translation workers: which one takes a batch (`freeTranslator`), what
 * a batch out covers until it is published (`coveredOut`), the options the
 * emitter is given here and on a worker (`emitOptions`), the arena their
 * emit cache shares, and a worker's whole life - attached when it loads or a
 * host's pool lends it, its answers taken (`onWorkerResults`), given up on
 * when overdue, detached when the pool takes it back. Forming and the store's
 * lookups stay on the engine thread, where the memory and the store are; the
 * emitting and encoding of what the store did not hold go to a worker, and
 * the engine never waits for one.
 */

import { CallStack } from '../emit/region.js';
import { arenaEmitCache, createEmitCache } from './emit-built.js';
import { createArena } from './arena.js';
import { keptEmitCache, putAll } from './kept.js';
import { ANY_TOP, keyOf } from './entries.js';
import { spansOf } from './summary.js';
import { openTranslationWorker } from './translator.js';
import { usesX87 } from './variants.js';

/** @typedef {import('./state.js').Pending} Pending */
/** @typedef {import('./state.js').Translator} Translator */

/**
 * The translation worker's file, beside this one, as a host opens it for a
 * pool of its own; null where it cannot be named (a bundler that did not carry
 * the file).
 *
 * @returns {string | null}
 */
export function translatorWorkerUrl(){
    try
    {
        return new URL('./translator.worker.js', import.meta.url).href;
    }
    catch {
        return null;
    }
}

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createTranslators(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { clock, leaveOut, profiling, resumable, settings, sharedMemory, table, transfersCounted
    } = /** @type {import('./state.js').Base} */ (state);
    const { counts, inFlight, noteStall, noteWay, refused } = rt;

    // The translation worker: forming and the store lookup stay on the engine
    // thread, where the memory and the store are, and the emitting and
    // encoding of what the store did not hold go to a worker. The engine
    // never waits for it -- a batch not back yet is simply not published this
    // call, and the answer is picked up between frames. Where no worker can
    // be opened (a test process, a bundler that did not carry the file), the
    // same `emitBuilt` runs inline and the split's `emitMs`/`encodeMs` are the
    // engine's own, as before.
    // A worker only pays where something paces the run: its answer is picked
    // up between frames, and a run with no frames (`feed: 'slice'`, a test)
    // has none to hide the round trip behind, so it translates inline as it
    // always did unless a worker is asked for outright.
    const workerWanted = settings.workerUrl !== undefined
        || (settings.worker ?? (settings.feed !== 'slice'
            && typeof globalThis.Worker === 'function'));
    const workerUrl = workerWanted ? (settings.workerUrl ?? translatorWorkerUrl()) : null;
    /** @type {Translator[]} */
    const translators = [];
    /** Whether the translators are a pool's to lend, none opened here, until the first is. */
    let awaitingLend = workerUrl !== null && settings.translators === 0;
    let workerClosed = false;
    /** One that can take a batch now. */
    const freeTranslator = ()=>translators.find(one=>one.ready && !one.leaving
        && one.pending === null) ?? null;
    /** Whether any translator takes batches, free or not. */
    const translatorReady = ()=>translators.some(one=>one.ready && !one.leaving);
    /**
     * Whether a translator was made and has not loaded yet -- or none is
     * opened here and the host's pool has yet to lend the first: what is asked
     * for meanwhile is emitted here as while a worker loads.
     */
    const translatorLoading = ()=>translators.some(one=>!one.ready)
        || (awaitingLend && translators.length === 0);
    const batchesOut = ()=>translators.some(one=>one.pending !== null);
    /**
     * The entries regions formed and not yet published will have, by `keyOf`
     * (`coverKeys`), and how many such regions hold each: a candidate among
     * them is not formed again beside them, as one a batch's own region
     * covers is not. A region covers its blocks from when it goes to a
     * translator, or its record comes back from the store, until it is
     * published -- with several batches out, every block of a loop met while
     * its region was with one translator otherwise became a region of its own
     * with the next, and a block met while the translator's module compiled
     * still did: in Far Cry's load, 8 768 of 22 000 regions began at a block
     * of a region formed and not yet published.
     * @type {Map<number, number>}
     */
    const coveredOut = new Map();
    /**
     * Where a formed region's blocks will be entries once it is published: at
     * any top, or at its entry's where it has x87 in it -- a block whose stack
     * has another shape there is cut, and a candidate at its own top is formed
     * once the region is published.
     * @param {{ region: import('../region.js').Region, entryTop: number }} one
     */
    const coverKeys = one=>{
        const top = usesX87(one.region) ? one.entryTop : ANY_TOP;
        return spansOf(one.region).map(([start])=>keyOf(start, top));
    };
    /** @param {number[]} keys @returns {number[]} the keys */
    const cover = keys=>{
        for (const key of keys)
        {
            coveredOut.set(key, (coveredOut.get(key) ?? 0) + 1);
        }
        return keys;
    };
    /** @param {number[] | undefined} keys */
    const uncoverKeys = keys=>{
        for (const key of keys ?? [])
        {
            const held = (coveredOut.get(key) ?? 1) - 1;
            if (held === 0)
            {
                coveredOut.delete(key);
            }
            else
            {
                coveredOut.set(key, held);
            }
        }
    };
    /** @param {Pending} pending */
    const uncover = pending=>{
        uncoverKeys(pending.covers);
        pending.covers = [];
    };
    /** Whether a region formed and not published will have an entry at an address and top.
     * @param {Set<number> | Map<number, number>} keys @param {number} eip @param {number} top */
    const coveredIn = (keys, eip, top)=>keys.has(keyOf(eip, ANY_TOP)) || keys.has(keyOf(eip, top));
    /** The process's translation cache arena, shared with every translator it has; none
     * without a translator or where memory cannot be shared. Its size is `createArena`'s:
     * an arena of 8 MiB rather than 48 bought no memory back (roadmap/negative-results.md). */
    /** The run's cache the host gives the functions emitted to (`KeptStore`): every
     * thread of the run reads them there in place, this one writes them. */
    const kept = settings.kept ?? null;
    const arena = kept !== null ? null : settings.arena ?? (workerUrl !== null
        && typeof SharedArrayBuffer === 'function' ? createArena() : null);
    /** What emitting inline keeps for a relink to take again: the run's cache, the arena
     * the translators share, or a cache of this thread's own. */
    /** The functions translation workers took from the run's cache, and handed over to keep. */
    const keptCounts = { workerHits: 0, handed: 0 };
    const emitCache = kept !== null ? keptEmitCache(kept.space)
        : arena !== null ? arenaEmitCache(arena) : createEmitCache();
    /** The options both the inline emitter and the worker's take. */
    const emitOptions = ()=>({
        countTransfers: transfersCounted,
        blockProfile: profiling,
        hash: table !== null,
        place: table !== null && settings.dispatch === true,
        profileCalls: table !== null && settings.callTargets === true,
        callReturn: table !== null && settings.callReturn === true,
        linkedCalls: settings.linkedCalls !== false,
        crossTailCalls: settings.crossTailCalls !== false,
        ...(settings.callDepth === CallStack.LIMIT ? {} : { callDepth: settings.callDepth }),
        resume: resumable,
        precise: settings.precise === true,
        checkReads: rt.readsChecked,
        atomic: settings.atomic === true,
        looseStacks: rt.loose,
        leaveOut,
        timings: import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.timings === true,
        ...(settings.trapPort === undefined ? {} : { trapPort: settings.trapPort }),
        ...(sharedMemory ? { memory: sharedMemory } : {}),
    });

    /**
     * A worker's answer: one module for the batch, published. Runs on the
     * engine thread when the message arrives, which is between the frames the
     * host asked for.
     *
     * @param {Translator} translator
     * @param {{ id: number, batch: import('./emit-built.js').BuiltBatch | null,
     *     compiled?: WebAssembly.Module | null, message?: string, busyMs?: number,
     *     compileMs?: number, packMs?: number }} data
     */
    const onWorkerResults = (translator, data)=>{
        const pending = translator.pending;
        if (pending === null || data?.id !== pending.id)
        {
            return;
        }
        translator.pending = null;
        // The regions cover their blocks until they are published.
        const covers = pending.covers ?? [];
        pending.covers = [];
        if (translator.leaving)
        {
            dropTranslator(translator);
        }
        if (!data.batch)
        {
            uncoverKeys(covers);
            refused[`emit: ${data.message ?? 'the worker failed'}`] = 1;
            return;
        }
        counts.workerMs += data.batch.emitMs + data.batch.encodeMs;
        if (settings.timings === true)
        {
            for (const one of pending.metas ?? [])
            {
                for (const block of one.region.blocks)
                {
                    noteWay(block.start, 'answered');
                }
            }
            counts.workerBusyMs += data.busyMs ?? 0;
            counts.workerEmitMs += data.batch.emitMs;
            counts.workerEncodeMs += data.batch.encodeMs;
            counts.workerCompileMs += data.compileMs ?? 0;
            counts.workerPackMs += data.packMs ?? 0;
            counts.inFlightMs += performance.now() - pending.at;
        }
        const publishedAt = clock();
        // A credit's worth a call where the work here is bounded: a translator's
        // batch of a hundred regions held the thread for ten milliseconds
        // published at once, a relink of five hundred for six to fifteen. One
        // emitted here has held it longer emitting, and is published in the
        // call that emitted it.
        if (pending.relink)
        {
            uncoverKeys(covers);
            rt.applyRelink(pending.relink, data.batch, data.compiled ?? null, pending.store,
                rt.holding());
        }
        else
        {
            rt.publishBatch(pending.metas ?? [], data.batch, data.compiled ?? null, pending.store,
                rt.holding(), covers);
        }
        noteStall(pending.relink ? 'relink' : 'publish', publishedAt);
        rt.sendNext();
    };

    /**
     * A batch given up: its answer, should it come, no longer matches, and
     * the candidates it held are free to be taken again.
     * @param {Translator} translator
     */
    const giveUp = translator=>{
        const { pending } = translator;
        if (pending === null)
        {
            return;
        }
        for (const one of pending.metas ?? [])
        {
            inFlight.delete(keyOf(one.region.entry, one.entryTop));
        }
        uncover(pending);
        translator.pending = null;
    };
    /** @param {Translator} translator */
    const dropTranslator = translator=>{
        const at = translators.indexOf(translator);
        if (at >= 0)
        {
            translators.splice(at, 1);
        }
        translator.leave?.();
        translator.leave = null;
        translator.adapter.terminate();
    };

    /**
     * A translation worker taken on: a worker the runtime opened, or one a
     * host's pool lends it. It is made at once and loads its modules after: a
     * batch posted before then waited out the load -- a quarter of a second
     * from source -- while inline it would have run. So the batches go to it
     * only once it has answered a first message of its own, and are emitted
     * inline until then (while no other translator is ready).
     *
     * @param {import('./translator.js').WorkerAdapter} adapter
     */
    const attachTranslator = adapter=>{
        if (workerClosed)
        {
            adapter.terminate();
            return;
        }
        /** @type {Translator} */
        const translator = { adapter, ready: false, pending: null, leaving: false, leave: null };
        awaitingLend = false;
        translators.push(translator);
        adapter.onMessage(data=>{
            // The functions it emitted, kept here for every thread of the run,
            // a batch given up or not: each is what its key says.
            if (kept !== null && data?.kept !== undefined)
            {
                putAll(kept.space, data.kept);
                keptCounts.handed += data.kept.length;
            }
            keptCounts.workerHits += data?.keptHits ?? 0;
            if (data?.ready === true)
            {
                translator.ready = true;
                // What waited for it goes now.
                rt.sendNext();
                return;
            }
            if (typeof data?.alive === 'number')
            {
                // Its sign of life, and the job it is on (`overdue`'s clock).
                const { pending } = translator;
                if (pending !== null && data.id === pending.id)
                {
                    pending.heard = performance.now();
                    pending.doing = data.alive;
                }
                return;
            }
            onWorkerResults(translator, data);
            // A translator free beside others still out takes the next batch
            // now rather than at the host's next ask.
            rt.sendNext();
        });
        adapter.onLost(reason=>{
            // A worker that cannot load or has died answers nothing again:
            // its batch is given up so the next one is not held behind it,
            // and emitting goes back inline once no translator is left.
            if (!translators.includes(translator))
            {
                return;
            }
            refused[`worker: ${reason}`] = 1;
            giveUp(translator);
            dropTranslator(translator);
        });
        // Joined to the run's cache, to read every thread's functions in
        // place; the segments made and let go after follow it.
        const joined = kept?.join?.(message=>adapter.post({ cache: message }, [])) ?? null;
        translator.leave = joined?.leave ?? null;
        adapter.post({ ready: true, doorbell: settings.doorbell ?? null, arena,
            kept: joined === null ? null : { shared: joined.shared, segments: joined.segments,
                prefix: /** @type {import('./kept.js').KeptStore} */ (kept).prefix } }, []);
    };

    /** One of the runtime's own workers opened: at the start, and in place of one that
     * went silent on a batch (`translateStep`). Nothing where the host's pool lends them. */
    const openTranslator = ()=>{
        if (workerUrl === null || settings.translators === 0)
        {
            return;
        }
        openTranslationWorker(workerUrl).then(adapter=>{
            if (adapter !== null)
            {
                attachTranslator(adapter);
            }
        }, ()=>{});
    };
    /**
     * A translator asked to go: it takes no batch from now on, and goes as
     * soon as the one it holds is back.
     * @param {import('./translator.js').WorkerAdapter} adapter
     */
    const detachTranslator = adapter=>{
        const translator = translators.find(one=>one.adapter === adapter);
        if (translator === undefined)
        {
            return;
        }
        translator.leaving = true;
        if (translator.pending === null)
        {
            dropTranslator(translator);
        }
    };
    /** The machine goes: the workers hold nothing the store needs, and each is
     * ended and any batch it still owes dropped. */
    const closeTranslators = ()=>{
        workerClosed = true;
        for (const translator of [...translators])
        {
            giveUp(translator);
            dropTranslator(translator);
        }
    };
    return {
        workerUrl,
        translators,
        get awaitingLend(){ return awaitingLend; },
        get workerClosed(){ return workerClosed; },
        freeTranslator,
        translatorReady,
        translatorLoading,
        batchesOut,
        coveredOut,
        coverKeys,
        cover,
        uncoverKeys,
        coveredIn,
        arena,
        kept,
        keptCounts,
        emitCache,
        emitOptions,
        giveUp,
        dropTranslator,
        attachTranslator,
        openTranslator,
        detachTranslator,
        closeTranslators,
        /** @param {{ name: string, bytes: Uint8Array }[]} entries */
        keepHanded: entries=>{
            if (kept !== null)
            {
                putAll(kept.space, entries);
            }
        },
    };
}
