/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The heap's small blocks: the guest's routines run on cork's test machine
 * over the same memory the host's half reads and writes, each call either
 * answered in the guest or handed to its trap -- a stub here that marks the
 * hand-over, after which the test answers it as the host would. Each test
 * runs twice: the i386 routines, and their x86-64 (`guest-heap-long.js`) on
 * cork's long-mode machine, called as the x64 convention calls, whose trap
 * stub keeps the four argument registers to be held to the call's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../../../../../cork/src/testing/machine.js';
import { createHeapAllocator } from './heap.js';
import {
    CACHE, CONTROL, HEAP_MAGIC, SLAB, SMALL_LIMIT, callocCode, createGuestHeap, freeCode,
    heapAllocCode, heapFreeCode, heapReAllocCode, heapSizeCode, mallocCode, msizeCode,
    reallocCode,
} from './guest-heap.js';
import {
    callocLongCode, freeLongCode, heapAllocLongCode, heapFreeLongCode, heapReAllocLongCode,
    heapSizeLongCode, mallocLongCode, msizeLongCode, reallocLongCode,
} from './guest-heap-long.js';
import {
    ENTRY_64, KEPT_64, argumentOf, longMachine,
} from '../../../../scripts/guest-code/long.mjs';

const ARENA = { base: 0x100000, size: 0x300000 };
const CODE = 0x10000;
const HALT = 0xf000;
const STACK = 0x8000;
/** Where a trap stub marks that its routine handed the call over. */
const HANDED = 0xe000;
const HEAP_ZERO_MEMORY = 0x8;
const HEAP_REALLOC_IN_PLACE_ONLY = 0x10;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** Where the 64-bit trap stub keeps RCX, RDX, R8 and R9 as it found them. */
const ARGS = 0xe100;

/**
 * What each routine's arguments are at 64 bits: a DWORD's upper half is
 * undefined, and the call gives it a pattern; a pointer's and a size's are
 * the value's own.
 *
 * @type {Record<string, ('word' | 'dword')[]>}
 */
const KINDS = {
    HeapAlloc: ['word', 'dword', 'word'],
    HeapFree: ['word', 'dword', 'word'],
    HeapSize: ['word', 'dword', 'word'],
    HeapReAlloc: ['word', 'dword', 'word', 'word'],
    malloc: ['word'],
    calloc: ['word', 'word'],
    free: ['word'],
    realloc: ['word', 'word'],
    _msize: ['word'],
};

/**
 * The guest memory the host's half is handed, over a machine's RAM.
 *
 * @param {() => Uint8Array} ram @param {() => DataView} view
 */
function heapMemory(ram, view){
    return {
        readU16: (/** @type {number} */ at)=>view().getUint16(at, true),
        readU32: (/** @type {number} */ at)=>view().getUint32(at, true),
        writeU16: (/** @type {number} */ at, /** @type {number} */ value)=>{
            view().setUint16(at, value, true);
        },
        writeU32: (/** @type {number} */ at, /** @type {number} */ value)=>{
            view().setUint32(at, value >>> 0, true);
        },
        readBytes: (/** @type {number} */ at, /** @type {number} */ length)=>
            ram().subarray(at, at + length),
        writeBytes: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>{
            ram().set(bytes, at);
        },
        /** @param {number} at @param {number} value @param {number} length */
        fillBytes(at, value, length){
            ram().fill(value, at, at + length);
        },
    };
}

/**
 * The guest heap over a machine's memory, with the heaps the tests use.
 *
 * @param {ReturnType<typeof heapMemory>} memory
 */
function heapsOver(memory){
    const backend = createHeapAllocator(ARENA);
    const guest = createGuestHeap({ allocator: backend, arena: ARENA, memory });
    const heap = guest.createHeap();
    const other = guest.createHeap();
    const placement = /** @type {import('./guest-heap.js').Placement} */ (guest.placement());
    return { backend, guest, heap, other, placement, allocator: guest.wrap() };
}

/**
 * A machine with the guest heap over its memory, every routine placed, and a
 * call that says which side answered.
 */
