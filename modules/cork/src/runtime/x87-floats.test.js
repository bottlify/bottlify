/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 arithmetic on floats under single precision (`floatSingles`): random
 * programs in the shapes float code takes under the precision control
 * Direct3D leaves -- values loaded as floats and held in registers across a
 * loop, sums of products, compares and branches on them, exchanges on one
 * side of a branch, doubles and integers among the floats, stores of every
 * width -- over floats at the edges of the type (the largest, the smallest
 * normal and around it, denormals, zeros, infinities, NaNs), run on the
 * interpreter, translated computing on floats, and translated rounding
 * doubles, each with all its budget and with a budget that ends a slice
 * inside the loop, so regions are entered at every block. The two
 * translations leave the same bits everywhere; with no NaN in the data, the
 * interpreter's too: the data written, the integer registers and the x87
 * block with its eight registers, top, empty mask and status word.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLayout, pagesFor, tablesSize } from './layout.js';
import { createCorkRuntime } from './runtime.js';
import { blockState, interpret } from '../interp.js';

const CODE = 0x401000;
const FLOATS = 0x500000;
const DOUBLES = 0x500100;
const INTEGERS = 0x500180;
const WORDS = 0x5001c0;
const DATA = 0x500400;
const DATA_BYTES = 0x400;
const TABLE = 0x520000;
/** Single precision rounding to nearest, the same truncating, and double precision. */
const CONTROL_WORDS = [0x07f, 0xc7f, 0x27f];

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** @param {number} bits */
const fromBits = bits=>{
    u32[0] = bits;
    return f32[0];
};
/**
 * The floats the programs load: ordinary ones, and the type's edges -- the
 * largest, the smallest normal, the values whose products round to it or
 * just under it (1 - 2^-24 and 1 - 2^-23 times it), denormals, both zeros.
 */
const ORDINARY = [1.5, -2.25, 3, 0.1, 1 / 3, 7, -0.5, 2, 1e-3, 12345.678, -1e5, 0.75];
const EDGES = [fromBits(0x7f7fffff), -fromBits(0x7f7fffff), 2 ** -126, -(2 ** -126),
    1 - 2 ** -24, 1 - 2 ** -23, 2 ** -149, 2 ** -140, 0, -0, 1e30, 1e-30, 2 ** 64, 2 ** -64,
    1.5 * 2 ** -126, 2 ** 127];
const SPECIALS = [Infinity, -Infinity, NaN, fromBits(0x7f800001), fromBits(0xffc00000)];
/** How many floats a program loads from: the edges twice as often as the specials. */
const FLOAT_COUNT = 2 * ORDINARY.length + EDGES.length + SPECIALS.length;
// Kept off a double's denormals and its largest magnitudes, where rounding a double
// differs from the interpreter by design (README: `precise`).
const DOUBLE_VALUES = [0.1, 1.5, -3, 1e-20, 2 ** -130, 1e20, 0.5, 1 / 3];
const INTEGER_VALUES = [3, -100000, 7, 0, 16777217, -1];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program's generator, deterministic from its seed.
 *
 * @param {number} seed
 * @returns {number[]}  the code, placed at CODE
 */
