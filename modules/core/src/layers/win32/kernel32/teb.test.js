/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createProcessBlocks, TEB, PEB, PARAMS, LDR_DATA, LDR_ENTRY, END_OF_EXCEPTION_LIST,
} from './teb.js';
import { WINDOWS_VERSIONS } from './versions.js';

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

test('the process block holds the process heap, for GetProcessHeap compiled inline', ()=>{
    // NtCurrentTeb()->Peb->ProcessHeap, read with no call: zero there is a
    // heap every allocation from fails on.
    const memory = guest();
    const { peb } = build(memory, { processHeap: 0x50004 });
    assert.equal(memory.view.getUint32(peb + PEB.PROCESS_HEAP, true), 0x50004);
});

test('the process block counts the processors the machine has, one when it is not told', ()=>{
    // Read with no call by a runtime sizing its thread pool, and the same
    // count GetSystemInfo gives.
    const memory = guest();
    assert.equal(memory.view.getUint32(build(memory).peb + PEB.NUMBER_OF_PROCESSORS, true), 1);
    const { peb } = build(memory, { processors: 4 });
    assert.equal(memory.view.getUint32(peb + PEB.NUMBER_OF_PROCESSORS, true), 4);
});

test('the process block holds the version and its service pack where a program reads them', ()=>{
    // A program that reads the block directly finds what GetVersionEx says:
    // the build is a WORD, and the WORD after it is the service pack, major
    // in the high byte -- a DWORD build would write a zero service pack over it.
    const memory = guest();
    const { peb } = build(memory, { version: WINDOWS_VERSIONS.win7 });

    assert.equal(memory.view.getUint32(peb + PEB.OS_MAJOR_VERSION, true), 6);
    assert.equal(memory.view.getUint32(peb + PEB.OS_MINOR_VERSION, true), 1);
    assert.equal(memory.view.getUint16(peb + PEB.OS_BUILD_NUMBER, true), 7601);
    assert.equal(memory.view.getUint16(peb + PEB.OS_CSD_VERSION, true), 0x0100);
    assert.equal(memory.view.getUint32(peb + PEB.OS_PLATFORM_ID, true), 2);

    const length = memory.view.getUint16(peb + PEB.CSD_VERSION, true);
    const buffer = memory.view.getUint32(peb + PEB.CSD_VERSION + 4, true);
    assert.equal(length, 'Service Pack 1'.length * 2);
    assert.equal(memory.view.getUint16(peb + PEB.CSD_VERSION + 2, true), length + 2);
    const text = String.fromCharCode(...Array.from({ length: length / 2 },
        (_, index)=>memory.view.getUint16(buffer + index * 2, true)));
    assert.equal(text, 'Service Pack 1');
});

