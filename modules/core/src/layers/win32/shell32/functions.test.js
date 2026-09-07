/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellFunctions } from './functions.js';

function machine(){
    const memory = new Uint8Array(0x200).fill(0xaa);
    const host = {
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
            memory.set(b, a),
    };
    return { memory, shell: /** @type {any} */ (createShellFunctions(host)) };
}

test('launching something is refused, not quietly succeeded', ()=>{
    // Success for something that did not happen is the failure that costs most:
    // the caller carries on believing a program started.
    const m = machine();
    assert.ok(m.shell.ShellExecuteA.handler([0, 0, 0, 0, 0, 0]) <= 32,
        'ShellExecute reports failure as a value of 32 or less');
    assert.equal(m.shell.ShellExecuteA.handler([0, 0, 0, 0, 0, 0]), 5);
});

test('finding an executable reports no association, and clears the buffer', ()=>{
    const m = machine();
    assert.equal(m.shell.FindExecutableA.handler([0, 0, 0x100]), 31);
    assert.equal(m.memory[0x100], 0,
        'a caller reads the buffer whatever the return says');
});

test('a window may accept drops, and no files are ever dropped on it', ()=>{
    const m = machine();
    assert.equal(m.shell.DragAcceptFiles.handler([0x40, 1]), 0);
    assert.equal(m.shell.DragAcceptFiles.handler([0x40, 0]), 0);
    assert.equal(m.shell.DragQueryFileA.handler([0, 0xffffffff, 0, 0]), 0,
        'the count a caller loops over is zero, which runs no times');
});

test('browsing for a folder is a cancelled browse, and yields no path', ()=>{
    const m = machine();
    assert.equal(m.shell.SHBrowseForFolderA.handler([0x100]), 0);
    assert.equal(m.shell.SHGetPathFromIDListA.handler([0, 0x100]), 0);
    assert.equal(m.memory[0x100], 0);
});

test('the allocator is refused with a null written where it would have gone', ()=>{
    // A caller that ignores the HRESULT then fails on a null it can see, rather
    // than on whatever its own stack held.
    const m = machine();
    assert.equal(m.shell.SHGetMalloc.handler([0x100]) | 0, 0x80004001 | 0);
    assert.deepEqual([...m.memory.slice(0x100, 0x104)], [0, 0, 0, 0]);
});
