/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleFunctions } from './console.js';

test('FatalAppExitA shows its message, then ends the process as ExitProcess(0) does', async()=>{
    // The order is the point: a program that dies this way says why first,
    // and the process ends only once the box is dismissed.
    /** @type {string[]} */
    const steps = [];
    const fns = createConsoleFunctions({
        write: ()=>{},
        exit: ()=>{},
        park: ()=>'parked',
        end: code=>{
            steps.push(`end ${code}`);
            return 'ended';
        },
        messageBox: text=>Promise.resolve().then(()=>{
            steps.push(`box 0x${text.toString(16)}`);
            return 1;
        }),
    });
    assert.equal(fns.FatalAppExitA.argBytes, 8);
    assert.equal(await fns.FatalAppExitA.handler([0, 0x4000]), 'ended');
    assert.deepEqual(steps, ['box 0x4000', 'end 0']);

    const quiet = createConsoleFunctions({ write: ()=>{}, exit: ()=>{}, park: ()=>'parked',
        end: code=>`ended ${code}` });
    assert.equal(quiet.FatalAppExitA.handler([0, 0x4000]), 'ended 0', 'with no box to show');
});

test('GetStdHandle answers the pipe ends a parent handed, and the console for the rest', ()=>{
    const fns = createConsoleFunctions({ write: ()=>{}, exit: ()=>{}, park: ()=>'parked',
        standardHandles: { output: 0x8c } });
    // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE.
    assert.deepEqual([-10, -11, -12].map(which=>fns.GetStdHandle.handler([which >>> 0])),
        [1, 0x8c, 3]);
    assert.equal(fns.SetStdHandle.handler([-11 >>> 0, 0x40]), 1);
    assert.equal(fns.GetStdHandle.handler([-11 >>> 0]), 0x40, 'a program\'s own redirection wins');
});
