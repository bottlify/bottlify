/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from './machine.js';
import { DATA, POOL, bodyOf, random } from './testing/sequences.js';

const CODE = 0x80000;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

test('a loop is translated as it runs, and halts with what the processor computes', async()=>{
    const m = createMachine({ ramSize: 1 << 20 });
    const turns = 100_000;
    // mov ecx, n; L: add eax, ecx; dec ecx; jnz L; hlt
    m.load(0x1000, [0xb9, ...u32(turns), 0x01, 0xc8, 0x49, 0x75, 0xfb, 0xf4]);
    m.setReg('eip', 0x1000);
    const stop = await m.run();
    assert.equal(stop.reason, 'halt');
    assert.equal(stop.retired, 1 + 3 * turns + 1);
    assert.ok(stop.translated > turns, `translated code ran ${stop.translated}`);
    assert.equal(m.reg('eax'), Number(BigInt(turns) * BigInt(turns + 1) / 2n % (1n << 32n)));
    assert.equal(m.reg('ecx'), 0);
    await m.dispose();
});

test('int n stops the run past the instruction, and the caller answers it', async()=>{
    const m = createMachine({ ramSize: 1 << 20 });
    // mov ecx, 1000; L: mov eax, ecx; int 0x80; add edi, eax; dec ecx; jnz L; hlt
    m.load(0x1000, [0xb9, ...u32(1000), 0x89, 0xc8, 0xcd, 0x80, 0x01, 0xc7, 0x49, 0x75, 0xf7,
        0xf4]);
    m.setReg('eip', 0x1000);
    let calls = 0;
    let translated = 0;
    for (;;)
    {
        const stop = await m.run();
        translated += stop.translated;
        if (stop.reason !== 'interrupt')
        {
            assert.equal(stop.reason, 'halt');
            break;
        }
        assert.equal(stop.vector, 0x80);
        assert.equal(m.reg('eip'), 0x1009, 'past the int');
        calls++;
        m.setReg('eax', m.reg('eax') * 2);
    }
    assert.equal(calls, 1000);
    assert.equal(m.reg('edi'), 1000 * 1001);
    assert.ok(translated > 0, 'the loop around the call was translated');
    await m.dispose();
});

test('an exception stops the run at the instruction, translated or interpreted alike', async()=>{
    for (const translate of [true, false])
    {
        const m = createMachine({ ramSize: 1 << 20, config: { translate } });
        // mov ecx, 100000; L: mov eax, 100; xor edx, edx; div ecx; add edi, eax; dec ecx;
        // jns L; hlt -- the last turn divides by zero.
        m.load(0x1000, [0xb9, ...u32(100_000), 0xb8, ...u32(100), 0x31, 0xd2, 0xf7, 0xf1,
            0x01, 0xc7, 0x49, 0x79, 0xf2, 0xf4]);
        m.setReg('eip', 0x1000);
        const stop = await m.run();
        assert.equal(stop.reason, 'fault', `translate ${translate}`);
        assert.equal(stop.vector, 0);
        assert.equal(stop.retired, 1 + 6 * 100_000 + 2, 'the div did not retire');
        assert.equal(m.reg('eip'), 0x100c);
        assert.equal(translate, stop.translated > 0);
        await m.dispose();
    }
});

test('a run stops at the instructions it was allowed and goes on from there', async()=>{
    const m = createMachine({ ramSize: 1 << 20 });
    m.load(0x1000, [0xb9, ...u32(100_000), 0x01, 0xc8, 0x49, 0x75, 0xfb, 0xf4]);
    m.setReg('eip', 0x1000);
    let retired = 0;
    for (;;)
    {
        const stop = await m.run({ maxInstructions: 10_000 });
        retired += stop.retired;
        if (stop.reason === 'halt')
        {
            break;
        }
        assert.equal(stop.reason, 'limit');
        // Translated code takes its budget at back edges and exits: a few past it.
        assert.ok(stop.retired >= 10_000 && stop.retired < 10_100, `${stop.retired}`);
    }
    assert.equal(retired, 300_002);
    await m.dispose();
});

/**
 * What a program can observe of a machine: the stop, the registers, the
 * flags, the x87 and XMM state and the data the pool's forms reach.
 *
 * @param {ReturnType<typeof createMachine>} m @param {import('./machine.js').MachineStop} stop
 */
function observed(m, stop){
    const { layout } = m;
    const view = new DataView(m.memory.buffer);
    const x87 = [];
    const empty = view.getUint8(layout.x87Empty);
    for (let i = 0; i < 8; i++)
    {
        // An empty register's bytes are no part of what a program can read.
        x87.push((empty >>> i & 1) !== 0 ? null : view.getFloat64(layout.x87 + i * 16, true));
    }
    return {
        reason: stop.reason, vector: stop.vector, retired: stop.retired,
        regs: ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags']
            .map(name=>m.reg(name)),
        x87, empty, top: view.getUint8(layout.x87Top) & 7,
        status: view.getUint16(layout.x87Status, true), control: view.getUint16(layout.x87Control,
            true),
        xmm: [...new Uint32Array(m.memory.buffer.slice(layout.xmm, layout.xmm + 128))],
        mxcsr: view.getUint32(layout.mxcsr, true),
        data: [...m.read(DATA, 0x60)],
    };
}