function world(){
    const m = createTestMachine({ ramSize: 4 << 20 });
    const ram = ()=>new Uint8Array(m.memory.buffer, m.layout.ramBase, 4 << 20);
    const view = ()=>new DataView(m.memory.buffer, m.layout.ramBase, 4 << 20);
    const memory = heapMemory(ram, view);
    const { backend, guest, heap, other, placement, allocator } = heapsOver(memory);
    m.write(HALT, [0xf4]);
    /** @type {Record<string, number>} */
    const at = {};
    let next = CODE;
    /**
     * @param {string} name @param {number} pop
     * @param {(p: import('./guest-heap.js').Placement, at: number, trap: number)
     *     => Uint8Array} make
     */
    const place = (name, pop, make)=>{
        // The trap: mark the hand-over, answer 0, and return as the routine would.
        const trap = next;
        m.write(trap, [0xc7, 0x05, ...u32(HANDED), ...u32(1), 0x31, 0xc0,
            ...pop === 0 ? [0xc3] : [0xc2, pop, 0]]);
        const code = make(placement, trap + 0x20, trap);
        m.write(trap + 0x20, code);
        at[name] = trap + 0x20;
        next = (trap + 0x20 + code.length + 0xff) & ~0xff;
    };
    place('HeapAlloc', 12, heapAllocCode);
    place('HeapFree', 12, heapFreeCode);
    place('HeapSize', 12, heapSizeCode);
    place('HeapReAlloc', 16, heapReAllocCode);
    place('malloc', 0, (p, where, trap)=>mallocCode(p, where, trap, heap));
    place('calloc', 0, (p, where, trap)=>callocCode(p, where, trap, heap));
    place('free', 0, freeCode);
    place('realloc', 0, reallocCode);
    place('_msize', 0, msizeCode);
    /**
     * @param {string} name @param {number[]} args
     * @returns {{ eax: number, handed: boolean }}
     */
    const call = (name, args)=>{
        m.writeU32(HANDED, 0);
        m.writeU32(STACK, HALT);
        args.forEach((value, i)=>m.writeU32(STACK + 4 + i * 4, value));
        m.setReg('esp', STACK);
        for (const register of ['ebx', 'esi', 'edi', 'ebp'])
        {
            m.setReg(register, 0x5a5a0000 + register.charCodeAt(1));
        }
        const exit = m.runProgram(at[name]);
        assert.equal(exit.kind, 3, `${name} ran to its return: ${JSON.stringify(exit)}`);
        for (const register of ['ebx', 'esi', 'edi', 'ebp'])
        {
            assert.equal(m.reg(register), 0x5a5a0000 + register.charCodeAt(1),
                `${name} kept ${register}`);
        }
        return { eax: m.reg('eax'), handed: m.readU32(HANDED) === 1 };
    };
    return { m, memory, ram, guest, heap, other, allocator, backend, call };
}

/**
 * The same over cork's long-mode machine: the x86-64 routines, each placed
 * after a trap stub that marks the hand-over and keeps RCX, RDX, R8 and R9,
 * and a call made as the x64 convention makes one, every register a pattern.
 * A hand-over is held to the arguments the call was made with; a routine's
 * answer to its upper half being zero; and every call to the registers the
 * convention says a callee keeps.
 */
