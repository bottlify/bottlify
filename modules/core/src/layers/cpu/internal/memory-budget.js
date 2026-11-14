/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The machine's memory: one budget for every guest memory of a run, as the
 * processes of a Windows machine share its RAM. Each process's
 * WebAssembly.Memory is its own address space, sized to the highest address
 * it touched, and the browser holds every byte of its length; so what the
 * budget counts is the length of every memory a run holds, made or grown or
 * kept for the next process, and a memory is made or grown only while the sum
 * stays within the machine's memory. A grow refused is the guest's allocation
 * failing, as on a machine out of memory; a process asked for while the
 * machine is full waits for another to end.
 *
 * The words live in a SharedArrayBuffer every worker of the run takes in its
 * start message, so a process in a worker of its own and its executors count
 * against the same machine. Counted in 64 KiB pages, a wasm memory's unit.
 */

import { runsJavaScriptCore } from './gc-nudge.js';

const PAGE = 65536;

/**
 * How a guest's memory is counted: by its length where growing a memory makes
 * its pages the tab's at once (JavaScriptCore: a grow made every grown page
 * resident), by what the guest was given elsewhere (V8 holds a page only once
 * it is written), as Windows counts a process's commit and not its address
 * space.
 *
 * @param {'length' | 'given' | undefined} asked  `cpu.guestCharge`
 * @returns {boolean} whether by length
 */
export function guestByLength(asked){
    return asked === 'length' || (asked === undefined && runsJavaScriptCore());
}

/** The words of a budget. */
export const BudgetWord = Object.freeze({
    LIMIT: 0,     // pages the machine has
    USED: 1,      // pages every memory of the run holds now
    PEAK: 2,      // the most USED has been
    REFUSED: 3,   // asks refused
    MADE: 4,      // memories made
    DROPPED: 5,   // memories let go for good
    // What USED holds, by kind (`MEMORY_KINDS`).
    GUEST: 8,
    ENGINE: 9,
    TRANSLATION: 10,
    HEAPS: 11,
    // Past the header, each holder's words: in use, then its pages by kind.
    HOLDERS_AT: 16,
    HOLDER_WORDS: 5,
    HOLDERS: 128,
});

/** The words a budget's buffer has. */
const WORDS = BudgetWord.HOLDERS_AT + BudgetWord.HOLDERS * BudgetWord.HOLDER_WORDS;

/**
 * The holder every budget opened without one takes for: the run itself (a
 * memory kept for the next process, the run's own workers).
 */
export const RUN_HOLDER = 0;

/**
 * What the machine's memory is held for: the guests' memories; the engine's
 * own (each worker's runtime, each process's state and arena); the
 * translator's modules and what compiling them costs; and the heaps' pools
 * (files, caches). The kinds share one limit; their sums are each other's
 * room.
 *
 * @typedef {'guest' | 'engine' | 'translation' | 'heaps'} MemoryKind
 */
const KIND_WORDS = Object.freeze({
    guest: BudgetWord.GUEST,
    engine: BudgetWord.ENGINE,
    translation: BudgetWord.TRANSLATION,
    heaps: BudgetWord.HEAPS,
});
/** Each kind's word in a holder's, past its in-use word. */
const KIND_INDEX = Object.freeze({ guest: 1, engine: 2, translation: 3, heaps: 4 });

/**
 * A fresh budget of `bytes`, rounded down to whole pages.
 *
 * @param {number} bytes
 * @returns {SharedArrayBuffer | ArrayBuffer}
 */
export function createMemoryBudget(bytes){
    if (!(bytes > 0))
    {
        throw new Error(`cpu: a machine's memory of ${bytes} bytes`);
    }
    const buffer = typeof SharedArrayBuffer === 'function'
        ? new SharedArrayBuffer(WORDS * 4)
        : new ArrayBuffer(WORDS * 4);
    const words = new Int32Array(buffer);
    words[BudgetWord.LIMIT] = Math.min(0x7fffffff, Math.floor(bytes / PAGE));
    words[BudgetWord.HOLDERS_AT] = 1;
    return buffer;
}

