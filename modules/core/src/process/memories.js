/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import {
    RUN_HOLDER, guestByLength, openMemoryBudget,
} from '../layers/cpu/internal/memory-budget.js';

/** @typedef {import('../app-options.js').SpareMemory} SpareMemory */

/**
 * memories - the guest memories of a run's processes: those of processes gone
 * kept for the next, and each process's part of the machine's memory held and
 * given back.
 */

/**
 * @param {Record<string, any>} deps  the parts of the process it works on, by the names
 *     `app.js` gives them
 */
export function processMemories(deps){
    const {
        options,
    } = deps;

    /**
     * The memories of the processes gone, for the next ones built, newest
     * last: a gone process's memory waits for a garbage collection nothing
     * prompts, and is held past it by whatever of the process anything still
     * reaches, so a parent that starts one short-lived child after another -- a
     * compiler a shader at a time, ngen a worker per assembly while several run
     * at once -- would hold one memory per child until the page ran out. A
     * process hands its memory back as it goes and the next one takes it, so
     * a run holds as many as it ever ran at once, and `SPARE_MEMORIES` more.
     * The run's, where a process is put in a worker of its own: a worker hands
     * its process's back as it ends (`runAcross`), and a process in a worker
     * keeps those it was handed there (`spareMemories`).
     *
     * @type {SpareMemory[]}
     */
    const spareMemories = options.spareMemories ?? [];
    /**
     * The machine's memory, where the run has one, as the run itself holds it
     * (`RUN_HOLDER`): the memories kept for the next process. Each process
     * holds its own part on a holder of its own (`holderOf`), given back whole
     * when it is gone however it ended.
     */
    const machineMemory = options.memoryBudget === undefined ? null
        : openMemoryBudget(options.memoryBudget);
    /** @param {number} holder */
    const holderView = holder=>openMemoryBudget(/** @type {any} */ (options.memoryBudget), holder);
    /**
     * Each process's holder, and whether the run claimed it (a process started
     * in a worker holds what its parent claimed for it).
     *
     * @type {Map<any, { holder: number, own: boolean }>}
     */
    const holderOf = new Map();
    /** Whether a guest's memory counts by its length (`guestByLength`). */
    const byLength = guestByLength(options.cpu?.guestCharge);
    /**
     * What a gone process's memory holds of the machine's: its length, or
     * what its process was given in it, whose pages the tab keeps.
     *
     * @param {SpareMemory} spare
     */
    const spareCharge = spare=>(byLength ? spare.memory.buffer.byteLength
        : /** @type {any} */ (spare).charged ?? 0);
    /** @param {SpareMemory | undefined} spare */
    const dropSpare = spare=>{
        if (spare && machineMemory !== null && /** @type {any} */ (spare).onRun !== false)
        {
            machineMemory.give(spareCharge(spare));
            machineMemory.dropped();
        }
    };
    /**
     * A gone process's memory handed to the run: what its process was given in
     * it (or its length) moved from the process's holder to the run's, once.
     *
     * @param {SpareMemory | null | undefined} spare
     * @param {number} holder
     */
    const spareToRun = (spare, holder)=>{
        if (!spare || machineMemory === null || /** @type {any} */ (spare).onRun === true)
        {
            return;
        }
        const view = holderView(holder);
        /** @type {any} */ (spare).charged = byLength ? spare.memory.buffer.byteLength
            : view.heldBy('guest');
        view.move(spareCharge(spare), 'guest', RUN_HOLDER);
        /** @type {any} */ (spare).onRun = true;
    };
    /**
     * A kept memory taken by a process: its charge moved to the process's holder.
     *
     * @param {SpareMemory | null} spare
     * @param {number} holder
     */
    const spareToProcess = (spare, holder)=>{
        if (!spare || machineMemory === null || /** @type {any} */ (spare).onRun === false)
        {
            return;
        }
        machineMemory.move(spareCharge(spare), 'guest', holder);
        /** @type {any} */ (spare).onRun = false;
    };
    /**
     * A gone process's memory kept for the next, held by the run from now on.
     *
     * @param {SpareMemory | null | undefined} spare
     */
    const keepSpare = spare=>{
        // A memory kept already, handed back again: one memory, one charge, the
        // larger of the two (each counts what a process was given in it).
        const kept = spare && spareMemories.find(one=>one.memory === spare.memory);
        if (spare && kept && machineMemory !== null && !byLength)
        {
            const had = spareCharge(kept);
            const more = spareCharge(spare);
            /** @type {any} */ (kept).charged = Math.max(had, more);
            machineMemory.give(had + more - Math.max(had, more));
        }
        if (spare && !kept)
        {
            spareMemories.push(spare);
            if (spareMemories.length > SPARE_MEMORIES)
            {
                dropSpare(spareMemories.shift());
            }
            // A spare holds its whole length of the machine's memory: past three
            // quarters of it, the oldest go, so a process that needs a memory of
            // its own still finds room (one made anew starts at its floor).
            if (machineMemory !== null)
            {
                const { limit } = machineMemory.report();
                while (spareMemories.length > 0 && machineMemory.report().used > limit * 3 / 4)
                {
                    dropSpare(spareMemories.shift());
                }
            }
        }
    };
    /**
     * Everything a gone process held of the machine's memory given back, its
     * memories handed to the run first where they are kept for the next.
     *
     * @param {number} holder
     * @param {(SpareMemory | null | undefined)[]} kept  its memories the run keeps
     */
    const releaseHolder = (holder, kept)=>{
        if (machineMemory === null)
        {
            kept.forEach(keepSpare);
            return;
        }
        kept.forEach(spare=>spareToRun(spare, holder));
        machineMemory.release(holder);
        kept.forEach(keepSpare);
    };
    /**
     * What a process's start takes of the machine's memory, taken before it is
     * built: its memory and the grows of its start (its first heap block, the
     * engine's own tables and routines) draw on it, so a start never finds the
     * machine full half way, and what is left is given back once it is built
     * (`releaseCredit`). A process asked for while the machine is full waits for
     * others to end, up to `MACHINE_WAIT_MS`; past that it is built on what the
     * machine has, and a start that cannot finish is the child failing.
     *
     * Before it waits, the memories of gone processes go to make room: the
     * ones kept for the next process, then the one this process took - it is
     * built in a memory of its own instead. Kept, they held the room the
     * processes taking them waited for: four children, each in a memory a
     * child before them was given 100 MiB in, waited on each other and none
     * started.
     *
     * @param {{ reused: SpareMemory | null }} start  the gone process's memory it
     *     is built in, if any; null once that is let go for room
     * @param {number} holder  the process's holder
     * @returns {Promise<{ left: number } | undefined>}
     */
    const roomForProcess = async(start, holder)=>{
        if (machineMemory === null)
        {
            return undefined;
        }
        const view = holderView(holder);
        // Counted by length: in a memory of its own, the floor grown to cover
        // the heap's first block; in a gone one, the room to grow that far. By
        // what it is given: its images, its first stack and heap. And the
        // engine's own part of a process (`PROCESS_ENGINE_BYTES`), held as long
        // as it stands.
        const wantedNow = ()=>(byLength
            ? Math.max(0, START_BYTES - (start.reused?.memory.buffer.byteLength ?? 0))
            : PROCESS_TABLES_BYTES) + START_SLACK_BYTES;
        const fits = ()=>view.fits(wantedNow() + PROCESS_ENGINE_BYTES);
        // Again at every look while it waits: a process that ends meanwhile
        // leaves its memory kept for the next, which holds the room it gave back.
        const makeRoom = ()=>{
            while (!fits() && spareMemories.length > 0)
            {
                dropSpare(spareMemories.shift());
            }
            if (!fits() && start.reused)
            {
                spareToRun(start.reused, holder);
                dropSpare(start.reused);
                start.reused = null;
            }
        };
        const waitMs = options.machineWaitMs ?? MACHINE_WAIT_MS;
        const until = Date.now() + waitMs;
        makeRoom();
        while (!(fits() && view.take(PROCESS_ENGINE_BYTES, 'engine')))
        {
            makeRoom();
            if (Date.now() >= until)
            {
                throw Object.assign(new Error('the machine\'s memory had no room for the'
                    + ` process for ${waitMs / 1000} s`), { code: 'MACHINE_MEMORY' });
            }
            await new Promise(resolve=>setTimeout(resolve, 50));
        }
        const wanted = wantedNow();
        if (!view.take(wanted))
        {
            view.give(PROCESS_ENGINE_BYTES, 'engine');
            throw Object.assign(new Error('the machine\'s memory had no room for the process'),
                { code: 'MACHINE_MEMORY' });
        }
        return { left: wanted };
    };
    /**
     * What a built process left of its start's credit, given back.
     *
     * @param {{ left: number } | undefined} credit
     * @param {number} holder
     */
    const releaseCredit = (credit, holder)=>{
        if (credit && credit.left > 0 && machineMemory !== null)
        {
            holderView(holder).give(credit.left);
            credit.left = 0;
        }
    };
    /** @param {any} gone  a machine disposed */
    const keepMemory = gone=>{
        const spare = gone?.spareMemory?.();
        const held = holderOf.get(gone);
        holderOf.delete(gone);
        if (held === undefined || !held.own)
        {
            // Its parent, in another thread, gives back the rest of what it held.
            if (held !== undefined)
            {
                spareToRun(spare, held.holder);
            }
            keepSpare(spare);
            return;
        }
        releaseHolder(held.holder, [spare]);
    };

    return {
        dropSpare, holderOf, keepMemory, keepSpare, machineMemory, releaseCredit, releaseHolder,
        roomForProcess, spareMemories, spareToProcess, spareToRun,

    };
}


/**
 * How many memories of gone processes a run keeps for the next ones beyond
 * those it takes at once: each is the size of a process's whole address space.
 */
const SPARE_MEMORIES = 4;

/**
 * What a process's start takes of the machine's memory where the run has one
 * (`roomForProcess`): its RAM grown to cover the heap's first block, which lies
 * at 192 MiB (`HEAP_FLOOR`).
 */
const START_BYTES = 256 << 20;

/** Past `START_BYTES`, the engine's pages of the process's first executor. */
const START_SLACK_BYTES = 32 << 20;

/**
 * What a process costs the tab past its guest's memory and its translations,
 * while it stands: its layers' state on the JavaScript heap, its translator's
 * arena, its buffers (`roadmap/decisions.md` A245).
 */
const PROCESS_ENGINE_BYTES = 32 << 20;

/**
 * Where guests count by what they were given, the translator's tables of a
 * process's first executor, past its RAM, which its start takes (`areaBytes`).
 */
const PROCESS_TABLES_BYTES = 64 << 20;

/** How long a process asked for while the machine's memory is full waits for room. */
const MACHINE_WAIT_MS = 600_000;
