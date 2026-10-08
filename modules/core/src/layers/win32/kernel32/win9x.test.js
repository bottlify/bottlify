/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Windows 95's own kernel32 calls: the stdcall ones by their handlers, and
 * the register-convention thunk helpers as the code they are, on cork's test
 * machine -- every register they promise to keep compared before and after,
 * and the refusal trap a stub that marks it was reached and returns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../../../../../cork/src/testing/machine.js';
import { createWin9xFunctions, MAPPED_ARGUMENTS, THUNK_EXITS } from './win9x.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_CALL_NOT_IMPLEMENTED = 120;

const HALT = 0xf000;
const TRAP = 0xe000;
const REACHED = 0xd000;
const CODE = 0x20000;
const STACK = 0x9000;
const FRAME = 0x8800;

/** @param {Record<string, any>} [handles] */
function setup(handles = {}){
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const said = [];
    const fns = createWin9xFunctions({
        setLastError: code=>errors.push(code),
        divergence: api=>said.push(api),
        resolveHandle: handle=>{
            if (!(handle in handles))
            {
                throw new Error('no such handle');
            }
            return handles[handle];
        },
    });
    return { fns, errors, said };
}

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** The registers a helper is run with, each distinct so a clobber shows. */
const SEEDED = { ebx: 0x0b0b0b0b, ecx: 0x0c0c0c0c, esi: 0x51515151, edi: 0x7e7e7e7e };

/**
 * The machine with one export's code placed and its trap a stub that marks
 * REACHED and returns, as the bridge's trap returns to its caller.
 *
 * @param {any} entry
 */
function place(entry){
    const m = createTestMachine({ ramSize: 2 << 20 });
    m.write(HALT, [0xf4]);
    // mov dword [REACHED], 1; ret
    m.write(TRAP, [0xc7, 0x05, ...u32(REACHED), ...u32(1), 0xc3]);
    /** @type {{ at: number, target: number }[]} */
    const jumps = [];
    let registered = 0;
    const code = entry.code({
        register: (/** @type {any} */ trap)=>{
            registered++;
            assert.equal(trap.argBytes, 0, 'the trap takes nothing off the stack');
            return TRAP;
        },
        jump: (/** @type {number} */ at, /** @type {number} */ target)=>jumps.push({ at, target }),
    });
    const bytes = Uint8Array.from(code);
    const view = new DataView(bytes.buffer);
    for (const { at, target } of jumps)
    {
        view.setUint32(at, (target - (CODE + at + 4)) >>> 0, true);
    }
    m.write(CODE, bytes);
    /** @param {Record<string, number>} registers */
    const run = registers=>{
        m.writeU32(REACHED, 0);
        m.writeU32(STACK, HALT);
        m.setReg('esp', STACK);
        for (const [name, value] of Object.entries({ ...SEEDED, ...registers }))
        {
            m.setReg(name, value);
        }
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3, `ran to its return: ${JSON.stringify(exit)}`);
        return { reached: m.readU32(REACHED) === 1 };
    };
    return { m, run, registered };
}

test('MapLS, MapSL and MapSLFix pass a pointer with no selector and refuse the rest', ()=>{
    const { fns, errors, said } = setup();
    for (const name of ['MapLS', 'MapSL', 'MapSLFix'])
    {
        assert.equal(fns[name].argBytes, 4);
        assert.equal(fns[name].handler([0]), 0, `${name}: null stays null`);
        assert.equal(fns[name].handler([0x1234]), 0x1234, `${name}: an integer resource name`);
        assert.equal(fns[name].handler([0x00401000]), 0, `${name}: no selector, a null answer`);
    }
    assert.deepEqual(errors, [], 'the mapping calls set no error');
    assert.deepEqual(said, ['MapLS', 'MapSL', 'MapSLFix'], 'each refusal said once');
    assert.equal(fns.UnMapLS.handler([0x00170000]), 0);
});

test('the Windows 95 services, VxD and socket calls are refused as not implemented', ()=>{
    const { fns, errors } = setup();
    const cases = [
        ['ThunkConnect32', 24], ['RegisterServiceProcess', 8], ['OpenVxDHandle', 4],
        ['CreateSocketHandle', 0], ['SetHandleContext', 8],
    ];
    for (const [name, argBytes] of cases)
    {
        assert.equal(fns[name].argBytes, argBytes, `${name} pops its arguments`);
        assert.equal(fns[name].handler([1, 2, 3, 4, 5, 6]), 0, `${name} fails`);
        assert.equal(errors.at(-1), ERROR_CALL_NOT_IMPLEMENTED, `${name}'s error`);
    }
});

