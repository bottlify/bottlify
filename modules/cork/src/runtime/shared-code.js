/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the executors of one process know together about translated code, in
 * shared memory: which of them hold code on each page, and the stores into code
 * each has met.
 *
 * The page flags are the process's (`executorLayout`), so a store on any
 * executor into a page where any executor has code is found -- by the store's
 * own check, an interpreter's, or the host writing. What it found has to reach
 * every executor's translations, not only the finder's: the finder drops its
 * own and says so in a ring every executor reads at its next slice, dropping
 * theirs. A page keeps its flag while any executor still holds code there:
 * one executor dropping its regions does not unmark another's.
 *
 * The ring is a count of entries ever written and slots of (stamp, address,
 * size, writer); a writer takes an index with an atomic add, fills the slot,
 * and stamps it last. A reader more than the ring behind has lost entries, and
 * drops everything it holds rather than guess which.
 *
 * Beside them, what one executor learns of the process that changes how every
 * executor translates: the pages of the threads' stacks, which only the
 * process's own executor is told of, and the switches a runtime flips once
 * for good (`SharedSwitch`) -- the process's translations are one, and an
 * executor that went on compiling the other way would keep the hazard the
 * switch was flipped for.
 */

import { Tables } from './layout.js';

/** Slots in the ring of stores into code. */
export const CODE_WRITE_SLOTS = 4096;
/** Words a slot takes: its stamp, the address, the size and the writer. */
const SLOT_WORDS = 4;
/** Words of the stack pages' bitmap: a bit for every page. */
const STACK_WORDS = Tables.PAGE_FLAGS_SIZE / 32;
/** Bytes the holders, the ring and the stack pages take, from where the host places them. */
export const SHARED_CODE_BYTES = Tables.PAGE_FLAGS_SIZE * 4 + 16
    + CODE_WRITE_SLOTS * SLOT_WORDS * 4 + STACK_WORDS * 4;

/**
 * What a runtime switches to for good and every executor of the process with it:
 * stores through esp tested (code was translated on a stack page), reads tested
 * (the program reached a page it cannot read).
 */
export const SharedSwitch = Object.freeze({ STACKS_TESTED: 1, READS_CHECKED: 2 });

/**
 * The shared record at `at` of `memory`, as executor `index` (below 32) sees it.
 *
 * @param {WebAssembly.Memory} memory @param {number} at @param {number} index
 */
export function createSharedCode(memory, at, index){
    if (!(index >= 0 && index < 32) || at % 4 !== 0)
    {
        throw new Error(`shared code: executor ${index} at ${at}`);
    }
    const holders = new Uint32Array(memory.buffer, at, Tables.PAGE_FLAGS_SIZE);
    const head = new Int32Array(memory.buffer, at + Tables.PAGE_FLAGS_SIZE * 4, 4);
    const slots = new Int32Array(memory.buffer, at + Tables.PAGE_FLAGS_SIZE * 4 + 16,
        CODE_WRITE_SLOTS * SLOT_WORDS);
    const stacks = new Int32Array(memory.buffer,
        at + Tables.PAGE_FLAGS_SIZE * 4 + 16 + CODE_WRITE_SLOTS * SLOT_WORDS * 4, STACK_WORDS);
    const bit = 1 << index;
    // Entries written before this executor existed are not its to apply: it
    // holds no code they could have reached.
    let taken = Atomics.load(head, 0);
    return {
        index,
        /** This executor holds code on the page. @param {number} page */
        hold(page){
            Atomics.or(holders, page, bit);
        },
        /**
         * Pages `first` to `last` hold a thread's stack.
         * @param {number} first @param {number} last
         */
        noteStack(first, last){
            for (let page = first; page <= last; page++)
            {
                Atomics.or(stacks, page >>> 5, 1 << (page & 31));
            }
        },
        /** Whether the page holds a thread's stack. @param {number} page */
        onStack: page=>(Atomics.load(stacks, page >>> 5) & 1 << (page & 31)) !== 0,
        /** Flips switches for every executor (`SharedSwitch`). @param {number} bits */
        raise(bits){
            Atomics.or(head, 1, bits);
        },
        /** The switches flipped so far. */
        switches: ()=>Atomics.load(head, 1),
        /**
         * This executor holds no more code on the page: whether any other still does.
         * @param {number} page
         */
        release(page){
            return (Atomics.and(holders, page, ~bit) & ~bit) !== 0;
        },
        /**
         * A store into code this executor met, for the others: the bytes it reached.
         * @param {number} address @param {number} size
         */
        publish(address, size){
            const entry = Atomics.add(head, 0, 1);
            const slot = (entry % CODE_WRITE_SLOTS) * SLOT_WORDS;
            Atomics.store(slots, slot + 1, address | 0);
            Atomics.store(slots, slot + 2, size | 0);
            Atomics.store(slots, slot + 3, index);
            Atomics.store(slots, slot, entry + 1);
        },
        /**
         * The stores into code the other executors met since this one last
         * looked, each handed to `apply`; `apply(0, -1)` -- everything -- where
         * the ring has moved on past entries it never read.
         *
         * @param {(address: number, size: number) => void} apply
         * @returns {number} the entries read
         */
        take(apply){
            const written = Atomics.load(head, 0);
            if (written === taken)
            {
                return 0;
            }
            if (written - taken > CODE_WRITE_SLOTS)
            {
                taken = written;
                apply(0, -1);
                return 1;
            }
            let read = 0;
            for (; taken < written; taken++)
            {
                const slot = (taken % CODE_WRITE_SLOTS) * SLOT_WORDS;
                // A writer between its index and its stamp: a few stores away.
                while (Atomics.load(slots, slot) !== taken + 1)
                {
                    if (Atomics.load(slots, slot) > taken + 1)
                    {
                        // Overwritten by a later lap while waited for: lost too.
                        apply(0, -1);
                        taken = Atomics.load(head, 0);
                        return read + 1;
                    }
                }
                if (Atomics.load(slots, slot + 3) !== index)
                {
                    apply(Atomics.load(slots, slot + 1) >>> 0, Atomics.load(slots, slot + 2) >>> 0);
                    read++;
                }
            }
            return read;
        },
    };
}
