/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program's mathematics costs, in node, and whether the engines agree
 * on its answers: a program runs one kind of operation N times in a loop
 * over 256 doubles (or sixteen matrices and vectors), and the same loop runs
 * with the operation's loads and stores but not the operation; the
 * difference over N is the operation's cost. Each operation is either a
 * call into a library -- msvcrt's maths in its cdecl and `_CI` forms and its
 * number reading, d3dx9's matrices, vectors, quaternions, planes and halves,
 * kernel32's MulDiv and ntdll's 64-bit division -- or the x87's own
 * instructions inline, the ones a compiler emits for the same mathematics,
 * so the cost of the call's way stands beside the cost of the translator's
 * own code.
 *
 *   node tools/math-bench.mjs [N] [--rounds R] [--engine cork|emulator]
 *       [--pc 53|24|both] [--rows REGEX] [--root DIR] [--json]
 *   node tools/math-bench.mjs --check [--pc ...] [--rows ...] [--root DIR]
 *   node tools/math-bench.mjs --compare BEFORE.json AFTER.json
 *
 * The control word is set at the program's start: 0x27f (double precision,
 * a Win32 program's default) or 0x07f (single, as Direct3D leaves it).
 * Every row is timed in each of R rounds, in turn with its loop without the
 * operation, and printed as the median over the rounds and the spread. `N`
 * is the default count; a row that does more in one turn (a matrix, an array
 * of points) scales it down and is reported per element.
 *
 * `--check` runs every row once under cork and once under the emulator and
 * sets their answers side by side -- the loop's last pass over its outputs,
 * which the program writes to its console as hex -- and a digest of each:
 * an operation whose answer is exact must agree to the bit, and one that is
 * not (the transcendentals, which each engine computes with its host's
 * library) is reported with the largest distance between the two in units
 * in the last place.
 *
 * `--root DIR` times the engine of another checkout; `--json` prints the
 * results for `--compare`, which sets two runs side by side.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildExe } from './make-pe.mjs';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/** How many doubles each input and output array holds. */
const SLOTS = 256;
/** How many matrices, vectors and points each d3dx9 array holds. */
const ITEMS = 16;
/** The outputs' bytes the program writes out: the doubles, and three item arrays. */
const DUMPED = SLOTS * 8 + 3 * ITEMS * 64;

/**
 * @typedef {Object} Row
 * @property {string} name
 * @property {Record<string, string[]>} [imports]
 * @property {'double' | 'float' | 'int'} out      What an output slot holds.
 * @property {boolean} exact                        The engines' answers agree to the bit.
 * @property {number} [per]                         Elements one turn computes (default 1).
 * @property {number} [scale]                       N is divided by it for this row.
 * @property {(x: Asm) => number[]} body           One turn, the operation in.
 * @property {(x: Asm) => number[]} base           One turn, the operation out.
 * @property {'any' | 'positive' | 'small' | 'unit'} [domain]  What the inputs are.
 * @property {boolean} [twice]                      The second argument 2 throughout.
 */

/**
 * The addresses a turn's code names: EDI the double slots' byte offset
 * (stepping 8), EBP the items' (stepping 64).
 *
 * @typedef {Object} Asm
 * @property {(name: string) => number} at     A data array's address.
 * @property {(name: string) => number} iat    An import's slot.
 */

/** `fld qword [array + edi]`. @param {number} address */
const fldIn = address=>[0xdd, 0x87, ...u32(address)];
/** `fstp qword [array + edi]`. @param {number} address */
const fstpOut = address=>[0xdd, 0x9f, ...u32(address)];
/** `call [iat]`. @param {number} slot */
const callIat = slot=>[0xff, 0x15, ...u32(slot)];
/** `lea eax, [texts + edi*4]; push eax`: the text of the turn's number. @param {Asm} x */
const pushText = x=>[0x8d, 0x04, 0xbd, ...u32(x.at('texts')), 0x50];
/** `sub esp, 8; fstp qword [esp]`: a double pushed as cdecl passes it. */
const pushDouble = [0x83, 0xec, 0x08, 0xdd, 0x1c, 0x24];
/** `lea eax, [array + ebp]; push eax`. @param {number} address */
const pushItem = address=>[0x8d, 0x85, ...u32(address), 0x50];

/**
 * A cdecl function of doubles in msvcrt: the arguments pushed, the call,
 * the result stored; without it, a result read back from the argument.
 *
 * @param {string} name @param {number} arity @param {boolean} exact
 * @param {Row['domain']} [domain]
 * @returns {Row}
 */