test('a Windows with no service pack has an empty one, not a missing one', ()=>{
    const memory = guest();
    const { peb } = build(memory, { version: WINDOWS_VERSIONS.win10 });

    assert.equal(memory.view.getUint32(peb + PEB.OS_MAJOR_VERSION, true), 10);
    assert.equal(memory.view.getUint16(peb + PEB.OS_BUILD_NUMBER, true), 19045);
    assert.equal(memory.view.getUint16(peb + PEB.OS_CSD_VERSION, true), 0);
    assert.equal(memory.view.getUint16(peb + PEB.CSD_VERSION, true), 0);
    const buffer = memory.view.getUint32(peb + PEB.CSD_VERSION + 4, true);
    assert.notEqual(buffer, 0, 'a reader copying the string finds a terminator');
    assert.equal(memory.view.getUint16(buffer, true), 0);
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

/**
 * Walks a circular LIST_ENTRY from its head, the way a program does, and
 * returns every node but the head -- a bound guards a test against spinning
 * for ever on a list this test itself broke.
 *
 * @param {any} memory @param {number} head
 */
function walkList(memory, head){
    /** @type {number[]} */
    const nodes = [];
    let at = memory.view.getUint32(head, true);
    for (let guard = 0; at !== head && guard < 100; guard++)
    {
        nodes.push(at);
        at = memory.view.getUint32(at, true);
    }
    assert.equal(at, head, 'the walk returned to the head, or the list is not really circular');
    return nodes;
}

/** @param {any} memory @param {number} at @param {number} length */
function readWide(memory, at, length){
    let text = '';
    for (let index = 0; index < length; index++)
    {
        text += String.fromCharCode(memory.view.getUint16(at + index * 2, true));
    }
    return text;
}

/** @param {any} memory @param {number} descriptorAt */
function readUnicodeString(memory, descriptorAt){
    const length = memory.view.getUint16(descriptorAt, true);
    const buffer = memory.view.getUint32(descriptorAt + 4, true);
    return readWide(memory, buffer, length / 2);
}

test('PEB->Ldr is a real block, never null, with three empty circular lists', ()=>{
    // A program that finds this null has every right to fault on the first
    // field it reads -- an anti-tamper check or a plugin loader that walks
    // the module list does exactly that before it does anything else.
    const memory = guest();
    const { peb } = build(memory);

    const ldr = memory.view.getUint32(peb + PEB.LDR, true);
    assert.notEqual(ldr, 0);

    for (const offset of [
        LDR_DATA.IN_LOAD_ORDER_MODULE_LIST,
        LDR_DATA.IN_MEMORY_ORDER_MODULE_LIST,
        LDR_DATA.IN_INITIALIZATION_ORDER_MODULE_LIST,
    ])
    {
        const head = ldr + offset;
        assert.equal(memory.view.getUint32(head, true), head, 'an empty list points at itself');
        assert.equal(memory.view.getUint32(head + 4, true), head);
    }
});

test('the modules given at build time are all three lists, in order, walkable from the head', ()=>{
    const memory = guest();
    const modules = [
        { name: 'kernel32.dll', base: 0x77000000, size: 0x80000, entryPoint: 0x77001000 },
        { name: 'user32.dll', base: 0x77100000, size: 0x40000, entryPoint: 0x77101000 },
        { name: 'app.exe', base: 0x00400000, size: 0x10000, entryPoint: 0x00401000,
            path: 'C:\\App\\app.exe' },
    ];
    const { peb } = build(memory, { modules });
    const ldr = memory.view.getUint32(peb + PEB.LDR, true);

    const loadOrder = walkList(memory, ldr + LDR_DATA.IN_LOAD_ORDER_MODULE_LIST);
    assert.equal(loadOrder.length, modules.length);

    // CONTAINING_RECORD subtracts the link's own offset to get back to the
    // entry -- and InLoadOrderLinks sits at offset zero, so a node walked out
    // of this list is the entry's own address.
    for (const [index, entry] of loadOrder.entries())
    {
        assert.equal(memory.view.getUint32(entry + LDR_ENTRY.DLL_BASE, true), modules[index].base);
        assert.equal(memory.view.getUint32(entry + LDR_ENTRY.ENTRY_POINT, true),
            modules[index].entryPoint);
        assert.equal(memory.view.getUint32(entry + LDR_ENTRY.SIZE_OF_IMAGE, true),
            modules[index].size);
        assert.equal(readUnicodeString(memory, entry + LDR_ENTRY.BASE_DLL_NAME),
            modules[index].name);
        assert.equal(readUnicodeString(memory, entry + LDR_ENTRY.FULL_DLL_NAME),
            modules[index].path ?? modules[index].name);
    }

    // The same entries, reached through either of the other two orderings --
    // by construction here they agree, and CONTAINING_RECORD for each link
    // subtracts that link's own offset rather than the load order's.
    const memoryOrder = walkList(memory, ldr + LDR_DATA.IN_MEMORY_ORDER_MODULE_LIST)
        .map(node=>node - LDR_ENTRY.IN_MEMORY_ORDER_LINKS);
    const initOrder = walkList(memory, ldr + LDR_DATA.IN_INITIALIZATION_ORDER_MODULE_LIST)
        .map(node=>node - LDR_ENTRY.IN_INITIALIZATION_ORDER_LINKS);
    assert.deepEqual(memoryOrder, loadOrder);
    assert.deepEqual(initOrder, loadOrder);
});

test('removeModule unlinks a library from all three lists, both ways round', ()=>{
    const memory = guest();
    const blocks = build(memory, { modules: [
        { name: 'kernel32.dll', base: 0x77000000, size: 0x1000 },
        { name: 'probe.dll', base: 0x10000000, size: 0x1000 },
        { name: 'other.dll', base: 0x10100000, size: 0x1000 },
    ] });
    const ldr = memory.view.getUint32(blocks.peb + PEB.LDR, true);

    blocks.removeModule(0x10000000);
    blocks.removeModule(0x10100000);
    blocks.addModule({ name: 'late.dll', base: 0x10200000, size: 0x1000 });

    for (const [list, link] of [
        [LDR_DATA.IN_LOAD_ORDER_MODULE_LIST, LDR_ENTRY.IN_LOAD_ORDER_LINKS],
        [LDR_DATA.IN_MEMORY_ORDER_MODULE_LIST, LDR_ENTRY.IN_MEMORY_ORDER_LINKS],
        [LDR_DATA.IN_INITIALIZATION_ORDER_MODULE_LIST, LDR_ENTRY.IN_INITIALIZATION_ORDER_LINKS],
    ])
    {
        const head = ldr + list;
        const nodes = walkList(memory, head);
        assert.deepEqual(nodes.map(node=>readUnicodeString(memory,
            node - link + LDR_ENTRY.BASE_DLL_NAME)), ['kernel32.dll', 'late.dll']);
        // Backwards too: every Blink is the node before it.
        let at = memory.view.getUint32(head + 4, true);
        for (const node of [...nodes].reverse())
        {
            assert.equal(at, node);
            at = memory.view.getUint32(at + 4, true);
        }
        assert.equal(at, head);
    }
    blocks.removeModule(0x12345678);
});

test('addModule joins a library LoadLibrary mapped after the process started', ()=>{
    const memory = guest();
    const blocks = build(memory, {
        modules: [{ name: 'kernel32.dll', base: 0x77000000, size: 0x1000, entryPoint: 0x77000100 }],
    });
    const ldr = memory.view.getUint32(blocks.peb + PEB.LDR, true);

    blocks.addModule({ name: 'winmm.dll', base: 0x10000000, size: 0x2000, path: 'C:\\winmm.dll' });

    const loadOrder = walkList(memory, ldr + LDR_DATA.IN_LOAD_ORDER_MODULE_LIST);
    assert.equal(loadOrder.length, 2, 'the module list grew rather than being fixed at start');
    assert.equal(readUnicodeString(memory, loadOrder[1] + LDR_ENTRY.BASE_DLL_NAME), 'winmm.dll');
    assert.equal(memory.view.getUint32(loadOrder[1] + LDR_ENTRY.SIZE_OF_IMAGE, true), 0x2000);
});
