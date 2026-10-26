/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createProcessBlocks, TEB, PEB, PARAMS, LDR_DATA, LDR_ENTRY, END_OF_EXCEPTION_LIST, TLS_SLOTS,
    TEB64, PEB64, PARAMS64, LDR_DATA64, LDR_ENTRY64,
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

/**
 * Memory a thread's blocks come from and go back to, over `memory`'s array: a
 * free list per size, the last given back the first handed out again, and
 * room for `room` blocks out at once.
 *
 * @param {any} memory @param {number} [room]
 */
function threadMemory(memory, room = Infinity){
    /** @type {Map<number, number>} */
    const out = new Map();
    /** @type {Map<number, number[]>} */
    const free = new Map();
    return {
        out,
        /** @param {number} size */
        allocate(size){
            if (out.size >= room)
            {
                return 0;
            }
            const at = free.get(size)?.pop() ?? memory.allocate(size);
            out.set(at, size);
            return at;
        },
        /** @param {number} at */
        free(at){
            const size = /** @type {number} */ (out.get(at));
            out.delete(at);
            free.set(size, [...free.get(size) ?? [], at]);
        },
    };
}

const TEMPLATE = Uint8Array.of(0x34, 0x12, 0xed, 0x5e, 1, 2, 3, 4);

test('a thread\'s blocks, its copies of the images\' thread-local blocks among them, all go back'
    + ' to the memory they came from', ()=>{
    const memory = guest();
    const held = threadMemory(memory);
    const blocks = build(memory, { threadMemory: held });
    const { teb, tls } = blocks.createThreadBlock({ id: 1, stackBase: 0x300000,
        stackLimit: 0x2f0000, locals: [{ slot: 3, template: TEMPLATE, size: 12 },
            { slot: 0, template: TEMPLATE.subarray(0, 4), size: 4 }] });

    const local = memory.view.getUint32(tls + 3 * 4, true);
    assert.deepEqual([...memory.bytes.subarray(local, local + 12)], [...TEMPLATE, 0, 0, 0, 0],
        'the template, then its zeroes, in the slot the image was given');
    assert.equal(memory.view.getUint32(memory.view.getUint32(tls, true), true), 0x5eed1234);
    assert.equal(held.out.size, 4, 'the block, the array and the two copies');

    assert.equal(blocks.releaseThreadBlock(teb), true);
    assert.equal(held.out.size, 0);
    assert.equal(blocks.releaseThreadBlock(teb), false, 'and only once');
});

test('a block made over what an ended thread was given is the new thread\'s, written in full', ()=>{
    // The memory comes back holding whatever the last thread left: its id,
    // its exception frames, its thread-local values.
    const memory = guest();
    const held = threadMemory(memory);
    const blocks = build(memory, { threadMemory: held });
    const locals = [{ slot: 5, template: TEMPLATE, size: 16 }];
    const first = blocks.createThreadBlock({ id: 1, stackBase: 0x300000, stackLimit: 0x2f0000,
        locals });
    const local = memory.view.getUint32(first.tls + 5 * 4, true);
    for (const [at, size] of held.out)
    {
        memory.bytes.fill(0xcc, at, at + size);
    }
    blocks.releaseThreadBlock(first.teb);

    const second = blocks.createThreadBlock({ id: 2, stackBase: 0x400000, stackLimit: 0x3f0000,
        locals });
    assert.equal(second.teb, first.teb, 'the same memory, handed out again');
    assert.equal(memory.view.getUint32(second.teb + TEB.SELF, true), second.teb);
    assert.equal(memory.view.getUint32(second.teb + TEB.THREAD_ID, true), 2);
    assert.equal(memory.view.getUint32(second.teb + TEB.STACK_BASE, true), 0x400000);
    assert.equal(memory.view.getUint32(second.teb + TEB.EXCEPTION_LIST, true),
        END_OF_EXCEPTION_LIST);
    assert.equal(memory.view.getUint32(second.teb + TEB.LAST_ERROR, true), 0);
    assert.equal(memory.view.getUint32(second.teb + TEB.TLS_POINTER, true), second.tls);
    const slots = Array.from({ length: TLS_SLOTS }, (_, slot)=>
        memory.view.getUint32(second.tls + slot * 4, true));
    assert.deepEqual(slots.filter((value, slot)=>slot !== 5 && value !== 0), [],
        'no slot of the last thread\'s values');
    assert.equal(slots[5], local);
    assert.deepEqual([...memory.bytes.subarray(local, local + 16)],
        [...TEMPLATE, ...new Array(8).fill(0)], 'the template again, and its zeroes');
});