test('gate: seeded loops of the sequence pool leave the same machine translated as'
    + ' interpreted', async()=>{
    const counter = DATA + 0x80;
    let translatedAll = 0;
    let retiredAll = 0;
    for (let seed = 1; seed <= 48; seed++)
    {
        const next = random(seed * 7919);
        const body = bodyOf(next, { shortest: 2, longest: 8 }).flatMap(index=>POOL[index].bytes);
        // L: body; dec dword [counter]; jnz L; hlt -- a counter in memory, so
        // no register the body writes ends the loop early or late.
        const tail = [0xff, 0x0d, ...u32(counter), 0x0f, 0x85];
        const back = -(body.length + tail.length + 4);
        const program = [...body, ...tail, ...u32(back), 0xf4];
        const registers = Array.from({ length: 8 }, ()=>Math.floor(next() * 2 ** 32));
        const data = Array.from({ length: 0x60 }, ()=>Math.floor(next() * 256));
        /** @param {Record<string, unknown>} config */
        const runOn = async config=>{
            const m = createMachine({ ramSize: 4 << 20, config });
            m.load(CODE, program);
            m.load(DATA, data);
            m.load(counter, u32(1000));
            ['eax', 'ecx', 'edx', 'ebx', 'esi', 'edi'].forEach((name, i)=>m.setReg(name,
                registers[i]));
            m.setReg('esp', 0x200000);
            m.setReg('ebp', 0x200000);
            m.setReg('eip', CODE);
            const stop = await m.run({ maxInstructions: 1 << 20 });
            const seen = observed(m, stop);
            await m.dispose();
            return { seen, translated: stop.translated };
        };
        const translated = await runOn({ precise: true });
        const interpreted = await runOn({ translate: false });
        assert.equal(interpreted.translated, 0);
        translatedAll += translated.translated;
        retiredAll += translated.seen.retired;
        assert.deepEqual(translated.seen, interpreted.seen, `seed ${seed}`);
    }
    // Most of the gate's instructions ran down the second path, not the first.
    assert.ok(translatedAll > retiredAll / 2, `translated ${translatedAll} of ${retiredAll}`);
});

test('a return from a host call into x87 code gets an entry: the returns stop leaving'
    + ' translated code', async()=>{
    // L: fld1; call [IAT]; R: fld dword [X]; faddp; fstp dword [Y]; dec ecx; jnz L; hlt
    // and the import: push edx; mov edx, PORT; out dx, eax; pop edx; ret -- a host call
    // through the trap port, as the core's thunks make one.
    const PORT = 0xe9;
    const turns = 3000;
    const F = 0x11000;
    const IAT = 0x12000;
    const X = 0x13000;
    const Y = 0x13010;
    const m = createMachine({ ramSize: 1 << 20, trapPort: PORT });
    const code = [0xb9, ...u32(turns), 0xd9, 0xe8, 0xff, 0x15, ...u32(IAT),
        0xd9, 0x05, ...u32(X), 0xde, 0xc1, 0xd9, 0x1d, ...u32(Y), 0x49, 0x75, 0x00, 0xf4];
    code[code.length - 2] = (0x1005 - (0x1000 + code.length - 1)) & 0xff;
    const R = 0x1000 + 13;
    m.load(0x1000, code);
    m.load(F, [0x52, 0xba, ...u32(PORT), 0xef, 0x5a, 0xc3]);
    m.load(IAT, u32(F));
    m.load(X, u32(0x3f800000));
    m.setReg('esp', 0x80000);
    m.setReg('eip', 0x1000);
    let calls = 0;
    let retired = 0;
    let translated = 0;
    for (;;)
    {
        const stop = await m.run();
        retired += stop.retired;
        translated += stop.translated;
        if (stop.reason !== 'trap')
        {
            assert.equal(stop.reason, 'halt');
            break;
        }
        calls++;
    }
    assert.equal(calls, turns);
    // 1 + 1 = 2 stored as a float every turn.
    assert.equal(new DataView(m.read(Y, 4).buffer).getFloat32(0, true), 2);
    const left = (m.diagnostics().exitsByTarget ?? []).find(one=>one.address === R);
    assert.ok((left?.count ?? 0) < 100, `left for the return ${left?.count} times`);
    assert.ok(translated > retired * 0.9, `translated ${translated} of ${retired}`);
    await m.dispose();
});