function world64(){
    const m = longMachine();
    const ram = ()=>m.bytes().subarray(0, 4 << 20);
    const view = ()=>new DataView(m.bytes().buffer, 0, 4 << 20);
    const memory = heapMemory(ram, view);
    const { backend, guest, heap, other, placement, allocator } = heapsOver(memory);
    m.write(HALT, [0xf4]);
    /** @type {Record<string, number>} */
    const at = {};
    let next = CODE;
    /**
     * @param {string} name
     * @param {(p: import('./guest-heap.js').Placement)
     *     => import('./guest-heap-long.js').LongRoutine} make
     */
    const place = (name, make)=>{
        const trap = next;
        m.write(trap, [
            0xc7, 0x04, 0x25, ...u32(HANDED), ...u32(1),     // mov dword [HANDED], 1
            0x48, 0x89, 0x0c, 0x25, ...u32(ARGS),            // mov [ARGS], rcx
            0x48, 0x89, 0x14, 0x25, ...u32(ARGS + 8),        // mov [ARGS + 8], rdx
            0x4c, 0x89, 0x04, 0x25, ...u32(ARGS + 16),       // mov [ARGS + 16], r8
            0x4c, 0x89, 0x0c, 0x25, ...u32(ARGS + 24),       // mov [ARGS + 24], r9
            0x31, 0xc0, 0xc3,                                // xor eax, eax; ret
        ]);
        const { code, jump } = make(placement);
        const where = trap + 0x40;
        const bytes = code.slice();
        new DataView(bytes.buffer).setInt32(jump, trap - (where + jump + 4), true);
        m.write(where, bytes);
        at[name] = where;
        next = (where + bytes.length + 0xff) & ~0xff;
    };
    place('HeapAlloc', heapAllocLongCode);
    place('HeapFree', heapFreeLongCode);
    place('HeapSize', heapSizeLongCode);
    place('HeapReAlloc', heapReAllocLongCode);
    place('malloc', p=>mallocLongCode(p, heap));
    place('calloc', p=>callocLongCode(p, heap));
    place('free', freeLongCode);
    place('realloc', reallocLongCode);
    place('_msize', msizeLongCode);
    const ARGUMENTS = ['rcx', 'rdx', 'r8', 'r9'];
    /**
     * @param {string} name @param {(number | bigint)[]} args  A bigint is passed whole.
     * @returns {{ eax: number, handed: boolean }}
     */
    const call = (name, args)=>{
        view().setUint32(HANDED, 0, true);
        const given = args.map((value, i)=>(typeof value === 'bigint' ? value
            : KINDS[name][i] === 'dword' ? argumentOf(value, i) : BigInt(value >>> 0)));
        /** @type {Record<string, bigint>} */
        const registers = { ...ENTRY_64, rcx: 0xc5c5c5c5c5c5c5c5n, rdx: 0xd5d5d5d5d5d5d5d5n,
            r8: 0x8888888888888888n, r9: 0x9999999999999999n, rsp: BigInt(STACK) };
        given.forEach((value, i)=>{
            registers[ARGUMENTS[i]] = value;
        });
        view().setBigUint64(STACK, BigInt(HALT), true);
        ram().fill(0xcd, STACK + 8, STACK + 40);
        const { halted } = m.call(at[name], registers);
        assert.ok(halted && m.rip() === HALT + 1, `${name} ran to its return`);
        assert.equal(m.reg('rsp'), BigInt(STACK + 8), `${name} took its frame down`);
        for (const register of KEPT_64)
        {
            assert.equal(m.reg(register), registers[register], `${name} kept ${register}`);
        }
        const handed = view().getUint32(HANDED, true) === 1;
        const rax = m.reg('rax');
        if (handed)
        {
            given.forEach((value, i)=>assert.equal(view().getBigUint64(ARGS + i * 8, true), value,
                `${name} handed over ${ARGUMENTS[i]} as it came`));
        }
        else if (name !== 'free')
        {
            assert.equal(rax >> 32n, 0n, `${name}'s answer is whole in RAX`);
        }
        // free answers nothing: its RAX is no answer.
        return { eax: name === 'free' ? 0 : Number(rax & 0xffffffffn), handed };
    };
    return { m, memory, ram, guest, heap, other, allocator, backend, call };
}

/**
 * A test on both machines: the i386 routines, then their x86-64.
 *
 * @param {string} name
 * @param {(w: ReturnType<typeof world>) => void} body
 */
function both(name, body){
    test(name, ()=>body(world()));
    test(`${name} (x86-64)`, ()=>body(/** @type {any} */ (world64())));
}

