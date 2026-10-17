/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The expressions fxc leaves in a compiled effect for D3DX to evaluate on the
 * CPU: a state's value computed from parameters (an FXLC object), and a
 * shader's preshader (the PRES comment of its bytecode), which computes
 * constants the shader reads.
 *
 * Either is a small program over tables of four-component registers: literals
 * (CLIT, doubles), the inputs -- parameters, laid out by the program's own
 * constant table -- temporaries, and the outputs. Each instruction runs once a
 * component, or once for a dot product, in double precision, stored in the
 * precision of the table it writes: floats, except literals.
 */

import { parseConstantTable, registerValues } from './constants.js';

/** @typedef {import('./constants.js').Constant} Constant */

const CTAB = 0x42415443;
const CLIT = 0x54494c43;
const FXLC = 0x434c5846;

/** The register tables, by the number an operand names them with. */
const TABLE = Object.freeze({ IMMED: 1, CONST: 2, INPUT: 3, OCONST: 4, OBCONST: 5, OICONST: 6,
    TEMP: 7 });

/** D3DXREGISTER_SET to the table an input of that set fills. */
const INPUT_TABLE = [TABLE.OBCONST, TABLE.OICONST, TABLE.CONST];

/** @param {number} table A boolean register holds one component, every other four. */
const width = table=>(table === TABLE.OBCONST ? 1 : 4);

/** @type {(x: number) => number} */
const nanSigned = x=>(Number.isNaN(x) ? -NaN : x);

/**
 * The operations, by opcode and how many inputs: what one component of the
 * result is of the inputs' components (`all` for one over every component).
 *
 * @type {Map<string, { all?: boolean, run: (a: number[], n: number) => number }>}
 */
const OPS = new Map([
    ['256:1', { run: a=>a[0] }],
    ['257:1', { run: a=>-a[0] }],
    ['259:1', { run: a=>1 / a[0] }],
    ['260:1', { run: a=>a[0] - Math.floor(a[0]) }],
    ['261:1', { run: a=>2 ** a[0] }],
    ['262:1', { run: a=>(a[0] === 0 ? 0 : Math.log2(Math.abs(a[0]))) }],
    ['263:1', { run: a=>(a[0] === 0 ? Infinity : 1 / Math.sqrt(Math.abs(a[0]))) }],
    ['264:1', { run: a=>Math.sin(a[0]) }],
    ['265:1', { run: a=>Math.cos(a[0]) }],
    ['266:1', { run: a=>nanSigned(Math.asin(a[0])) }],
    ['267:1', { run: a=>nanSigned(Math.acos(a[0])) }],
    ['268:1', { run: a=>Math.atan(a[0]) }],
    ['512:2', { run: a=>Math.min(a[0], a[1]) }],
    ['513:2', { run: a=>Math.max(a[0], a[1]) }],
    ['514:2', { run: a=>(a[0] < a[1] ? 1 : 0) }],
    ['515:2', { run: a=>(a[0] >= a[1] ? 1 : 0) }],
    ['516:2', { run: a=>a[0] + a[1] }],
    ['517:2', { run: a=>a[0] * a[1] }],
    ['518:2', { run: a=>Math.atan2(a[0], a[1]) }],
    // D3DX answers 0 for a division; fxc writes rcp and mul instead.
    ['520:2', { run: ()=>0 }],
    ['768:3', { run: a=>(a[0] >= 0 ? a[1] : a[2]) }],
    ['1280:2', { all: true, run: (a, n)=>dot(a, n) }],
    ['1806:6', { run: a=>dot(a, 3) }],
    ['1806:8', { run: a=>dot(a, 4) }],
]);

/** @param {number[]} a @param {number} n */
function dot(a, n){
    let sum = 0;
    for (let i = 0; i < n; i++)
    {
        sum += a[i] * a[i + n];
    }
    return sum;
}

/**
 * @typedef {{ table: number, offset: number, index: { table: number, offset: number } | null }}
 *     Operand  `offset` in components; `index` a register whose value moves it.
 */

/**
 * @typedef {Object} Preshader
 * @property {Constant[]} inputs   The parameters it reads, by name, and where they go.
 * @property {{ offset: number } | null} copies   For a program of one instruction that
 *     moves one input component to the first output -- most states an effect
 *     computes, a parameter given as it is -- the component it moves; null otherwise.
 * @property {(values: (constant: Constant) => number[] | null) => number[]} run
 *     The output registers' components, given each input's numbers.
 * @property {readonly Instruction[]} instructions  The program, for whoever runs it elsewhere.
 * @property {readonly number[]} immediates  Its literals, the IMMED table.
 */

/**
 * @typedef {{ opcode: number, arity: number, scalar: boolean, count: number,
 *     inputs: Operand[], output: Operand }} Instruction  an instruction as read: its
 *     opcode (bits 20 to 30 of its first word) and how many inputs it takes
 */

class PreshaderError extends Error {}

/**
 * Reads a preshader: `words` from its version token (an FXLC object's first
 * word, or the first word of a PRES comment's body).
 *
 * @param {Uint32Array} words
 * @returns {Preshader}
 * @throws {PreshaderError} for a program this does not read
 */