test('ConvertToGlobalHandle answers the handle itself, and refuses one naming nothing', ()=>{
    const { fns, errors } = setup({ 0x44: { kind: 'event' } });
    assert.equal(fns.ConvertToGlobalHandle.handler([0x44]), 0x44);
    assert.equal(fns.ConvertToGlobalHandle.handler([0xffffffff]), 0xffffffff,
        'the process pseudo-handle is one too');
    assert.equal(fns.ConvertToGlobalHandle.handler([0x48]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(fns.MakeCriticalSectionGlobal.argBytes, 4);
    assert.equal(fns.MakeCriticalSectionGlobal.handler([0x1000]), 0);
});

test('SMapLS answers a small pointer as itself and refuses a selector, keeping registers', ()=>{
    const { fns } = setup();
    const { m, run, registered } = place(fns.SMapLS);
    assert.equal(registered, 1);

    let { reached } = run({ eax: 0x1234, edx: 0xdddddddd });
    assert.equal(m.reg('eax'), 0x1234);
    assert.equal(m.reg('edx'), 0, 'and no alias to free');
    assert.equal(reached, false, 'nothing refused');

    ({ reached } = run({ eax: 0x00401000, edx: 0xdddddddd }));
    assert.equal(m.reg('eax'), 0, 'a null 16:16 pointer');
    assert.equal(m.reg('edx'), 0);
    assert.equal(reached, true, 'the refusal reported');
    for (const [name, value] of Object.entries(SEEDED))
    {
        assert.equal(m.reg(name), value, `${name} kept across the report`);
    }
    assert.equal(m.reg('esp'), STACK + 4, 'a plain ret');
});

test('SMapLS_IP_EBP_n maps the argument at [EBP+n] and leaves no alias in its slot', ()=>{
    const { fns } = setup();
    for (const offset of MAPPED_ARGUMENTS)
    {
        const { m, run } = place(fns[`SMapLS_IP_EBP_${offset}`]);
        m.writeU32(FRAME + offset, 0x00000042);
        m.writeU32(FRAME + offset + 4, 0x99999999);
        let { reached } = run({ ebp: FRAME });
        assert.equal(m.reg('eax'), 0x42, `${offset}: a small value passes`);
        assert.equal(m.readU32(FRAME + offset), 0, `${offset}: the slot holds the alias`);
        assert.equal(m.readU32(FRAME + offset + 4), 0x99999999, `${offset}: and only it`);
        assert.equal(reached, false);

        m.writeU32(FRAME + offset, 0x00402000);
        ({ reached } = run({ ebp: FRAME }));
        assert.equal(m.reg('eax'), 0, `${offset}: no selector`);
        assert.equal(reached, true);
        assert.equal(m.reg('ebp'), FRAME);
        assert.equal(m.reg('esi'), SEEDED.esi);
        assert.equal(m.reg('esp'), STACK + 4);
    }
});

test('SUnMapLS keeps every register, and SUnMapLS_IP_EBP_n clears its slot and keeps EAX', ()=>{
    const { fns } = setup();
    {
        const { m, run } = place(fns.SUnMapLS);
        run({ eax: 0x12345678, edx: 0x2222 });
        assert.equal(m.reg('eax'), 0x12345678);
        assert.equal(m.reg('edx'), 0x2222);
        assert.equal(m.reg('esp'), STACK + 4);
    }
    for (const offset of MAPPED_ARGUMENTS)
    {
        const { m, run } = place(fns[`SUnMapLS_IP_EBP_${offset}`]);
        m.writeU32(FRAME + offset, 0xabcd0000);
        run({ eax: 0x777, ebp: FRAME });
        assert.equal(m.readU32(FRAME + offset), 0, `${offset}: cleared`);
        assert.equal(m.reg('eax'), 0x777, `${offset}: the thunk's answer kept`);
        assert.equal(m.reg('esp'), STACK + 4);
    }
});

test('FT_Thunk refuses the 16-bit call with zero in DX:AX and keeps the rest', ()=>{
    const { fns } = setup();
    const { m, run } = place(fns.FT_Thunk);
    const { reached } = run({ eax: 0x1111, edx: 0x2222, ebp: FRAME });
    assert.equal(reached, true);
    assert.equal(m.reg('eax'), 0);
    assert.equal(m.reg('edx'), 0);
    assert.equal(m.reg('ebp'), FRAME);
    assert.equal(m.reg('ebx'), SEEDED.ebx);
    assert.equal(m.reg('esp'), STACK + 4);
});

test('FT_ExitN leaves FT_Prolog\'s frame and returns to the thunk\'s caller, N bytes popped', ()=>{
    const { fns } = setup();
    for (const pop of THUNK_EXITS)
    {
        const entry = fns[`FT_Exit${pop}`];
        const m = createTestMachine({ ramSize: 2 << 20 });
        m.write(HALT, [0xf4]);
        m.write(CODE, entry.code());
        // The thunk's caller's frame: its return address at EBP+4, the old
        // EBP at EBP, the caller's EBX, ESI and EDI below, ESP at EBP-64.
        m.writeU32(FRAME + 4, HALT);
        m.writeU32(FRAME, 0x00c0ffee);
        m.writeU32(FRAME - 4, 0xb0b0b0b0);
        m.writeU32(FRAME - 8, 0x5e5e5e5e);
        m.writeU32(FRAME - 12, 0xd1d1d1d1);
        m.setReg('ebp', FRAME);
        m.setReg('esp', FRAME - 64);
        m.setReg('ebx', 0x1234);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3, `FT_Exit${pop} ran to its return`);
        assert.equal(m.reg('eax'), 0x1234, 'the answer moved from EBX');
        assert.equal(m.reg('ebx'), 0xb0b0b0b0);
        assert.equal(m.reg('esi'), 0x5e5e5e5e);
        assert.equal(m.reg('edi'), 0xd1d1d1d1);
        assert.equal(m.reg('ebp'), 0x00c0ffee);
        assert.equal(m.reg('esp'), FRAME + 8 + pop, `FT_Exit${pop} popped ${pop} bytes`);
    }
});
