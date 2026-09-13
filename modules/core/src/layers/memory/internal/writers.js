/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Who writes into guest memory, by name.
 *
 * Every byte the host puts into the guest's address space passes through this
 * layer, and until now it arrived as one number for the whole run -- which is
 * the single figure that rises fastest in a stalling frame and the one that
 * cannot be acted on. So each write is charged to whoever is in flight when it
 * happens: the host call the bridge is inside, or, when there is none, a name
 * of its own rather than whoever ran last.
 *
 * The write path is hot -- tens of thousands a second -- so a charge is a slot
 * number and six array operations, with nothing looked up, nothing allocated
 * and no string touched. Names are resolved to slots once, where a function is
 * registered, and interned once, where a slot is taken.
 *
 * The frame's busiest writer is found as the writes happen rather than by
 * walking the table when the frame closes: a stamp per slot says whether its
 * frame total belongs to this frame, so a frame ends by bumping the stamp
 * instead of clearing anything.
 */

export const WRITER_COLUMNS = ['name', 'bytes', 'writes'];

/**
 * How many writers are named. Beyond this they share one row: a program has
 * tens of functions that write and hundreds that do not, and a table sized for
 * every import would be mostly zeroes.
 */
export const WRITER_ROWS = 64;

/** Writes made with no host call in flight -- the run loop, a device pump. */
export const NO_CALL = 0;
/** Writers past the end of the table, together. */
export const BEYOND = 1;
const RESERVED = 2;

/**
 * @typedef {Object} WriterAccount
 * @property {(text: string) => number} writer   The slot a name is charged to.
 * @property {(slot: number) => number} charging
 *     Charges what follows to `slot` and answers who was being charged, so a
 *     caller restores that on the way out and nesting needs no stack.
 * @property {(length: number) => void} charge
 * @property {() => { writer: number, bytes: number }} publish
 *     The busiest writer of the frame just closed, as a dictionary id, and
 *     what it wrote. Resets the frame's tally.
 */

/**
 * @param {Object} options
 * @param {import('../../log/internal/table.js').TableWriter} options.table
 * @param {(text: string) => number} options.intern
 * @returns {WriterAccount}
 */
export function createWriterAccount({ table, intern }){
    const values = table.values;
    const width = table.width;
    /** Each slot's name as a dictionary id, so publishing touches no string. */
    const ids = new Int32Array(table.rows).fill(-1);
    /** @type {Map<string, number>} */
    const slots = new Map();
    let taken = RESERVED;

    /** @param {number} slot @param {string} text */
    const name = (slot, text)=>{
        ids[slot] = intern(text);
        table.set(slot, 0, ids[slot]);
    };
    name(NO_CALL, '<no host call>');
    name(BEYOND, '<beyond the table>');
    table.used(RESERVED);

    const frameBytes = new Float64Array(table.rows);
    const frameStamp = new Int32Array(table.rows);
    let generation = 1;
    let topSlot = NO_CALL;
    let topBytes = 0;
    let current = NO_CALL;

    return {
        writer(text){
            let slot = slots.get(text);
            if (slot === undefined)
            {
                slot = taken < table.rows ? taken++ : BEYOND;
                slots.set(text, slot);
                if (slot !== BEYOND)
                {
                    name(slot, text);
                    table.used(taken);
                }
            }
            return slot;
        },

        charging(slot){
            const was = current;
            // A caller with no slot of its own -- a build whose bridge predates
            // the account, a handler registered before the table existed --
            // leaves the charge where it was rather than moving it nowhere.
            current = slot >= 0 && slot < table.rows ? slot : current;
            return was;
        },

        charge(length){
            const slot = current;
            const at = slot * width;
            values[at + 1] += length;
            values[at + 2] += 1;
            if (frameStamp[slot] !== generation)
            {
                frameStamp[slot] = generation;
                frameBytes[slot] = 0;
            }
            const bytes = frameBytes[slot] += length;
            if (bytes > topBytes)
            {
                topBytes = bytes;
                topSlot = slot;
            }
        },

        publish(){
            const writer = topBytes > 0 ? ids[topSlot] : -1;
            const bytes = topBytes;
            generation++;
            topSlot = NO_CALL;
            topBytes = 0;
            return { writer, bytes };
        },
    };
}
