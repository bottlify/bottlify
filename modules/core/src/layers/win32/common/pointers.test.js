/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    declareAddresses, forwarded, paramsOf, pointerArg, pointerWidth, wholeAddress, wholeAnswer,
    wideOf, wideParams,
} from './pointers.js';

test('a 32-bit pointer is a dword', ()=>{
    const width = pointerWidth();
    assert.equal(width.size, 4);
    assert.deepEqual([...width.bytes(0x12345678)], [0x78, 0x56, 0x34, 0x12]);
    assert.deepEqual([...width.array([1, 2])], [1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
});

test('a 64-bit pointer is a qword whose high half is zero', ()=>{
    const width = pointerWidth(8);
    const bytes = new Uint8Array(16).fill(0xee);
    const view = new DataView(bytes.buffer);
    width.set(view, 8, 0x8badf00d);
    assert.deepEqual([...bytes.subarray(8)], [0x0d, 0xf0, 0xad, 0x8b, 0, 0, 0, 0]);
    assert.equal(width.get(view, 8), 0x8badf00d);
    assert.equal(width.array([7]).length, 16);
    assert.deepEqual([...width.array([7])], [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a 64-bit integer by value: two dwords to a 32-bit callee, one slot to a 64-bit one', ()=>{
    assert.deepEqual(pointerWidth(4).quadword(0x1_0000_0002), [2, 1]);
    assert.deepEqual(pointerWidth(4).quadword(-1), [0xffffffff, 0xffffffff]);
    assert.deepEqual(pointerWidth(8).quadword(0x1_0000_0002), [0x1_0000_0002n]);
    assert.deepEqual(pointerWidth(8).quadword(-2), [0xffff_ffff_ffff_fffen]);
});

test('no other width', ()=>{
    assert.throws(()=>pointerWidth(2), RangeError);
});

test('a pointer argument whole: the low dword, and the high one a 64-bit call carries', ()=>{
    const args = /** @type {number[] & { high?: number[] }} */ ([0x40001000 | 0, -1]);
    assert.equal(pointerArg(args, 0), 0x40001000, 'no high half: the low dword unsigned');
    assert.equal(pointerArg(args, 1), 0xffffffff);
    args.high = [1, 0];
    assert.equal(pointerArg(args, 0), 0x140001000, 'an image at 0x140000000');
});

test('an address as the engine holds it: unsigned below 4 GiB, whole past it', ()=>{
    assert.equal(wholeAddress(0x90000000 | 0), 0x90000000);
    assert.equal(wholeAddress(0x140001740), 0x140001740, 'not its low dword');
    assert.equal(wholeAddress(0), 0);
});

test('a message\'s WPARAM and LPARAM are carried whole only where a dword does not say them', ()=>{
    // A WPARAM widens as a UINT, an LPARAM as a LONG: -1 is its sign's ones.
    assert.equal(wideParams(7, 0, -1, 0xffffffff), undefined);
    assert.equal(wideParams(0x80000001 | 0, 0, 5, 0), undefined);
    // A pointer past 2 GiB in an LPARAM has a zero high half, not its sign's.
    assert.deepEqual(wideParams(0, 0, 0x90000000 | 0, 0), { l: 0x90000000n });
    assert.deepEqual(wideParams(0x23456789, 1, 0x23456789, 1),
        { w: 0x123456789n, l: 0x123456789n });
    assert.deepEqual(wideParams(-1, 0xffffffff, 0, 0), { w: 0xffffffffffffffffn });

    const args = /** @type {number[] & { high?: number[] }} */ ([1, 2, 3, 0x90000000 | 0]);
    assert.equal(wideOf(args, 2, 3), undefined, 'a 32-bit call: the dwords are the values');
    assert.equal(wideOf(args, 2, 3, true), undefined);
    args.high = [0, 0, 0, 0];
    assert.deepEqual(wideOf(args, 2, 3), { l: 0x90000000n });
    args[3] = 5;
    assert.equal(wideOf(args, 2, 3), undefined);
    assert.deepEqual(wideOf(args, 2, 3, true), {}, 'a holder for a 64-bit send\'s answer');
});

test('a procedure is handed the whole value while it is still that dword\'s', ()=>{
    assert.deepEqual(paramsOf({ wParam: 0x80000001, lParam: 0xffffffff }), [0x80000001, -1]);
    assert.deepEqual(paramsOf({ wParam: 0x23456789, lParam: 0x90000000,
        wide: { w: 0x123456789n, l: 0x90000000n } }), [0x123456789n, 0x90000000n]);
    // A message converted on the way has another value in the dword: the dword's.
    assert.deepEqual(paramsOf({ wParam: 0x41, lParam: 0x200000,
        wide: { w: 0x123456789n, l: 0x90000000n } }), [0x41, 0x200000]);
});

test('a send answers the procedure\'s quadword where it is still the answer', ()=>{
    assert.equal(wholeAnswer(5, undefined), 5);
    assert.equal(wholeAnswer(0x90000000, { r: 0x90000000n }), 0x90000000n);
    assert.equal(wholeAnswer(0x23456789, { r: 0x123456789n }), 0x123456789n);
    assert.equal(wholeAnswer(1, { r: 0x123456789n }), 1, 'an answer changed on the way');
    assert.equal(wholeAnswer(null, { r: 1n }), null, 'a send that timed out');
});

test('an argument handed on to a routine: whole from a 64-bit caller, by its type', ()=>{
    const args = /** @type {number[] & { high?: number[] }} */ ([0x90000000 | 0, -1, 0x23456789]);
    assert.equal(forwarded(args, 0), 0x90000000 | 0, 'a 32-bit call\'s dword as it is');
    args.high = [0, 0xffffffff, 1];
    assert.equal(forwarded(args, 0), 0x90000000, 'a ULONG_PTR by zeros');
    assert.equal(forwarded(args, 0, true), 0x90000000n,
        'an LPARAM past 2 GiB is not its sign\'s');
    assert.equal(forwarded(args, 1, true), -1);
    assert.equal(forwarded(args, 1), 0xffffffffffffffffn);
    assert.equal(forwarded(args, 2), 0x123456789n);
});

test('each function is declared the address arguments its signature names', ()=>{
    const handler = ()=>0;
    const own = { argBytes: 8, handler, addresses: [1] };
    const shared = { argBytes: 12, handler };
    /** @type {Record<string, Record<string, any>>} */
    const libraries = {
        'A.dll': {
            CreateFileA: { argBytes: 28, handler },
            Quad: { argBytes: 16, handler, quadwords: [0] },
            Float: { argBytes: 8, handler, floats: { 1: 'f32' } },
            ByValue: { argBytes: 24, handler, structs: { 1: 4 } },
            Short: { argBytes: 4, handler },
            Own: own,
            Member: { convention: 'thiscall', argBytes: 8, handler },
            Unlisted: { argBytes: 8, handler },
            Data: { data: ()=>new Uint8Array(4) },
            First: shared,
        },
        'B.dll': { Second: shared },
    };
    declareAddresses(libraries, {
        CreateFileA: [0, 3], Quad: [0, 1, 2], Float: [0, 1], ByValue: [0, 2, 5], Short: [0, 1],
        Own: [0], First: [2], Second: [0],
    });
    const a = libraries['A.dll'];
    assert.deepEqual(a.CreateFileA.addresses, [0, 3]);
    assert.deepEqual(a.Quad.addresses, [2], 'a quadword\'s halves are none');
    assert.deepEqual(a.Float.addresses, [0], 'a float is none');
    assert.deepEqual(a.ByValue.addresses, [0, 5], 'a structure\'s dwords are none');
    assert.deepEqual(a.Short.addresses, [0], 'none past the arguments');
    assert.deepEqual(own.addresses, [1], 'its own declaration stays');
    assert.deepEqual(a.Member.addresses, [0], 'a member\'s this');
    assert.equal(a.Unlisted.addresses, undefined);
    assert.equal(a.Data.addresses, undefined);
    assert.deepEqual(/** @type {any} */ (shared).addresses, [2], 'one function: its first name');
});
