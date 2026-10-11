/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Programs that write their own code, judged on the translator against the
 * interpreter alone.
 *
 * A store into code keeps the regions whose bytes it left as they were and
 * drops the ones made of a byte it changed (`storedInto`); a page rewritten
 * too fast is left to the interpreter for a while and then translated again.
 * Each program here is a loop that patches an instruction inside itself on
 * every turn -- its opcode and its immediate drawn from a small table, so a
 * patch is often the bytes already there and sometimes others -- the way a
 * software mixer turns a voice on and off. Whatever the translator kept,
 * dropped and formed again, every register and the memory must come out as
 * the interpreter leaves them.
 *
 * `CODE_WRITE_PROGRAMS` raises the count, `CODE_WRITE_SEED` names another run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../../core/src/layers/cpu/internal/cork-host.js';
import * as engine from '../index.js';
import { random } from '../testing/sequences.js';

const SEED = Number(process.env.CODE_WRITE_SEED ?? 0x5e1f);
const COUNT = Number(process.env.CODE_WRITE_PROGRAMS ?? 40);

const CODE = 0x10000;
const DATA = 0x20000;
const ENTRY_VECTOR = 0x7000;
/** The ALU forms with an imm32 into eax a patch picks from: mov, add, xor, or, sub. */
const OPCODES = [0xb8, 0x05, 0x35, 0x0d, 0x2d];

/** @param {number} value */
const le32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A loop of `turns` that, each turn, writes the instruction at `site` from
 * entry `ecx & 3` of an opcode table and an immediate table, then runs it.
 *
 * @param {number} turns
 * @returns {number[]}
 */
function program(turns){
    const head = [
        0xb9, ...le32(turns),                       // mov ecx, turns
    ];
    const loop = CODE + head.length;
    const site = loop + 2 + 3 + 6 + 5 + 7 + 6;
    const body = [
        0x89, 0xca,                                 // mov edx, ecx
        0x83, 0xe2, 0x03,                           // and edx, 3
        0x8a, 0x82, ...le32(DATA),                  // mov al, [edx + opcodes]
        0xa2, ...le32(site),                        // mov [site], al
        0x8b, 0x14, 0x95, ...le32(DATA + 0x10),     // mov edx, [edx*4 + immediates]
        0x89, 0x15, ...le32(site + 1),              // mov [site + 1], edx
        0xb8, 0, 0, 0, 0,                           // site: patched
        0x01, 0xc3,                                 // add ebx, eax
        0xc1, 0xc3, 0x03,                           // rol ebx, 3
        0x49,                                       // dec ecx
    ];
    const back = loop - (CODE + head.length + body.length + 6);
    return [...head, ...body, 0x0f, 0x85, ...le32(back >>> 0), 0xf4];
}

/** @param {Record<string, unknown>} cork */
const hostOf = cork=>createCorkHost({
    engine, memorySize: 1 << 20, trapPort: 0x1234, entryVector: ENTRY_VECTOR,
    initialStack: 0x80000, cork,
});

/**
 * @param {ReturnType<typeof hostOf>} host @param {number[]} code @param {number[]} data
 * @param {boolean} translating
 */
async function runOn(host, code, data, translating){
    host.writePhysical(CODE, Uint8Array.from(code));
    host.writePhysical(DATA, Uint8Array.from(data));
    host.writePhysical(ENTRY_VECTOR, Uint8Array.from(le32(CODE)));
    for (let slices = 0; !host.haltedFlag(); slices++)
    {
        if (slices > 100_000)
        {
            throw new Error('the program did not halt');
        }
        host.runSlice(translating ? 2000 : 1 << 20);
        if (translating)
        {
            await host.cork().translatePending();
        }
    }
    return {
        registers: ['eax', 'ebx', 'ecx', 'edx', 'eip'].map(name=>host.readReg32(name) >>> 0),
        code: [...host.readPhysical(CODE, code.length)],
    };
}

test('a program that writes its own code leaves on the translator what it leaves on the'
    + ' interpreter, whatever was kept, dropped and formed again', async()=>{
    const next = random(SEED);
    let kept = 0;
    let dropped = 0;
    let translated = 0;
    for (let index = 0; index < COUNT; index++)
    {
        // Four entries; two kinds of program: entries mostly alike (a patch
        // that rewrites what is there) and entries all drawn (one that changes).
        const alike = next() < 0.5;
        const first = { op: OPCODES[Math.floor(next() * OPCODES.length)],
            imm: Math.floor(next() * 0x100000000) };
        const entries = Array.from({ length: 4 }, ()=>(alike && next() < 0.85 ? first
            : { op: OPCODES[Math.floor(next() * OPCODES.length)],
                imm: Math.floor(next() * 0x100000000) }));
        const data = new Array(0x20).fill(0);
        entries.forEach((entry, at)=>{
            data[at] = entry.op;
            data.splice(0x10 + at * 4, 4, ...le32(entry.imm));
        });
        const code = program(200 + Math.floor(next() * 3000));
        const model = await runOn(hostOf({ translate: false, wasmInterpreter: false }), code,
            data, false);
        const host = hostOf({ hotThreshold: 2 });
        const subject = await runOn(host, code, data, true);
        assert.deepEqual(subject, model, `seed ${SEED} #${index}`
            + ` ${entries.map(entry=>`${entry.op.toString(16)}:${entry.imm.toString(16)}`)}`);
        const d = host.cork().diagnostics();
        kept += d.storesKept;
        dropped += d.invalidations;
        translated += d.translatedShare > 0.1 ? 1 : 0;
    }
    console.log(`code writes: ${COUNT} programs, ${kept} stores kept the code, ${dropped}`
        + ` regions dropped, ${translated} programs translated in part`);
    // Both paths ran: stores that kept code and stores that dropped it. The
    // programs whose patches rewrite what is there run translated -- a tenth
    // of their instructions and more, the rest being each turn's tail after
    // its store's exit, which the interpreter runs to the loop's entry -- and
    // the ones whose patches change the code leave it to the interpreter.
    assert.ok(kept > 0, 'no store kept a region');
    assert.ok(dropped > 0, 'no store dropped a region');
    assert.ok(translated >= COUNT / 8, `only ${translated} of ${COUNT} programs ran translated`);
});
