/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compiler seam's entry points as a 64-bit program reaches them: the
 * addresses it passes are whole past 4 GiB (the compiling itself is
 * d3d10.test.js's).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompilerSeam } from './d3dcompiler.js';

test('D3DReflect reads a 64-bit program\'s shader past 4 GiB where it is', ()=>{
    // Cut to its low dword, 0x40000100 named nothing of the program's.
    const high = 0x1_4000_0000;
    const bytes = new Uint8Array(0x1000);
    bytes.set([0x44, 0x58, 0x42, 0x43], 0x100);
    /** @type {Uint8Array[]} */
    const reflected = [];
    const { exports } = createCompilerSeam({
        fields: { readU32: ()=>0, writeU32: ()=>{} },
        memory: {
            readMemory: (at, n)=>{
                assert.ok(at >= high, `read at 0x${at.toString(16)}`);
                return bytes.slice(at - high, at - high + n);
            },
            writeMemory: ()=>{},
        },
        allocate: undefined,
        free: undefined,
        report: ()=>{},
        blobInto: ()=>0,
        readCString: ()=>'',
        callGuest: undefined,
        currentThread: undefined,
        reflect: (shader, riid, out)=>{
            reflected.push(shader);
            assert.deepEqual([riid, out], [high + 0x200, high + 0x300]);
            return 0;
        },
    });
    assert.equal(exports.D3DReflect.handler([high + 0x100, 4, high + 0x200, high + 0x300]), 0);
    assert.deepEqual([...reflected[0]], [0x44, 0x58, 0x42, 0x43]);
});
