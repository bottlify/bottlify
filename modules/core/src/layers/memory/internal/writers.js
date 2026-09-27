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
 * and no string touched. Names are numbered once, where a function is
 * registered, and interned once, where a row is taken.
 *
 * A row is taken at a name's first write, not at its registration. Registration
 * order is the order the engine happens to build its libraries in, so rows
 * taken there go to the first few dozen kernel32 functions -- most of which
 * never write a byte -- and everything registered afterwards, which is most of
 * what actually writes, shares the overflow row. Taken at the first write, the
 * table holds the writers.
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
 * every import would be mostly zeroes. Rows go to the ones that do write, so
 * this is a count of writers rather than of registrations.
 */
export const WRITER_ROWS = 256;

/** Writes made with no host call in flight -- the run loop, a device pump. */
export const NO_CALL = 0;
/** Writers past the end of the table, together. */
export const BEYOND = 1;
const RESERVED = 2;

/**
 * @typedef {Object} WriterAccount
 * @property {(text: string) => number} writer
 *     The number a name's writes are charged under. Not a row in the table:
 *     a row is scarce and is taken when the name first writes.
 * @property {(slot: number) => number} charging
 *     Charges what follows to `slot` and answers who was being charged, so a
 *     caller restores that on the way out and nesting needs no stack.
 * @property {Int32Array} slot
 *     Who is being charged, one element: what `charging` swaps, for a caller
 *     that swaps it itself with numbers `writer` gave it.
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
    /** Each row's name as a dictionary id, so publishing touches no string. */
    const ids = new Int32Array(table.rows).fill(-1);
    /** Every name that has been numbered; the first two are the reserved rows. */
    const names = ['<no host call>', '<beyond the table>'];
    /** The row each name was given, -1 until it writes. @type {number[]} */
    const rows = [NO_CALL, BEYOND];
    /** @type {Map<string, number>} */
    const numbered = new Map();
    let taken = RESERVED;

    /** @param {number} row @param {string} text */
    const name = (row, text)=>{
        ids[row] = intern(text);
        table.set(row, 0, ids[row]);
    };
    name(NO_CALL, names[NO_CALL]);
    name(BEYOND, names[BEYOND]);
    table.used(RESERVED);

    /**
     * The row a name writes into, taken now because it is writing. Off the hot
     * path by one branch: a name takes a row once and the charge after that is
     * an array read.
     *
     * @param {number} id
     */
    const rowFor = id=>{
        const row = taken < table.rows ? taken++ : BEYOND;
        rows[id] = row;
        if (row !== BEYOND)
        {
            name(row, names[id]);
            table.used(taken);
        }
        return row;
    };

    const frameBytes = new Float64Array(table.rows);
    const frameStamp = new Int32Array(table.rows);
    let generation = 1;
    let topSlot = NO_CALL;
    let topBytes = 0;
    // Who is being charged, as a cell rather than a variable: the bridge sets
    // it around every host call, and a typed array's element is a store
    // where `charging` is a call into this instance.
    const slot = new Int32Array(1);
    slot[0] = NO_CALL;

    return {
        writer(text){
            let id = numbered.get(text);
            if (id === undefined)
            {
                id = names.length;
                names.push(text);
                rows.push(-1);
                numbered.set(text, id);
            }
            return id;
        },

        slot,

        charging(id){
            const was = slot[0];
            // A caller with no number of its own -- a build whose bridge
            // predates the account, a handler registered before the table
            // existed -- leaves the charge where it was rather than moving it
            // nowhere.
            slot[0] = id >= 0 && id < names.length ? id : was;
            return was;
        },

        charge(length){
            const current = slot[0];
            let row = rows[current];
            if (row < 0)
            {
                row = rowFor(current);
            }
            const at = row * width;
            values[at + 1] += length;
            values[at + 2] += 1;
            if (frameStamp[row] !== generation)
            {
                frameStamp[row] = generation;
                frameBytes[row] = 0;
            }
            const bytes = frameBytes[row] += length;
            if (bytes > topBytes)
            {
                topBytes = bytes;
                topSlot = row;
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
