/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87 at long mode's width is the 32-bit translator's x87: one emitter
 * (`emit/x87.js`), its registers, stack shapes and exits over the 64-bit
 * state block, the runtime keying its regions by the stack's top as at 32
 * bits. Seeded programs of x87 forms whose bytes mean the same in either mode
 * (memory through ebx/rbx and esi/rsi, the stack forms, compares into the
 * flags and the status word, the transcendentals, the control word) run
 * translated in a 32-bit process and in a 64-bit one, and everything the
 * program can see must agree: the held registers, the top, the empty mask, the
 * status and control words, eax, the flags and the data written. The 32-bit
 * translator is itself judged by the instruction model (`sequences-judge.js` in
 * cork), so this is the 64-bit x87 against the model one step removed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from './cork-host.js';
import * as engine from '../../../../../cork/src/index.js';

const ENTRY_VECTOR = 0x7000;
const CODE = 0x11000;
const DATA = 0x20000;

/** Forms whose bytes mean the same in 32-bit and long mode. */
const POOL = [
    'dd4310', 'd94318', 'db6b20', 'db4328', 'df6b30', 'df4338', 'dd5e08', 'd95610', 'db7e18',
    'df7e28', 'db5630', 'db4e34', 'df5e38', 'dc4310', 'd84b18', 'dc6340', 'd87b44', 'da4328',
    'dc5310', 'd85b18', 'd97e40', 'd96b48', 'dd7e44', 'd9e8', 'd9ee', 'd9eb', 'd9ea', 'd9c1',
    'ddd9', 'd9c9', 'd9cb', 'dec1', 'dee1', 'dec9', 'def9', 'd8c2', 'dccb', 'd9e0', 'd9e1',
    'd9fa', 'd9fc', 'd9fd', 'd9f0', 'd9f1', 'd9f8', 'd9e5', 'd9e4', 'dbf1', 'dfe9', 'd8d9',
    'ded9', 'dae9', 'dfe0', 'dac1', 'daca', 'dbd1', 'ddc2', 'd9f7', 'd9f6', 'dbe3', 'dbe2', '9b',
    'd9fe', 'd9ff', 'd9f3', 'd9f2', 'd9f4', 'd9fb', '0f97c0', '0f42ca', '9e', '39c8',
];

/** @param {number} seed */
function random(seed){
    let x = seed >>> 0 || 1;
    return ()=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
}

/**
 * A program of `count` forms run three times by `dec edi; jnz` back to its
 * start (edi no form writes), then `hlt`.
 *
 * @param {number} seed @param {number} count
 */
function program(seed, count){
    const next = random(seed);
    const body = Array.from({ length: count }, ()=>POOL[next() % POOL.length]).join('');
    const length = body.length / 2;
    const back = (256 - (length + 4)) & 0xff;
    return `${body}ffcf75${back.toString(16).padStart(2, '0')}f4`;
}

/**
 * Runs `code` translated in a process of `bits` and answers what it can see.
 *
 * @param {string} code @param {32 | 64} bits @param {Record<string, unknown>} cork
 */
async function run(code, bits, cork){
    const h = createCorkHost({ engine, memorySize: 16 << 20, trapPort: 0x1234,
        entryVector: ENTRY_VECTOR, initialStack: 0x300000, ...bits === 64 ? { bits } : {},
        cork });
    h.writePhysical(CODE, Uint8Array.from(code.match(/../g) ?? [], byte=>parseInt(byte, 16)));
    const next = random(0x87);
    h.writePhysical(DATA, Uint8Array.from({ length: 256 }, ()=>next() & 0xff));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, CODE, true);
    h.writePhysical(ENTRY_VECTOR, vector);
    const registers = /** @type {const} */ ([['ebx', DATA], ['esi', DATA + 0x40], ['edi', 3],
        ['eax', 0x1234], ['ecx', 0x9abc], ['edx', 0x5678]]);
    for (const [name, value] of registers)
    {
        if (bits === 64)
        {
            h.writeReg64(`r${name.slice(1)}`, BigInt(value));
        }
        else
        {
            h.writeReg32(name, value);
        }
    }
    h.cork().noteHot(CODE, 0);
    await h.cork().translatePending();
    for (let slices = 0; slices < 200 && !h.halted(); slices++)
    {
        h.runSlice(100);
        await h.cork().translatePending();
    }
    const x87 = h.x87State();
    return {
        halted: h.halted(),
        // The held registers: an empty one is never read.
        registers: [...x87.registers].map((value, i)=>((x87.empty >>> i & 1) !== 0 ? 'empty'
            : Object.is(value, -0) ? '-0' : String(value))).join(' '),
        top: x87.top, empty: x87.empty, status: x87.status, control: x87.control,
        eax: bits === 64 ? Number(h.readReg64('rax') & 0xffffffffn) : h.readReg32('eax') >>> 0,
        ecx: bits === 64 ? Number(h.readReg64('rcx') & 0xffffffffn) : h.readReg32('ecx') >>> 0,
        flags: h.readReg32('eflags') & 0x8d5,
        data: Buffer.from(h.readPhysical(DATA, 256)).toString('hex'),
        interpreted: h.corkDiagnostics().interpreted,
    };
}

// Outside `precise` the sticky IE, ZE and UE (and the summary they raise) are
// the translator's and the interpreter tier's to leave unraised, as a program
// that reads them runs precise: which of the two runs an instruction is the
// schedule's, not the width's.
const RELAXED = 0x1 | 0x4 | 0x10 | 0x80;

for (const [name, cork] of /** @type {const} */ ([
    ['stack shapes tested at the entry', {}],
    ['every instruction checked', { x87Shapes: false }],
    ['precise', { precise: true }],
]))
{
    test(`x87 programs run translated at 64 bits as at 32, ${name}`, async()=>{
        const failures = [];
        const interpreted = { narrow: 0, wide: 0 };
        for (let seed = 1; seed <= 120; seed++)
        {
            const code = program(seed * 0x9e37, 3 + seed % 12);
            const narrow = await run(code, 32, cork);
            const wide = await run(code, 64, cork);
            if (!('precise' in cork))
            {
                narrow.status &= ~RELAXED;
                wide.status &= ~RELAXED;
            }
            assert.ok(narrow.halted && wide.halted, `program ${seed} ran to its hlt`);
            interpreted.narrow += narrow.interpreted;
            interpreted.wide += wide.interpreted;
            for (const key of /** @type {const} */ (['registers', 'top', 'empty', 'status',
                'control', 'eax', 'ecx', 'flags', 'data']))
            {
                if (narrow[key] !== wide[key])
                {
                    failures.push(`program ${seed} ${code}: ${key} ${wide[key]} at 64 bits,`
                        + ` ${narrow[key]} at 32`);
                }
            }
        }
        assert.deepEqual(failures.slice(0, 10), [], `${failures.length} differences`);
        // Long mode translates its x87 as much as the 32-bit translator does.
        assert.ok(interpreted.wide <= interpreted.narrow * 1.25 + 100, JSON.stringify(interpreted));
    });
}
