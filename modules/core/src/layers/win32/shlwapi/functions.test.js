/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShlwapiFunctions } from './functions.js';

const AT = 0x100;

function machine(){
    const memory = new Uint8Array(0x400);
    const fns = createShlwapiFunctions({
        readCString: (address, maxLength)=>{
            let text = '';
            for (let at = address; at < address + maxLength && memory[at] !== 0; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    /** @param {string} text */
    const put = text=>{
        memory.fill(0, AT, AT + 0x100);
        memory.set(new TextEncoder().encode(text), AT);
        return AT;
    };
    /** @param {number} address */
    const at = address=>{
        let text = '';
        for (let cursor = address; memory[cursor] !== 0; cursor++)
        {
            text += String.fromCharCode(memory[cursor]);
        }
        return text;
    };
    return { fns, put, at };
}

test('the extension is the last dot of the last component, or the terminator', ()=>{
    const { fns, put, at } = machine();
    assert.equal(at(fns.PathFindExtensionA.handler([put('C:\\dir.d\\file.tar.gz')])), '.gz');
    assert.equal(at(fns.PathFindExtensionA.handler([put('C:\\dir.d\\file')])), '',
        'a dot in a directory name is not the file\'s extension');
    assert.equal(fns.PathFindExtensionA.handler([put('file.txt')]), AT + 4,
        'a pointer into the caller\'s own buffer');
    assert.equal(fns.PathFindExtensionA.handler([0]), 0);
});

test('the file name follows the last separator that has something after it', ()=>{
    const { fns, put, at } = machine();
    assert.equal(at(fns.PathFindFileNameA.handler([put('C:\\dir\\file.exe')])), 'file.exe');
    assert.equal(at(fns.PathFindFileNameA.handler([put('C:\\dir\\')])), 'dir\\');
    assert.equal(at(fns.PathFindFileNameA.handler([put('C:file')])), 'file');
    assert.equal(at(fns.PathFindFileNameA.handler([put('file')])), 'file');
});

test('stripping to the root keeps a drive or a share and refuses a path with neither', ()=>{
    const { fns, put, at } = machine();
    let path = put('C:\\Program Files\\Title\\title.exe');
    assert.equal(fns.PathStripToRootA.handler([path]), 1);
    assert.equal(at(path), 'C:\\');

    path = put('\\\\server\\share\\dir\\file');
    assert.equal(fns.PathStripToRootA.handler([path]), 1);
    assert.equal(at(path), '\\\\server\\share');

    path = put('dir\\file');
    assert.equal(fns.PathStripToRootA.handler([path]), 0);
    assert.equal(at(path), '', 'cut down one component at a time until nothing was left');
});

test('a UNC path is one that starts with two separators', ()=>{
    const { fns, put } = machine();
    assert.equal(fns.PathIsUNCA.handler([put('\\\\server\\share')]), 1);
    assert.equal(fns.PathIsUNCA.handler([put('C:\\dir')]), 0);
    assert.equal(fns.PathIsUNCA.handler([put('\\')]), 0);
    assert.equal(fns.PathIsUNCA.handler([0]), 0);
});

test('each declares the one pointer it pops', ()=>{
    const { fns } = machine();
    for (const fn of Object.values(fns))
    {
        assert.equal(fn.argBytes, 4);
    }
});