function generate(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    const pick = n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
    let slot = 0;
    const float = ()=>le(FLOATS + pick(FLOAT_COUNT) * 4);
    const written32 = ()=>le(DATA + (slot++ % 64) * 4);
    const written64 = ()=>le(DATA + 0x100 + (slot++ % 64) * 8);
    // A float read back from what the program stored, its own results.
    const stored = ()=>le(DATA + pick(64) * 4);
    const storeStatus = ()=>[0xdf, 0xe0, 0x66, 0xa3, ...le(DATA + 0x300 + (slot++ % 64) * 2)];
    const arithmetic = [0xc0, 0xc8, 0xe0, 0xe8, 0xf0, 0xf8];
    const memoryForm = [0x05, 0x0d, 0x25, 0x2d, 0x35, 0x3d];
    /**
     * Each form: its code at a depth, the depth it needs, what it adds, and how often.
     * @type {[(depth: number) => number[], number, number, number][]}
     */
    const ops = [
        [()=>[0xd9, 0x05, ...float()], 0, 1, 6], // fld dword
        [()=>[0xd9, 0x05, ...stored()], 0, 1, 1], // fld dword, a result
        [()=>[0xdd, 0x05, ...le(DOUBLES + pick(8) * 8)], 0, 1, 1], // fld qword
        [()=>[0xdb, 0x05, ...le(INTEGERS + pick(6) * 4)], 0, 1, 1], // fild dword
        [depth=>[0xd9, 0xc0 + pick(depth)], 1, 1, 2], // fld st(i)
        [()=>[0xd9, pick(2) ? 0xe8 : 0xee], 0, 1, 1], // fld1, fldz
        [()=>[0xd8, memoryForm[pick(6)], ...float()], 1, 0, 6], // fop dword
        [()=>[0xdc, memoryForm[pick(6)], ...le(DOUBLES + pick(8) * 8)], 1, 0, 1], // fop qword
        [()=>[0xda, pick(2) ? 0x05 : 0x0d, ...le(INTEGERS + pick(6) * 4)], 1, 0, 1], // fiadd, fimul
        [depth=>[0xd8, arithmetic[pick(6)] + pick(depth)], 1, 0, 4], // fop st0, st(i)
        [depth=>[0xdc, arithmetic[pick(6)] + pick(depth)], 1, 0, 3], // fop st(i), st0
        [depth=>[0xde, arithmetic[pick(6)] + 1 + pick(depth - 1)], 2, -1, 4], // fopp st(i), st0
        [()=>[0xd9, [0xe0, 0xe1, 0xfa][pick(3)]], 1, 0, 2], // fchs, fabs, fsqrt
        [()=>[0xd9, 0xfc], 1, 0, 1], // frndint
        [()=>[0xd9, 0x15, ...written32()], 1, 0, 2], // fst dword
        [()=>[0xd9, 0x1d, ...written32()], 1, -1, 2], // fstp dword
        [()=>[0xdd, 0x15, ...written64()], 1, 0, 1], // fst qword
        [()=>[0xdd, 0x1d, ...written64()], 1, -1, 1], // fstp qword
        [depth=>[0xdd, 0xd0 + pick(depth)], 1, 0, 1], // fst st(i)
        [depth=>[0xdd, 0xd8 + pick(depth)], 1, -1, 1], // fstp st(i)
        [()=>[0xdb, 0x1d, ...written32()], 1, -1, 1], // fistp dword
        [depth=>[0xd8, 0xd0 + pick(depth), ...storeStatus()], 1, 0, 1], // fcom st(i)
        [()=>[0xd8, 0x1d, ...float(), ...storeStatus()], 1, -1, 1], // fcomp dword
        [()=>[0xde, 0xd9, ...storeStatus()], 2, -2, 1], // fcompp
        [()=>[0xd9, pick(2) ? 0xe4 : 0xe5, ...storeStatus()], 1, 0, 1], // ftst, fxam
        [depth=>[0xd9, 0xc9 + pick(depth - 1)], 2, 0, 3], // fxch st(i)
        // fldcw: single mostly, truncating or double now and then
        [()=>[0xd9, 0x2d, ...le(WORDS + (pick(8) < 6 ? 0 : 2 + pick(2) * 2))], 0, 0, 1],
    ];
    const weights = ops.reduce((sum, [, , , weight])=>sum + weight, 0);
    /** @param {number} depth */
    const one = depth=>{
        for (;;)
        {
            let at = pick(weights);
            const [emit, needs, adds] = /** @type {typeof ops[number]} */ (ops.find(op=>
                (at -= op[3]) < 0));
            const after = depth + adds;
            if (depth >= needs && after >= 0 && after <= 7 && (adds <= 0 || depth < 7))
            {
                return { code: emit(depth), depth: after };
            }
        }
    };
    /** @param {number} depth @param {number} count */
    const straight = (depth, count)=>{
        /** @type {number[]} */
        const code = [];
        for (let i = 0; i < count; i++)
        {
            const next = one(depth);
            code.push(...next.code);
            depth = next.depth;
        }
        return { code, depth };
    };
    /** Code that brings the stack from one depth to another. @param {number} from @param {number} to */
    const settle = (from, to)=>{
        /** @type {number[]} */
        const code = [];
        for (; from > to; from--)
        {
            code.push(0xd9, 0x1d, ...written32());
        }
        for (; from < to; from++)
        {
            code.push(0xd9, 0x05, ...float());
        }
        return code;
    };
    // A compare of ST0 with another register and a branch over a stretch that leaves the
    // stack as deep as it found it, an exchange often at its end: the stretch's way and
    // the branch's meet with the registers in different locals.
    /** @param {number} depth */
    const compareBranch = depth=>{
        const inner = straight(depth, 1 + pick(4));
        const body = [...inner.code, ...settle(inner.depth, depth)];
        if (depth >= 2 && pick(2))
        {
            body.push(0xd9, 0xc9 + pick(depth - 1));
        }
        const compare = pick(3) === 0 ? [0xdb, 0xe8 + pick(depth)] : [0xdb, 0xf0 + pick(depth)];
        return [...compare, [0x76, 0x77, 0x7a, 0x7b, 0x72, 0x73][pick(6)], body.length, ...body];
    };
    // Floats held in registers across the loop, as a transform's matrix is.
    const held = 1 + pick(4);
    const code = [...settle(0, held), 0xb9, ...le(2 + pick(20))];
    const loop = [];
    let depth = held;
    for (let part = 2 + pick(5); part > 0; part--)
    {
        if (pick(3) === 0 && depth >= 1 && loop.length < 80)
        {
            loop.push(...compareBranch(depth));
            continue;
        }
        const next = straight(depth, 1 + pick(6));
        loop.push(...next.code);
        depth = next.depth;
    }
    loop.push(...settle(depth, held), 0x49);
    code.push(...loop, 0x0f, 0x85, ...le(-(loop.length + 6)));
    // Every register stored, the status word with them.
    for (let k = 0; k < held; k++)
    {
        code.push(0xdd, 0x1d, ...le(DATA + 0x380 + k * 8));
    }
    code.push(0xdf, 0xe0, 0x66, 0xa3, ...le(DATA + 0x3fc), 0xf4);
    return code;
}

