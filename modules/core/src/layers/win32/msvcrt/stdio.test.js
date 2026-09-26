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

/** Where the runtime's `_iob` sits, as the loader would have placed it. */
const IOB = 0x9000;

/** @param {{ late?: boolean }} [options] */
function build(options = {}){
    const memory = fakeMemory();
    const files = fakeVolume({ 'C:\\data.bin': new Uint8Array([1, 2, 3, 4, 5, 6, 7]) }, options);
    /** @type {[number, string][]} */
    const console = [];
    /** @type {number[]} */
    const errno = [];
    const fns = /** @type {any} */ (createStdioFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        allocate: memory.allocate,
        free: ()=>true,
        files,
        write: (handle, text)=>console.push([handle, text]),
        iob: ()=>IOB,
        errno: code=>errno.push(code),
    }));
    return { memory, files, fns, console, errno };
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

test('fprintf formats and writes to the stream, not to stdout', ()=>{
    const { memory, files, fns } = build();
    const path = memory.put('C:\\new.txt');
    const stream = fns.fopen.handler([path, memory.put('wb')]);
    const format = memory.put('%s scored %d%%');
    const name = memory.put('player');

    assert.equal(fns.fprintf.handler([stream, format, name, 90]), 17);
    assert.equal(fns.ftell.handler([stream]), 17);
    assert.equal(String.fromCharCode(...files.files['C:\\new.txt']), 'player scored 90%');
});

test('fprintf on a stream not open for writing is a negative count, nothing written', ()=>{
    const { memory, fns } = build();
    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('rb')]);
    const before = fns.ftell.handler([stream]);

    assert.equal(fns.fprintf.handler([stream, memory.put('%d'), 5]), -1);
    assert.equal(fns.ftell.handler([stream]), before, 'the position did not move');
});

test('fprintf on a stream that is not one is a negative count', ()=>{
    const { memory, fns } = build();
    assert.equal(fns.fprintf.handler([0x999, memory.put('x'), 0]), -1);
});

test('setvbuf accepts a stream and a real mode, and does nothing observable', ()=>{
    const { memory, fns } = build();
    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('rb')]);
    const IONBF = 0x0004;
    const IOFBF = 0x0000;
    const IOLBF = 0x0040;

    assert.equal(fns.setvbuf.handler([stream, 0, IONBF, 0]), 0);
    assert.equal(fns.setvbuf.handler([stream, 0, IOFBF, 512]), 0);
    assert.equal(fns.setvbuf.handler([stream, 0, IOLBF, 512]), 0);
    assert.equal(fns.setvbuf.handler([stream, 0, 0x1234, 0]), -1, 'not a mode this runtime has');
    assert.equal(fns.setvbuf.handler([0x999, 0, IONBF, 0]), -1, 'not a stream at all');
});

test('_iob is the records themselves, the standard three first, each naming its descriptor', ()=>{
    const { fns } = build();
    const bytes = fns._iob.data();
    const view = new DataView(bytes.buffer);

    assert.equal(bytes.length, 20 * 32, 'twenty records');
    assert.deepEqual([0, 1, 2].map(index=>view.getUint32(index * 32 + 16, true)), [0, 1, 2]);
    assert.deepEqual([0, 1, 2].map(index=>view.getUint32(index * 32 + 12, true)),
        [0x1, 0x2, 0x2], 'stdin reads, stdout and stderr write');
    assert.equal(fns.__iob_func.handler([]), IOB);
    assert.equal(fns.__p__iob.handler([]), IOB);
});

test('stdout and stderr write to the console; stdin is at its end', ()=>{
    const { memory, fns, console } = build();
    const text = memory.put('%s=%d');
    const name = memory.put('x');
    const bytes = memory.put('hey');

    assert.equal(fns.fprintf.handler([IOB + 32, text, name, 3]), 3);
    assert.equal(fns.fwrite.handler([bytes, 1, 3, IOB + 64]), 3);
    assert.deepEqual(console, [[2, 'x=3'], [3, 'hey']], 'the standard handles, 2 and 3');

    const buffer = memory.allocate(4);
    assert.equal(fns.fread.handler([buffer, 1, 1, IOB]), 0);
    assert.equal(fns.fseek.handler([IOB + 32, 0, 0]), -1, 'the console does not seek');
    assert.equal(fns.fclose.handler([IOB + 32]), 0, 'and is not the program\'s to free');
    assert.equal(fns.fprintf.handler([IOB + 96, text, name, 3]), -1,
        'the fourth record is no stream until something opens one');
});

test('fopen and fclose say why they failed in errno', ()=>{
    // fopen: a missing file is ENOENT; a null or empty name and a mode that is
    // not one are invalid parameters. fclose: a null stream is EINVAL, a
    // stream closed already fails without touching errno (Wine's msvcrt file
    // tests, test_fopen_fclose_fcloseall).
    const { memory, fns, errno } = build();
    const ENOENT = 2;
    const EINVAL = 22;

    assert.equal(fns.fopen.handler([memory.put('C:\\none.txt'), memory.put('r')]), 0);
    assert.deepEqual(errno.splice(0), [ENOENT]);
    assert.equal(fns.fopen.handler([memory.put(''), memory.put('w+')]), 0);
    assert.equal(fns.fopen.handler([0, memory.put('w+')]), 0);
    assert.equal(fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('x')]), 0);
    assert.equal(fns.fopen.handler([memory.put('C:\\data.bin'), 0]), 0);
    assert.deepEqual(errno.splice(0), [EINVAL, EINVAL, EINVAL, EINVAL]);

    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('rb')]);
    assert.equal(fns.fclose.handler([stream]), 0);
    assert.equal(fns.fclose.handler([stream]), -1);
    assert.deepEqual(errno, [], 'a second close leaves errno alone');
    assert.equal(fns.fclose.handler([0]), -1);
    assert.deepEqual(errno, [EINVAL]);
});