function cdecl(name, arity, exact, domain = 'any'){
    const load = (/** @type {Asm} */ x)=>[
        ...arity === 2 ? [...fldIn(x.at('in2')), ...pushDouble] : [],
        ...fldIn(x.at('in')), ...pushDouble,
    ];
    return {
        name, imports: { 'msvcrt.dll': [name] }, out: 'double', exact, domain,
        body: x=>[...load(x), ...callIat(x.iat(name)), 0x83, 0xc4, arity * 8,
            ...fstpOut(x.at('out'))],
        base: x=>[...load(x), 0xdd, 0x04, 0x24, 0x83, 0xc4, arity * 8, ...fstpOut(x.at('out'))],
    };
}

/**
 * The same function's `_CI` form: the arguments on the x87 stack.
 *
 * @param {string} name @param {number} arity @param {boolean} exact
 * @param {Row['domain']} [domain]
 * @returns {Row}
 */
function intrinsic(name, arity, exact, domain = 'any'){
    const load = (/** @type {Asm} */ x)=>[...fldIn(x.at('in')),
        ...arity === 2 ? fldIn(x.at('in2')) : []];
    return {
        name, imports: { 'msvcrt.dll': [name] }, out: 'double', exact, domain,
        body: x=>[...load(x), ...callIat(x.iat(name)), ...fstpOut(x.at('out'))],
        base: x=>[...load(x), ...arity === 2 ? [0xdd, 0xd8] : [], ...fstpOut(x.at('out'))],
    };
}

/**
 * The x87's instructions inline: `op` on the argument (and a second one
 * pushed after it), one double left.
 *
 * @param {string} name @param {number} arity @param {number[]} op @param {boolean} exact
 * @param {Row['domain']} [domain]
 * @returns {Row}
 */
function inline(name, arity, op, exact, domain = 'any'){
    const load = (/** @type {Asm} */ x)=>[...fldIn(x.at('in')),
        ...arity === 2 ? fldIn(x.at('in2')) : []];
    // Sixteen times the turns: an instruction costs a few nanoseconds, and the
    // difference has to stand clear of a run's start.
    return {
        name, out: 'double', exact, domain, scale: 1 / 16,
        body: x=>[...load(x), ...op, ...fstpOut(x.at('out'))],
        base: x=>[...load(x), ...arity === 2 ? [0xdd, 0xd8] : [], ...fstpOut(x.at('out'))],
    };
}

/**
 * A stdcall d3dx9 function of pointers into the item arrays (`#n` a dword
 * pushed as it is, `+k:` an item array's pointer k bytes on); `first`
 * pushed last. One whose answers involve the x87's transcendentals is not
 * exact: each engine computes those with its host's library.
 *
 * @param {string} name @param {string[]} args  Each array's name, first first.
 * @param {'float'} out @param {number} [per] @param {boolean} [exact]
 * @returns {Row}
 */
function d3dx(name, args, out, per = 1, exact = true){
    const pushes = (/** @type {Asm} */ x)=>[...args].reverse().flatMap(arg=>{
        if (arg.startsWith('#'))
        {
            return [0x68, ...u32(Number(arg.slice(1)))];
        }
        const [, offset, array] = /^(?:\+(\d+):)?(.*)$/.exec(arg) ?? [];
        return pushItem(x.at(array) + Number(offset ?? 0));
    });
    return {
        name, imports: { 'd3dx9_26.dll': [name] }, out, exact, per, scale: 2 * per,
        body: x=>[...pushes(x), ...callIat(x.iat(name))],
        base: x=>[...pushes(x), 0x83, 0xc4, args.length * 4],
    };
}

/** A FLOAT argument as the dword `d3dx` pushes. @param {number} value */
const float = value=>{
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return `#${view.getUint32(0, true)}`;
};

/** fld st0; frndint; fsubr st1, st0... the power of two exp's sequence ends in. */
const EXP2 = [
    0xd9, 0xea, 0xde, 0xc9,             // fldl2e; fmulp: t = x log2 e
    0xd9, 0xc0, 0xd9, 0xfc,             // fld st0; frndint: n
    0xdc, 0xe9, 0xd9, 0xc9,             // fsub st1, st0: t - n; fxch
    0xd9, 0xf0, 0xd9, 0xe8, 0xde, 0xc1, // f2xm1; fld1; faddp
    0xd9, 0xfd, 0xdd, 0xd9,             // fscale; fstp st1
];

/** fxch; fprem until C2 clears (fnstsw ax; test ah, 4; jnz); fstp st1: ST1's rem... */
const FPREM = [0xd9, 0xc9, 0xd9, 0xf8, 0xdf, 0xe0, 0xf6, 0xc4, 0x04, 0x75, 0xf7, 0xdd, 0xd9];

