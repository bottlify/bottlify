/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Numbers and small helpers of a process's layout and accounts: the first
 * process's id, the engine code's span, how memory a gone process leaves is
 * reused, a cleared allocation's alignment, how many trace lines a report keeps.
 */


/**
 * The process id of a run's first process, where the caller named none: the
 * kernel's, its windows' and its frames' alike, wherever it stands.
 */
export const FIRST_PROCESS_ID = 0x1000;

/**
 * The guest ranges a process taking a gone one's memory zeroes at its start
 * (`CorkHostConfig.reused`'s `written`): what it finds in place before anything
 * hands it out -- the thunk table and the first thread's stack under the image,
 * that stack where it lies at the stack pool's start -- and what the gone
 * process's heap left below this one's, which this heap never hands out again.
 * Images are written whole as they are mapped, the heap zeroes a block as it
 * hands it out (`createHeapAllocator`'s `dirtyTo`), and the stack pool a stack
 * as it is taken: zeroing all the gone process wrote made every page of it
 * resident at the start, a quarter of a gigabyte for the smallest program.
 *
 * @param {{ guestEnd: number, heapFrom?: number }} spare
 * @param {{ below: number, mainStack: [number, number] | null, heapBase: number }} here
 *     `below`: where the thunk table and the first thread's stack under the image end
 * @returns {[number, number][]}
 */
export function reusedRanges(spare, { below, mainStack, heapBase }){
    /** @type {[number, number][]} */
    const ranges = [[0, below]];
    if (mainStack)
    {
        ranges.push(mainStack);
    }
    // A gone heap's start unknown: everything it may have reached below this heap.
    const heapFrom = spare.heapFrom ?? below;
    if (heapFrom < heapBase)
    {
        ranges.push([heapFrom, Math.min(spare.guestEnd, heapBase)]);
    }
    return ranges.filter(([from, to])=>to > from);
}

/**
 * Where a graphics resource's memory starts: on a multiple of sixteen bytes,
 * as Wine keeps every resource (its RESOURCE_ALIGNMENT, for which it drops a
 * GL mapping a driver hands back off the boundary). A program writes what it
 * locked with SSE stores, which fault off it, and one checks the pointer a
 * DISCARD hands back and, given one off it, unlocks and leaves out of the
 * frame what it would have written there. The heap's own boundary is eight.
 */
export const RESOURCE_ALIGNMENT = 16;

/**
 * Memory for a graphics resource, cleared and on `RESOURCE_ALIGNMENT`. A
 * driver hands out a new surface, texture or buffer reading as zeroes (the
 * kernel clears what it maps), and a program may draw one it never wrote: an
 * empty layer under a menu, a target it clears only in part. The guest heap
 * recycles freed blocks as they were left, so a texture made after a Reset
 * held the old back buffer's picture. Memory the heap never handed out is
 * zero already and is not written, and neither is memory the device says
 * nobody reads before it is written (`cleared` false): a render target drawn
 * by another device.
 *
 * @param {{ allocate: (bytes: number, options?: { alignment?: number }) => number,
 *     block: (address: number) => { fresh?: boolean } | null | undefined }} heap
 * @param {(address: number, value: number, length: number) => void} fill
 * @param {number} bytes
 * @param {boolean} [cleared]
 * @returns {number} the address, or 0
 */
export function allocateCleared(heap, fill, bytes, cleared = true){
    const address = heap.allocate(bytes, { alignment: RESOURCE_ALIGNMENT });
    if (cleared && address !== 0 && heap.block(address)?.fresh !== true)
    {
        fill(address, 0, bytes);
    }
    return address;
}

/**
 * The span after the system modules the engine's own guest code is placed in
 * and the data its routines keep (`engineCode`): a process that loads every
 * engine library places some hundreds of kilobytes of it.
 */
export const ENGINE_CODE_BYTES = 0x400000;

/** How many of the layers' last trace lines a report keeps: an exception's account and the
 * last-chance filter's are a few lines each, and a wait's repeated warning many more. */
export const TRACED_KEPT = 200;