/**
 * @typedef {Object} MemoryBudget
 * @property {(bytes: number, kind?: MemoryKind) => boolean} take
 *     room for `bytes` more of `kind` (a guest's by default), or false and nothing taken
 * @property {(bytes: number, kind?: MemoryKind) => void} give  `bytes` of `kind` let go of
 * @property {(bytes: number, kind: MemoryKind, to: number) => void} move
 *     `bytes` of `kind` this holder holds handed to holder `to`: the machine's
 *     sum unchanged (a gone process's memory kept by the run, then taken by the next)
 * @property {() => number} claim  a holder no one holds, for a process starting
 *     (`RUN_HOLDER` where all are held)
 * @property {(holder: number) => number} release  everything `holder` holds given
 *     back at once, as a process's memory is at its exit however it ended; the
 *     bytes given
 * @property {number} holder  the holder this view takes for
 * @property {(kind: MemoryKind) => number} heldBy  what this view's holder holds of `kind`
 * @property {(bytes: number) => boolean} fits  whether `bytes` more would fit now
 * @property {() => void} made  a memory was made (counted for the report)
 * @property {() => void} dropped  a memory was let go for good
 * @property {() => { limit: number, used: number, peak: number, refused: number,
 *     made: number, dropped: number, byKind: Record<MemoryKind, number> }} report  in bytes
 * @property {SharedArrayBuffer | ArrayBuffer} buffer
 */

/**
 * The budget seen from one thread.
 *
 * @param {SharedArrayBuffer | ArrayBuffer} buffer
 * @returns {MemoryBudget}
 */
