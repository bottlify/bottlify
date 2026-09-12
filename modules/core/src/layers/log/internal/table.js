/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A table of numbers in memory a reader on another thread can see.
 *
 * Everything a layer used to build into a diagnostics object on request -- a
 * counter, a row per thread, a frame's split by kind, an instruction count per
 * page -- is a number a writer can store where it happens and a reader can
 * pick up whenever it likes. So that is the whole primitive: rows of float64
 * columns, a row count, and a name per column that is published once. A
 * string belongs in the journal's dictionary, and the table holds its id.
 *
 * Float64 rather than an atomic integer: a retired-instruction count passes
 * 2^31 in seconds, and every writer here is the one engine thread, so a plain
 * store is enough for a reader that samples. An aligned eight-byte store is
 * one instruction on every platform this runs on; a torn read would be one
 * bad sample, not a bad count.
 */

const USED = 0;
const WRITTEN = 1;
const CONTROL_WORDS = 2;
const HEADER_BYTES = 8;

/**
 * @typedef {Object} TableDescriptor
 * @property {ArrayBufferLike} buffer
 * @property {number} rows
 * @property {string[]} columns
 */

/**
 * @typedef {Object} TableWriter
 * @property {Float64Array} values      `rows * columns.length`, row-major.
 * @property {number} rows
 * @property {number} width             Columns per row.
 * @property {(row: number, column: number, value: number) => void} set
 * @property {(row: number, column: number, amount: number) => void} add
 * @property {(count: number) => void} used     How many rows carry something.
 * @property {() => number} advance     Takes the next slot of a ring of rows; answers the row.
 * @property {() => TableDescriptor} describe
 */

/**
 * @param {Object} options
 * @param {number} options.rows
 * @param {string[]} options.columns
 * @param {boolean} [options.shared]
 * @returns {TableWriter}
 */
export function createTable({ rows, columns, shared = true }){
    const width = columns.length;
    const bytes = HEADER_BYTES + rows * width * 8;
    const buffer = shared && typeof SharedArrayBuffer === 'function'
        ? new SharedArrayBuffer(bytes)
        : new ArrayBuffer(bytes);
    const control = new Int32Array(buffer, 0, CONTROL_WORDS);
    const values = new Float64Array(buffer, HEADER_BYTES, rows * width);
    let written = 0;
    return {
        values,
        rows,
        width,
        set: (row, column, value)=>{ values[row * width + column] = value; },
        add: (row, column, amount)=>{ values[row * width + column] += amount; },
        used: count=>Atomics.store(control, USED, count),
        advance(){
            const row = written % rows;
            written++;
            Atomics.store(control, WRITTEN, written >>> 0);
            if (written <= rows)
            {
                Atomics.store(control, USED, written);
            }
            return row;
        },
        describe: ()=>({ buffer, rows, columns: columns.slice() }),
    };
}

/**
 * @typedef {Object} TableReader
 * @property {Float64Array} values
 * @property {number} rows
 * @property {string[]} columns
 * @property {() => number} used
 * @property {() => number} written     Rows ever taken with `advance`.
 * @property {(row: number) => Record<string, number>} row
 * @property {() => Record<string, number>[]} all    The rows in use, oldest first for a ring.
 */

/**
 * @param {TableDescriptor} descriptor
 * @returns {TableReader}
 */
export function readTable({ buffer, rows, columns }){
    const width = columns.length;
    const control = new Int32Array(buffer, 0, CONTROL_WORDS);
    const values = new Float64Array(buffer, HEADER_BYTES, rows * width);
    const row = (/** @type {number} */ at)=>{
        /** @type {Record<string, number>} */
        const out = {};
        for (let column = 0; column < width; column++)
        {
            out[columns[column]] = values[at * width + column];
        }
        return out;
    };
    return {
        values,
        rows,
        columns,
        used: ()=>Atomics.load(control, USED),
        written: ()=>Atomics.load(control, WRITTEN) >>> 0,
        row,
        all(){
            const used = Atomics.load(control, USED);
            const written = Atomics.load(control, WRITTEN) >>> 0;
            const out = [];
            // A ring that has lapped starts at its oldest slot, which is the
            // one `advance` will take next.
            const first = written > rows ? written % rows : 0;
            for (let i = 0; i < used; i++)
            {
                out.push(row((first + i) % rows));
            }
            return out;
        },
    };
}