both('a block allocated in the guest is sized, resized in place and freed in the guest,'
    + ' once the host has filled the cache', w=>{
    const first = w.call('HeapAlloc', [w.heap, 0, 24]);
    assert.equal(first.handed, true, 'the cache starts empty: the host fills it');
    const block = w.allocator.allocate(24, { owner: w.heap });
    assert.ok(block !== 0);
    const second = w.call('HeapAlloc', [w.heap, 0, 20]);
    assert.equal(second.handed, false, 'then the guest takes one');
    assert.equal(second.eax % 8, 0);
    assert.notEqual(second.eax, block);
    assert.deepEqual(w.call('HeapSize', [w.heap, 0, second.eax]), { eax: 20, handed: false });
    assert.deepEqual(w.call('HeapSize', [w.heap, 0, block]), { eax: 24, handed: false });
    assert.equal(w.allocator.block(second.eax)?.size, 20, 'the host sees its size');
    assert.equal(w.allocator.block(second.eax)?.owner, w.heap);
    // Grown within its cell and shrunk: in place.
    assert.deepEqual(w.call('HeapReAlloc', [w.heap, 0, second.eax, 24]),
        { eax: second.eax, handed: false });
    assert.deepEqual(w.call('HeapSize', [w.heap, 0, second.eax]), { eax: 24, handed: false });
    assert.deepEqual(w.call('HeapReAlloc', [w.heap, HEAP_REALLOC_IN_PLACE_ONLY, second.eax, 3]),
        { eax: second.eax, handed: false });
    assert.equal(w.allocator.block(second.eax)?.size, 3);
    // Past its cell: the host's, which moves it.
    assert.equal(w.call('HeapReAlloc', [w.heap, 0, second.eax, 25]).handed, true);
    assert.deepEqual(w.call('HeapFree', [w.heap, 0, second.eax]), { eax: 1, handed: false });
    assert.equal(w.allocator.block(second.eax), null, 'free to the host too');
    assert.equal(w.call('HeapFree', [w.heap, 0, second.eax]).handed, true,
        'a second free is the host\'s to refuse');
    assert.equal(w.call('HeapSize', [w.heap, 0, second.eax]).handed, true);
    assert.deepEqual(w.call('HeapFree', [w.heap, 0, 0]), { eax: 1, handed: false },
        'a null pointer is TRUE');
});

both('what the guest\'s path does not take goes to the host', w=>{
    w.allocator.free(w.allocator.allocate(8, { owner: w.heap }));
    assert.equal(w.call('HeapAlloc', [w.heap, 0, SMALL_LIMIT + 1]).handed, true, 'too large');
    assert.equal(w.call('HeapAlloc', [w.heap, 0x20, 8]).handed, true, 'a flag it does not take');
    assert.equal(w.call('HeapAlloc', [0, 0, 8]).handed, true, 'no heap');
    assert.equal(w.call('HeapAlloc', [w.heap + 0x100, 0, 8]).handed, true, 'not a heap');
    assert.equal(w.call('HeapAlloc', [0x7ff00000, 0, 8]).handed, true, 'outside the arena');
    const block = w.call('HeapAlloc', [w.heap, 1 | 4, 8]);
    assert.equal(block.handed, false, 'HEAP_NO_SERIALIZE and HEAP_GENERATE_EXCEPTIONS are taken');
    assert.equal(w.call('HeapFree', [w.other, 0, block.eax]).handed, true, 'another heap\'s');
    assert.equal(w.call('HeapSize', [w.other, 0, block.eax]).handed, true);
    assert.equal(w.call('HeapFree', [w.heap, 0, block.eax + 4]).handed, true, 'inside a cell');
    const large = w.allocator.allocate(4096, { owner: w.heap });
    assert.equal(w.call('HeapFree', [w.heap, 0, large]).handed, true, 'a block of the host\'s');
    assert.equal(w.call('free', [0x20]).handed, true, 'below the arena');
    assert.deepEqual(w.call('free', [0]), { eax: 0, handed: false });
    // The lock another thread holds: every path hands over.
    w.memory.writeU32(w.heap + CONTROL.LOCK, 1);
    assert.equal(w.call('HeapAlloc', [w.heap, 0, 8]).handed, true, 'the lock is held');
    assert.equal(w.call('HeapFree', [w.heap, 0, block.eax]).handed, true);
    const meanwhile = w.allocator.allocate(8, { owner: w.heap });
    assert.ok(meanwhile !== 0, 'the host allocates beside the cache');
    assert.ok(w.allocator.free(meanwhile));
    assert.equal(w.memory.readU32(w.heap + CONTROL.LOCK), 1, 'and leaves the lock as it was');
    w.memory.writeU32(w.heap + CONTROL.LOCK, 0);
    assert.deepEqual(w.call('HeapFree', [w.heap, 0, block.eax]), { eax: 1, handed: false });
});

