/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The WebAssembly binary encoder: the one place cork writes wasm bytes.
 *
 * A module is built from parts in any order -- types, imports, globals, a
 * function table, functions with their bodies, element segments -- and laid
 * out in the section order the format requires when `toBytes()` is asked. A
 * body is an instruction stream with the block structure checked as it is
 * written, so a `block` left open is an error here, with a line to look at,
 * rather than a validation failure naming a byte offset.
 *
 * Only what the translator emits is here; nothing is generated from a table
 * of every instruction. Numbers are LEB128 as the format wants them, and
 * every helper that takes a signed constant encodes it signed.
 */

/** Value types, by their byte. */
export const ValType = Object.freeze({
    i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70,
});

/** The block type of a block that leaves nothing on the stack. */
export const EMPTY = 0x40;

/**
 * Unsigned LEB128.
 *
 * @param {number} value  0 .. 2^32 - 1
 * @returns {number[]}
 */
export function leb128u(value){
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    {
        throw new Error(`encoder: ${value} is not an unsigned 32-bit integer`);
    }
    const out = [];
    let rest = value;
    for (;;)
    {
        const byte = rest % 128;
        rest = Math.floor(rest / 128);
        out.push(rest > 0 ? byte | 0x80 : byte);
        if (rest === 0)
        {
            return out;
        }
    }
}

/**
 * Signed LEB128 of a 32-bit value (an i32 constant, a branch depth's
 * signed forms are not needed).
 *
 * @param {number} value  -2^31 .. 2^32 - 1, taken as its 32-bit pattern
 * @returns {number[]}
 */
export function leb128s32(value){
    return leb128s64(BigInt(value | 0));
}

/**
 * Signed LEB128 of a 64-bit value.
 *
 * @param {bigint} value
 * @returns {number[]}
 */
export function leb128s64(value){
    const out = [];
    let rest = BigInt.asIntN(64, value);
    for (;;)
    {
        const byte = Number(rest & 0x7fn);
        rest >>= 7n;
        const done = (rest === 0n && (byte & 0x40) === 0) || (rest === -1n && (byte & 0x40) !== 0);
        out.push(done ? byte : byte | 0x80);
        if (done)
        {
            return out;
        }
    }
}

/** @param {string} text @returns {number[]} a name as the format writes one */
function name(text){
    const bytes = [...new TextEncoder().encode(text)];
    return [...leb128u(bytes.length), ...bytes];
}

/** @param {number[]} bytes @param {number} count @returns {number[]} a vector with its count */
function vector(bytes, count){
    return [...leb128u(count), ...bytes];
}

/** Memory access opcodes by kind, with the natural alignment of each. */
const LOADS = Object.freeze({
    i32: [0x28, 2], i64: [0x29, 3], f32: [0x2a, 2], f64: [0x2b, 3],
    i32_8s: [0x2c, 0], i32_8u: [0x2d, 0], i32_16s: [0x2e, 1], i32_16u: [0x2f, 1],
    i64_8s: [0x30, 0], i64_8u: [0x31, 0], i64_16s: [0x32, 1], i64_16u: [0x33, 1],
    i64_32s: [0x34, 2], i64_32u: [0x35, 2],
});
const STORES = Object.freeze({
    i32: [0x36, 2], i64: [0x37, 3], f32: [0x38, 2], f64: [0x39, 3],
    i32_8: [0x3a, 0], i32_16: [0x3b, 1], i64_8: [0x3c, 0], i64_16: [0x3d, 1], i64_32: [0x3e, 2],
});
/** v128 memory access, as SIMD opcodes: `v128.load` and `v128.store`. */
const SIMD_LOAD = 0;
const SIMD_STORE = 11;

/**
 * An instruction stream, with the block nesting checked as it is written.
 */
export class Body {
    constructor(){
        /** @type {number[]} */
        this.bytes = [];
        this.depth = 0;
    }

    /** @param {number} opcode @param {number[]} [immediates] */
    op(opcode, immediates = []){
        if (!Number.isInteger(opcode))
        {
            // A misspelt name would otherwise encode as byte 0: unreachable.
            throw new Error(`encoder: no such opcode (${String(opcode)})`);
        }
        this.bytes.push(opcode, ...immediates);
        return this;
    }

    /** A SIMD instruction by its number in the 0xfd space. @param {number} opcode */
    simd(opcode){
        return this.op(0xfd, leb128u(opcode));
    }

