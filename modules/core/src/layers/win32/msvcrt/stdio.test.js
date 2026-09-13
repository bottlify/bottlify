/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStdioFunctions } from './stdio.js';
import { fakeMemory } from './harness.test.js';

/**
 * A volume of byte arrays: a node is a path, reads and writes go straight
 * to the array, and a read may be handed back late to stand for a block
 * that is still on its way.
 *
 * @param {Record<string, Uint8Array>} files
 * @param {{ late?: boolean }} [options]
 */
export function fakeVolume(files, { late = false } = {}){
    /** @type {string[]} */
    const closed = [];
    return {
        files,
        closed,
        /** @param {string} path @param {{ create?: boolean, truncate?: boolean }} mode */
        open(path, mode){
            if (!files[path] && !mode.create)
            {
                return null;
            }
            if (!files[path] || mode.truncate)
            {
                files[path] = new Uint8Array(0);
            }
            return path;
        },
        /** @param {string} path */
        stat: path=>(files[path] ? { size: files[path].length } : null),
        /** @param {string} node @param {number} at @param {number} length */
        read(node, at, length){
            const bytes = files[node].slice(at, at + length);
            return late ? Promise.resolve(bytes) : bytes;
        },
        /** @param {string} node @param {number} at @param {Uint8Array} bytes */
        write(node, at, bytes){
            const grown = new Uint8Array(Math.max(files[node].length, at + bytes.length));
            grown.set(files[node]);
            grown.set(bytes, at);
            files[node] = grown;
            return bytes.length;
        },
        /** @param {string} node */
        close: node=>closed.push(node),
    };
}

/** @param {{ late?: boolean }} [options] */
function build(options = {}){
    const memory = fakeMemory();
    const files = fakeVolume({ 'C:\\data.bin': new Uint8Array([1, 2, 3, 4, 5, 6, 7]) }, options);
    const fns = /** @type {any} */ (createStdioFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        allocate: memory.allocate,
        free: ()=>true,
        files,
    }));
    return { memory, files, fns };
}

test('a stream reads whole elements, tells its position, seeks and closes', ()=>{
    const { memory, files, fns } = build();
    const path = memory.put('C:\\data.bin');
    const mode = memory.put('rb');
    const stream = fns.fopen.handler([path, mode]);
    assert.notEqual(stream, 0);
    assert.equal(memory.bytes[stream + 16], 3,
        '_file is the first descriptor above the standard three');

    const buffer = memory.allocate(16);
    assert.equal(fns.fread.handler([buffer, 2, 2, stream]), 2, 'two elements of two');
    assert.deepEqual([...memory.bytes.subarray(buffer, buffer + 4)], [1, 2, 3, 4]);
    assert.equal(fns.ftell.handler([stream]), 4);
    assert.equal(fns.fread.handler([buffer, 2, 4, stream]), 1,
        'three bytes remain: one whole element, the odd byte not counted');
    assert.equal(fns.ftell.handler([stream]), 6);

    assert.equal(fns.fseek.handler([stream, -1, 2]), 0, 'SEEK_END');
    assert.equal(fns.ftell.handler([stream]), 6);
    assert.equal(fns.fseek.handler([stream, 1, 0]), 0, 'SEEK_SET');
    assert.equal(fns.fseek.handler([stream, 2, 1]), 0, 'SEEK_CUR');
    assert.equal(fns.ftell.handler([stream]), 3);
    assert.equal(fns.fseek.handler([stream, -10, 1]), -1, 'before the start');

    assert.equal(fns.fclose.handler([stream]), 0);
    assert.deepEqual(files.closed, ['C:\\data.bin']);
    assert.equal(fns.fclose.handler([stream]), -1, 'closed twice is EOF');
    assert.equal(fns.ftell.handler([stream]), -1);
});

test('a file that is not there is null to open for reading, and made to open for writing', ()=>{
    const { memory, files, fns } = build();
    const path = memory.put('C:\\new.txt');
    assert.equal(fns.fopen.handler([path, memory.put('rb')]), 0);
    assert.equal(fns.fopen.handler([path, memory.put('x')]), 0, 'no such mode');

    const stream = fns.fopen.handler([path, memory.put('wb')]);
    assert.notEqual(stream, 0);
    const text = memory.put('hello');
    assert.equal(fns.fwrite.handler([text, 1, 5, stream]), 5);
    assert.equal(fns.fread.handler([text, 1, 5, stream]), 0, 'not open for reading');
    assert.equal(fns.fclose.handler([stream]), 0);
    assert.equal(String.fromCharCode(...files.files['C:\\new.txt']), 'hello');

    // Appending starts at the end; a second write lands after the first.
    const again = fns.fopen.handler([path, memory.put('ab')]);
    assert.equal(fns.ftell.handler([again]), 5);
    fns.fwrite.handler([text, 5, 1, again]);
    fns.fclose.handler([again]);
    assert.equal(String.fromCharCode(...files.files['C:\\new.txt']), 'hellohello');
});

test('a read whose bytes are still on their way answers when they arrive', async()=>{
    const { memory, fns } = build({ late: true });
    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('r')]);
    const buffer = memory.allocate(16);
    const answer = fns.fread.handler([buffer, 1, 3, stream]);
    assert.equal(typeof answer.then, 'function', 'the caller parks on it');
    assert.equal(await answer, 3);
    assert.deepEqual([...memory.bytes.subarray(buffer, buffer + 3)], [1, 2, 3]);
    assert.equal(fns.ftell.handler([stream]), 3);
});

test('every entry is cdecl with the argument count it reads', ()=>{
    const { fns } = build();
    const expected = { fopen: 8, fclose: 4, fread: 16, fwrite: 16, fseek: 12, ftell: 4 };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fns[name].convention, 'cdecl', name);
        assert.equal(fns[name].argBytes, argBytes, name);
    }
});
