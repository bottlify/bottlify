/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The nasm instruction corpus as test data.
 *
 * Each case is a small program assembled by the emulator fork's CI (`.text`
 * at 0x80000, `.bss` and the stack at 0x100000..0x102000), run there on the
 * runner's own processor under a debugger, and recorded: the eight
 * registers, EIP, ST0..7 relative to the top, MM0..7, XMM0..7, the 8 KiB
 * of `.bss`, EFLAGS, the tag and status words -- or the signal the case
 * died with. This module turns the published document into cases, runs one
 * on any host the cpu layer offers, and diffs the outcome against the
 * recording with the same masks and tolerances the fork's own runner uses,
 * so a case that passes here passes there for the same reason.
 *
 * Test support only: nothing in the product reads a corpus.
 */

import { gunzipSync } from 'node:zlib';

/** Where a case keeps its data and stack, and the span the recording holds. */
export const BSS = 0x100000;
export const BSS_SIZE = 0x2000;
/** Where a case's code is linked, and how much room a restore clears for it. */
export const TEXT = 0x80000;
export const TEXT_SIZE = 0x10000;
/** The multiboot header every case carries, unused here but placed. */
export const HEADER = 0x20000;
export const HEADER_SIZE = 0x1000;

/** CF PF AF ZF SF OF, the flags the recording is compared on. */
export const ARITH_MASK = 1 | 1 << 2 | 1 << 4 | 1 << 6 | 1 << 7 | 1 << 11;
/** Status-word bits the fork's runner leaves out of the comparison: 1, 3, 5 and 9. */
export const STATUS_MASK = 0xffff & ~(1 << 9 | 1 << 5 | 1 << 3 | 1 << 1);
/** The tag word of an FPU with every register empty, as the debugger reports it. */
export const TAG_ALL_INVALID = 0xaaaa;
/** How close two x87 values must be to count as equal: the runner's seven digits. */
const FLOAT_EPSILON = 1e-7;

/** Which processor exception a debugger signal stands for. */
const SIGNALS = Object.freeze({
    SIGFPE: 'DE', SIGILL: 'UD', SIGSEGV: 'GP', SIGBUS: 'PF',
});
/** The same, by the vector a fault stub reports. */
export const VECTOR_NAMES = Object.freeze({ 0: 'DE', 6: 'UD', 13: 'GP', 14: 'PF' });

/**
 * @typedef {Object} Fixture
 * @property {'DE' | 'UD' | 'GP' | 'PF' | null} exception
 * @property {Int32Array} reg32
 * @property {number} eip
 * @property {(number | 'invalid')[]} st   ST(0)..ST(7), relative to the top
 * @property {Int32Array} mm               16 words: mm0 low, mm0 high, mm1 low, …
 * @property {Int32Array} xmm              32 words
 * @property {Int32Array} memory           the 8 KiB at BSS as dwords
 * @property {number} eflags
 * @property {number} ftag
 * @property {number} fstat
 */

/**
 * @typedef {Object} CorpusCase
 * @property {string} name
 * @property {{ address: number, bytes: Uint8Array }[]} segments  PT_LOAD, zero-filled to memsz
 * @property {number} entry
 * @property {Fixture} expected
 */

/**
 * The published document, gunzipped and parsed into cases.
 *
 * @param {Uint8Array} packed  the `nasm-corpus.json.gz` bytes
 * @returns {{ commit: string, cases: CorpusCase[] }}
 */
export function loadCorpus(packed){
    const document = JSON.parse(new TextDecoder().decode(gunzipSync(packed)));
    return {
        commit: String(document.commit),
        cases: document.cases.map((
            /** @type {{ name: string, image: string, fixture: string }} */ one)=>{
            const elf = parseElf32(Uint8Array.from(Buffer.from(one.image, 'base64')));
            return {
                name: one.name,
                segments: elf.segments,
                entry: elf.entry,
                expected: parseFixture(one.fixture),
            };
        }),
    };
}

/**
 * The loadable segments and entry of a 32-bit little-endian ELF.
 *
 * @param {Uint8Array} image
 * @returns {{ entry: number, segments: { address: number, bytes: Uint8Array }[] }}
 */
export function parseElf32(image){
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if (image[0] !== 0x7f || image[1] !== 0x45 || image[2] !== 0x4c || image[3] !== 0x46)
    {
        throw new Error('corpus: not an ELF image');
    }
    if (image[4] !== 1 || image[5] !== 1)
    {
        throw new Error('corpus: not a 32-bit little-endian ELF');
    }
    const entry = view.getUint32(0x18, true);
    const headersAt = view.getUint32(0x1c, true);
    const headerSize = view.getUint16(0x2a, true);
    const headerCount = view.getUint16(0x2c, true);
    const segments = [];
    for (let index = 0; index < headerCount; index++)
    {
        const at = headersAt + index * headerSize;
        const type = view.getUint32(at, true);
        if (type !== 1)
        {
            continue;
        }
        const offset = view.getUint32(at + 4, true);
        const address = view.getUint32(at + 8, true);
        const fileSize = view.getUint32(at + 16, true);
        const memorySize = view.getUint32(at + 20, true);
        const bytes = new Uint8Array(memorySize);
        bytes.set(image.subarray(offset, offset + fileSize));
        segments.push({ address, bytes });
    }
    return { entry, segments };
}