    /**
     * A SIMD memory instruction: opcode, memarg and, for the lane forms, the
     * lane index.
     *
     * @param {number} opcode
     * @param {{ align: number, offset: number, lane?: number }} memarg  align as its log2
     */
    simdMem(opcode, { align, offset, lane }){
        const bytes = [...leb128u(opcode), ...leb128u(align), ...leb128u(offset)];
        if (lane !== undefined)
        {
            bytes.push(lane);
        }
        return this.op(0xfd, bytes);
    }

    unreachable(){
        return this.op(0x00);
    }

    nop(){
        return this.op(0x01);
    }

    /** @param {number} type  A value type, or EMPTY. */
    block(type = EMPTY){
        this.depth++;
        return this.op(0x02, [type]);
    }

    /** @param {number} type */
    loop(type = EMPTY){
        this.depth++;
        return this.op(0x03, [type]);
    }

    /** @param {number} type */
    if(type = EMPTY){
        this.depth++;
        return this.op(0x04, [type]);
    }

    else(){
        if (this.depth === 0)
        {
            throw new Error('encoder: else outside any if');
        }
        return this.op(0x05);
    }

    end(){
        if (this.depth === 0)
        {
            throw new Error('encoder: end with no block open');
        }
        this.depth--;
        return this.op(0x0b);
    }

    /** @param {number} depth */
    br(depth){
        return this.op(0x0c, leb128u(depth));
    }

    /** @param {number} depth */
    brIf(depth){
        return this.op(0x0d, leb128u(depth));
    }

    /** @param {number[]} depths @param {number} fallback */
    brTable(depths, fallback){
        const targets = depths.flatMap(depth=>leb128u(depth));
        return this.op(0x0e, [...vector(targets, depths.length), ...leb128u(fallback)]);
    }

    return(){
        return this.op(0x0f);
    }

    /** @param {number} functionIndex */
    call(functionIndex){
        return this.op(0x10, leb128u(functionIndex));
    }

    /** @param {number} typeIndex @param {number} table */
    callIndirect(typeIndex, table = 0){
        return this.op(0x11, [...leb128u(typeIndex), ...leb128u(table)]);
    }

    /** A tail call. @param {number} functionIndex */
    returnCall(functionIndex){
        return this.op(0x12, leb128u(functionIndex));
    }

    /** @param {number} typeIndex @param {number} table */
    returnCallIndirect(typeIndex, table = 0){
        return this.op(0x13, [...leb128u(typeIndex), ...leb128u(table)]);
    }

    drop(){
        return this.op(0x1a);
    }

    select(){
        return this.op(0x1b);
    }

    /** @param {number} index */
    localGet(index){
        return this.op(0x20, leb128u(index));
    }

    /** @param {number} index */
    localSet(index){
        return this.op(0x21, leb128u(index));
    }

    /** @param {number} index */
    localTee(index){
        return this.op(0x22, leb128u(index));
    }

    /** @param {number} index */
    globalGet(index){
        return this.op(0x23, leb128u(index));
    }

    /** @param {number} index */
    globalSet(index){
        return this.op(0x24, leb128u(index));
    }

    /**
     * @param {keyof typeof LOADS} kind
     * @param {{ offset?: number, align?: number }} [options]  `align` as log2; natural by default.
     */
    load(kind, { offset = 0, align } = {}){
        const [opcode, natural] = LOADS[kind];
        return this.op(opcode, [...leb128u(align ?? natural), ...leb128u(offset)]);
    }

    /**
     * @param {keyof typeof STORES} kind
     * @param {{ offset?: number, align?: number }} [options]
     */
    store(kind, { offset = 0, align } = {}){
        const [opcode, natural] = STORES[kind];
        return this.op(opcode, [...leb128u(align ?? natural), ...leb128u(offset)]);
    }

    /** @param {{ offset?: number, align?: number }} [options] */
    loadV128({ offset = 0, align = 4 } = {}){
        return this.op(0xfd, [...leb128u(SIMD_LOAD), ...leb128u(align), ...leb128u(offset)]);
    }

    /** @param {{ offset?: number, align?: number }} [options] */
    storeV128({ offset = 0, align = 4 } = {}){
        return this.op(0xfd, [...leb128u(SIMD_STORE), ...leb128u(align), ...leb128u(offset)]);
    }

    /** @param {number} value */
    i32const(value){
        return this.op(0x41, leb128s32(value));
    }

    /** @param {bigint} value */
    i64const(value){
        return this.op(0x42, leb128s64(value));
    }

    /** @param {number} value */
    f32const(value){
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setFloat32(0, value, true);
        return this.op(0x43, [...bytes]);
    }