test('a thread-local block whose slot is past the array is left out, not written beyond it', ()=>{
    const memory = guest();
    const held = threadMemory(memory);
    const { tls } = build(memory, { threadMemory: held }).createThreadBlock({ id: 1,
        stackBase: 0x300000, stackLimit: 0x2f0000,
        locals: [{ slot: TLS_SLOTS, template: TEMPLATE, size: 8 },
            { slot: 0xffffffff, template: TEMPLATE, size: 8 }] });
    assert.equal(held.out.size, 2, 'the block and its array only');
    assert.equal(memory.view.getUint32(tls + TLS_SLOTS * 4, true), 0);
});

test('a thread there is no room for gets no block, and none of what was taken for it is kept', ()=>{
    for (const room of [0, 1, 2])
    {
        const memory = guest();
        const held = threadMemory(memory, room);
        const block = build(memory, { threadMemory: held }).createThreadBlock({ id: 1,
            stackBase: 0x300000, stackLimit: 0x2f0000,
            locals: [{ slot: 0, template: TEMPLATE, size: 8 }] });
        assert.equal(block, null, `room for ${room} of the three`);
        assert.equal(held.out.size, 0, `room for ${room}: given back`);
    }
});

test('a library loaded after the threads were made gives each its own copy, at its slot, and'
    + ' takes them back when it goes', ()=>{
    const memory = guest();
    const held = threadMemory(memory);
    const blocks = build(memory, { threadMemory: held });
    const first = blocks.createThreadBlock({ id: 1, stackBase: 0x300000, stackLimit: 0x2f0000 });
    const second = blocks.createThreadBlock({ id: 2, stackBase: 0x400000, stackLimit: 0x3f0000,
        locals: [{ slot: 1, template: TEMPLATE, size: 8 }] });
    const before = held.out.size;

    assert.equal(blocks.addThreadLocal({ slot: 6, template: TEMPLATE, size: 12 }), true);
    const copies = [first, second].map(({ tls })=>memory.view.getUint32(tls + 6 * 4, true));
    assert.notEqual(copies[0], copies[1], 'one each');
    for (const copy of copies)
    {
        assert.deepEqual([...memory.bytes.subarray(copy, copy + 12)], [...TEMPLATE, 0, 0, 0, 0]);
    }
    assert.equal(held.out.size, before + 2);

    blocks.removeThreadLocal(6);
    assert.equal(held.out.size, before, 'both given back');
    assert.deepEqual([first, second].map(({ tls })=>memory.view.getUint32(tls + 6 * 4, true)),
        [0, 0], 'and the slot reads zero');
    assert.notEqual(memory.view.getUint32(second.tls + 4, true), 0, 'another image\'s left alone');

    assert.equal(blocks.addThreadLocal({ slot: 6, template: TEMPLATE, size: 12 }), true);
    blocks.releaseThreadBlock(first.teb);
    blocks.releaseThreadBlock(second.teb);
    assert.equal(held.out.size, 0, 'a copy given later goes with its thread');
});