/**
 * The recording, parsed the way the fork's runner parses it.
 *
 * @param {string} text
 * @returns {Fixture}
 */
export function parseFixture(text){
    /** @type {Fixture['exception']} */
    let exception = null;
    for (const [signal, name] of Object.entries(SIGNALS))
    {
        if (text.includes(`(signal ${signal})`))
        {
            exception = /** @type {Fixture['exception']} */ (name);
        }
    }
    if (exception === null && text.includes('Program received signal'))
    {
        throw new Error(`corpus: a case was killed by a signal the runner does not map:\n${text}`);
    }
    const match = /---BEGIN JSON---([\s\S]*?)---END JSON---/.exec(text);
    if (!match)
    {
        throw new Error('corpus: no state block in the recording');
    }
    // A debugger prints infinities and NaNs as words JSON has no spelling for.
    // The stand-ins are upper case so the second pass does not find the first
    // pass's "inf" inside its own "-inf".
    const json = match[1]
        .replace(/-inf\b/g, '"-INF"').replace(/\binf\b/g, '"INF"')
        .replace(/-nan\b/g, '"NAN"').replace(/\bnan\b/g, '"NAN"');
    /** @type {(number | string)[]} */
    const array = JSON.parse(json);
    if (array.length !== 8 + 1 + 8 + 16 + 32 + BSS_SIZE / 4 + 3)
    {
        throw new Error(`corpus: a recording of ${array.length} values, not 2116`);
    }
    let at = 0;
    /** @param {number} count */
    const ints = count=>Int32Array.from(array.slice(at, at += count), value=>Number(value) | 0);
    const reg32 = ints(8);
    const eip = Number(array[at++]) >>> 0;
    /** @type {(number | 'invalid')[]} */
    const st = array.slice(at, at += 8).map(value=>{
        if (value === 'invalid')
        {
            return /** @type {'invalid'} */ ('invalid');
        }
        if (value === 'INF')
        {
            return Infinity;
        }
        if (value === '-INF')
        {
            return -Infinity;
        }
        return value === 'NAN' ? NaN : Number(value);
    });
    const mm = ints(16);
    const xmm = ints(32);
    const memory = ints(BSS_SIZE / 4);
    const eflags = Number(array[at++]) >>> 0;
    const ftag = Number(array[at++]) & 0xffff;
    const fstat = Number(array[at++]) & 0xffff;
    return { exception, reg32, eip, st, mm, xmm, memory, eflags, ftag, fstat };
}

/**
 * What a run of a case left behind, in the recording's own shape.
 *
 * @typedef {Object} Outcome
 * @property {{ name: string, eip: number } | null} exception
 * @property {boolean} halted   false when the case ran out of its budget
 * @property {Int32Array} reg32
 * @property {number} eip
 * @property {(number | 'invalid')[]} st
 * @property {number} fstat
 * @property {Int32Array} mm
 * @property {Int32Array} xmm
 * @property {Int32Array} memory
 * @property {number} eflags
 */

/**
 * The host surface a case needs, which the cpu layer's emulator host has.
 *
 * @typedef {Object} CaseHost
 * @property {(name: string) => number} readReg32
 * @property {(address: number, length: number) => Uint8Array} readPhysical
 * @property {(address: number, bytes: Uint8Array) => void} writePhysical
 * @property {(address: number) => number} readU32
 * @property {(index: number) => Uint32Array} readXmm
 * @property {() => import('./snapshot.js').X87State} x87State
 * @property {(handler: (id: number) => void) => void} onTrap
 * @property {() => boolean} halted
 * @property {() => void} wake
 * @property {(instructions: number) => number} step   runs at most that many, answers retired
 */

/**
 * Runs one case on a host that has been put back into its pristine state
 * (registers as after boot, EIP on the ROM's jump into guest code, the
 * case's memory spans cleared) and reads the outcome.
 *
 * @param {CaseHost} host
 * @param {CorpusCase} testCase
 * @param {Object} options
 * @param {number} options.entryVector    where the ROM's jump reads its target
 * @param {number} options.faultTrapBase  the trap id of vector 0
 * @param {(vector: number, esp: number) => number} options.faultEip
 *     the faulting instruction's address, read off the frame the stub found
 * @param {number} [options.budget]       instructions before giving up
 * @returns {Outcome}
 */
