/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A call through a method table to an incremental linker's thunk to an empty method -- the
 * bytes of one an engine's virtual calls spend an eighth of their thread's time in -- run
 * interpreted, translated with the call entering the thunk's region (`emptyCalls` off),
 * returned from in the transfer (`emptyCalls`), and returned from at the call
 * (`emptySites`): the registers, the flags, `esp` and the slot the call pushed into come
 * out the same, and the runs that should take the short ways do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const MAIN = 0x1000;
const OBJECT = 0x80000;
const TABLE = 0x80100;
const STACK = 0xf0000;
// Engine.dll+0x3f9b3, `jmp 0x30477690`, and its target, `ret`, 0x30000000 lower: the jump is
// relative, so the bytes are the ones in the image.
const THUNK = 0x3f9b3;
const BODY = 0x477690;
const TURNS = 600;

/** @param {number} value */
const le32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];

// mov edi, TURNS
// L: mov ecx, OBJECT; mov eax, [ecx]; cmp edi, 7; call [eax+8]
//    mov esi, [esp-4]; add ebp, esi      -- the slot the call pushed into
//    pushfd; pop edx; and edx, 0x8d5; add ebx, edx   -- the flags the call left
//    dec edi; jnz L; hlt
const loop = [0xb9, ...le32(OBJECT), 0x8b, 0x01, 0x83, 0xff, 0x07, 0xff, 0x50, 0x08,
    0x8b, 0x74, 0x24, 0xfc, 0x01, 0xf5,
    0x9c, 0x5a, 0x81, 0xe2, ...le32(0x8d5), 0x01, 0xd3, 0x4f];
const MAIN_CODE = [0xbf, ...le32(TURNS), ...loop, 0x75, (-(loop.length + 2)) & 0xff, 0xf4];
const RETURN_ADDRESS = MAIN + 5 + 13;

/** @param {Record<string, unknown>} config */
async function run(config){
    const m = createMachine({ ramSize: 8 << 20,
        config: { hashSlots: 1 << 12, hotThreshold: 2, blockProfile: true, ...config } });
    try
    {
        m.load(MAIN, MAIN_CODE);
        m.load(OBJECT, le32(TABLE));
        m.load(TABLE + 8, le32(THUNK));
        m.load(THUNK, [0xe9, 0xd8, 0x7c, 0x43, 0x00]);
        m.load(BODY, [0xc3]);
        m.setReg('esp', STACK);
        m.setReg('eip', MAIN);
        const stop = await m.run({ maxInstructions: 1_000_000 });
        const mechanisms = /** @type {Record<string, number>} */ (m.diagnostics().mechanisms ?? {});
        return {
            observed: {
                stop: stop.reason,
                registers: ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip']
                    .map(name=>m.reg(name)),
                flags: m.reg('eflags') & 0x8d5,
                stack: [...m.read(STACK - 16, 16)],
            },
            translated: stop.translated,
            inTransfer: mechanisms.EMPTY_RETURN ?? 0,
            atCall: mechanisms.EMPTY_SITE ?? 0,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('a virtual call to a thunk to an empty method returns as the method would', async()=>{
    const expected = await run({ hotThreshold: 1e9 });
    assert.equal(expected.translated, 0, 'the reference ran interpreted');
    assert.equal(expected.observed.stop, 'halt');
    assert.equal(expected.observed.registers[4], STACK, 'esp is back where the call left it');
    assert.equal(expected.observed.registers[6], RETURN_ADDRESS, 'the slot held the address');
    const entered = await run({ emptyCalls: false });
    const inTransfer = await run({});
    const atCall = await run({ emptySites: true });
    for (const [name, got] of Object.entries({ entered, inTransfer, atCall }))
    {
        assert.deepEqual(got.observed, expected.observed, name);
        assert.ok(got.translated > 0, `${name}: translated code ran`);
    }
    assert.equal(entered.inTransfer + entered.atCall, 0, 'off, every call enters the region');
    assert.ok(inTransfer.inTransfer > TURNS / 2, 'the transfer returned from most calls');
    assert.equal(inTransfer.atCall, 0);
    assert.ok(atCall.atCall > TURNS / 2, 'the call site returned from most calls');
});
