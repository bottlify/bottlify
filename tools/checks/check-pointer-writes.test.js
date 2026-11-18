/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointerWriteIssues } from './check-pointer-writes.mjs';

test('a pointer written as a dword and a zero by hand is found', ()=>{
    const issues = pointerWriteIssues('layers/x/seam.js', [
        '    const writePointer = (address, value)=>{',
        '        writeU32(address, value);',
        '        if (long)',
        '        {',
        '            writeU32((address >>> 0) + 4, 0);',
        '        }',
        '    };',
    ].join('\n'));
    assert.equal(issues.length, 2, issues.join('\n'));
    assert.match(issues[0], /^1: a pointer read or written by hand/);
    assert.match(issues[1], /^5: a pointer's upper half/);
});

test('a reader of its own is found too, a block body read to its end', ()=>{
    assert.equal(pointerWriteIssues('layers/x/seam.js', [
        '    const readPointer = address=>{',
        '        const low = readU32(address);',
        '        return long ? low + readU32(address + 4) * 2 ** 32 : low;',
        '    };',
    ].join('\n')).length, 1);
});

test('a reader or writer handing its work to the memory layer or pointerIo passes', ()=>{
    for (const text of [
        '    const writePointer = (address, value)=>fields.writePointer(address, value, 8);',
        '    const { read: readPointer, write: writePointer } = pointerIo(host, 8);',
        '    const readPointer = address=>{\n        const bytes = host.readMemory(address, 8);\n'
            + '        return width.get(new DataView(bytes.buffer), 0);\n    };',
        '    writePointer: (address, value, bytes)=>memory.writePointer(address, value, bytes),',
    ])
    {
        assert.deepEqual(pointerWriteIssues('layers/x/seam.js', text), [], text);
    }
});

test('a dword zero at + 4 outside a test of the width is a field, not a pointer', ()=>{
    assert.deepEqual(pointerWriteIssues('layers/x/seam.js',
        'writeU32(out, LUID);\nwriteU32(out + 4, 0);'), []);
});

test('the owners define the reader and writer', ()=>{
    assert.deepEqual(pointerWriteIssues('layers/memory/module.js',
        'const writePointer = (address, value)=>{\n    if (long)\n    {\n'
        + '        writeU32(address + 4, 0);\n    }\n};'), []);
});
