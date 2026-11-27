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
 *
 * The pool is a fixed span below the heap, sixteen of the stacks a program
 * linked for four megabytes and more gets. A thread past them takes its stack
 * from the process's free address space, as every stack is on Windows, through
 * a lender the layer that owns that space gives (`lend`); without one it is not
 * made.
 */

/** What a stack's size is rounded up to: the allocation granularity. */
const GRANULE = 0x10000;
/** What a commit that outgrows the default reserve is rounded up to. */
const MEGABYTE = 0x100000;

/**
 * Where a stack the pool has no room for comes from: address space taken and
 * given back by whoever owns it. `take` answers the base of `bytes` of memory
 * the guest may write, on the allocation granularity, or 0.
 *
 * @typedef {{ take: (bytes: number) => number, give: (base: number) => void }} StackLender
 */

/**
 * @param {Object} options
 * @param {any} options.memory   The memory layer's API.
 * @param {number} options.base
 * @param {number} options.size   The default reserve: what a thread asking for nothing gets.
 * @param {number} options.limit  Where the pool ends.
 * @param {number} [options.dirtyTo]  Where the bytes a gone process left in the pool end,
 *     in a memory it handed on: a stack this process takes there for the first time is
 *     zeroed below it, as a new thread's stack reads zero on Windows -- each as it is
 *     taken, where zeroing the gone process's whole reach at the start made it resident.
 */
export function createStackPool({ memory, base, size, limit, dirtyTo = base }){
    /** @type {{ base: number, size: number, name: string, owner: any }[]} */
    const held = [];
    /** Stacks taken from the lender, outside the pool's span. @type {typeof held} */
    const lent = [];
    /** @type {StackLender | null} */
    let lender = null;
    let issued = 0;
    /** Where the stacks this process took end, the highest: below it they are its own. */
    let reached = base;

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
            for (let at = lent.length - 1; at >= 0; at--)
            {
                if (lent[at].owner !== null && released(lent[at].owner))
                {
                    lender?.give(lent[at].base);
                    lent.splice(at, 1);
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
                const taken = lender?.take(bytes) ?? 0;
                if (taken === 0)
                {
                    return null;
                }
                issued++;
                const slot = { base: taken, size: bytes, name: `stack-${issued}`, owner: null };
                lent.push(slot);
                return slot;
            }
            // A stack past the highest the pool reached is the guest's to write:
            // taken from the machine's memory, none where it has no room.
            const past = from + bytes - Math.max(reached, from);
            if (past > 0 && memory.charge?.(past) === false)
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
            const stale = { from: Math.max(slot.base, reached),
                to: Math.min(slot.base + slot.size, dirtyTo) };
            if (stale.to > stale.from)
            {
                memory.fillBytes(stale.from, 0, stale.to - stale.from);
            }
            reached = Math.max(reached, slot.base + slot.size);
            return slot;
        },

        /**
         * Where what any process wrote in the pool ends: the stacks this one
         * took, or the bytes a gone one left (`dirtyTo`).
         */
        reached: ()=>Math.max(reached, dirtyTo),

        /**
         * Where stacks past the pool's span come from from now on.
         *
         * @param {StackLender} by
         */
        lend: by=>{
            lender = by;
        },

        diagnostics: ()=>({
            stacksHeld: held.length,
            stacksLent: lent.length,
            stacksIssued: issued,
            stackBytesHeld: held.reduce((total, slot)=>total + slot.size, 0),
        }),
    };
}
