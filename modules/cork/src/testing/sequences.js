/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The sequence corpus's data: a pool of hand-encoded instruction forms, a
 * seeded generator over it, and the minimiser that names a divergence by the
 * shortest sequence still reproducing it.
 *
 * Test support only, like `corpus.js`: nothing in the product reads a pool.
 * The single-instruction corpus judges one instruction at a time against the
 * hardware recording and finds nothing left; this is what
 * `sequences-judge.js` judges *interactions* with -- sequences of two to eight
 * instructions run live on translated code and on the instruction model,
 * which is where a defect one instruction cannot show lives.
 */

/** Where the judged sequence stands, where its preamble runs, and its data. */
export const CODE = 0x80000;
export const SETUP = 0x81000;
export const DATA = 0x100000;
export const DATA_SIZE = 0x60;

/** The qword the x87 and MMX loads read, the qword the MMX store writes, and
 * the 28-byte environment `fnstenv` writes and `fldenv` reads. */
const M0 = DATA;
const M1 = DATA + 8;
const ENV = DATA + 0x20;

/** The memory compared after a run: all of it the pool's operands reach. */
export const SPANS = [{ address: DATA, length: DATA_SIZE }];

/** Every sequence ends in this. */
export const HALT = 0xf4;

/** @param {number} address */
const disp32 = address=>[address & 0xff, address >>> 8 & 0xff,
    address >>> 16 & 0xff, address >>> 24 & 0xff];

/**
 * One hand-encoded form the generator draws from.
 *
 * @typedef {Object} Form
 * @property {string} name    the assembly it encodes, as the report names it
 * @property {number[]} bytes
 */

/** @type {Form[]} */
export const POOL = [
    // --- x87 ---
    { name: 'fld1', bytes: [0xd9, 0xe8] },
    { name: 'fldz', bytes: [0xd9, 0xee] },
    { name: 'fld qword [m]', bytes: [0xdd, 0x05, ...disp32(M0)] },
    { name: 'fstp qword [m]', bytes: [0xdd, 0x1d, ...disp32(M0)] },
    { name: 'fstp st0', bytes: [0xdd, 0xd8] },
    { name: 'faddp', bytes: [0xde, 0xc1] },
    { name: 'fmul st0, st1', bytes: [0xd8, 0xc9] },
    { name: 'fxch st1', bytes: [0xd9, 0xc9] },
    { name: 'fxch st2', bytes: [0xd9, 0xca] },
    { name: 'fcomp', bytes: [0xd8, 0xd9] },
    { name: 'fnstsw ax', bytes: [0xdf, 0xe0] },
    { name: 'fnstenv [m]', bytes: [0xd9, 0x35, ...disp32(ENV)] },
    { name: 'fldenv [m]', bytes: [0xd9, 0x25, ...disp32(ENV)] },
    { name: 'fninit', bytes: [0xdb, 0xe3] },
    { name: 'fnclex', bytes: [0xdb, 0xe2] },
    { name: 'ffree st0', bytes: [0xdd, 0xc0] },
    // --- MMX ---
    { name: 'movq mm0, [m]', bytes: [0x0f, 0x6f, 0x05, ...disp32(M0)] },
    { name: 'movq [m], mm1', bytes: [0x0f, 0x7f, 0x0d, ...disp32(M1)] },
    { name: 'movd mm2, eax', bytes: [0x0f, 0x6e, 0xd0] },
    { name: 'paddw mm0, mm1', bytes: [0x0f, 0xfd, 0xc1] },
    { name: 'pxor mm1, mm1', bytes: [0x0f, 0xef, 0xc9] },
    { name: 'pshufw mm0, mm1, 0x1b', bytes: [0x0f, 0x70, 0xc1, 0x1b] },
    { name: 'emms', bytes: [0x0f, 0x77] },
    // --- SSE forms with an mm operand: the two register classes meet ---
    { name: 'cvtps2pi mm0, xmm0', bytes: [0x0f, 0x2d, 0xc0] },
    { name: 'cvttps2pi mm1, xmm1', bytes: [0x0f, 0x2c, 0xc9] },
    { name: 'cvtpi2ps xmm0, mm0', bytes: [0x0f, 0x2a, 0xc0] },
    { name: 'movq2dq xmm1, mm1', bytes: [0xf3, 0x0f, 0xd6, 0xc9] },
    { name: 'movdq2q mm2, xmm2', bytes: [0xf2, 0x0f, 0xd6, 0xd2] },
    // --- the hardening list: bitwise-not order and the shift matrix ---
    { name: 'andnps xmm0, xmm1', bytes: [0x0f, 0x55, 0xc1] },
    { name: 'andnpd xmm0, xmm1', bytes: [0x66, 0x0f, 0x55, 0xc1] },
    { name: 'pandn mm0, mm1', bytes: [0x0f, 0xdf, 0xc1] },
    { name: 'psrlw mm0, 4', bytes: [0x0f, 0x71, 0xd0, 0x04] },
    { name: 'psraw mm0, 4', bytes: [0x0f, 0x71, 0xe0, 0x04] },
    { name: 'psllw mm0, 4', bytes: [0x0f, 0x71, 0xf0, 0x04] },
    { name: 'psrld mm0, 4', bytes: [0x0f, 0x72, 0xd0, 0x04] },
    { name: 'psrlq mm0, 4', bytes: [0x0f, 0x73, 0xd0, 0x04] },
    { name: 'psrlw xmm0, 4', bytes: [0x66, 0x0f, 0x71, 0xd0, 0x04] },
    { name: 'psrldq xmm0, 4', bytes: [0x66, 0x0f, 0x73, 0xd8, 0x04] },
    // --- scalar forms keep the upper lanes ---
    { name: 'addss xmm0, xmm1', bytes: [0xf3, 0x0f, 0x58, 0xc1] },
    { name: 'addsd xmm0, xmm1', bytes: [0xf2, 0x0f, 0x58, 0xc1] },
    { name: 'mulss xmm0, xmm1', bytes: [0xf3, 0x0f, 0x59, 0xc1] },
    // --- x87: the tag word a non-popping store leaves ---
    { name: 'fst qword [m]', bytes: [0xdd, 0x15, ...disp32(M0)] },
    // --- integer, between them ---
    { name: 'mov eax, 0x0f3a9c11', bytes: [0xb8, 0x11, 0x9c, 0x3a, 0x0f] },
    { name: 'add eax, ebx', bytes: [0x01, 0xd8] },
    { name: 'xor ecx, ecx', bytes: [0x31, 0xc9] },
];

