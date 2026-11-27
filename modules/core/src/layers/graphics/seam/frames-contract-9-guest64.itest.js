/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The frames gate (`frames-contract.itest.js`) for Direct3D 9 in a 64-bit
 * process: the guest code built for its width against every call a trap,
 * each call made as an x86-64 caller makes it. What it must take in the guest
 * is what the tables hold as code; `wide` names what they must hold at least.
 *
 * A random program seldom makes the calls a routine leaves to the host, and
 * in a 64-bit process that way has work of its own - the argument registers
 * put back before the trap - so the cases each wide routine leaves are made
 * here directly, down both machines.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3D9, HWND, SOFTWARE_VERTEXPROCESSING, machine } from './guest-machine.itest.js';
import { frameGate } from './frames-contract.itest.js';

frameGate(D3D9, 'guest', { bits: 64, wide: ['GetRenderState'] });

const D3DRS_TEXTUREFACTOR = 60;

/** @typedef {import('./guest-machine.itest.js').Call} Call */

/** @param {string} method @param {Call['args']} args @returns {Call} */
const device = (method, args)=>({ on: '#1', kind: 'device', method, args });

/**
 * Each wide routine's calls: answered in the guest, and every case it leaves
 * to the host. `guest` says whether the guest code must answer it itself;
 * null for a call that only sets the stage.
 *
 * @type {{ call: Call, guest: boolean | null }[]}
 */
const CASES = [
    { call: device('SetRenderState', [D3DRS_TEXTUREFACTOR, 0x12345678]), guest: null },
    { call: device('GetRenderState', [D3DRS_TEXTUREFACTOR, 'out']), guest: true },
    // A state past the block's, one the device refuses, a null pointer.
    { call: device('GetRenderState', [300, 'out']), guest: false },
    { call: device('GetRenderState', [1, 'out']), guest: false },
    { call: device('GetRenderState', [D3DRS_TEXTUREFACTOR, 0]), guest: false },
];

test('Direct3D 9 in a 64-bit process: what a wide routine leaves reaches the host as the'
    + ' program made the call', ()=>{
    /** @param {boolean} guestCode */
    const run = guestCode=>{
        const m = machine(D3D9, guestCode, { bits: 64 });
        m.run({ on: '#0', kind: 'root', method: 'CreateDevice', args: [0, 1, HWND,
            SOFTWARE_VERTEXPROCESSING, { words: D3D9.presentParameters }, 'out'] });
        return CASES.map(({ call })=>{
            const answer = m.run(call);
            return { line: `${call.method}(${call.args.join(',')}) ${answer.eax.toString(16)} `
                + `${answer.out} ${m.memory.readU32(0x10000).toString(16)}`,
            inGuest: answer.traps.length === 0 };
        });
    };
    const guest = run(true);
    const trap = run(false);
    assert.deepEqual(guest.map(({ line })=>line), trap.map(({ line })=>line));
    assert.deepEqual(guest.map(({ inGuest }, i)=>(CASES[i].guest === null ? null : inGuest)),
        CASES.map(({ guest: g })=>g));
});