export function openMemoryBudget(buffer, holder = RUN_HOLDER){
    const words = new Int32Array(buffer, 0, WORDS);
    const holderWord = (/** @type {number} */ index, /** @type {MemoryKind} */ kind)=>
        BudgetWord.HOLDERS_AT + index * BudgetWord.HOLDER_WORDS + KIND_INDEX[kind];
    const shared = typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;
    const load = (/** @type {number} */ at)=>(shared ? Atomics.load(words, at) : words[at]);
    const add = (/** @type {number} */ at, /** @type {number} */ by)=>{
        if (shared)
        {
            Atomics.add(words, at, by);
        }
        else
        {
            words[at] += by;
        }
    };
    const pagesOf = (/** @type {number} */ bytes)=>Math.ceil(Math.max(0, bytes) / PAGE);
    const notePeak = (/** @type {number} */ used)=>{
        for (;;)
        {
            const peak = load(BudgetWord.PEAK);
            if (used <= peak || !shared)
            {
                if (!shared && used > peak)
                {
                    words[BudgetWord.PEAK] = used;
                }
                return;
            }
            if (Atomics.compareExchange(words, BudgetWord.PEAK, peak, used) === peak)
            {
                return;
            }
        }
    };
    return {
        buffer,
        take(bytes, kind = 'guest'){
            const pages = pagesOf(bytes);
            if (pages === 0)
            {
                return true;
            }
            const limit = load(BudgetWord.LIMIT);
            // A compare-exchange loop: two processes growing at once never both
            // take the last of the machine's memory.
            for (;;)
            {
                const used = load(BudgetWord.USED);
                if (used + pages > limit)
                {
                    add(BudgetWord.REFUSED, 1);
                    return false;
                }
                if (!shared)
                {
                    words[BudgetWord.USED] = used + pages;
                    add(KIND_WORDS[kind], pages);
                    add(holderWord(holder, kind), pages);
                    notePeak(used + pages);
                    return true;
                }
                if (Atomics.compareExchange(words, BudgetWord.USED, used, used + pages) === used)
                {
                    add(KIND_WORDS[kind], pages);
                    add(holderWord(holder, kind), pages);
                    notePeak(used + pages);
                    return true;
                }
            }
        },
        give(bytes, kind = 'guest'){
            // Never more than the holder holds: a give that comes after its holder
            // was released (a worker's last word, late) takes nothing from the
            // others' sums.
            const at = holderWord(holder, kind);
            let pages = pagesOf(bytes);
            for (;;)
            {
                const has = load(at);
                const given = Math.min(pages, has);
                if (given <= 0)
                {
                    return;
                }
                if (!shared)
                {
                    words[at] = has - given;
                    pages = given;
                    break;
                }
                if (Atomics.compareExchange(words, at, has, has - given) === has)
                {
                    pages = given;
                    break;
                }
            }
            add(BudgetWord.USED, -pages);
            add(KIND_WORDS[kind], -pages);
        },
        move(bytes, kind, to){
            // Never more than this holder holds, as `give`: a memory handed on
            // twice (by the process that ran in it, then by its parent) moves once.
            const at = holderWord(holder, kind);
            if (to === holder)
            {
                return;
            }
            for (;;)
            {
                const has = load(at);
                const moved = Math.min(pagesOf(bytes), has);
                if (moved <= 0)
                {
                    return;
                }
                if (!shared)
                {
                    words[at] = has - moved;
                    add(holderWord(to, kind), moved);
                    return;
                }
                if (Atomics.compareExchange(words, at, has, has - moved) === has)
                {
                    add(holderWord(to, kind), moved);
                    return;
                }
            }
        },
        claim(){
            for (let index = 1; index < BudgetWord.HOLDERS; index++)
            {
                const at = BudgetWord.HOLDERS_AT + index * BudgetWord.HOLDER_WORDS;
                if (shared ? Atomics.compareExchange(words, at, 0, 1) === 0
                    : words[at] === 0 && (words[at] = 1) === 1)
                {
                    return index;
                }
            }
            return RUN_HOLDER;
        },
        release(index){
            if (index === RUN_HOLDER)
            {
                return 0;
            }
            let given = 0;
            for (const kind of /** @type {MemoryKind[]} */ (Object.keys(KIND_INDEX)))
            {
                const at = holderWord(index, kind);
                const pages = shared ? Atomics.exchange(words, at, 0) : words[at];
                if (!shared)
                {
                    words[at] = 0;
                }
                if (pages !== 0)
                {
                    add(BudgetWord.USED, -pages);
                    add(KIND_WORDS[kind], -pages);
                    given += pages * PAGE;
                }
            }
            const inUse = BudgetWord.HOLDERS_AT + index * BudgetWord.HOLDER_WORDS;
            if (shared)
            {
                Atomics.store(words, inUse, 0);
            }
            else
            {
                words[inUse] = 0;
            }
            return given;
        },
        holder,
        heldBy: kind=>load(holderWord(holder, kind)) * PAGE,
        fits: bytes=>load(BudgetWord.USED) + pagesOf(bytes) <= load(BudgetWord.LIMIT),
        made: ()=>add(BudgetWord.MADE, 1),
        dropped: ()=>add(BudgetWord.DROPPED, 1),
        report: ()=>({
            limit: load(BudgetWord.LIMIT) * PAGE,
            used: load(BudgetWord.USED) * PAGE,
            peak: load(BudgetWord.PEAK) * PAGE,
            refused: load(BudgetWord.REFUSED),
            made: load(BudgetWord.MADE),
            dropped: load(BudgetWord.DROPPED),
            byKind: /** @type {Record<MemoryKind, number>} */ (Object.fromEntries(
                Object.entries(KIND_WORDS).map(([kind, at])=>[kind, load(at) * PAGE]))),
        }),
    };
}

/**
 * A holder's part of the machine's memory taken in amounts of any size, as
 * whole pages only where its sum crosses one: a translator taking a module of
 * a few kilobytes at a time pays for the bytes it holds, not a page a module.
 * Each byte counts `weight` times: what holding it costs past its own bytes
 * (a module's compiled code and the engine's state beside it).
 *
 * @param {MemoryBudget} budget
 * @param {MemoryKind} kind
 * @param {number} [weight]
 * @returns {{ take(bytes: number): boolean, give(bytes: number): void, held(): number }}
 */
export function openCharge(budget, kind, weight = 1){
    let bytesHeld = 0;
    const pagesFor = (/** @type {number} */ bytes)=>Math.ceil(bytes * weight / PAGE);
    return {
        take(bytes){
            const more = pagesFor(bytesHeld + bytes) - pagesFor(bytesHeld);
            if (more > 0 && !budget.take(more * PAGE, kind))
            {
                return false;
            }
            bytesHeld += bytes;
            return true;
        },
        give(bytes){
            const fewer = pagesFor(bytesHeld) - pagesFor(Math.max(0, bytesHeld - bytes));
            bytesHeld = Math.max(0, bytesHeld - bytes);
            if (fewer > 0)
            {
                budget.give(fewer * PAGE, kind);
            }
        },
        held: ()=>bytesHeld,
    };
}