/** The index of a form by its name. @type {Map<string, number>} */
export const BY_NAME = new Map(POOL.map((form, index)=>[form.name, index]));

/**
 * The pool index of a form, named so a test reads as the assembly does.
 *
 * @param {string} name
 * @returns {number}
 */
export function at(name){
    const index = BY_NAME.get(name);
    if (index === undefined)
    {
        throw new Error(`sequences: no form named "${name}"`);
    }
    return index;
}

/**
 * The forms a preamble shapes the x87 stack with, so a sequence is entered
 * with a top and a permutation the region must be compiled for rather than
 * always with the empty stack a fresh processor has.
 */
export const PUSHES = ['fld1', 'fldz', 'fld qword [m]'].map(at);
export const EXCHANGE = at('fxch st1');
/** The one more permutation the widened preamble reaches: a deeper exchange. */
export const EXCHANGE2 = at('fxch st2');

/** The data area's known contents, before any sequence writes it. */
export const DATA_BYTES = (()=>{
    const bytes = new Uint8Array(DATA_SIZE);
    const view = new DataView(bytes.buffer);
    view.setFloat64(M0 - DATA, 3.25, true);
    view.setBigUint64(M1 - DATA, 0x0123456789abcdefn, true);
    // The environment `fldenv` reads before any `fnstenv` wrote it: the
    // default control word, nothing raised, an empty stack -- in the shape
    // `fnstenv` writes, so the two forms round-trip.
    const env = ENV - DATA;
    view.setUint32(env, 0xffff037f, true);
    view.setUint32(env + 4, 0xffff0000, true);
    view.setUint32(env + 8, 0xffffaaaa, true);
    view.setUint32(env + 12, 0xffffffff, true);
    view.setUint32(env + 16, 0xffffffff, true);
    view.setUint32(env + 20, 0xffffffff, true);
    view.setUint32(env + 24, 0xffff0000, true);
    for (let offset = 0x40; offset < DATA_SIZE; offset += 4)
    {
        view.setUint32(offset, (0x5a5a0000 + offset) >>> 0, true);
    }
    return bytes;
})();