export function readPreshader(words){
    /** @param {number} fourcc @returns {Uint32Array | null} the comment's body after its tag */
    const comment = fourcc=>{
        for (let i = 1; i < words.length && (words[i] & 0xffff) === 0xfffe;)
        {
            const size = words[i] >>> 16;
            if (size === 0 || i + 1 + size > words.length)
            {
                break;
            }
            if (words[i + 1] === fourcc)
            {
                return words.subarray(i + 2, i + 1 + size);
            }
            i += 1 + size;
        }
        return null;
    };

    const literals = comment(CLIT);
    /** @type {number[]} */
    const immediates = [];
    if (literals)
    {
        const count = literals[0];
        const doubles = new Float64Array(literals.buffer.slice(literals.byteOffset + 4,
            literals.byteOffset + 4 + count * 8));
        immediates.push(...doubles);
    }

    const table = comment(CTAB);
    const inputs = table ? parseConstantTable(new DataView(table.buffer, table.byteOffset,
        table.byteLength), 0).constants : [];

    const code = comment(FXLC);
    /** @type {(Instruction & { op: { all?: boolean, run: (a: number[], n: number) => number } })[]} */
    const program = [];
    if (code)
    {
        let at = 1;
        /** @returns {number} */
        const next = ()=>{
            if (at >= code.length)
            {
                throw new PreshaderError('the program runs past its comment');
            }
            return code[at++];
        };
        /** @returns {{ table: number, offset: number }} */
        const register = ()=>{
            const t = next();
            if (t < TABLE.IMMED || t > TABLE.TEMP)
            {
                throw new PreshaderError(`register table ${t}`);
            }
            return { table: t, offset: next() };
        };
        /** @returns {Operand} */
        const operand = ()=>{
            const relative = next();
            if (relative > 1)
            {
                throw new PreshaderError(`addressing ${relative}`);
            }
            const index = relative ? register() : null;
            const reg = register();
            return { ...reg, offset: reg.table === TABLE.OBCONST ? reg.offset >>> 2 : reg.offset,
                index };
        };
        for (let n = code[0]; n > 0; n--)
        {
            const raw = next();
            const inputCount = next();
            const op = OPS.get(`${(raw & 0x7ff00000) >>> 20}:${inputCount}`);
            const count = raw & 0xffff;
            if (!op || count < 1 || count > 4)
            {
                throw new PreshaderError(`instruction 0x${(raw >>> 0).toString(16)} of `
                    + `${inputCount} inputs`);
            }
            const ins = Array.from({ length: inputCount }, operand);
            program.push({ op, opcode: (raw & 0x7ff00000) >>> 20, arity: inputCount,
                scalar: (raw & 0x80000000) !== 0, count, inputs: ins, output: operand() });
        }
    }

    const only = program.length === 1 ? program[0] : null;
    const copies = only && only.op === OPS.get('256:1') && only.count === 1
        && only.inputs[0].table === TABLE.CONST && !only.inputs[0].index
        && only.output.table === TABLE.OCONST && only.output.offset === 0
        ? { offset: only.inputs[0].offset } : null;
    return {
        inputs,
        copies,
        instructions: program,
        immediates,
        run: values=>{
            /** @type {number[][]} */
            const tables = [[], immediates.slice(), [], [], [], [], [], []];
            for (const constant of inputs)
            {
                const numbers = values(constant);
                const t = INPUT_TABLE[constant.set];
                if (!numbers || t === undefined)
                {
                    continue;
                }
                const { registers, count } = registerValues(constant, numbers);
                for (let r = 0; r < count; r++)
                {
                    for (let c = 0; c < width(t); c++)
                    {
                        tables[t][(constant.index + r) * width(t) + c] = Math.fround(
                            registers[r * 4 + c]);
                    }
                }
            }
            /** @param {Operand} o @param {number} component */
            const read = (o, component)=>{
                const base = o.index ? Math.round(tables[o.index.table][o.index.offset] ?? 0) : 0;
                return tables[o.table][base * width(o.table) + o.offset + component] ?? 0;
            };
            /** @param {Operand} o @param {number} component @param {number} value */
            const write = (o, component, value)=>{
                tables[o.table][o.offset + component] = o.table === TABLE.IMMED ? value
                    : o.table === TABLE.OICONST ? Math.round(value)
                        : o.table === TABLE.OBCONST ? (value ? 1 : 0) : Math.fround(value);
            };
            for (const { op, scalar, count, inputs: ins, output } of program)
            {
                if (op.all)
                {
                    const args = ins.flatMap((o, k)=>Array.from({ length: count }, (_, j)=>
                        read(o, scalar && k === 0 ? 0 : j)));
                    write(output, 0, op.run(args, count));
                    continue;
                }
                for (let j = 0; j < count; j++)
                {
                    write(output, j, op.run(ins.map((o, k)=>read(o, scalar && k === 0 ? 0 : j)),
                        count));
                }
            }
            return Array.from(tables[TABLE.OCONST], v=>v ?? 0);
        },
    };
}

export { PreshaderError, TABLE };
