/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The write watch over the engine's page marks, for a caller that keeps a copy
 * of guest bytes -- what the graphics recorder last sent of a dynamic buffer --
 * and asks which of its pages may differ from it.
 *
 * The engine marks a page at the first store after the page was armed, and
 * the host reads the marks and arms the pages again (`takeWrites`). Two things
 * the marks alone do not give are made here:
 *
 * - Several watches over one page: a look by one arms the page again for
 *   all. Each page keeps the tick of the clock it was last found written at,
 *   and each watch the tick it last looked at the page at.
 * - Another executor's store in flight: a store tested its page while the
 *   page was marked written -- or a group's window or a loop's stream tested
 *   its pages once for many stores -- and lands after a look armed the page
 *   again, unmarked. A test and the stores it covers lie in one run of
 *   translated code, never across a call into the host (a window ends at a
 *   trap), so each executor counts its runs of guest code, odd while one is
 *   on (`Word.EPOCH`). A page armed while an executor's count was odd is
 *   found written at every look until that count has moved on: every store
 *   tested before the arming has landed by then, and that look is its last.
 *   The process's own executor needs no count: a look is made on its thread,
 *   between its slices or in a call into the host.
 */

/** Bytes in a guest page, as a shift. */
const PAGE_SHIFT = 12;

/**
 * A watch over a range: the pages of it that may differ from what the caller
 * last looked at.
 *
 * @typedef {Object} WriteWatch
 * @property {(address: number, length: number) => number[]} take  the pages of
 *     `[address, address + length)` (clipped to the watched range) written since
 *     this watch last took them, or since it began; looked at from now
 */

/**
 * @param {{ take: (address: number, length: number) => number[],
 *     epochs: () => ArrayLike<number | undefined> }} engine
 *     take: the engine's marks of a range's pages, each armed again (`takeWrites`): those
 *     written since they were armed, never armed, or never marked by a store; epochs: each
 *     other executor's count of its runs of guest code, by its index
 */
export function createWriteClock({ take, epochs }){
    let tick = 0;
    /** The tick each page was last found written at. @type {Map<number, number>} */
    const writtenAt = new Map();
    /**
     * The pages armed while another executor ran guest code, with the counts
     * then: found written at every look until each odd one has moved on.
     *
     * @type {Map<number, number[]>}
     */
    const unsettled = new Map();

    /** The counts now, if any executor runs guest code; null if none does. */
    const running = ()=>{
        const now = epochs();
        for (let index = 0; index < now.length; index++)
        {
            if (((now[index] ?? 0) & 1) !== 0)
            {
                return Array.from(now, count=>count ?? 0);
            }
        }
        return null;
    };
    /** Whether every executor that ran guest code at `then` has ended that run. @param {number[]} then */
    const settled = then=>{
        const now = epochs();
        for (let index = 0; index < then.length; index++)
        {
            if ((then[index] & 1) !== 0 && now[index] === then[index])
            {
                return false;
            }
        }
        return true;
    };

    /**
     * A look at the pages of a range: those the engine found written, and
     * those still unsettled, are made written at a new tick.
     *
     * @param {number} first @param {number} last  pages
     * @returns {number} the tick
     */
    const look = (first, last)=>{
        tick++;
        const written = take(first << PAGE_SHIFT >>> 0, (last - first + 1) << PAGE_SHIFT >>> 0);
        // After the arming: an executor running then may have tested a page
        // before it.
        const during = written.length > 0 ? running() : null;
        for (const page of written)
        {
            writtenAt.set(page, tick);
            if (during !== null)
            {
                unsettled.set(page, during);
            }
            else
            {
                unsettled.delete(page);
            }
        }
        if (unsettled.size > 0)
        {
            for (let page = first; page <= last; page++)
            {
                const then = unsettled.get(page);
                if (then !== undefined && writtenAt.get(page) !== tick)
                {
                    writtenAt.set(page, tick);
                    if (settled(then))
                    {
                        unsettled.delete(page);
                    }
                }
            }
        }
        return tick;
    };

    return {
        /**
         * Watches `[address, address + length)`: the caller reads the bytes
         * after this, and `take` answers what may have changed since.
         *
         * @param {number} address @param {number} length
         * @returns {WriteWatch}
         */
        watch(address, length){
            const first = address >>> PAGE_SHIFT;
            const last = (address + Math.max(length, 1) - 1) >>> PAGE_SHIFT;
            // A look, not an arming of its own: that would wipe a mark another
            // watch of the page has not taken yet.
            const seen = new Float64Array(last - first + 1).fill(look(first, last));
            return {
                take(from, bytes){
                    const low = Math.max(first, from >>> PAGE_SHIFT);
                    const high = Math.min(last, (from + Math.max(bytes, 1) - 1) >>> PAGE_SHIFT);
                    /** @type {number[]} */
                    const changed = [];
                    if (high < low)
                    {
                        return changed;
                    }
                    const at = look(low, high);
                    for (let page = low; page <= high; page++)
                    {
                        if ((writtenAt.get(page) ?? 0) > seen[page - first])
                        {
                            changed.push(page);
                        }
                        seen[page - first] = at;
                    }
                    return changed;
                },
            };
        },
        /** Pages whose last arming may still be crossed by a store in flight. */
        unsettled: ()=>unsettled.size,
    };
}