    /** @param {number} value */
    f64const(value){
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value, true);
        return this.op(0x44, [...bytes]);
    }

    /** Sixteen bytes as a v128 constant. @param {Uint8Array | number[]} lanes */
    v128const(lanes){
        if (lanes.length !== 16)
        {
            throw new Error('encoder: a v128 constant is sixteen bytes');
        }
        return this.op(0xfd, [...leb128u(12), ...lanes]);
    }

    /** The finished body's instructions, `end` included. @returns {Uint8Array<ArrayBuffer>} */
    toBytes(){
        if (this.depth !== 0)
        {
            throw new Error(`encoder: block left open (${this.depth} deep)`);
        }
        return Uint8Array.from([...this.bytes, 0x0b]);
    }
}

/**
 * A module under construction.
 */
export class ModuleBuilder {
    constructor(){
        /** @type {string[]} signatures, as "params|results" keys, by type index */
        this.types = [];
        /** @type {number[][]} */
        this.typeBytes = [];
        /** @type {number[][]} import entries, in declaration order */
        this.imports = [];
        this.importedFunctions = 0;
        this.importedGlobals = 0;
        /** @type {{ typeIndex: number, locals: number[], body: Uint8Array }[]} */
        this.functions = [];
        /** @type {number[][]} */
        this.globals = [];
        /** @type {number[][]} */
        this.exports = [];
        /** @type {number | null} */
        this.tableMin = null;
        this.importedTable = false;
        /** @type {{ offset: number, functions: number[] }[]} */
        this.elements = [];
        /** @type {[number, string][]} function index and name, for the `name` section */
        this.functionNames = [];
    }

    /**
     * A function type, deduplicated.
     *
     * @param {{ params: number[], results: number[] }} signature
     * @returns {number} the type index
     */
    type({ params, results }){
        const key = `${params.join(',')}|${results.join(',')}`;
        const known = this.types.indexOf(key);
        if (known >= 0)
        {
            return known;
        }
        this.types.push(key);
        this.typeBytes.push([
            0x60, ...vector(params, params.length), ...vector(results, results.length),
        ]);
        return this.types.length - 1;
    }

    /**
     * @param {string} module @param {string} field
     * @param {{ min: number, max?: number, shared?: boolean }} limits  in pages
     */
    importMemory(module, field, { min, max, shared = false }){
        const flag = (max === undefined ? 0 : 1) | (shared ? 2 : 0);
        const limits = [flag, ...leb128u(min), ...(max === undefined ? [] : leb128u(max))];
        this.imports.push([...name(module), ...name(field), 0x02, ...limits]);
        return this;
    }

    /**
     * @param {string} module @param {string} field @param {number} typeIndex
     * @returns {number} the function index
     */
    importFunction(module, field, typeIndex){
        if (this.functions.length > 0)
        {
            throw new Error('encoder: imports come before functions, which index after them');
        }
        this.imports.push([...name(module), ...name(field), 0x00, ...leb128u(typeIndex)]);
        return this.importedFunctions++;
    }

    /**
     * @param {string} module @param {string} field @param {number} valType @param {boolean} mutable
     * @returns {number} the global index
     */
    importGlobal(module, field, valType, mutable){
        if (this.globals.length > 0)
        {
            throw new Error('encoder: imported globals come before defined ones');
        }
        this.imports.push([...name(module), ...name(field), 0x03, valType, mutable ? 1 : 0]);
        return this.importedGlobals++;
    }

    /**
     * A defined global with a constant initialiser.
     *
     * @param {number} valType @param {boolean} mutable @param {number | bigint} init
     * @returns {number} the global index
     */
    global(valType, mutable, init){
        const initial = new Body();
        switch (valType)
        {
            case ValType.i32: initial.i32const(Number(init)); break;
            case ValType.i64: initial.i64const(BigInt(init)); break;
            case ValType.f32: initial.f32const(Number(init)); break;
            case ValType.f64: initial.f64const(Number(init)); break;
            default:
                throw new Error(`encoder: no initialiser for value type 0x${valType.toString(16)}`);
        }
        this.globals.push([valType, mutable ? 1 : 0, ...initial.toBytes()]);
        return this.importedGlobals + this.globals.length - 1;
    }

    /** One funcref table. @param {number} min */
    table(min){
        if (this.tableMin !== null || this.importedTable)
        {
            throw new Error('encoder: one table');
        }
        this.tableMin = min;
        return 0;
    }

    /**
     * The one table, imported instead: the host's, shared between modules.
     *
     * @param {string} module @param {string} field @param {number} min
     * @returns {number} the table index
     */
    importTable(module, field, min){
        if (this.tableMin !== null || this.importedTable)
        {
            throw new Error('encoder: one table');
        }
        this.importedTable = true;
        this.imports.push([...name(module), ...name(field), 0x01, ValType.funcref, 0x00,
            ...leb128u(min)]);
        return 0;
    }