both('the host takes and gives back a heap\'s lock in one step each, and leaves a held one'
    + ' alone', w=>{
    /** What each compare-and-swap found. @type {number[]} */
    const found = [];
    Object.assign(w.memory, {
        /** @param {number} at @param {number} expected @param {number} value */
        compareExchangeU32(at, expected, value){
            const was = w.memory.readU32(at);
            if (was === expected)
            {
                w.memory.writeU32(at, value);
            }
            found.push(was);
            return was;
        },
    });
    const block = w.allocator.allocate(8, { owner: w.heap });
    assert.ok(block !== 0);
    assert.deepEqual(found, [0, 1], 'taken free, and given back as one step too');
    assert.equal(w.memory.readU32(w.heap + CONTROL.LOCK), 0, 'and given back');
    // Held by a thread running on another executor: the host keeps off the cache.
    w.memory.writeU32(w.heap + CONTROL.LOCK, 1);
    const cache = w.guest.diagnostics();
    assert.ok(w.allocator.free(block));
    assert.deepEqual(found, [0, 1, 1]);
    assert.equal(w.memory.readU32(w.heap + CONTROL.LOCK), 1, 'still the other thread\'s');
    assert.deepEqual(w.guest.diagnostics().cached, cache.cached, 'the cache untouched');
});

both('HEAP_ZERO_MEMORY and calloc zero a recycled block, and a grown one past its old end', w=>{
    w.allocator.free(w.allocator.allocate(100, { owner: w.heap }));
    const dirty = w.call('HeapAlloc', [w.heap, 0, 100]).eax;
    w.ram().fill(0xaa, dirty, dirty + 100);
    assert.equal(w.call('HeapFree', [w.heap, 0, dirty]).handed, false);
    const zeroed = w.call('HeapAlloc', [w.heap, HEAP_ZERO_MEMORY, 99]);
    assert.deepEqual(zeroed, { eax: dirty, handed: false }, 'the same cell, last in first out');
    assert.ok(w.ram().subarray(dirty, dirty + 99).every(byte=>byte === 0));
    w.ram().fill(0xbb, dirty, dirty + 99);
    assert.equal(w.call('HeapReAlloc', [w.heap, HEAP_ZERO_MEMORY, dirty, 40]).eax, dirty);
    w.ram().fill(0xcc, dirty + 40, dirty + 112);
    assert.equal(w.call('HeapReAlloc', [w.heap, HEAP_ZERO_MEMORY, dirty, 110]).eax, dirty);
    assert.ok(w.ram().subarray(dirty, dirty + 40).every(byte=>byte === 0xbb), 'kept');
    assert.ok(w.ram().subarray(dirty + 40, dirty + 110).every(byte=>byte === 0), 'gained, zero');
    assert.equal(w.call('free', [dirty]).handed, false);
    const again = w.call('calloc', [11, 10]);
    assert.deepEqual(again, { eax: dirty, handed: false });
    assert.ok(w.ram().subarray(dirty, dirty + 110).every(byte=>byte === 0));
    assert.deepEqual(w.call('_msize', [dirty]), { eax: 110, handed: false });
    assert.equal(w.call('calloc', [0x10000, 0x10001]).handed, true, 'past 32 bits');
    assert.equal(w.call('calloc', [33, 32]).handed, true, 'past a kilobyte');
});

both('a full cache hands half back, and a slab whose cells all come back leaves the arena', w=>{
    const cells = SLAB / 64;
    /** @type {number[]} */
    const blocks = [];
    for (let i = 0; i < cells * 3; i++)
    {
        let { eax, handed } = w.call('malloc', [64]);
        if (handed)
        {
            eax = w.allocator.allocate(64, { owner: w.heap });
        }
        blocks.push(eax);
    }
    assert.equal(new Set(blocks).size, blocks.length);
    assert.equal(w.guest.diagnostics().slabs, 3);
    let handedOver = 0;
    for (const block of blocks)
    {
        if (w.call('free', [block]).handed)
        {
            handedOver++;
            assert.ok(w.allocator.free(block));
        }
    }
    assert.ok(handedOver > 0 && handedOver < blocks.length / 10,
        `${handedOver} frees found the cache full`);
    const d = w.guest.diagnostics();
    assert.ok(d.released >= 1, `slabs given back: ${JSON.stringify(d)}`);
    assert.ok(d.cached <= CACHE);
    assert.equal(w.allocator.owned(w.heap).length, 0);
});

