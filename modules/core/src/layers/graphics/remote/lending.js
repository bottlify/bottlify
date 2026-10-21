/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Guest memory lent to the played side rather than copied into a batch: where
 * the guest's memory is shared, what an unlock let the program write is sent
 * as where it lies, and the played side copies it out of guest memory when it
 * plays the record.
 *
 * Until then the bytes must stay as they were at the record. The program
 * writes them again only after something on this side lets it -- a lock, a
 * copy the device makes, a block given back -- and each of those claims the
 * range first. A claim on a lend the played side has not begun copies the
 * bytes into a stash both sides see and points the lend there; one it is
 * reading waits the copy out; one it has read is done. So neither side waits
 * on the other for longer than a copy, and never for a record still unsent:
 * a lend's room in the stash is taken when it is lent -- in the order the
 * played side reads them, so the stash is a ring -- and a range with no room
 * left is copied into the batch as before.
 *
 * Each lend is a slot of two words: its state, and where in the stash its
 * bytes are when they are there. The state moves LENT -> READING -> DONE on
 * the played side, or LENT -> STASHED -> DONE when this side claims first; a
 * compare-exchange on each side decides which.
 */

export const LEND = Object.freeze({ FREE: 0, LENT: 1, READING: 2, DONE: 3, STASHED: 4 });

/** How many lends may be outstanding at once; one more is copied as before. */
export const LEND_SLOTS = 4096;

/** The bytes the stash holds: the most the lends outstanding at once may cover. */
export const STASH_BYTES = 16 << 20;

/**
 * The smallest allocation whose bytes are lent; a smaller one's are copied
 * into the batch. A lent level's lock is the host's, since only the host's
 * lock claims the lend back before the program writes over it: Call of Duty
 * 4 locks every level of a 32x32 texture every frame, 151 thousand locks in
 * eight minutes on the process's executor, each a whole sync of the device's
 * ring and a wait of the thread that draws, to save copying 1.3 KB.
 */
export const LEND_LEAST = 64 << 10;

/** How long a claim waits on a read the played side began before it gives the bytes up. */
const WAIT_LIMIT_MS = 10000;

/**
 * Whether this thread may block on a shared word: a browser's window may
 * not, and a lend a claim cannot wait out is never made.
 */
export function mayWait(){
    if (typeof SharedArrayBuffer !== 'function')
    {
        return false;
    }
    try
    {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
        return true;
    }
    catch {
        return false;
    }
}

/**
 * The shared parts of a lending: the slots and the stash, made on the side
 * that lends and sent once to the side that reads.
 *
 * @returns {{ slots: SharedArrayBuffer, stash: SharedArrayBuffer }}
 */
export function createLendingBuffers(){
    return { slots: new SharedArrayBuffer(LEND_SLOTS * 8),
        stash: new SharedArrayBuffer(STASH_BYTES) };
}

/**
 * @typedef {Object} Lender
 * @property {(address: number, length: number) => number} lend
 *     a slot for the range, or -1 when no slot or no room in the stash is
 *     free or the range is not in the memory the played side sees: then the
 *     bytes go as before
 * @property {() => boolean} unsent
 *     whether anything was lent since the last `sent`: the sooner the played
 *     side has it, the likelier it is read before a claim
 * @property {() => void} sent  what was lent went to the played side
 * @property {number} least  the smallest allocation lent (`LEND_LEAST`)
 * @property {(address: number, length: number) => void} claim
 *     before anything on this side lets the range be written: every lend it
 *     overlaps is made safe to write over
 * @property {() => { lent: number, lentBytes: number, stashed: number, stashedBytes: number,
 *     waited: number, waitedMs: number }} diagnostics
 */

/**
 * The lending side.
 *
 * @param {Object} options
 * @param {SharedArrayBuffer} options.slots
 * @param {SharedArrayBuffer} options.stash
 * @param {Uint8Array} options.memory   the guest's memory, as the played side sees it
 * @param {number} [options.base]       the guest address of `memory`'s first byte
 * @param {() => number} [options.now]
 * @param {number} [options.least]     the smallest allocation lent (`LEND_LEAST`)
 * @returns {Lender}
 */
