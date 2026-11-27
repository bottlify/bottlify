/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C runtime's guest functions called by a 64-bit process with every
 * buffer past 4 GiB, the two ways a call is answered: the committed x86-64
 * on cork's long-mode machine over a wide window, and the JavaScript handler
 * through the bridge's 64-bit trap as the export registers it. A pointer
 * read as its low half names the bytes 4 GiB lower, which hold other text
 * here, so a function that takes one as a `u32` answers wrong and writes
 * there; each case is the answer C says, and the low twin is left as it was.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_64, HIGH_64, callLong, longMachine } from '../../../../scripts/guest-code/long.mjs';
import { longMachine as bridgeMachine } from '../../bridge/internal/long-machine.fixture.js';
import { guestEntry } from './guest-code.js';
import { guestThrough } from './guest-window.fixture.js';
import * as crt from './inguest.js';
import { COMPILED as CRT_X86 } from './inguest.x86.js';
import { COMPILED as CRT_X64 } from './inguest.x64.js';
import * as int64 from './inguest-int64.js';
import { COMPILED as INT64_X86 } from './inguest-int64.x86.js';
import { COMPILED as INT64_X64 } from './inguest-int64.x64.js';
import * as print from './inguest-print.js';
import { COMPILED as PRINT_X86 } from './inguest-print.x86.js';
import { COMPILED as PRINT_X64 } from './inguest-print.x64.js';

/** The buffers, past 4 GiB, and the bytes their low halves name. */
const HIGH = HIGH_64 + 0x200000;
const TWIN = 0x200000;
const SPAN = 0x100;
const HALT = 0x0f00;
const HANDED = 0x0e00;

/** @type {Record<string, { sources: Record<string, any>, i386: Record<string, any>, long: Record<string, any> }>} */
const MODULES = {
    crt: { sources: crt, i386: CRT_X86, long: CRT_X64 },
    int64: { sources: int64, i386: INT64_X86, long: INT64_X64 },
    print: { sources: print, i386: PRINT_X86, long: PRINT_X64 },
};

/**
 * The bytes at HIGH: strings and wide strings at fixed offsets, and a
 * `va_list` of quadwords; the twin is other text of the same lengths.
 */
function layout(){
    const bytes = new Uint8Array(SPAN);
    /** @param {number} at @param {string} text */
    const ansi = (at, text)=>bytes.set([...Buffer.from(`${text}\0`, 'latin1')], at);
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>bytes.set([...Buffer.from(`${text}\0`, 'utf16le')], at);
    ansi(0x00, 'four');
    ansi(0x08, '  -123x');
    ansi(0x10, 'banana');
    ansi(0x18, 'nan');
    ansi(0x1c, 'ab');
    ansi(0x20, 'BANANA');
    wide(0x28, '77');
    wide(0x30, 'Abc');
    ansi(0x38, 'n=%d');
    // 0x40..0x5f: an output buffer of 0xcc; 0x60: *end; 0x70: the va_list.
    bytes.fill(0xcc, 0x40, 0x68);
    new DataView(bytes.buffer).setBigUint64(0x70, 42n, true);
    const twin = Uint8Array.from(bytes, (byte, i)=>(byte === 0 ? 0 : 0x30 + i % 9));
    return { bytes, twin };
}

/**
 * @typedef {Object} Case
 * @property {string} module @property {string} name
 * @property {number[]} args  Whole, as RCX, RDX, R8 and R9 carry them.
 * @property {bigint} rax  What C answers, as RAX holds it.
 * @property {(bytes: Uint8Array) => void} [writes]  What the call stores at HIGH.
 */

