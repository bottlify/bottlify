/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fibers against a host of plain words: what a switch keeps, what it puts in
 * the thread block and the kernel's idea of the stack, and what each call
 * refuses. The switch on a real stack is fibers.itest.js.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFiberFunctions } from './fibers.js';
import { TEB } from './teb.js';

const TEB_AT = 0x7ffd0000;
const RETURN_STUB = 0x00777000;

function setup({ room = true } = {}){
    /** @type {Map<number, number>} */
    const words = new Map();
    let heap = 0x00900000;
    let stacks = 0x00500000;
    /** @type {Record<string, number>} */
    let registers = { ebx: 1, esi: 2, edi: 3, ebp: 4, esp: 0x00120000, eip: 0x00401000 };
    /** @type {Record<string, number>[]} */
    const set = [];
    /** @type {number[]} */
    const errors = [];
    /** @type {any[]} */
    const released = [];
    /** @type {number[]} */
    const exits = [];
    const thread = { stackTop: 0x00130000, stackLimit: 0x00030000 };
    const fns = createFiberFunctions({
        readU32: address=>words.get(address >>> 0) ?? 0,
        writeU32: (address, value)=>words.set(address >>> 0, value >>> 0),
        registers: ()=>registers,
        setRegisters: values=>{
            set.push(values);
            registers = { ...registers, ...values };
        },
        currentThread: ()=>thread,
        teb: ()=>TEB_AT,
        allocate: bytes=>{
            const at = heap;
            heap += bytes;
            return at;
        },
        free: ()=>{},
        allocateStack: ()=>{
            if (!room)
            {
                return null;
            }
            const base = stacks;
            stacks += 0x10000;
            return { base, top: base + 0x10000 };
        },
        releaseStack: stack=>released.push(stack),
        threadReturn: ()=>RETURN_STUB,
        exitThread: code=>exits.push(code),
        setLastError: code=>errors.push(code),
    });
    words.set(TEB_AT + TEB.EXCEPTION_LIST, 0x0012ff00);
    words.set(TEB_AT + TEB.STACK_BASE, 0x00130000);
    words.set(TEB_AT + TEB.STACK_LIMIT, 0x00030000);
    const word = (/** @type {number} */ at)=>words.get(at >>> 0) ?? 0;
    return { fns, word, set, errors, released, exits, thread };
}

test('a switch keeps where the caller resumes and takes up the other fiber, thread block and'
    + ' kernel stack bounds with it', ()=>{
    const { fns, word, set, thread } = setup();
    const home = fns.ConvertThreadToFiber.handler([0xaa]);
    assert.equal(word(TEB_AT + TEB.FIBER_DATA), home, 'GetCurrentFiber reads it');
    assert.equal(word(home), 0xaa, 'GetFiberData reads the parameter');

    const fiber = fns.CreateFiberEx.handler([0, 0, 0, 0x00402000, 0xbb]);
    assert.notEqual(fiber, 0);
    assert.equal(word(fiber), 0xbb);

    fns.SwitchToFiber.handler([fiber], { restingStack: 0x0011fff8, hostReturn: 0x00401234 });
    const entered = set.at(-1) ?? {};
    assert.equal(entered.eip, 0x00402000, 'the fiber starts at its routine');
    assert.equal(word(entered.esp), RETURN_STUB, 'which returns where a thread routine does');
    assert.equal(word(entered.esp + 4), 0xbb, 'with its parameter above');
    assert.equal(word(TEB_AT + TEB.FIBER_DATA), fiber);
    assert.equal(word(TEB_AT + TEB.EXCEPTION_LIST), 0xffffffff, 'a fresh fiber has no handlers');
    assert.equal(word(TEB_AT + TEB.STACK_BASE), 0x00510000);
    assert.equal(word(TEB_AT + TEB.STACK_LIMIT), 0x00500000);
    assert.deepEqual(thread, { stackTop: 0x00510000, stackLimit: 0x00500000 });

    fns.SwitchToFiber.handler([home], { restingStack: 0x0050fff0, hostReturn: 0x00402040 });
    assert.deepEqual(set.at(-1),
        { ebx: 1, esi: 2, edi: 3, ebp: 4, esp: 0x0011fff8, eip: 0x00401234 },
        'home resumes after its call, on the stack as the call left it');
    assert.equal(word(TEB_AT + TEB.EXCEPTION_LIST), 0x0012ff00, 'with its own handler chain');
    assert.equal(word(TEB_AT + TEB.STACK_BASE), 0x00130000);
    assert.deepEqual(thread, { stackTop: 0x00130000, stackLimit: 0x00030000 });

    fns.SwitchToFiber.handler([fiber], { restingStack: 0x0011fff8, hostReturn: 0x00401234 });
    assert.equal(set.at(-1)?.eip, 0x00402040, 'and the fiber where it left off');
    assert.equal(set.at(-1)?.esp, 0x0050fff0);
});

test('deleting a fiber gives its stack back, and deleting the running one ends the thread', ()=>{
    const { fns, released, exits } = setup();
    const home = fns.ConvertThreadToFiber.handler([0]);
    const fiber = fns.CreateFiber.handler([0, 0x00402000, 0]);
    fns.DeleteFiber.handler([fiber]);
    assert.equal(released.length, 1);
    assert.deepEqual(exits, []);
    fns.DeleteFiber.handler([home]);
    assert.deepEqual(exits, [1]);
});

test('what each call refuses: a second conversion, a fiber with no routine or no room', ()=>{
    const { fns, errors } = setup({ room: false });
    assert.notEqual(fns.ConvertThreadToFiber.handler([0]), 0);
    assert.equal(fns.ConvertThreadToFiber.handler([0]), 0);
    assert.equal(fns.CreateFiberEx.handler([0, 0, 0, 0, 0]), 0);
    assert.equal(fns.CreateFiber.handler([0, 0x00402000, 0]), 0);
    assert.deepEqual(errors, [1280, 87, 8],
        'ERROR_ALREADY_FIBER, ERROR_INVALID_PARAMETER, no memory');
    assert.equal(fns.IsThreadAFiber.handler(), 1);
    assert.equal(fns.ConvertFiberToThread.handler(), 1);
    assert.equal(fns.IsThreadAFiber.handler(), 0);
});