    /**
     * @param {number} typeIndex
     * @param {number[]} locals  value types, one entry per local
     * @param {Uint8Array} body  from `Body.toBytes()`
     * @param {{ exportAs?: string }} [options]
     * @returns {number} the function index
     */
    function(typeIndex, locals, body, { exportAs } = {}){
        const index = this.importedFunctions + this.functions.length;
        this.functions.push({ typeIndex, locals, body });
        if (exportAs !== undefined)
        {
            this.exports.push([...name(exportAs), 0x00, ...leb128u(index)]);
        }
        return index;
    }

    /**
     * Names a function in the module's custom `name` section, which a
     * browser's profiler reads: a region function named by its address shows
     * in a CPU profile as itself rather than as `wasm-function[0]`.
     *
     * @param {number} functionIndex @param {string} functionName
     */
    nameFunction(functionIndex, functionName){
        this.functionNames.push([functionIndex, functionName]);
        return this;
    }

    /** @param {string} field @param {number} functionIndex */
    exportFunction(field, functionIndex){
        this.exports.push([...name(field), 0x00, ...leb128u(functionIndex)]);
        return this;
    }

    /** @param {string} field @param {number} globalIndex */
    exportGlobal(field, globalIndex){
        this.exports.push([...name(field), 0x03, ...leb128u(globalIndex)]);
        return this;
    }

    /** @param {string} field */
    exportTable(field){
        this.exports.push([...name(field), 0x01, 0x00]);
        return this;
    }

    /** Functions placed into the table from `offset`. @param {number} offset @param {number[]} functions */
    element(offset, functions){
        this.elements.push({ offset, functions });
        return this;
    }

    /** @returns {Uint8Array<ArrayBuffer>} */
    toBytes(){
        /** @param {number} id @param {number[]} content */
        const section = (id, content)=>(content.length === 0
            ? []
            : [id, ...leb128u(content.length), ...content]);
        /** @param {number[][]} entriesOf */
        const entries = entriesOf=>vector(entriesOf.flat(), entriesOf.length);

        /**
         * Pieces concatenated once: a body is a typed array and stays one,
         * never spread through a JavaScript array (a large region's module
         * spent longer being assembled than compiled).
         *
         * @param {(number[] | Uint8Array)[]} pieces
         */
        const concat = pieces=>{
            let length = 0;
            for (const piece of pieces)
            {
                length += piece.length;
            }
            const out = new Uint8Array(length);
            let at = 0;
            for (const piece of pieces)
            {
                out.set(piece, at);
                at += piece.length;
            }
            return out;
        };
        const codes = this.functions.map(({ locals, body })=>{
            // Runs of one type are one entry: "3 × i32, 1 × f64".
            /** @type {number[][]} */
            const runs = [];
            for (const local of locals)
            {
                const last = runs[runs.length - 1];
                if (last && last[1] === local)
                {
                    last[0]++;
                }
                else
                {
                    runs.push([1, local]);
                }
            }
            const declared = vector(
                runs.flatMap(([count, type])=>[...leb128u(count), type]), runs.length);
            return concat([leb128u(declared.length + body.length), declared, body]);
        });
        const codeSection = codes.length === 0 ? new Uint8Array(0) : (()=>{
            const content = concat([leb128u(codes.length), ...codes]);
            return concat([[10], leb128u(content.length), content]);
        })();

        // The custom `name` section, last: its function-names subsection (1)
        // maps indices to names.
        const nameSection = this.functionNames.length === 0 ? new Uint8Array(0) : (()=>{
            const map = vector(this.functionNames.flatMap(
                ([index, functionName])=>[...leb128u(index), ...name(functionName)]),
            this.functionNames.length);
            const content = [...name('name'), 0x01, ...leb128u(map.length), ...map];
            return concat([[0x00], leb128u(content.length), content]);
        })();
        const table = this.tableMin === null
            ? []
            : [ValType.funcref, 0x00, ...leb128u(this.tableMin)];
        const elements = this.elements.map(({ offset, functions })=>[
            0x00, ...new Body().i32const(offset).toBytes(),
            ...vector(functions.flatMap(index=>leb128u(index)), functions.length),
        ]);

        return concat([
            [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
            section(1, entries(this.typeBytes)),
            section(2, entries(this.imports)),
            section(3, vector(
                this.functions.flatMap(f=>leb128u(f.typeIndex)), this.functions.length)),
            section(4, this.tableMin === null ? [] : vector(table, 1)),
            section(6, entries(this.globals)),
            section(7, entries(this.exports)),
            section(9, entries(elements)),
            codeSection,
            nameSection,
        ]);
    }
}
