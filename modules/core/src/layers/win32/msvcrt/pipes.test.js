/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDescriptors, createIoFunctions } from './io.js';
import { withPipes } from './pipes.js';
import { fakeMemory, fakeVolume } from './harness.test.js';

const O_BINARY = 0x8000;
const O_TEXT = 0x4000;
const O_NOINHERIT = 0x0080;
const EINVAL = 22;
const S_IFIFO = 0x1000;

function build({ fmode = 0 } = {}){
    const memory = fakeMemory();
    const files = withPipes(fakeVolume({}, { directories: ['C:\\'] }));
    /** @type {number[]} */
    const errno = [];
    const descriptors = createDescriptors({
        files, errno: code=>errno.push(code), fmode: ()=>fmode,
    });
    const fns = /** @type {Record<string, any>} */ (createIoFunctions({
        ...memory, files, errno: code=>errno.push(code),
    }, descriptors));
    const fds = memory.allocate(8);
    /** @param {number} mode @returns {[number, number]} */
    const pipe = mode=>{
        assert.equal(fns._pipe.handler([fds, 1024, mode]), 0);
        return [memory.u32(fds), memory.u32(fds + 4)];
    };
    const buffer = memory.allocate(64);
    /** @param {number} fd @param {string} text */
    const write = (fd, text)=>fns._write.handler([fd, memory.put(text), text.length]);
    /** @param {number} fd @param {number} count */
    const read = (fd, count)=>{
        const got = fns._read.handler([fd, buffer, count]);
        return got < 0 ? got : String.fromCharCode(...memory.bytes.subarray(buffer, buffer + got));
    };
    return { memory, fns, errno, pipe, write, read, descriptors };
}

test('_pipe hands out a reading and a writing end at the lowest numbers free', ()=>{
    const { fns, errno, pipe, write, read } = build();
    const [reader, writer] = pipe(O_BINARY);
    assert.deepEqual([reader, writer], [3, 4]);
    assert.equal(write(writer, 'Hello world'), 11);
    assert.equal(read(reader, 5), 'Hello');
    assert.equal(read(reader, 64), ' world', 'a read takes what was not taken before');
    assert.equal(read(reader, 64), '', 'an empty pipe answers nothing at once');
    assert.equal(read(writer, 4), -1, 'the writing end is not read');
    assert.equal(write(reader, 'x'), -1, 'nor the reading end written');

    assert.equal(fns._pipe.handler([0, 1024, O_BINARY]), -1);
    assert.equal(errno.at(-1), EINVAL, 'no array is EINVAL');
});

test('a text pipe folds CR LF, a CR last in a read taking the LF after it', ()=>{
    // Wine's msvcrt test_pipes: Windows keeps the byte it looked at past a
    // CR for the next read, as a pipe cannot seek back.
    const { fns, pipe, write, read } = build();
    const [reader, writer] = pipe(O_BINARY);
    assert.equal(write(writer, '\r\n\rab\r\n'), 7);
    assert.equal(fns._setmode.handler([reader, O_TEXT]), O_BINARY);
    assert.equal(read(reader, 1), '\n');
    assert.equal(read(reader, 1), '\r', 'a CR not before an LF is itself');
    assert.equal(read(reader, 1), 'a', 'and the byte looked at is still there');
    assert.equal(read(reader, 2), 'b\n');
});

test('a pipe\'s mode is _fmode\'s when none is named', ()=>{
    const { pipe, write, read } = build({ fmode: O_BINARY });
    const [reader, writer] = pipe(0);
    write(writer, 'a\r\n');
    assert.equal(read(reader, 8), 'a\r\n');
});

test('_fstat calls a pipe end a FIFO on the device of its own number', ()=>{
    const { memory, fns, pipe, write } = build();
    const [reader, writer] = pipe(O_BINARY);
    write(writer, 'abc');
    const stat = memory.allocate(64);
    assert.equal(fns._fstat.handler([reader, stat]), 0);
    const view = new DataView(memory.bytes.buffer, stat);
    assert.equal(view.getUint32(0, true), reader, 'st_dev');
    assert.equal(view.getUint16(6, true), S_IFIFO, 'st_mode');
    assert.equal(view.getInt16(8, true), 1, 'st_nlink');
});

test('the pipe flags its ends in __pioinfo, and is let go when both ends close', ()=>{
    const { fns, pipe, write, descriptors } = build();
    const [reader, writer] = pipe(O_BINARY | O_NOINHERIT);
    // The first block's entries, 36 bytes each past the 64 block pointers;
    // `wxflag` is the byte at 4: open, a pipe, not inherited.
    const wxflag = (/** @type {number} */ fd)=>descriptors.ioinfoBytes()[64 * 4 + fd * 36 + 4];
    assert.equal(wxflag(reader), 0x01 | 0x08 | 0x10);
    assert.equal(wxflag(writer), 0x01 | 0x08 | 0x10);
    write(writer, 'abc');
    const pipeNode = descriptors.get(reader)?.node;
    assert.equal(fns._close.handler([writer]), 0);
    assert.equal(pipeNode.bytes.length, 3, 'one end open keeps what is in it');
    assert.equal(fns._close.handler([reader]), 0);
    assert.equal(pipeNode.bytes.length, 0, 'the last end closed lets it go');
});
