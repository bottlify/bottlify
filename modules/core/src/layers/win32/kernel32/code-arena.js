/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Pages for the guest code the engine writes itself -- the fast paths of a
 * critical section, of thread-local storage, of the clocks -- and for nothing
 * else.
 *
 * A translator notices a store into a page that holds translated code, and a
 * page stored into again and again is left to the interpreter for good. Code
 * placed by the heap sits beside whatever the heap handed out next: the fast
 * paths' own counters, or an object of the program's that it writes on every
 * frame. Every store there invalidated the fast path, and the most frequent
 * call a program makes ran interpreted -- in one title, thirty-two million
 * times in two minutes of starting up. So code gets pages of its own, carved
 * page-aligned out of spans of the heap that nothing else is handed.
 */

/** The size of a page, which is what a translator watches for stores. */
export const PAGE = 4096;

/** Where code placed here is aligned to. */
const ALIGN = 16;

/**
 * @param {(bytes: number) => number} allocate  the heap, which hands back memory
 *     aligned to nothing in particular; 0 when it has none
 * @returns {(bytes: number) => number}  a place for `bytes` of code, 0 when the heap has
 *     none to give
 */
export function createCodeArena(allocate){
    let at = 0;
    let end = 0;
    return bytes=>{
        const size = Math.ceil(bytes / ALIGN) * ALIGN;
        if (at === 0 || at + size > end)
        {
            // A span one page longer than the pages wanted holds them whole,
            // wherever the heap puts it; the rest of the span is left unused.
            const pages = Math.max(1, Math.ceil(size / PAGE));
            const span = allocate((pages + 1) * PAGE);
            if (span === 0)
            {
                return 0;
            }
            at = Math.ceil(span / PAGE) * PAGE;
            end = at + pages * PAGE;
        }
        const placed = at;
        at += size;
        return placed;
    };
}