export function runCase(host, testCase,
    { entryVector, faultTrapBase, faultEip, budget = 5_000_000 })
{
    for (const { address, bytes } of testCase.segments)
    {
        host.writePhysical(address, bytes);
    }
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, testCase.entry, true);
    host.writePhysical(entryVector, vector);

    /** @type {{ name: string, eip: number } | null} */
    let exception = null;
    host.onTrap(id=>{
        const number = id - faultTrapBase;
        if (number >= 0 && number < 256 && exception === null)
        {
            exception = {
                name: /** @type {Record<number, string>} */ (VECTOR_NAMES)[number] ?? `#${number}`,
                eip: faultEip(number, host.readReg32('esp')),
            };
        }
    });
    host.wake();
    let left = budget;
    while (left > 0 && !host.halted())
    {
        const ran = host.step(Math.min(left, 100_000));
        left -= Math.max(ran, 1);
    }
    host.onTrap(()=>{});

    const x87 = host.x87State();
    // ST(i) by value whether or not the register is held: the recording prints
    // an empty register's contents too (a fresh process holds zeros), and the
    // fork's runner compares them, so an outcome that answered "invalid" for
    // an empty register would diverge on every case that never used the FPU.
    /** @type {(number | 'invalid')[]} */
    const st = [];
    for (let index = 0; index < 8; index++)
    {
        st.push(x87.registers[(x87.top + index) & 7]);
    }
    const rawWords = new Int32Array(x87.raw.buffer, x87.raw.byteOffset, 32);
    const mm = new Int32Array(16);
    for (let index = 0; index < 8; index++)
    {
        mm[index * 2] = rawWords[index * 4];
        mm[index * 2 + 1] = rawWords[index * 4 + 1];
    }
    const xmm = new Int32Array(32);
    for (let index = 0; index < 8; index++)
    {
        xmm.set(Int32Array.from(host.readXmm(index), word=>word | 0), index * 4);
    }
    const bss = Uint8Array.from(host.readPhysical(BSS, BSS_SIZE));
    const reg32 = new Int32Array(8);
    ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'].forEach((name, index)=>{
        reg32[index] = host.readReg32(name) | 0;
    });
    return {
        exception,
        halted: host.halted(),
        reg32,
        eip: host.readReg32('eip') >>> 0,
        st,
        fstat: x87.status,
        mm,
        xmm,
        memory: new Int32Array(bss.buffer, bss.byteOffset, BSS_SIZE / 4),
        eflags: host.readReg32('eflags') >>> 0,
    };
}

/** @param {number} x @param {number} y  the runner's seven-digit comparison */
function floatEqual(x, y){
    if ((x === Infinity && y === Infinity) || (x === -Infinity && y === -Infinity)
        || (Number.isNaN(x) && Number.isNaN(y)))
    {
        return true;
    }
    return Math.abs(x - y) < FLOAT_EPSILON;
}

/**
 * What differs between the recording and an outcome, with the fork's own
 * rules: a case that died compares only the faulting address; otherwise
 * the registers, then either the x87 stack and status (when the tag word
 * says any register is held) or the MMX words (when none is), then XMM,
 * memory and the arithmetic flags.
 *
 * @param {Fixture} expected
 * @param {Outcome} actual
 * @returns {import('./snapshot.js').Divergence[]}
 */
export function diffFixture(expected, actual){
    /** @type {import('./snapshot.js').Divergence[]} */
    const out = [];
    /** @param {string} name @param {number | string} want @param {number | string} got */
    const differ = (name, want, got)=>{
        if (want !== got)
        {
            out.push({ name, expected: want, actual: got });
        }
    };
    if (expected.exception !== null)
    {
        if (actual.exception === null)
        {
            out.push({ name: 'exception', expected: expected.exception, actual: 'none' });
        }
        else
        {
            differ('exception eip', expected.eip, actual.exception.eip);
        }
        return out;
    }
    if (actual.exception !== null)
    {
        out.push({ name: 'exception', expected: 'none',
            actual: `${actual.exception.name} at 0x${actual.exception.eip.toString(16)}` });
        return out;
    }
    if (!actual.halted)
    {
        out.push({ name: 'halted', expected: 'halted', actual: 'still running at the budget' });
    }
    ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'].forEach((name, index)=>{
        differ(name, expected.reg32[index], actual.reg32[index]);
    });
    if (expected.ftag !== TAG_ALL_INVALID)
    {
        for (let index = 0; index < 8; index++)
        {
            const want = expected.st[index];
            const got = actual.st[index];
            if (want === 'invalid')
            {
                continue;
            }
            if (got === 'invalid' || !floatEqual(got, want))
            {
                out.push({ name: `st${index}`, expected: want, actual: got });
            }
        }
        differ('fpu status word', expected.fstat & STATUS_MASK, actual.fstat & STATUS_MASK);
    }
    else
    {
        for (let word = 0; word < 16; word++)
        {
            differ(`mm${word >> 1}.int32[${word & 1}]`, expected.mm[word], actual.mm[word]);
        }
    }
    for (let word = 0; word < 32; word++)
    {
        differ(`xmm${word >> 2}.int32[${word & 3}]`, expected.xmm[word], actual.xmm[word]);
    }
    for (let word = 0; word < BSS_SIZE / 4; word++)
    {
        differ(`mem[0x${(BSS + word * 4).toString(16)}]`,
            expected.memory[word], actual.memory[word]);
    }
    differ('eflags', (expected.eflags & ARITH_MASK) >>> 0, (actual.eflags & ARITH_MASK) >>> 0);
    return out;
}