/** @type {Row[]} */
const ROWS = [
    cdecl('sqrt', 1, true, 'positive'),
    cdecl('sin', 1, false, 'small'),
    cdecl('cos', 1, false, 'small'),
    cdecl('atan2', 2, false),
    { ...cdecl('pow', 2, true, 'positive'), name: 'pow(x,2)', twice: true },
    { ...cdecl('pow', 2, false, 'positive'), name: 'pow(x,y)' },
    cdecl('exp', 1, false, 'small'),
    cdecl('log', 1, false, 'positive'),
    cdecl('fmod', 2, true),
    cdecl('floor', 1, true),
    {
        name: '_ftol', imports: { 'msvcrt.dll': ['_ftol'] }, out: 'int', exact: true,
        domain: 'small',
        body: x=>[...fldIn(x.at('in')), ...callIat(x.iat('_ftol')),
            0x89, 0x87, ...u32(x.at('out')), 0x89, 0x97, ...u32(x.at('out') + 4)],
        base: x=>[...fldIn(x.at('in')), 0xdd, 0xd8, 0x89, 0x87, ...u32(x.at('out')),
            0x89, 0x97, ...u32(x.at('out') + 4)],
    },
    {
        // The text of a number a program's configuration holds, a pointer to it pushed.
        name: 'atof', imports: { 'msvcrt.dll': ['atof'] }, out: 'double', exact: true,
        body: x=>[...pushText(x), ...callIat(x.iat('atof')), 0x83, 0xc4, 0x04,
            ...fstpOut(x.at('out'))],
        base: x=>[...pushText(x), 0x58, 0xd9, 0xee, ...fstpOut(x.at('out'))],
    },
    {
        // Seventeen significant digits: past the fast path, the handler's.
        name: 'atof(long)', imports: { 'msvcrt.dll': ['atof'] }, out: 'double', exact: true,
        body: x=>[...pushText(x), ...callIat(x.iat('atof')), 0x83, 0xc4, 0x04,
            ...fstpOut(x.at('out'))],
        base: x=>[...pushText(x), 0x58, 0xd9, 0xee, ...fstpOut(x.at('out'))],
    },
    ...['strtod', 'strtod(long)'].map(name=>/** @type {Row} */ ({
        // The same texts, the end written where a program keeps it.
        name, imports: { 'msvcrt.dll': ['strtod'] }, out: 'double', exact: true,
        body: x=>[0x68, ...u32(x.at('slack')), ...pushText(x), ...callIat(x.iat('strtod')),
            0x83, 0xc4, 0x08, ...fstpOut(x.at('out'))],
        base: x=>[0x68, ...u32(x.at('slack')), ...pushText(x), 0x58, 0x58, 0xd9, 0xee,
            ...fstpOut(x.at('out'))],
    })),
    {
        // _controlfp(_PC_53, _MCW_PC): the precision set, as a program keeps setting it.
        name: '_controlfp', imports: { 'msvcrt.dll': ['_controlfp'] }, out: 'int', exact: true,
        body: x=>[0x68, ...u32(0x30000), 0x68, ...u32(0x10000),
            ...callIat(x.iat('_controlfp')), 0x83, 0xc4, 0x08, 0x89, 0x87, ...u32(x.at('out'))],
        base: x=>[0x68, ...u32(0x30000), 0x68, ...u32(0x10000), 0x83, 0xc4, 0x08,
            0x89, 0x87, ...u32(x.at('out'))],
    },
    {
        name: '_fpclass', imports: { 'msvcrt.dll': ['_fpclass'] }, out: 'int', exact: true,
        body: x=>[...fldIn(x.at('in')), ...pushDouble, ...callIat(x.iat('_fpclass')), 0x83, 0xc4,
            0x08, 0x89, 0x87, ...u32(x.at('out'))],
        base: x=>[...fldIn(x.at('in')), ...pushDouble, 0x83, 0xc4, 0x08,
            0x89, 0x87, ...u32(x.at('out'))],
    },
    {
        // div(1000, 7): the quotient in EAX, the remainder in EDX, both stored.
        name: 'div', imports: { 'msvcrt.dll': ['div'] }, out: 'int', exact: true,
        body: x=>[0x6a, 0x07, 0x68, ...u32(1000), ...callIat(x.iat('div')), 0x83, 0xc4, 0x08,
            0x89, 0x87, ...u32(x.at('out')), 0x89, 0x97, ...u32(x.at('out') + 4)],
        base: x=>[0x6a, 0x07, 0x68, ...u32(1000), 0x83, 0xc4, 0x08,
            0x89, 0x87, ...u32(x.at('out')), 0x89, 0x97, ...u32(x.at('out') + 4)],
    },
    {
        // MulDiv(a double's low word, 7, 3000), stdcall: a scaling a program does per item.
        name: 'MulDiv', imports: { 'KERNEL32.dll': ['MulDiv'] }, out: 'int', exact: true,
        body: x=>[0x68, ...u32(3000), 0x6a, 0x07, 0xff, 0xb7, ...u32(x.at('in')),
            ...callIat(x.iat('MulDiv')), 0x89, 0x87, ...u32(x.at('out'))],
        base: x=>[0x68, ...u32(3000), 0x6a, 0x07, 0xff, 0xb7, ...u32(x.at('in')), 0x83, 0xc4, 0x0c,
            0x89, 0x87, ...u32(x.at('out'))],
    },
    {
        // _alldiv(a double's bits, the high word of another's): a 64-bit value by a
        // divisor of one word, as a program divides a count of ticks; callee pops.
        name: '_alldiv', imports: { 'ntdll.dll': ['_alldiv'] }, out: 'int', exact: true,
        body: x=>[0x6a, 0x00, 0xff, 0xb7, ...u32(x.at('in2') + 4),
            0xff, 0xb7, ...u32(x.at('in') + 4), 0xff, 0xb7, ...u32(x.at('in')),
            ...callIat(x.iat('_alldiv')),
            0x89, 0x87, ...u32(x.at('out')), 0x89, 0x97, ...u32(x.at('out') + 4)],
        base: x=>[0x6a, 0x00, 0xff, 0xb7, ...u32(x.at('in2') + 4),
            0xff, 0xb7, ...u32(x.at('in') + 4), 0xff, 0xb7, ...u32(x.at('in')), 0x83, 0xc4, 0x10,
            0x89, 0x87, ...u32(x.at('out')), 0x89, 0x97, ...u32(x.at('out') + 4)],
    },
    intrinsic('_CIsqrt', 1, true, 'positive'),
    intrinsic('_CIsin', 1, false, 'small'),
    intrinsic('_CIcos', 1, false, 'small'),
    intrinsic('_CIatan2', 2, false),
    intrinsic('_CIpow', 2, false, 'positive'),
    intrinsic('_CIexp', 1, false, 'small'),
    intrinsic('_CIlog', 1, false, 'positive'),
    intrinsic('_CIfmod', 2, true),
    d3dx('D3DXMatrixMultiply', ['mOut', 'mA', 'mB'], 'float'),
    d3dx('D3DXMatrixInverse', ['mOut', 'det', 'mA'], 'float'),
    d3dx('D3DXVec3Transform', ['vOut', 'v', 'mA'], 'float'),
    d3dx('D3DXVec3TransformCoord', ['vOut', 'v', 'mA'], 'float'),
    d3dx('D3DXVec3TransformCoordArray', ['vOut', '#12', 'v', '#12', 'mA', `#${ITEMS}`], 'float',
        ITEMS),
    d3dx('D3DXVec3Normalize', ['vOut', 'v'], 'float'),
    {
        // A float in ST0, stored as a program stores it.
        ...d3dx('D3DXMatrixDeterminant', ['mA'], 'float'),
        body: x=>[...pushItem(x.at('mA')), ...callIat(x.iat('D3DXMatrixDeterminant')),
            0xd9, 0x9d, ...u32(x.at('det'))],
    },
    d3dx('D3DXMatrixRotationYawPitchRoll', ['mOut', float(0.3), float(-1.2), float(2.5)],
        'float', 1, false),
    d3dx('D3DXMatrixPerspectiveFovLH', ['mOut', float(Math.PI / 4), float(4 / 3), float(1),
        float(1000)], 'float', 1, false),
    d3dx('D3DXMatrixLookAtLH', ['mOut', 'v', '+16:v', '+32:v'], 'float'),
    d3dx('D3DXMatrixTransformation', ['mOut', 'v', 'q', '+16:v', '+32:v', '+16:q', '+48:v'],
        'float'),
    d3dx('D3DXMatrixDecompose', ['vOut', '+16:vOut', '+32:vOut', 'mA'], 'float'),
    d3dx('D3DXQuaternionSlerp', ['vOut', 'q', '+16:q', float(0.3)], 'float', 1, false),
    d3dx('D3DXQuaternionSquad', ['vOut', 'q', '+16:q', '+32:q', '+48:q', float(0.7)], 'float', 1,
        false),
    d3dx('D3DXQuaternionRotationMatrix', ['vOut', 'mA'], 'float'),
    d3dx('D3DXPlaneFromPoints', ['vOut', 'v', '+16:v', '+32:v'], 'float'),
    d3dx('D3DXPlaneIntersectLine', ['vOut', 'v', '+16:v', '+32:v'], 'float'),
    d3dx('D3DXVec3Project', ['vOut', 'v', 'viewport', 'mA', 'mB', '+64:mA'], 'float'),
    d3dx('D3DXVec3Unproject', ['vOut', 'v', 'viewport', 'mA', 'mB', '+64:mA'], 'float'),
    d3dx('D3DXFloat32To16Array', ['vOut', 'v', `#${ITEMS * 4}`], 'float', ITEMS * 4),
    inline('fsqrt', 1, [0xd9, 0xfa], true, 'positive'),
    inline('fsin', 1, [0xd9, 0xfe], false, 'small'),
    inline('fcos', 1, [0xd9, 0xff], false, 'small'),
    inline('fsincos', 1, [0xd9, 0xfb, 0xde, 0xc1], false, 'small'),
    inline('fpatan', 2, [0xd9, 0xf3], false),
    inline('fyl2x', 2, [0xd9, 0xc9, 0xd9, 0xf1], false, 'positive'),
    inline('f2xm1+fscale', 1, EXP2, false, 'small'),
    inline('fprem', 2, FPREM, true),
    inline('frndint', 1, [0xd9, 0xfc], true),
    inline('fmul+fadd', 2, [0xd9, 0xc1, 0xde, 0xc9, 0xde, 0xc1], true),
];

