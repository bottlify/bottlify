/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';
import { frameworkNeeded, managedImageOf } from './need.js';
import { managedExe } from './managed.fixture.js';

test('a managed image is known by its COM descriptor, with its runtime and width', ()=>{
    assert.deepEqual(managedImageOf(managedExe()), { bits: 32, runtime: 'v4.0.30319' });
    assert.deepEqual(managedImageOf(managedExe({ bits: 64, runtime: 'v2.0.50727' })),
        { bits: 64, runtime: 'v2.0.50727' });
    assert.equal(managedImageOf(buildExe({ imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ()=>[0xc3] })), null, 'a native one is not');
    assert.equal(managedImageOf(new Uint8Array(64)), null, 'nor bytes that are no image');
});

test('a managed program needs the Framework\'s layer of its width where the volume runs it not',
    ()=>{
        const framework = 'C:\\WINDOWS\\Microsoft.NET\\Framework';
        /** @param {string[]} files */
        const on = files=>(/** @type {string} */ path)=>files.includes(path);
        assert.equal(frameworkNeeded(managedExe(), on([]), 'C:\\WINDOWS'), 'dotnet48-x86');
        assert.equal(frameworkNeeded(managedExe({ bits: 64 }), on([]), 'C:\\WINDOWS'),
            'dotnet48-amd64');
        assert.equal(frameworkNeeded(managedExe(),
            on([`${framework}\\v4.0.30319\\mscoreei.dll`]), 'C:\\WINDOWS'), null,
        'a Framework 4 there');
        assert.equal(frameworkNeeded(managedExe({ bits: 64 }),
            on([`${framework}\\v4.0.30319\\mscoreei.dll`]), 'C:\\WINDOWS'), 'dotnet48-amd64',
        'a 64-bit program wants Framework64');
        // A CLR 2 program runs on a CLR 2 runtime installed; a CLR 4 one does not.
        const clr2 = on([`${framework}\\v2.0.50727\\mscorwks.dll`]);
        assert.equal(frameworkNeeded(managedExe({ runtime: 'v2.0.50727' }), clr2, 'C:\\WINDOWS'),
            null);
        assert.equal(frameworkNeeded(managedExe(), clr2, 'C:\\WINDOWS'), 'dotnet48-x86');
        assert.equal(frameworkNeeded(buildExe({ imports: { 'KERNEL32.dll': ['ExitProcess'] },
            code: ()=>[0xc3] }), on([]), 'C:\\WINDOWS'), null, 'a native program needs none');
    });