/** The SSE registers' known contents: ordinary finite values, so no engine's
 * exception flags are a difference the sequence did not ask for. */
export const XMM = [
    [0x3fc00000, 0xc0100000, 0x40e00000, 0x3f000000],   // 1.5, -2.25, 7, 0.5
    [0x40000000, 0x40400000, 0xc0800000, 0x42c80000],   // 2, 3, -4, 100
    [0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00],
];

/** The registers a sequence starts with. */
export const REGISTERS = { eax: 0x0f3a9c11, ebx: 0x25, ecx: 0x77, esp: 0x300000 };

/**
 * A seeded PRNG (mulberry32): one seed, one run, and a failing sequence named
 * by the seed and its index is a failing sequence anyone can run again.
 *
 * @param {number} seed
 * @returns {() => number}  the next value in [0, 1)
 */
export function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * A sequence's body: `shortest` to `longest` forms drawn from the pool.
 *
 * @param {() => number} next
 * @param {{ shortest?: number, longest?: number, pool?: Form[] }} [given]
 * @returns {number[]}  pool indices
 */
export function bodyOf(next, { shortest = 2, longest = 8, pool = POOL } = {}){
    const length = shortest + Math.floor(next() * (longest - shortest + 1));
    return Array.from({ length }, ()=>Math.floor(next() * pool.length));
}

/**
 * The x87 a sequence is entered with: up to seven pushes, so the entry top is
 * any of 0..7 rather than only 0, 5, 6 and 7 (the deep tops 1 to 4 a sequence
 * used to reach only with its own instructions, inside a region rather than at
 * its entry), and one of two exchanges, so the entry's registers are permuted
 * two ways rather than one. A region is then compiled for every stack depth and
 * more of the slot mappings an entry can have -- the entry key is part of where
 * a defect hides -- and a deep stack overflows on the sequence's own pushes,
 * which is where the C1 an overflow sets is judged.
 *
 * @param {() => number} next
 * @returns {number[]}  pool indices
 */
export function preambleOf(next){
    const pushes = Math.floor(next() * 8);
    const items = Array.from({ length: pushes },
        ()=>PUSHES[Math.floor(next() * PUSHES.length)]);
    if (pushes >= 2)
    {
        const which = next();
        if (which < 0.34)
        {
            items.push(EXCHANGE);
        }
        else if (which < 0.67 && pushes >= 3)
        {
            // st2 needs a third register held to exchange with.
            items.push(EXCHANGE2);
        }
    }
    return items;
}

/**
 * The bytes of a program: the forms named by `indices`, then a halt.
 *
 * @param {number[]} indices  pool indices
 * @param {Form[]} [pool]
 * @returns {Uint8Array}
 */
export function programBytes(indices, pool = POOL){
    const bytes = indices.flatMap(index=>pool[index].bytes);
    return Uint8Array.from([...bytes, HALT]);
}

/** How a report names a sequence. @param {number[]} indices @param {Form[]} [pool] */
export function namesOf(indices, pool = POOL){
    return indices.map(index=>pool[index].name).join('; ');
}

/**
 * The shortest subsequence of `items` that `diverges` still answers true for:
 * items are dropped one at a time, left to right, while what is left still
 * reproduces. A divergence named by two instructions is a cause; one named by
 * eight is a haystack.
 *
 * @template T
 * @param {T[]} items
 * @param {(items: T[]) => boolean | Promise<boolean>} diverges
 * @param {number} [shortest]  the length to stop at
 * @returns {Promise<T[]>}
 */
export async function minimise(items, diverges, shortest = 2){
    let best = [...items];
    while (best.length > shortest)
    {
        /** @type {T[] | null} */
        let shorter = null;
        for (let i = 0; i < best.length; i++)
        {
            const trial = [...best.slice(0, i), ...best.slice(i + 1)];
            if (await diverges(trial))
            {
                shorter = trial;
                break;
            }
        }
        if (shorter === null)
        {
            return best;
        }
        best = shorter;
    }
    return best;
}