both('HeapDestroy\'s half takes every slab and the handle with it', w=>{
    const before = w.backend.diagnostics().used;
    const heap = w.guest.createHeap();
    for (let i = 0; i < 50; i++)
    {
        const { eax, handed } = w.call('HeapAlloc', [heap, 0, 8 + i * 16]);
        if (handed)
        {
            assert.ok(w.allocator.allocate(8 + i * 16, { owner: heap }) !== 0);
        }
        else
        {
            assert.ok(eax !== 0);
        }
    }
    assert.ok(w.allocator.owned(heap).length === 50);
    assert.ok(w.guest.destroyHeap(heap));
    assert.equal(w.backend.diagnostics().used, before);
    assert.equal(w.memory.readU32(heap + CONTROL.MAGIC), 0);
    assert.equal(w.call('HeapAlloc', [heap, 0, 8]).handed, true, 'the handle is no heap now');
    assert.equal(w.guest.isHeap(heap), false);
});

both('a heap\'s handle is its control block, on a 64 KiB boundary, marked as a heap', w=>{
    for (const heap of [w.heap, w.other])
    {
        assert.equal(heap % 0x10000, 0);
        assert.equal(w.memory.readU32(heap + CONTROL.MAGIC), HEAP_MAGIC);
    }
    assert.deepEqual(w.guest.list(), [w.heap, w.other]);
});

both('thousands of random calls from both sides keep every block whole and apart', w=>{
    let state = 12345;
    const random = (/** @type {number} */ n)=>{
        state = Math.imul(state ^ state >>> 15, 0x2c1b3c6d) + 0x297a2d39 | 0;
        return (state >>> 0) % n;
    };
    /** @type {Map<number, { size: number, fill: number, heap: number }>} */
    const live = new Map();
    let guestCalls = 0;
    let hostCalls = 0;
    const heaps = [w.heap, w.other];
    const sizeOf = ()=>(random(10) === 0 ? 1025 + random(3000) : random(10) < 7
        ? random(129) : random(1025));
    /** @param {number} address @param {number} size @param {number} fill */
    const paint = (address, size, fill)=>{
        w.ram().fill(fill, address, address + size);
    };
    /** @param {number} address */
    const check = address=>{
        const { size, fill } = /** @type {{ size: number, fill: number }} */ (live.get(address));
        const bytes = w.ram().subarray(address, address + size);
        assert.ok(bytes.every(byte=>byte === fill), `block ${address.toString(16)} intact`);
    };
    for (let step = 0; step < 4000; step++)
    {
        const op = random(10);
        const byHost = random(4) === 0;
        if (op < 4 || live.size === 0)
        {
            const heap = heaps[random(2)];
            const size = sizeOf();
            let address = 0;
            const zero = random(3) === 0;
            if (!byHost)
            {
                const { eax, handed } = heap === w.heap && random(2) === 0
                    ? w.call(zero ? 'calloc' : 'malloc', zero ? [1, size] : [size])
                    : w.call('HeapAlloc', [heap, zero ? HEAP_ZERO_MEMORY : 0, size]);
                address = handed ? 0 : eax;
                guestCalls += handed ? 0 : 1;
            }
            if (address === 0)
            {
                address = w.allocator.allocate(size, { owner: heap });
                hostCalls++;
                if (zero)
                {
                    w.ram().fill(0, address, address + size);
                }
            }
            assert.ok(address !== 0 && address % 8 === 0);
            if (zero)
            {
                assert.ok(w.ram().subarray(address, address + size).every(byte=>byte === 0));
            }
            for (const [other, block] of live)
            {
                assert.ok(address + Math.max(size, 1) <= other
                    || other + Math.max(block.size, 1) <= address,
                `${address.toString(16)}+${size} overlaps ${other.toString(16)}+${block.size}`);
            }
            const fill = 1 + random(255);
            paint(address, size, fill);
            live.set(address, { size, fill, heap });
            continue;
        }
        const keys = [...live.keys()];
        const address = keys[random(keys.length)];
        const block = /** @type {{ size: number, fill: number, heap: number }} */ (
            live.get(address));
        check(address);
        if (op < 7)
        {
            const size = byHost ? w.allocator.block(address)?.size
                : random(2) === 0 ? w.call('_msize', [address]) : w.call('HeapSize',
                    [block.heap, 0, address]);
            const answered = typeof size === 'number' ? size
                : size?.handed ? w.allocator.block(address)?.size : size?.eax;
            assert.equal(answered, block.size, 'the size asked for');
            live.delete(address);
            let freed = false;
            if (!byHost)
            {
                const { handed } = random(2) === 0 ? w.call('free', [address])
                    : w.call('HeapFree', [block.heap, 0, address]);
                freed = !handed;
                guestCalls += handed ? 0 : 1;
            }
            if (!freed)
            {
                assert.ok(w.allocator.free(address));
                hostCalls++;
            }
            assert.equal(w.allocator.block(address), null);
            continue;
        }
        // Resized: in place when it fits, and moved by the host otherwise.
        const size = sizeOf();
        const { eax, handed } = byHost ? { eax: 0, handed: true } : random(2) === 0
            ? w.call('realloc', [address, size]) : w.call('HeapReAlloc',
                [block.heap, 0, address, size]);
        let moved = eax;
        if (handed)
        {
            hostCalls++;
            if (w.allocator.resize(address, size))
            {
                moved = address;
            }
            else
            {
                moved = w.allocator.allocate(size, { owner: block.heap });
                w.ram().copyWithin(moved, address, address + Math.min(size, block.size));
                assert.ok(w.allocator.free(address));
            }
        }
        else
        {
            guestCalls++;
            assert.equal(moved, address, 'the guest resizes in place');
        }
        live.delete(address);
        const kept = Math.min(size, block.size);
        assert.ok(w.ram().subarray(moved, moved + kept).every(byte=>byte === block.fill));
        paint(moved, size, block.fill);
        live.set(moved, { size, fill: block.fill, heap: block.heap });
        assert.equal(w.allocator.block(moved)?.size, size);
    }
    for (const address of live.keys())
    {
        check(address);
        assert.equal(w.allocator.block(address)?.size, live.get(address)?.size);
    }
    const owned = new Set([...w.allocator.owned(w.heap), ...w.allocator.owned(w.other)]);
    assert.deepEqual([...owned].sort((a, b)=>a - b), [...live.keys()].sort((a, b)=>a - b),
        'the host walks exactly the live blocks');
    assert.ok(guestCalls > hostCalls, `${guestCalls} in the guest, ${hostCalls} in the host`);
});