/**
 * The inputs: 256 doubles of the row's domain, a fixed sequence.
 *
 * @param {Row['domain']} domain @param {number} seed
 */
function doubles(domain, seed){
    let state = seed >>> 0;
    const next = ()=>{
        state = state + 0x6d2b79f5 >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 2 ** 32;
    };
    const values = new Float64Array(SLOTS);
    for (let i = 0; i < SLOTS; i++)
    {
        const r = next();
        values[i] = domain === 'positive' ? 10 ** (r * 8 - 4)
            : domain === 'small' ? (r - 0.5) * 20
                : domain === 'unit' ? r * 2 - 1
                    : (r - 0.5) * 10 ** (next() * 6 - 2);
    }
    return values;
}

/** Sixteen matrices of floats, each far from singular. @param {number} seed */
function matrices(seed){
    const m = new Float32Array(ITEMS * 16);
    const values = doubles('any', seed);
    for (let i = 0; i < m.length; i++)
    {
        m[i] = values[i % SLOTS] / 64 + (i % 5 === 0 ? 2 : 0);
    }
    return m;
}

/**
 * A number's text in each 32 bytes, one for each double slot: the short
 * decimals a program's configuration holds, or seventeen significant digits.
 *
 * @param {boolean} long
 */
function texts(long){
    const values = doubles('small', 7);
    return [...values].flatMap((value, i)=>{
        const text = long ? value.toPrecision(17)
            : [String(Math.round(value * 100) / 100), `${i % 640}`, `${(i % 9) * 0.25}`,
                `${Math.round(value)}e-${i % 4}`][i % 4];
        return [...text.slice(0, 31)].map(c=>c.charCodeAt(0)).concat(
            new Array(32 - Math.min(text.length, 31)).fill(0));
    });
}