/** @type {Case[]} */
const CASES = [
    { module: 'crt', name: 'strlen', args: [HIGH], rax: 4n },
    { module: 'crt', name: 'strtol', args: [HIGH + 0x08, HIGH + 0x60, 10],
        rax: BigInt.asUintN(64, -123n),
        writes: bytes=>new DataView(bytes.buffer).setBigUint64(0x60, BigInt(HIGH + 0x0e), true) },
    { module: 'crt', name: 'strtoul', args: [HIGH + 0x0b, HIGH + 0x60, 0], rax: 123n,
        writes: bytes=>new DataView(bytes.buffer).setBigUint64(0x60, BigInt(HIGH + 0x0e), true) },
    { module: 'crt', name: 'atoi', args: [HIGH + 0x08], rax: BigInt.asUintN(64, -123n) },
    { module: 'crt', name: '_wtoi', args: [HIGH + 0x28], rax: 77n },
    { module: 'crt', name: '_itoa', args: [255, HIGH + 0x40, 16], rax: BigInt(HIGH + 0x40),
        writes: bytes=>bytes.set([0x66, 0x66, 0], 0x40) },
    { module: 'crt', name: '_itow', args: [7, HIGH + 0x40, 10], rax: BigInt(HIGH + 0x40),
        writes: bytes=>bytes.set([0x37, 0, 0, 0], 0x40) },
    { module: 'crt', name: 'strchr', args: [HIGH, 0x75], rax: BigInt(HIGH + 2) },
    { module: 'crt', name: 'strrchr', args: [HIGH + 0x10, 0x61], rax: BigInt(HIGH + 0x15) },
    { module: 'crt', name: 'strstr', args: [HIGH + 0x10, HIGH + 0x18], rax: BigInt(HIGH + 0x12) },
    { module: 'crt', name: 'strspn', args: [HIGH + 0x10, HIGH + 0x1c], rax: 2n },
    { module: 'crt', name: 'strpbrk', args: [HIGH + 0x10, HIGH + 0x18], rax: BigInt(HIGH + 0x11) },
    { module: 'crt', name: 'strcmp', args: [HIGH + 0x10, HIGH + 0x10], rax: 0n },
    { module: 'crt', name: '_stricmp', args: [HIGH + 0x10, HIGH + 0x20], rax: 0n },
    { module: 'crt', name: 'strncmp', args: [HIGH + 0x10, HIGH + 0x18, 1],
        rax: BigInt.asUintN(64, -12n) },
    { module: 'crt', name: 'wcschr', args: [HIGH + 0x30, 0x63], rax: BigInt(HIGH + 0x34) },
    { module: 'crt', name: '_strupr', args: [HIGH + 0x18], rax: BigInt(HIGH + 0x18),
        writes: bytes=>bytes.set([0x4e, 0x41, 0x4e], 0x18) },
    { module: 'crt', name: 'memmove', args: [HIGH + 0x40, HIGH + 0x10, 7],
        rax: BigInt(HIGH + 0x40), writes: bytes=>bytes.set([...Buffer.from('banana\0')], 0x40) },
    { module: 'crt', name: 'strcpy_s', args: [HIGH + 0x40, 3, HIGH + 0x1c], rax: 0n,
        writes: bytes=>bytes.set([0x61, 0x62, 0], 0x40) },
    { module: 'int64', name: '_atoi64', args: [HIGH + 0x08], rax: BigInt.asUintN(64, -123n) },
    { module: 'int64', name: '_i64toa', args: [255, HIGH + 0x40, 8], rax: BigInt(HIGH + 0x40),
        writes: bytes=>bytes.set([0x33, 0x37, 0x37, 0], 0x40) },
    { module: 'print', name: 'vsprintf', args: [HIGH + 0x40, HIGH + 0x38, HIGH + 0x70], rax: 4n,
        writes: bytes=>bytes.set([...Buffer.from('n=42\0')], 0x40) },
];

/** A machine with the case's bytes at HIGH and the twin's 4 GiB lower. */
function machineWith(/** @type {Uint8Array} */ bytes, /** @type {Uint8Array} */ twin){
    const m = longMachine({ window: 2 ** 33 });
    m.write(HALT, [0xf4]);
    m.write(HANDED, [0xf4]);
    m.write(HIGH, bytes);
    m.write(TWIN, twin);
    return m;
}

/**
 * @param {Case} c @param {import('../../../../scripts/guest-code/long.mjs').LongMachine} m
 * @param {Uint8Array} twin @param {string} way @param {bigint} rax
 */
function holds(c, m, twin, way, rax){
    const what = `${c.name} ${way}`;
    const { bytes } = layout();
    c.writes?.(bytes);
    assert.equal(rax, c.rax, `${what}: RAX`);
    assert.deepEqual(Array.from(m.read(HIGH, SPAN)), Array.from(bytes),
        `${what}: memory past 4 GiB`);
    assert.deepEqual(Array.from(m.read(TWIN, SPAN)), Array.from(twin),
        `${what}: the bytes 4 GiB lower left alone`);
}

test('the x86-64 code follows every pointer past 4 GiB', async t=>{
    for (const c of CASES)
    {
        await t.test(c.name, ()=>{
            const fn = MODULES[c.module].long[c.name];
            assert.ok(fn, `${c.name} has x86-64 code`);
            const { bytes, twin } = layout();
            const m = machineWith(bytes, twin);
            const code = fn.code.slice();
            if (fn.host !== undefined)
            {
                new DataView(code.buffer).setUint32(fn.host,
                    (HANDED - (CODE_64 + fn.host + 4)) >>> 0, true);
            }
            m.write(CODE_64, code);
            callLong(m, CODE_64, { args: c.args.map(BigInt), returnTo: HALT });
            assert.equal(m.rip(), HALT + 1, `${c.name}: answered in the guest, not handed over`);
            holds(c, m, twin, 'in the guest', m.reg('rax'));
        });
    }
});

test('the handler, through the 64-bit trap, is given every pointer past 4 GiB whole', async t=>{
    for (const c of CASES)
    {
        await t.test(c.name, ()=>{
            const { sources, i386 } = MODULES[c.module];
            const { bytes, twin } = layout();
            const m = machineWith(bytes, twin);
            // The process's view, as win32's libraries hand it, at its pointer width.
            const view = guestThrough((at, length)=>m.read(at, length),
                (at, data)=>m.write(at, data), 8);
            const [rcx = 0n, rdx = 0n, r8 = 0n, r9 = 0n] = c.args.map(BigInt);
            // The trap's stub keeps RDX in R11.
            const { dispatcher, r } = bridgeMachine({ registers: { rcx, r11: rdx, r8, r9 } });
            // An i64's high half, which win32 hands the bridge for RAX (module.js).
            const setRegisters = (/** @type {Record<string, number>} */ { edx })=>
                dispatcher.answerHigh(edx >>> 0);
            const entry = guestEntry(sources[c.name], i386[c.name], { guest: view, setRegisters },
                { argBytes: 0, handler: ()=>{
                    throw new Error(`${c.name}: handed to the host`);
                } });
            dispatcher.register(1, { name: `msvcrt!${c.name}`, ...entry });
            dispatcher.dispatch(1);
            holds(c, m, twin, 'through the trap', /** @type {bigint} */ (r.get('rax')));
        });
    }
});