test('at 64 bits a pointer or a size with an upper half is the host\'s, its arguments as they came',
    ()=>{
        const w = world64();
        // Each class a size's low half falls in has a cell cached: only the upper half
        // can send these calls to the host.
        for (const size of [8, 24])
        {
            w.allocator.free(w.allocator.allocate(size, { owner: w.heap }));
        }
        const block = w.call('HeapAlloc', [w.heap, 0, 24]);
        assert.equal(block.handed, false);
        const high = BigInt(block.eax) | 1n << 32n;
        const huge = 1n << 32n | 8n;
        assert.equal(w.call('HeapAlloc', [w.heap, 0, huge]).handed, true, 'a size past 32 bits');
        assert.equal(w.call('malloc', [huge]).handed, true);
        assert.equal(w.call('calloc', [1n << 32n, 1]).handed, true);
        assert.equal(w.call('calloc', [1, 1n << 32n]).handed, true);
        assert.equal(w.call('calloc', [1n << 63n, 2]).handed, true, 'a product past 64 bits');
        assert.equal(w.call('calloc', [2, 1n << 63n]).handed, true);
        for (const name of ['HeapFree', 'HeapSize'])
        {
            assert.equal(w.call(name, [w.heap, 0, high]).handed, true, `${name} of a pointer`
                + ' whose low half is a cell');
        }
        assert.equal(w.call('HeapReAlloc', [w.heap, 0, high, 16]).handed, true);
        assert.equal(w.call('HeapReAlloc', [w.heap, 0, block.eax, huge]).handed, true,
            'a new size past 32 bits, R9 given back');
        for (const name of ['free', '_msize'])
        {
            assert.equal(w.call(name, [high]).handed, true, name);
        }
        assert.equal(w.call('realloc', [high, 16]).handed, true);
        assert.equal(w.call('realloc', [block.eax, huge]).handed, true);
        assert.deepEqual(w.call('HeapSize', [w.heap, 0, block.eax]), { eax: 24, handed: false },
            'and the block as it was');
        assert.deepEqual(w.call('HeapFree', [w.heap, 0, block.eax]), { eax: 1, handed: false });
    });
