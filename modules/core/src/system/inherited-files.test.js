/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossingFiles, handedFiles, inheritedOpen } from './inherited-files.js';

test('an inherited open file crosses as values, its position left with the parent', ()=>{
    const open = { path: 'C:\\App\\out.txt', node: { id: 7 }, read: false, write: true,
        position: 5, terms: { read: false, write: true, shareRead: true }, mode: 0x20 };
    const crossed = crossingFiles([{ handle: 0x30, type: 'file', object: open, access: 0x120196 },
        { handle: 0x34, type: 'pipe', object: {} }]);
    assert.deepEqual(crossed, [{ handle: 0x30, type: 'file', access: 0x120196,
        object: { path: 'C:\\App\\out.txt', read: false, write: true,
            terms: { read: false, write: true, shareRead: true }, mode: 0x20 } }]);
    assert.doesNotThrow(()=>structuredClone(crossed), 'what crosses is data');
});

test('a crossed file reads and moves the parent\'s position, by its handle', ()=>{
    const open = { path: 'C:\\App\\out.txt', write: true, position: 5, terms: {} };
    const inherited = [{ handle: 0x30, type: 'file', object: open }];
    const [held] = handedFiles(crossingFiles(inherited),
        handle=>inheritedOpen(inherited, handle)?.position ?? 0,
        (handle, at)=>{
            const parent = inheritedOpen(inherited, handle);
            if (parent)
            {
                parent.position = at;
            }
        });
    assert.equal(held.object.position, 5);
    held.object.position += 5;
    assert.equal(open.position, 10, 'one position, the parent\'s open\'s');
    assert.equal(inheritedOpen(inherited, 0x34), null, 'no file under another number');
});