/**
 * What a program is run with: the floats it loads, the doubles, and how many bytes of
 * results from DATA on it leaves.
 *
 * @typedef {{ floats: number[], doubles?: number[], pairs?: number[][], size?: number }} Setup
 */

/** @param {boolean} specials  NaNs and infinities among the floats @returns {Setup} */
const generated = specials=>({
    floats: [...ORDINARY, ...EDGES, ...ORDINARY, ...specials ? SPECIALS : EDGES.slice(0, 5)],
});

/**
 * Lays a program and its data into a fresh memory.
 *
 * @param {number[]} code @param {Setup} setup
 */
function machine(code, { floats, doubles = DOUBLE_VALUES, pairs = [] }){
    const layout = ownLayout({ ramSize: 16 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const view = new DataView(memory.buffer);
    view.setUint8(layout.x87Empty, 0xff);
    view.setUint16(layout.x87Control, CONTROL_WORDS[0], true);
    new Uint8Array(memory.buffer).set(code, layout.ramBase + CODE);
    floats.forEach((value, i)=>view.setFloat32(layout.ramBase + FLOATS + i * 4, value, true));
    doubles.forEach((value, i)=>view.setFloat64(layout.ramBase + DOUBLES + i * 8, value, true));
    pairs.flat().forEach((value, i)=>view.setFloat32(layout.ramBase + TABLE + i * 4, value, true));
    INTEGER_VALUES.forEach((value, i)=>view.setInt32(layout.ramBase + INTEGERS + i * 4, value,
        true));
    CONTROL_WORDS.forEach((word, i)=>view.setUint16(layout.ramBase + WORDS + i * 2, word, true));
    view.setUint32(layout.regs + 16, 0x800000, true);
    view.setUint32(layout.eip, CODE, true);
    return { layout, memory, view, size: DATA_BYTES };
}

/**
 * What a run leaves that a program can read: the data written, the integer
 * registers, the x87 registers, top, empty mask, control and status words.
 *
 * @param {ReturnType<typeof machine>} m
 */
function observed({ layout, memory, size }){
    const bytes = new Uint8Array(memory.buffer);
    return {
        data: bytes.slice(layout.ramBase + DATA, layout.ramBase + DATA + size),
        registers: bytes.slice(layout.regs, layout.regs + 32),
        x87: bytes.slice(layout.x87, layout.x87 + 64),
        top: bytes[layout.x87Top],
        empty: bytes[layout.x87Empty],
        control: new DataView(memory.buffer).getUint16(layout.x87Control, true),
        status: new DataView(memory.buffer).getUint16(layout.x87Status, true),
    };
}

/**
 * An observation as fast code is held to it (README: `precise`): the status
 * word's bits it does not keep -- the exception flags, the stack fault, the
 * summary and busy bits, C1 -- cleared wherever the word went (the field, ax,
 * the words the program stored), and a NaN's bits, which are the host's,
 * made one NaN in the floats and doubles of the data and in the registers.
 * A region that leaves for the host has it run the operation exactly, so the
 * runs on floats raise flags and pick NaNs the runs on doubles do not.
 *
 * @param {ReturnType<typeof observed>} o
 * @param {{ floats?: [number, number][], doubles?: [number, number][],
 *     words?: number[] }} where  byte ranges of the data, and its status words
 */
function comparable(o, { floats = [], doubles = [], words = [] }){
    const KEPT = 0x7d00;
    const data = o.data.slice();
    const view = new DataView(data.buffer);
    for (const at of words)
    {
        view.setUint16(at, view.getUint16(at, true) & KEPT, true);
    }
    for (const [from, to] of floats)
    {
        for (let at = from; at < to; at += 4)
        {
            if (Number.isNaN(view.getFloat32(at, true)))
            {
                view.setUint32(at, 0x7fc00000, true);
            }
        }
    }
    const x87 = o.x87.slice();
    /** @param {DataView} doubleView @param {number} from @param {number} to */
    const oneNaN = (doubleView, from, to)=>{
        for (let at = from; at < to; at += 8)
        {
            if (Number.isNaN(doubleView.getFloat64(at, true)))
            {
                doubleView.setBigUint64(at, 0x7ff8000000000000n, true);
            }
        }
    };
    for (const [from, to] of doubles)
    {
        oneNaN(view, from, to);
    }
    oneNaN(new DataView(x87.buffer), 0, x87.length);
    const registers = o.registers.slice();
    const ax = new DataView(registers.buffer);
    ax.setUint16(0, ax.getUint16(0, true) & KEPT, true);
    return { ...o, data, x87, registers, status: o.status & KEPT };
}

/** Where the generated programs keep floats, doubles and status words in the data. */
const GENERATED = {
    floats: /** @type {[number, number][]} */ ([[0, 0x100]]),
    doubles: /** @type {[number, number][]} */ ([[0x100, 0x300], [0x380, 0x3c0]]),
    words: [...Array.from({ length: 64 }, (_, k)=>0x300 + k * 2), 0x3fc],
};

/**
 * Where two runs' observations differ, a field or byte offset at a time.
 *
 * @param {ReturnType<typeof observed>} a @param {ReturnType<typeof observed>} b
 */
function differences(a, b){
    /** @type {string[]} */
    const found = [];
    for (const key of /** @type {(keyof typeof a)[]} */ (Object.keys(a)))
    {
        const [x, y] = [a[key], b[key]];
        if (typeof x === 'number' || typeof y === 'number')
        {
            if (x !== y)
            {
                found.push(`${key} ${x.toString(16)} != ${y.toString(16)}`);
            }
            continue;
        }
        for (let i = 0; i < x.length; i += 4)
        {
            const [u, v] = [x.slice(i, i + 4), y.slice(i, i + 4)];
            if (u.some((byte, k)=>byte !== v[k]))
            {
                const word = (/** @type {Uint8Array} */ w)=>new DataView(w.buffer, w.byteOffset)
                    .getUint32(0, true).toString(16);
                found.push(`${key}+${i.toString(16)} ${word(u)} != ${word(v)}`);
            }
        }
    }
    return found.slice(0, 8).join('; ');
}

/** @param {number[]} code @param {Setup} setup */
function interpreted(code, setup){
    const m = { ...machine(code, setup), size: setup.size ?? DATA_BYTES };
    const state = blockState({ memory: m.memory, layout: m.layout });
    state.syncIn();
    interpret(state, 1_000_000);
    state.syncOut();
    assert.ok(state.halted, 'the program halts');
    return observed(m);
}

/**
 * Runs a program to its `hlt`, translated where a region can be made.
 *
 * @param {number[]} code @param {Setup} setup @param {number} budget
 * @param {Record<string, unknown>} config
 * @param {(diagnostics: any) => void} [done]  told the runtime's diagnostics at the `hlt`
 */
async function translated(code, setup, budget, config, done){
    const m = { ...machine(code, setup), size: setup.size ?? DATA_BYTES };
    const { layout, memory, view } = m;
    const runtime = createCorkRuntime({
        memory, layout, config: { leafCalls: false, ...config },
        read: address=>new Uint8Array(memory.buffer)[layout.ramBase + address],
        imports: { trap: ()=>0, getEflags: ()=>view.getUint32(layout.eflags, true),
            x87Read: ()=>0, rdtsc: ()=>0n },
    });
    const eip = ()=>view.getUint32(layout.eip, true);
    // As the host runs: after a region left before an operation for the host to run it
    // (`RANGE` and its kin) the interpreter goes on to the next address that has an entry,
    // and only an address it keeps reaching without one becomes a region of its own; a
    // jump out of a region is to code that becomes one.
    let interpreting = 0;
    for (let turn = 0; ; turn++)
    {
        assert.ok(turn < 1_000_000, 'the program halts');
        const top = view.getUint8(layout.x87Top);
        if (runtime.entryOf(eip(), top) < 0 && interpreting === 0)
        {
            runtime.noteHot(eip(), top);
            await runtime.translatePending();
        }
        const entry = runtime.entryOf(eip(), top);
        if (entry < 0)
        {
            const state = blockState({ memory, layout });
            state.syncIn();
            interpret(state, 1, { force: true });
            state.syncOut();
            if (state.halted)
            {
                break;
            }
            interpreting = Math.max(0, interpreting - 1);
            continue;
        }
        const exit = runtime.run(entry, budget);
        if (exit.kind === 'halt')
        {
            break;
        }
        interpreting = exit.kind === 'untranslated' && exit.vector !== 0 ? 64 : 0;
    }
    done?.(runtime.diagnostics());
    return observed(m);
}

test('x87 arithmetic on floats under single precision leaves what rounding doubles leaves,'
    + ' and what the interpreter leaves', async()=>{
    const seen = { programs: 0, narrow: 0, range: 0, floatMisses: 0, floatsRounded: 0 };
    for (let seed = 1; seed <= 160; seed++)
    {
        const code = generate(seed * 7919);
        const specials = seed % 4 === 0;
        const setup = generated(specials);
        const expected = specials ? null : interpreted(code, setup);
        for (const budget of [10_000_000, 61])
        {
            const label = `seed ${seed}, budget ${budget}`;
            const doubles = await translated(code, setup, budget, { floatSingles: false });
            const floats = await translated(code, setup, budget, {}, diagnostics=>{
                seen.narrow += diagnostics.precision.narrow;
                seen.range += diagnostics.untranslatedBy?.range ?? 0;
                seen.floatMisses += diagnostics.floatMisses;
                seen.floatsRounded += diagnostics.floatsRounded;
            });
            assert.equal(differences(comparable(floats, GENERATED), comparable(doubles, GENERATED)),
                '', `${label}: on floats as rounding doubles`);
            if (expected !== null)
            {
                assert.equal(differences(comparable(floats, GENERATED),
                    comparable(expected, GENERATED)), '', `${label}: as the interpreter`);
            }
            seen.programs++;
        }
    }
    console.log(`x87 floats: ${JSON.stringify(seen)}`);
    assert.ok(seen.narrow > seen.programs, 'regions compiled for single precision');
    assert.ok(seen.floatMisses > 0, 'some float result left for the host');
    assert.ok(seen.floatsRounded > 0, 'some region translated again rounding doubles');
});

test('each operation on every pair of floats at the type\'s edges is the processor\'s 24-bit'
    + ' result, or leaves for the host', async()=>{
    // A loop a form over a table of every pair: fld dword [esi]; fop dword [esi+4] -- or
    // through the registers, fld dword [esi+4]; fld dword [esi]; fop st0, st1; fstp st1 --
    // fstp qword [edi]. The products that round to the smallest normal or under it, sums
    // past the largest, zeros of both signs, infinities and NaNs; the region never
    // translated again for its misses, so every pair takes the float path.
    const values = [...EDGES, 1.5, -3, 0.1, ...SPECIALS];
    const pairs = values.flatMap(a=>values.map(c=>[a, c]));
    /** @type {number[]} */
    const code = [];
    const forms = [0x05, 0x0d, 0x25, 0x2d, 0x35, 0x3d];
    let loops = 0;
    for (const throughRegisters of [false, true])
    {
        for (const form of forms)
        {
            const body = throughRegisters
                ? [0xd9, 0x46, 0x04, 0xd9, 0x06, 0xd8, 0xc1 + form - 0x05, 0xdd, 0xd9]
                : [0xd9, 0x06, 0xd8, form - 0x05 + 0x46, 0x04];
            // mov esi, TABLE; mov edi, out; mov ecx, pairs
            code.push(0xbe, ...le(TABLE), 0xbf, ...le(DATA + loops * pairs.length * 8),
                0xb9, ...le(pairs.length));
            const loop = [...body, 0xdd, 0x1f, 0x83, 0xc6, 0x08, 0x83, 0xc7, 0x08, 0x49];
            code.push(...loop, 0x75, -(loop.length + 2) & 0xff);
            loops++;
        }
    }
    code.push(0xf4);
    const size = loops * pairs.length * 8;
    const setup = { floats: [], pairs, size };
    const where = { doubles: /** @type {[number, number][]} */ ([[0, size]]) };
    const expected = interpreted(code, setup);
    const config = { checkedAfter: 1e9 };
    const doubles = await translated(code, setup, 10_000_000, { ...config, floatSingles: false });
    let misses = 0;
    const floats = await translated(code, setup, 10_000_000, config, diagnostics=>{
        misses = diagnostics.floatMisses;
    });
    assert.equal(differences(comparable(floats, where), comparable(doubles, where)), '',
        'on floats as rounding doubles');
    assert.equal(differences(comparable(floats, where), comparable(expected, where)), '',
        'as the interpreter');
    assert.ok(misses > loops * pairs.length / 10, `results past a float's range left: ${misses}`);
});

test('an entry into a block taking a float in leaves for the host when the register holds a'
    + ' double that is not one', async()=>{
    // fld qword [x]; mov ecx, 12; mov edi, DATA; mov eax, L; jmp eax
    // L: fadd dword [2^-30]; fst qword [edi]; add edi, 8; dec ecx; jnz L; hlt
    // L's register is a float on the loop's own edge, so L takes it in as one; the jump
    // into the loop's region from outside brings 1 + 2^-24, which the float would hold as
    // 1: plus 2^-30 that is 1, where the processor rounds the double's sum up.
    const tiny = EDGES.length;
    const loop = [0xd8, 0x05, ...le(FLOATS + tiny * 4), 0xdd, 0x17, 0x83, 0xc7, 0x08, 0x49];
    const at = CODE + 23;
    const code = [0xdd, 0x05, ...le(DOUBLES), 0xb9, ...le(12), 0xbf, ...le(DATA),
        0xb8, ...le(at), 0xff, 0xe0, ...loop, 0x75, -(loop.length + 2) & 0xff, 0xf4];
    assert.equal(code.length - loop.length - 3, at - CODE);
    for (const start of [1 + 2 ** -24, 1.5])
    {
        const setup = { floats: [...EDGES, 2 ** -30], doubles: [start], size: 12 * 8 };
        const expected = interpreted(code, setup);
        assert.equal(new DataView(expected.data.buffer).getFloat64(0, true),
            start === 1.5 ? 1.5 : 1 + 2 ** -23, 'the processor rounds the sum up');
        for (const budget of [10_000_000, 13])
        {
            let rounded = 0;
            const floats = await translated(code, setup, budget, {}, diagnostics=>{
                rounded = diagnostics.floatsRounded;
            });
            assert.equal(differences(floats, expected), '', `${start}, budget ${budget}`);
            assert.equal(rounded > 0, start !== 1.5, `${start}: translated again rounding`);
        }
    }
});
