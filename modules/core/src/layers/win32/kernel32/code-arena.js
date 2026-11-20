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

import { assemble } from '../msvcrt/guest-code.js';

/** The size of a page, which is what a translator watches for stores. */
export const PAGE = 4096;

/** Where code placed here is aligned to. */
const ALIGN = 16;

/**
 * @param {(bytes: number) => number} allocate  the heap, which hands back memory
 *     aligned to nothing in particular; 0 when it has none
 * @param {() => number} [part]  which part of the memory `allocate` takes from
 *     now: code placed in another part than the last starts a span of its own
 *     there (the engine's span, a part a module: `app.js` `engineCode`), so
 *     where a module's routines lie does not depend on what was placed before
 * @returns {(bytes: number) => number}  a place for `bytes` of code, 0 when the heap has
 *     none to give
 */
export function createCodeArena(allocate, part = ()=>0){
    let at = 0;
    let end = 0;
    let taken = 0;
    return bytes=>{
        const size = Math.ceil(bytes / ALIGN) * ALIGN;
        const now = part();
        if (at === 0 || at + size > end || now !== taken)
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
            taken = now;
        }
        const placed = at;
        at += size;
        return placed;
    };
}

/**
 * @typedef {(number[] | string | { jump: number[], to: string, short?: boolean })} Piece
 */

/**
 * Guest code assembled where it will be placed, ending at a label `slow`
 * with the jump to the trap it falls back to.
 *
 * @param {Piece[]} pieces @param {number} at @param {number} trap
 */
export function assembleTo(pieces, at, trap){
    const code = assemble([...pieces, 'slow', [0xe9, 0, 0, 0, 0]]);
    new DataView(code.buffer).setInt32(code.length - 4, (trap - (at + code.length)) | 0, true);
    return code;
}
