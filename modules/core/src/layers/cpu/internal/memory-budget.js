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

const PAGE = 65536;

/** The words of a budget. */
export const BudgetWord = Object.freeze({
    LIMIT: 0,     // pages the machine has
    USED: 1,      // pages every memory of the run holds now
    PEAK: 2,      // the most USED has been
    REFUSED: 3,   // asks refused
    MADE: 4,      // memories made
    DROPPED: 5,   // memories let go for good
    WORDS: 8,
});

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
        ? new SharedArrayBuffer(BudgetWord.WORDS * 4)
        : new ArrayBuffer(BudgetWord.WORDS * 4);
    new Int32Array(buffer)[BudgetWord.LIMIT] = Math.min(0x7fffffff, Math.floor(bytes / PAGE));
    return buffer;
}

/**
 * @typedef {Object} MemoryBudget
 * @property {(bytes: number) => boolean} take  room for `bytes` more, or false and nothing taken
 * @property {(bytes: number) => void} give  `bytes` a memory let go of
 * @property {(bytes: number) => boolean} fits  whether `bytes` more would fit now
 * @property {() => void} made  a memory was made (counted for the report)
 * @property {() => void} dropped  a memory was let go for good
 * @property {() => { limit: number, used: number, peak: number, refused: number,
 *     made: number, dropped: number }} report  in bytes
 * @property {SharedArrayBuffer | ArrayBuffer} buffer
 */

/**
 * The budget seen from one thread.
 *
 * @param {SharedArrayBuffer | ArrayBuffer} buffer
 * @returns {MemoryBudget}
 */
export function openMemoryBudget(buffer){
    const words = new Int32Array(buffer, 0, BudgetWord.WORDS);
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
        take(bytes){
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
                    notePeak(used + pages);
                    return true;
                }
                if (Atomics.compareExchange(words, BudgetWord.USED, used, used + pages) === used)
                {
                    notePeak(used + pages);
                    return true;
                }
            }
        },
        give(bytes){
            const pages = pagesOf(bytes);
            if (pages > 0)
            {
                add(BudgetWord.USED, -pages);
            }
        },
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
        }),
    };
}