test('a library\'s copies with no room for every thread are none, and a slot past the array none',
    ()=>{
        // Room for both threads' blocks and one copy: the second thread's
        // copy fails, and the first thread's is taken back.
        const memory = guest();
        const held = threadMemory(memory, 5);
        const blocks = build(memory, { threadMemory: held });
        const threads = [1, 2].map(id=>blocks.createThreadBlock({ id,
            stackBase: 0x300000 * id, stackLimit: 0x2f0000 * id }));
        assert.equal(held.out.size, 4);

        assert.equal(blocks.addThreadLocal({ slot: 2, template: TEMPLATE, size: 8 }), false);
        assert.equal(held.out.size, 4, 'nothing kept');
        assert.deepEqual(threads.map(({ tls })=>memory.view.getUint32(tls + 2 * 4, true)), [0, 0]);

        assert.equal(blocks.addThreadLocal({ slot: TLS_SLOTS, template: TEMPLATE, size: 8 }),
            false);
        assert.equal(held.out.size, 4);
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

/**
 * A quadword field of a 64-bit block, as a number: its high half must be
 * zero, every address lying below 4 GiB.
 *
 * @param {any} memory @param {number} at
 */
const quad = (memory, at)=>{
    assert.equal(memory.view.getUint32(at + 4, true), 0, `the high half at 0x${at.toString(16)}`);
    return memory.view.getUint32(at, true);
};

test('a 64-bit thread block is laid out as GS reaches it, its pointers quadwords', ()=>{
    // Compiled code reads gs:[0x30] for the block, gs:[0x58] for the
    // thread-local array, gs:[0x60] for the process block and gs:[0x10] for
    // the stack limit a probe compares against: the 32-bit offsets there
    // are other fields, or the middle of one.
    const memory = guest();
    memory.bytes.fill(0xcc);
    const blocks = build(memory, { pointerSize: 8 });
    const { teb, tls } = blocks.createThreadBlock({ id: 7, stackBase: 0x300000,
        stackLimit: 0x2f0000, locals: [{ slot: 3, template: Uint8Array.of(1, 2, 3), size: 8 }] });

    assert.deepEqual([TEB64.STACK_BASE, TEB64.STACK_LIMIT, TEB64.SELF, TEB64.PROCESS_ID,
        TEB64.THREAD_ID, TEB64.TLS_POINTER, TEB64.PEB, TEB64.LAST_ERROR],
    [0x08, 0x10, 0x30, 0x40, 0x48, 0x58, 0x60, 0x68]);
    assert.equal(quad(memory, teb + TEB64.EXCEPTION_LIST), 0, 'no chain: handlers are in tables');
    assert.equal(quad(memory, teb + TEB64.STACK_BASE), 0x300000);
    assert.equal(quad(memory, teb + TEB64.STACK_LIMIT), 0x2f0000);
    assert.equal(quad(memory, teb + TEB64.SELF), teb);
    assert.equal(quad(memory, teb + TEB64.PROCESS_ID), 0x1234);
    assert.equal(quad(memory, teb + TEB64.THREAD_ID), 7);
    assert.equal(quad(memory, teb + TEB64.TLS_POINTER), tls);
    assert.equal(quad(memory, teb + TEB64.PEB), blocks.peb);
    // The array's slots are pointers too: the image's copy at slot 3, the
    // others zero, in all their eight bytes.
    const copy = quad(memory, tls + 3 * 8);
    assert.deepEqual([...memory.bytes.subarray(copy, copy + 8)], [1, 2, 3, 0, 0, 0, 0, 0]);
    assert.equal(quad(memory, tls + 2 * 8), 0);
    assert.equal(quad(memory, tls + (TLS_SLOTS - 1) * 8), 0);

    blocks.removeThreadLocal(3);
    assert.equal(quad(memory, tls + 3 * 8), 0, 'a slot taken back reads zero, all of it');
});

test('a 64-bit process block holds its pointers and version where x64 code reads them', ()=>{
    const memory = guest();
    memory.bytes.fill(0xcc);
    const { peb, params } = build(memory, {
        pointerSize: 8, processHeap: 0x0c000000, processors: 4,
        version: { major: 10, minor: 0, build: 19045, servicePackMajor: 3,
            csdVersion: 'Service Pack 3' },
        commandLine: '"C:\\App\\x.exe" one', standardHandles: { input: 0x10, output: 0x14,
            error: 0x18 },
    });
    assert.equal(quad(memory, peb + PEB64.IMAGE_BASE_ADDRESS), 0x00400000);
    assert.equal(quad(memory, peb + PEB64.PROCESS_PARAMETERS), params);
    assert.equal(quad(memory, peb + PEB64.PROCESS_HEAP), 0x0c000000);
    assert.equal(memory.view.getUint32(peb + PEB64.NUMBER_OF_PROCESSORS, true), 4);
    assert.equal(memory.view.getUint32(peb + PEB64.OS_MAJOR_VERSION, true), 10);
    assert.equal(memory.view.getUint32(peb + PEB64.OS_MINOR_VERSION, true), 0);
    assert.equal(memory.view.getUint16(peb + PEB64.OS_BUILD_NUMBER, true), 19045);
    assert.equal(memory.view.getUint32(peb + PEB64.OS_PLATFORM_ID, true), 2);
    assert.equal(readUnicodeString64(memory, peb + PEB64.CSD_VERSION), 'Service Pack 3');
    assert.ok(params >= peb + PEB64.SIZE, 'the parameters lie past the whole process block');

    assert.equal(quad(memory, params + PARAMS64.STANDARD_INPUT), 0x10);
    assert.equal(quad(memory, params + PARAMS64.STANDARD_OUTPUT), 0x14);
    assert.equal(quad(memory, params + PARAMS64.STANDARD_ERROR), 0x18);
    assert.equal(readUnicodeString64(memory, params + PARAMS64.COMMAND_LINE),
        '"C:\\App\\x.exe" one');
});

test('a 64-bit module list links quadword pointers, walkable from the head', ()=>{
    const memory = guest();
    const modules = [
        { name: 'kernel32.dll', base: 0x77000000, size: 0x80000, entryPoint: 0x77001000 },
        { name: 'app.exe', base: 0x00400000, size: 0x10000, entryPoint: 0x00401000,
            path: 'C:\\App\\app.exe' },
    ];
    const blocks = build(memory, { pointerSize: 8, modules });
    const ldr = quad(memory, blocks.peb + PEB64.LDR);
    assert.equal(memory.view.getUint32(ldr + LDR_DATA64.LENGTH, true), LDR_DATA64.SIZE);

    for (const [list, link] of /** @type {const} */ ([
        [LDR_DATA64.IN_LOAD_ORDER_MODULE_LIST, LDR_ENTRY64.IN_LOAD_ORDER_LINKS],
        [LDR_DATA64.IN_MEMORY_ORDER_MODULE_LIST, LDR_ENTRY64.IN_MEMORY_ORDER_LINKS],
        [LDR_DATA64.IN_INITIALIZATION_ORDER_MODULE_LIST, LDR_ENTRY64.IN_INITIALIZATION_ORDER_LINKS],
    ]))
    {
        const head = ldr + list;
        /** @type {number[]} */
        const forward = [];
        for (let at = quad(memory, head); at !== head; at = quad(memory, at))
        {
            forward.push(at - link);
            assert.ok(forward.length <= modules.length, 'the list comes back to its head');
        }
        /** @type {number[]} */
        const backward = [];
        for (let at = quad(memory, head + 8); at !== head; at = quad(memory, at + 8))
        {
            backward.unshift(at - link);
            assert.ok(backward.length <= modules.length);
        }
        assert.deepEqual(backward, forward, 'Blink, eight bytes on, walks it the other way');
        forward.forEach((entry, index)=>{
            assert.equal(quad(memory, entry + LDR_ENTRY64.DLL_BASE), modules[index].base);
            assert.equal(quad(memory, entry + LDR_ENTRY64.ENTRY_POINT), modules[index].entryPoint);
            assert.equal(memory.view.getUint32(entry + LDR_ENTRY64.SIZE_OF_IMAGE, true),
                modules[index].size);
            assert.equal(readUnicodeString64(memory, entry + LDR_ENTRY64.BASE_DLL_NAME),
                modules[index].name);
            assert.equal(readUnicodeString64(memory, entry + LDR_ENTRY64.FULL_DLL_NAME),
                modules[index].path ?? modules[index].name);
        });
    }
});

/**
 * A 64-bit UNICODE_STRING: the two counts, four bytes of padding, and the
 * buffer's quadword pointer.
 *
 * @param {any} memory @param {number} descriptorAt
 */
function readUnicodeString64(memory, descriptorAt){
    const length = memory.view.getUint16(descriptorAt, true);
    return readWide(memory, quad(memory, descriptorAt + 8), length / 2);
}