export function createLender(options){
    const { slots, stash, memory, base = 0, now = ()=>performance.now(),
        least = LEND_LEAST } = options;
    const states = new Int32Array(slots);
    const stashBytes = new Uint8Array(stash);
    /** @type {number[]} */
    const free = [];
    for (let slot = LEND_SLOTS - 1; slot >= 0; slot--)
    {
        free.push(slot);
    }
    /**
     * Every slot in use, in the order lent: the range, its room in the stash,
     * and whether it was claimed (then it is no longer the range's).
     *
     * @type {{ slot: number, address: number, end: number, claimed: boolean,
     *     stash: { start: number, end: number, gone: boolean } }[]}
     */
    let out = [];
    /**
     * The stash's rooms, oldest first; a room is given back when its lend is
     * done, and the ring's tail moves on past what is given back.
     *
     * @type {{ start: number, end: number, gone: boolean }[]}
     */
    const parts = [];
    let head = 0;
    const counts = { lent: 0, lentBytes: 0, stashed: 0, stashedBytes: 0, waited: 0,
        waitedMs: 0 };
    let unsent = false;

    /** @param {number} length @returns {{ start: number, end: number, gone: boolean } | null} */
    const take = length=>{
        if (length > STASH_BYTES)
        {
            return null;
        }
        let start = -1;
        if (parts.length === 0)
        {
            start = 0;
        }
        else
        {
            const tail = parts[0].start;
            if (head > tail)
            {
                if (head + length <= STASH_BYTES)
                {
                    start = head;
                }
                else if (length <= tail)
                {
                    start = 0;
                }
            }
            else if (head + length <= tail)
            {
                start = head;
            }
        }
        if (start < 0)
        {
            return null;
        }
        const part = { start, end: start + length, gone: false };
        parts.push(part);
        head = part.end;
        return part;
    };

    /** The slots the played side is done with, freed; their stash given back. */
    const prune = ()=>{
        out = out.filter(entry=>{
            if (Atomics.load(states, entry.slot * 2) !== LEND.DONE)
            {
                return true;
            }
            entry.stash.gone = true;
            free.push(entry.slot);
            return false;
        });
        while (parts.length > 0 && parts[0].gone)
        {
            parts.shift();
        }
        if (parts.length === 0)
        {
            head = 0;
        }
    };

    /** @param {number} slot */
    const waitDone = slot=>{
        if (Atomics.load(states, slot * 2) === LEND.DONE)
        {
            return;
        }
        const started = now();
        counts.waited++;
        for (;;)
        {
            const state = Atomics.load(states, slot * 2);
            if (state === LEND.DONE || now() - started > WAIT_LIMIT_MS)
            {
                break;
            }
            Atomics.wait(states, slot * 2, state, 50);
        }
        counts.waitedMs += now() - started;
    };

    return {
        least,
        lend(address, length){
            const at = address - base;
            if (length <= 0 || at < 0 || at + length > memory.length)
            {
                return -1;
            }
            let room = free.length > 0 ? take(length) : null;
            if (!room)
            {
                prune();
                room = free.length > 0 ? take(length) : null;
                if (!room)
                {
                    return -1;
                }
            }
            const slot = /** @type {number} */ (free.pop());
            Atomics.store(states, slot * 2, LEND.LENT);
            out.push({ slot, address, end: address + length, claimed: false, stash: room });
            unsent = true;
            counts.lent++;
            counts.lentBytes += length;
            return slot;
        },
        unsent: ()=>unsent,
        sent(){
            unsent = false;
        },
        claim(address, length){
            const end = address + length;
            let any = false;
            for (const entry of out)
            {
                if (entry.claimed || entry.end <= address || entry.address >= end)
                {
                    continue;
                }
                any = true;
                entry.claimed = true;
                const slot = entry.slot;
                if (Atomics.load(states, slot * 2) === LEND.DONE)
                {
                    continue;
                }
                if (Atomics.load(states, slot * 2) === LEND.LENT)
                {
                    stashBytes.set(memory.subarray(entry.address - base, entry.end - base),
                        entry.stash.start);
                    Atomics.store(states, slot * 2 + 1, entry.stash.start);
                    if (Atomics.compareExchange(states, slot * 2, LEND.LENT, LEND.STASHED)
                        === LEND.LENT)
                    {
                        counts.stashed++;
                        counts.stashedBytes += entry.end - entry.address;
                        continue;
                    }
                }
                waitDone(slot);
            }
            if (any)
            {
                prune();
            }
        },
        diagnostics: ()=>({ ...counts }),
    };
}

/**
 * The reading side.
 *
 * @param {Object} options
 * @param {SharedArrayBuffer} options.slots
 * @param {SharedArrayBuffer} options.stash
 * @param {Uint8Array} options.memory  the guest's memory
 * @param {number} [options.base]      the guest address of `memory`'s first byte
 * @returns {(slot: number, address: number, length: number,
 *     use: (bytes: Uint8Array) => void) => void}
 *     a lend's bytes, given to `use` -- in place, so it copies what it keeps --
 *     and the slot done after
 */
export function createBorrower({ slots, stash, memory, base = 0 }){
    const states = new Int32Array(slots);
    const stashBytes = new Uint8Array(stash);
    return (slot, address, length, use)=>{
        const was = Atomics.compareExchange(states, slot * 2, LEND.LENT, LEND.READING);
        try
        {
            if (was === LEND.LENT)
            {
                use(memory.subarray(address - base, address - base + length));
            }
            else if (was === LEND.STASHED)
            {
                const start = Atomics.load(states, slot * 2 + 1);
                use(stashBytes.subarray(start, start + length));
            }
            else
            {
                throw new Error(`remote: a lend of ${length} bytes at 0x${address.toString(16)}`
                    + ` found in state ${was}`);
            }
        }
        finally
        {
            Atomics.store(states, slot * 2, LEND.DONE);
            Atomics.notify(states, slot * 2);
        }
    };
}
