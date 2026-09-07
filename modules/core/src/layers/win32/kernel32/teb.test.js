/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessBlocks, TEB, PEB, PARAMS, END_OF_EXCEPTION_LIST } from './teb.js';

/** Guest memory as a flat array, with a bump allocator over it. */
function guest(){
    const bytes = new Uint8Array(0x20000);
    let next = 0x1000;
    return {
        bytes,
        view: new DataView(bytes.buffer),
        /** @param {number} size */
        allocate(size){
            const at = next;
            next += size + 15 & ~15;
            return at;
        },
        /** @param {number} at @param {Uint8Array} value */
        writeMemory(at, value){
            bytes.set(value, at);
        },
    };
}

const build = (/** @type {any} */ memory, /** @type {any} */ extra = {})=>createProcessBlocks({
    allocate: (/** @type {number} */ size)=>memory.allocate(size),
    writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
        memory.writeMemory(at, value),
    processId: 0x1234,
    version: { major: 5, minor: 1, build: 2600 },
    imageBase: 0x00400000,
    ...extra,
});

test('a thread block says there is no handler yet, rather than saying zero', ()=>{
    // Zero is an address. A dispatcher walking the chain from a zero head would
    // follow it and call whatever is at the bottom of memory.
    const memory = guest();
    const { teb } = build(memory).createThreadBlock(
        { id: 7, stackBase: 0x300000, stackLimit: 0x2f0000 });

    assert.equal(memory.view.getUint32(teb + TEB.EXCEPTION_LIST, true), END_OF_EXCEPTION_LIST);
});

test('a thread block points at itself, because FS cannot be read as a pointer', ()=>{
    const memory = guest();
    const { teb } = build(memory).createThreadBlock(
        { id: 7, stackBase: 0x300000, stackLimit: 0x2f0000 });

    assert.equal(memory.view.getUint32(teb + TEB.SELF, true), teb);
    assert.equal(memory.view.getUint32(teb + TEB.THREAD_ID, true), 7);
    assert.equal(memory.view.getUint32(teb + TEB.PROCESS_ID, true), 0x1234);
    assert.equal(memory.view.getUint32(teb + TEB.STACK_BASE, true), 0x300000);
    assert.equal(memory.view.getUint32(teb + TEB.STACK_LIMIT, true), 0x2f0000);
});

test('the thread-local array is somewhere real, not at offset zero', ()=>{
    // A thread-local variable compiles to an index off this pointer. A null one
    // is read without complaint and indexed into the bottom of memory.
    const memory = guest();
    const { teb, tls } = build(memory).createThreadBlock(
        { id: 1, stackBase: 0x300000, stackLimit: 0x2f0000 });

    assert.notEqual(tls, 0);
    assert.equal(memory.view.getUint32(teb + TEB.TLS_POINTER, true), tls);
});

test('two threads get two blocks and two arrays', ()=>{
    const memory = guest();
    const blocks = build(memory);
    const first = blocks.createThreadBlock({ id: 1, stackBase: 0x300000, stackLimit: 0x2f0000 });
    const second = blocks.createThreadBlock({ id: 2, stackBase: 0x400000, stackLimit: 0x3f0000 });

    assert.notEqual(first.teb, second.teb);
    assert.notEqual(first.tls, second.tls, 'or one thread would read the other\'s locals');
    assert.equal(memory.view.getUint32(first.teb + TEB.PEB, true),
        memory.view.getUint32(second.teb + TEB.PEB, true), 'and both name one process');
});

test('the process block points at its parameters, and they say they are normalised', ()=>{
    // Not a missing feature when absent: a runtime reads the flag on its first
    // frame, and a null pointer here is one it dereferences having every right
    // to. A clear flag is worse -- every pointer inside is then read as an
    // offset from the block instead of as an address.
    const memory = guest();
    const { peb, params } = build(memory);

    assert.equal(memory.view.getUint32(peb + PEB.PROCESS_PARAMETERS, true), params);
    assert.notEqual(memory.view.getUint32(params + PARAMS.FLAGS, true) & 0x80000000, 0);
    assert.equal(memory.view.getUint32(peb + PEB.IMAGE_BASE_ADDRESS, true), 0x00400000);
});

test('a counted string names its length in bytes and its room including the terminator', ()=>{
    const memory = guest();
    const { params } = build(memory, { commandLine: '"C:\\game.exe"' });
    const at = params + PARAMS.COMMAND_LINE;

    const length = memory.view.getUint16(at, true);
    const maximum = memory.view.getUint16(at + 2, true);
    const buffer = memory.view.getUint32(at + 4, true);

    assert.equal(length, '"C:\\game.exe"'.length * 2, 'the length excludes the terminator');
    assert.equal(maximum, length + 2, 'and the room includes it');
    assert.notEqual(buffer, 0);
    assert.equal(memory.view.getUint16(buffer, true), '"'.charCodeAt(0),
        'the characters are UTF-16, where a reader expects them');
});

test('the strings do not overlap each other', ()=>{
    const memory = guest();
    const { params } = build(memory, {
        imagePath: 'C:\\one.exe',
        commandLine: '"C:\\one.exe" --flag',
        currentDirectory: 'C:\\',
    });

    const buffers = [PARAMS.IMAGE_PATH_NAME, PARAMS.COMMAND_LINE, PARAMS.CURRENT_DIRECTORY]
        .map(offset=>({
            at: memory.view.getUint32(params + offset + 4, true),
            size: memory.view.getUint16(params + offset + 2, true),
        }))
        .sort((left, right)=>left.at - right.at);

    for (let index = 1; index < buffers.length; index++)
    {
        assert.ok(buffers[index].at >= buffers[index - 1].at + buffers[index - 1].size,
            'a string written over another gives a program the wrong one, with no error');
    }
});