/**
 * Sixteen unit quaternions, each in 64 bytes, and room past the last for
 * the ones a row reads after it.
 *
 * @param {number} seed
 */
function quaternions(seed){
    const q = new Float32Array(ITEMS * 16 + 64);
    const values = doubles('unit', seed);
    for (let i = 0; i < ITEMS + 4; i++)
    {
        const [x, y, z, w] = values.slice(i * 4, i * 4 + 4);
        const length = Math.hypot(x, y, z, w) || 1;
        q.set([x / length, y / length, z / length, w / length], i * 16);
    }
    return q;
}

/**
 * The program: the control word set, N turns of the row's body (or base),
 * then every output written to the console as hex, and exit 0.
 *
 * @param {Row} row @param {number} n @param {boolean} withOp @param {number} control
 */
export function program(row, n, withOp, control){
    const second = row.twice ? new Float64Array(SLOTS).fill(2)
        : doubles(row.name === 'pow(x,y)' || row.name === '_CIpow' ? 'unit' : row.domain, 2);
    const bytes = (/** @type {ArrayBufferView} */ view)=>[...new Uint8Array(view.buffer)];
    // A vector in each 64 bytes, and room past the last for an array of points.
    const vectors = new Float32Array(ITEMS * 16 + 64);
    doubles('small', 5).forEach((value, i)=>{
        vectors[(i >> 2) * 16 + (i & 3)] = value;
        vectors[ITEMS * 16 + (i & 63)] = value;
    });
    // The outputs first and together: the dump writes them as one run.
    /** @type {Record<string, number[]>} */
    const data = {
        apart: new Array(0x1000).fill(0),
        out: new Array(SLOTS * 8).fill(0),
        mOut: new Array(ITEMS * 64).fill(0), vOut: new Array(ITEMS * 64).fill(0),
        det: new Array(ITEMS * 64).fill(0),
        slack: new Array(256).fill(0),
        cw: [...u32(control)],
        in: bytes(doubles(row.domain, 1)), in2: bytes(second),
        mA: bytes(matrices(3)), mB: bytes(matrices(4)), v: bytes(vectors),
        q: bytes(quaternions(6)),
        texts: texts(row.name.endsWith('(long)')),
        viewport: [...[10, 5, 800, 600].flatMap(u32), ...bytes(Float32Array.of(0, 1))],
        hex: new Array(2 * DUMPED).fill(0),
        digits: [...'0123456789abcdef'].map(c=>c.charCodeAt(0)),
        written: [0, 0, 0, 0],
    };
    const imports = {
        ...row.imports,
        'KERNEL32.dll': [...row.imports?.['KERNEL32.dll'] ?? [], 'ExitProcess', 'GetStdHandle',
            'WriteFile'],
    };
    return buildExe({
        imports,
        data,
        codeSize: 0x400,
        code: ({ iat, at })=>{
            const x = { at, iat };
            const turn = [
                ...(withOp ? row.body(x) : row.base(x)),
                0x83, 0xc7, 0x08, 0x81, 0xe7, ...u32(SLOTS * 8 - 8),   // edi: the next double
                0x83, 0xc5, 0x40, 0x81, 0xe5, ...u32(ITEMS * 64 - 64), // ebp: the next item
                0x4e,                                                  // dec esi
            ];
            const loop = [
                0xd9, 0x2d, ...u32(at('cw')),                          // fldcw [cw]
                0xbe, ...u32(n), 0x31, 0xff, 0x31, 0xed,               // esi = N; edi, ebp = 0
                ...turn,
                0x0f, 0x85, ...u32(-(turn.length + 6) >>> 0),          // jnz the turn
            ];
            // Every output as hex, a byte at a time: out, mOut, vOut, det.
            const byte = [
                0x0f, 0xb6, 0x06, 0x89, 0xc2, 0xc1, 0xe8, 0x04,        // movzx eax, [esi]; edx; >>4
                0x83, 0xe2, 0x0f,                                      // and edx, 15
                0x8a, 0x80, ...u32(at('digits')), 0x88, 0x07,          // mov al, digit; [edi]
                0x8a, 0x92, ...u32(at('digits')), 0x88, 0x57, 0x01,    // mov dl, digit; [edi+1]
                0x46, 0x83, 0xc7, 0x02, 0x49,                          // inc esi; edi += 2; dec
            ];
            const dump = [
                0xbe, ...u32(at('out')), 0xbf, ...u32(at('hex')),       // esi, edi
                0xb9, ...u32(DUMPED),                                  // ecx = bytes
                ...byte, 0x75, 0x100 - byte.length - 2,                // jnz the byte
                0x6a, 0x00, 0x68, ...u32(at('written')),               // WriteFile(stdout, hex...)
                0x68, ...u32(2 * DUMPED), 0x68, ...u32(at('hex')),
                0x6a, 0xf5, 0xff, 0x15, ...u32(iat('GetStdHandle')), 0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            return [...loop, ...dump];
        },
    });
}

/**
 * The engine of a checkout: runs a program to its exit and answers the wall
 * time of the run and what it wrote to its console.
 *
 * @param {string} root @param {'cork' | 'emulator'} engine
 */
async function engineOf(root, engine){
    const { createApp } = await import(
        pathToFileURL(join(root, 'modules', 'core', 'src', 'app.js')).href);
    /** @type {Record<string, unknown>} */
    const extra = {};
    if (engine === 'emulator')
    {
        const prebuilt = join(root, 'modules', 'core', 'vendor', 'prebuilt');
        const wasm = await readFile(join(prebuilt, 'v86.wasm'));
        extra.v86 = {
            moduleUrl: pathToFileURL(join(prebuilt, 'libv86.mjs')).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        };
    }
    /** @param {Uint8Array} executable */
    return async executable=>{
        const app = await createApp({ executable, engine, ...extra });
        /** @type {string[]} */
        const output = [];
        app.on('output', (/** @type {any} */ payload)=>output.push(payload.text));
        const started = performance.now();
        const code = await app.run({ timeoutMs: 600000, maxTurns: 1e9 });
        const ms = performance.now() - started;
        const calls = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge')
            ?.metrics?.calls ?? 0;
        await app.dispose();
        if (code !== 0)
        {
            throw new Error(`the program exited ${code}: an import the tree has not?`);
        }
        const text = output.join('');
        const bytes = new Uint8Array(text.length >> 1);
        for (let i = 0; i < bytes.length; i++)
        {
            bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
        }
        return { ms, calls, bytes };
    };
}

/** @param {number[]} values */
function median(values){
    const sorted = [...values].sort((a, b)=>a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** @param {number} control */
const pcName = control=>((control & 0x300) === 0 ? 'PC24' : 'PC53');

/**
 * The distance in units in the last place between two answers of a row, the
 * largest over its outputs: 0 when they are the same bits, Infinity when one
 * is a NaN and the other not.
 *
 * @param {Row} row @param {Uint8Array} left @param {Uint8Array} right
 */
function ulps(row, left, right){
    const a = new DataView(left.buffer, left.byteOffset, left.byteLength);
    const b = new DataView(right.buffer, right.byteOffset, right.byteLength);
    let largest = 0;
    const width = row.out === 'double' ? 8 : 4;
    const [from, to] = row.out === 'float' ? [SLOTS * 8, DUMPED] : [0, SLOTS * 8];
    for (let at = from; at < to; at += width)
    {
        if (row.out === 'int')
        {
            largest = Math.max(largest, a.getUint32(at, true) === b.getUint32(at, true) ? 0
                : Infinity);
            continue;
        }
        const x = width === 8 ? a.getFloat64(at, true) : a.getFloat32(at, true);
        const y = width === 8 ? b.getFloat64(at, true) : b.getFloat32(at, true);
        if (Object.is(x, y) || Number.isNaN(x) && Number.isNaN(y))
        {
            continue;
        }
        if (Number.isNaN(x) || Number.isNaN(y) || Math.sign(x) !== Math.sign(y))
        {
            largest = Infinity;
            continue;
        }
        const i = width === 8 ? a.getBigInt64(at, true) : BigInt(a.getInt32(at, true));
        const j = width === 8 ? b.getBigInt64(at, true) : BigInt(b.getInt32(at, true));
        largest = Math.max(largest, Number(i > j ? i - j : j - i));
    }
    return largest;
}

/** @param {string[]} argv */
function options(argv){
    /** @param {string} flag */
    const value = flag=>{
        const at = argv.indexOf(flag);
        return at >= 0 ? argv[at + 1] : undefined;
    };
    const engine = value('--engine') ?? 'cork';
    if (engine !== 'cork' && engine !== 'emulator')
    {
        throw new Error(`--engine is cork or emulator, not ${engine}`);
    }
    const pc = value('--pc') ?? 'both';
    const flagged = new Set(['--rounds', '--engine', '--root', '--rows', '--pc', '--compare']);
    const positional = argv.filter((arg, i)=>!arg.startsWith('--')
        && !flagged.has(argv[i - 1] ?? ''));
    const pattern = new RegExp(value('--rows') ?? '.');
    return {
        n: Number(positional[0] ?? 1_000_000),
        rounds: Number(value('--rounds') ?? 3),
        engine: /** @type {'cork' | 'emulator'} */ (engine),
        controls: pc === '24' ? [0x07f] : pc === '53' ? [0x27f] : [0x27f, 0x07f],
        rows: ROWS.filter(row=>pattern.test(row.name)),
        root: resolve(value('--root') ?? HERE),
        json: argv.includes('--json'),
        check: argv.includes('--check'),
        compare: argv.includes('--compare')
            ? argv.slice(argv.indexOf('--compare') + 1, argv.indexOf('--compare') + 3) : null,
    };
}

/**
 * @typedef {Object} Result
 * @property {string} row
 * @property {string} pc
 * @property {number[]} ns    An element's cost, each round.
 * @property {number} median
 * @property {number} min
 * @property {number} max
 * @property {number} hostCalls
 * @property {string} digest  The outputs' digest, the last round's.
 */

/** @param {ReturnType<typeof options>} o */
async function measure(o){
    const run = await engineOf(o.root, o.engine);
    // The process's first run pays for compiling the engine; no row should.
    for (const row of o.rows.slice(0, 1))
    {
        await run(program(row, 1000, true, o.controls[0]));
        await run(program(row, 1000, false, o.controls[0]));
    }
    /** @type {Result[]} */
    const results = [];
    for (const row of o.rows)
    {
        for (const control of o.controls)
        {
            const n = Math.max(1, Math.round(o.n / (row.scale ?? 1)));
            const elements = n * (row.per ?? 1);
            /** @type {number[]} */
            const ns = [];
            let hostCalls = 0;
            let digest = '';
            try
            {
                for (let round = 0; round < o.rounds; round++)
                {
                    const loop = await run(program(row, n, false, control));
                    const ops = await run(program(row, n, true, control));
                    ns.push((ops.ms - loop.ms) * 1e6 / elements);
                    hostCalls = ops.calls;
                    digest = createHash('sha256').update(ops.bytes).digest('hex').slice(0, 16);
                }
            }
            catch (e){
                if (!o.json)
                {
                    console.error(`${row.name} ${pcName(control)}: ${/** @type {Error} */ (e)
                        .message}`);
                }
                continue;
            }
            const result = { row: row.name, pc: pcName(control), ns, median: median(ns),
                min: Math.min(...ns), max: Math.max(...ns), hostCalls, digest };
            results.push(result);
            if (!o.json)
            {
                console.error(`${row.name} ${result.pc}: ${result.median.toFixed(1)} ns `
                    + `(${ns.map(v=>v.toFixed(1)).join(', ')}), ${hostCalls} host calls`);
            }
        }
    }
    return { n: o.n, rounds: o.rounds, engine: o.engine, root: o.root, results };
}

/** @param {ReturnType<typeof options>} o */
async function check(o){
    const cork = await engineOf(o.root, 'cork');
    const emulator = await engineOf(o.root, 'emulator');
    const lines = [`${'row'.padEnd(28)} ${'pc'.padEnd(5)} ${'cork'.padEnd(17)} `
        + `${'emulator'.padEnd(17)} agreement`];
    for (const row of o.rows)
    {
        for (const control of o.controls)
        {
            try
            {
                const exe = program(row, 4096, true, control);
                const [a, b] = [(await cork(exe)).bytes, (await emulator(exe)).bytes];
                const digest = (/** @type {Uint8Array} */ bytes)=>createHash('sha256')
                    .update(bytes).digest('hex').slice(0, 16);
                const distance = ulps(row, a, b);
                const verdict = distance === 0 ? 'bit for bit'
                    : `${row.exact ? 'DIFFERS: ' : ''}${distance === Infinity ? 'NaN or sign'
                        : `${distance} ulp`} at most`;
                lines.push(`${row.name.padEnd(28)} ${pcName(control).padEnd(5)} `
                    + `${digest(a).padEnd(17)} ${digest(b).padEnd(17)} ${verdict}`);
            }
            catch (e){
                lines.push(`${row.name.padEnd(28)} ${pcName(control).padEnd(5)} `
                    + `${/** @type {Error} */ (e).message}`);
            }
        }
    }
    return lines.join('\n');
}

/** @param {Result[][]} runs @param {string[]} labels */
function table(runs, labels){
    const keys = [...new Set(runs.flatMap(results=>results.map(r=>`${r.row}\u0000${r.pc}`)))];
    const lines = [[`${'row'.padEnd(28)} pc   `, ...labels.map(label=>`${`${label} ns`
        .padStart(12)} ${'min..max'.padStart(15)} ${'host'.padStart(8)}`)].join('')];
    for (const key of keys)
    {
        const [row, pc] = key.split('\u0000');
        const cells = runs.map(results=>{
            const found = results.find(r=>r.row === row && r.pc === pc);
            return found ? `${found.median.toFixed(1).padStart(12)} `
                + `${`${found.min.toFixed(0)}..${found.max.toFixed(0)}`.padStart(15)} `
                + `${String(found.hostCalls).padStart(8)}` : ''.padStart(37);
        });
        lines.push([`${row.padEnd(28)} ${pc} `, ...cells].join(''));
    }
    return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    const o = options(process.argv.slice(2));
    if (o.compare)
    {
        const runs = await Promise.all(o.compare.map(async path=>
            JSON.parse(await readFile(path, 'utf8')).results));
        console.log(table(runs, ['before', 'after']));
    }
    else if (o.check)
    {
        console.log(await check(o));
    }
    else
    {
        const measured = await measure(o);
        if (o.json)
        {
            console.log(JSON.stringify(measured, null, 2));
        }
        else
        {
            console.log(`N ${o.n}, ${o.rounds} rounds, ${o.engine}; ns an element, the median `
                + 'over the rounds; host: calls into the host in the last run');
            console.log(table([measured.results], ['this']));
        }
    }
}
