/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pool thread stacks come from.
 *
 * Each stack is registered in the address space like anything else, so a
 * stack that runs into its neighbour is caught by the region map rather than
 * by the corruption it causes. And each is given back once its thread no
 * longer needs it: a program that makes a worker per task and lets each one
 * end has only ever had a few alive, and a pool that never took one back ran
 * out after as many threads as it holds stacks.
 */

/** What a stack's size is rounded up to: the allocation granularity. */
const GRANULE = 0x10000;
/** What a commit that outgrows the default reserve is rounded up to. */
const MEGABYTE = 0x100000;

/**
 * @param {Object} options
 * @param {any} options.memory   The memory layer's API.
 * @param {number} options.base
 * @param {number} options.size   The default reserve: what a thread asking for nothing gets.
 * @param {number} options.limit  Where the pool ends.
 */
export function createStackPool({ memory, base, size, limit }){
    /** @type {{ base: number, size: number, name: string, owner: any }[]} */
    const held = [];
    let issued = 0;

    /**
     * The reserve a thread gets, by the rules CreateThread documents: a
     * size given as a reservation is the reserve; a commit as large as the
     * default reserve raises it to that commit, to a whole megabyte; anything
     * less keeps the default.
     *
     * @param {{ commit?: number, reserve?: number }} asked
     */
    const reserveFor = ({ commit = 0, reserve = 0 })=>{
        if (reserve > 0)
        {
            return reserve;
        }
        if (commit >= size)
        {
            return Math.ceil(commit / MEGABYTE) * MEGABYTE;
        }
        return size;
    };

    return {
        /**
         * Finds room for a stack, lowest first, after taking back every stack
         * whose owner has let it go.
         *
         * @param {{ commit?: number, reserve?: number }} asked
         * @param {(owner: any) => boolean} released
         *        Whether a stack's thread is done with it. Asked here rather
         *        than when the thread ends, because the call that ends a thread
         *        still writes on that thread's stack on its way out.
         * @returns {{ base: number, size: number, name: string, owner: any } | null}
         *          null when the pool has no room
         */
        allocate(asked, released){
            for (let at = held.length - 1; at >= 0; at--)
            {
                if (held[at].owner !== null && released(held[at].owner))
                {
                    memory.unregister(held[at].name);
                    held.splice(at, 1);
                }
            }
            const bytes = Math.ceil(reserveFor(asked) / GRANULE) * GRANULE;
            held.sort((a, b)=>a.base - b.base);
            let from = base;
            for (const slot of held)
            {
                if (slot.base - from >= bytes)
                {
                    break;
                }
                from = Math.max(from, slot.base + slot.size);
            }
            if (from + bytes > limit)
            {
                return null;
            }
            issued++;
            const slot = { base: from, size: bytes, name: `stack-${issued}`, owner: null };
            memory.register({
                name: slot.name,
                base: slot.base,
                size: slot.size,
                kind: memory.RegionKind.STACK,
                access: memory.Access.READ_WRITE,
            });
            held.push(slot);
            return slot;
        },

        diagnostics: ()=>({
            stacksHeld: held.length,
            stacksIssued: issued,
            stackBytesHeld: held.reduce((total, slot)=>total + slot.size, 0),
        }),
    };
}
