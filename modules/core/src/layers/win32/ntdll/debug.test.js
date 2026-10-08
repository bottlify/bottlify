/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebugFunctions } from './debug.js';

const STATUS_SUCCESS = 0;
const STATUS_UNSUCCESSFUL = 0xc0000001;
const STATUS_NOT_IMPLEMENTED = 0xc0000002;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_PORT_NOT_SET = 0xc0000353;
const TEB = 0x2000;

/** @param {{ teb?: number }} [options] */
function setup({ teb = TEB } = {}){
    const bytes = new Uint8Array(0x4000);
    /** @type {number[][]} */
    const raised = [];
    /** @type {string[]} */
    const said = [];
    /** @type {string[]} */
    const diverged = [];
    /** @type {number[]} */
    const freed = [];
    /** @type {number[][]} */
    const printed = [];
    /** @param {number} address @param {number} maxLength */
    const readCString = (address, maxLength)=>{
        let text = '';
        for (let at = address; at < address + maxLength && bytes[at] !== 0; at++)
        {
            text += String.fromCharCode(bytes[at]);
        }
        return text;
    };
    const fns = /** @type {Record<string, any>} */ (createDebugFunctions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString,
        kernel32: {
            RaiseException: { handler: (/** @type {number[]} */ args)=>{
                raised.push(args);
                return 0;
            } },
            OutputDebugStringA: { handler: (/** @type {number[]} */ [text])=>{
                said.push(readCString(text, 0x1000));
                return 0;
            } },
        },
        crt: {
            // Stands in for the runtime's formatter: the format with its one
            // %d replaced, which is all these tests hand it.
            _snprintf: { handler: (/** @type {number[]} */ [buffer, count, format, value])=>{
                printed.push([count]);
                const text = readCString(format, 256).replace('%d', String(value | 0));
                bytes.set([...new TextEncoder().encode(text), 0], buffer);
                return text.length;
            } },
        },
        teb: ()=>teb,
        allocate: ()=>0x3000,
        free: address=>{
            freed.push(address);
            return true;
        },
        divergence: api=>void diverged.push(api),
    }));
    return { bytes, fns, raised, said, diverged, freed, printed };
}

test('DbgBreakPoint is the processor\'s int3, then a ret', ()=>{
    const { fns, raised } = setup();
    assert.deepEqual([...fns.DbgBreakPoint.code()], [0xcc, 0xc3]);
    assert.equal(fns.DbgBreakPoint.argBytes, 0);
    fns.DbgBreakPoint.handler([]);
    assert.deepEqual(raised, [[0x80000003, 0, 0, 0]],
        'called from the host, the same exception through RaiseException');
});

test('DbgPrint formats, goes to the log through OutputDebugStringA, and succeeds', ()=>{
    const { bytes, fns, said, freed, printed } = setup();
    bytes.set([...new TextEncoder().encode('frame %d\n'), 0], 0x100);
    assert.equal(fns.DbgPrint.handler([0x100, 42]), STATUS_SUCCESS);
    assert.deepEqual(said, ['frame 42\n']);
    assert.deepEqual(printed, [[512]], 'cut at the system\'s 512 bytes');
    assert.deepEqual(freed, [0x3000], 'its buffer given back');
    assert.equal(fns.DbgPrint.convention, 'cdecl');
    assert.equal(fns.DbgPrint.handler([0]), STATUS_SUCCESS, 'no format prints nothing');
});

test('the thread\'s debug object is kept in its thread block, NULL until set', ()=>{
    const { bytes, fns } = setup();
    assert.equal(fns.DbgUiGetThreadDebugObject.handler([]), 0);
    fns.DbgUiSetThreadDebugObject.handler([0x88]);
    assert.equal(fns.DbgUiGetThreadDebugObject.handler([]), 0x88);
    assert.equal(bytes[TEB + 0xf24], 0x88, 'DbgSsReserved[1]');

    const early = setup({ teb: 0 });
    early.fns.DbgUiSetThreadDebugObject.handler([0x44]);
    assert.equal(early.fns.DbgUiGetThreadDebugObject.handler([]), 0x44,
        'with no thread block yet, kept all the same');
});

test('no debugger can attach: each call answers its status, said once', ()=>{
    const { bytes, fns, diverged } = setup();
    bytes.set([0xff, 0xff, 0xff, 0xff], 0x200);
    assert.equal(fns.NtCreateDebugObject.handler([0x200, 0x1f000f, 0, 1]),
        STATUS_NOT_IMPLEMENTED);
    assert.deepEqual([...bytes.subarray(0x200, 0x204)], [0, 0, 0, 0], 'the handle left NULL');
    /** @type {[string, number, number][]} */
    const expected = [
        ['NtDebugActiveProcess', 8, STATUS_ACCESS_DENIED],
        ['NtRemoveProcessDebug', 8, STATUS_PORT_NOT_SET],
        ['NtDebugContinue', 12, STATUS_INVALID_HANDLE],
        ['NtSetInformationDebugObject', 20, STATUS_INVALID_HANDLE],
        ['NtWaitForDebugEvent', 16, STATUS_INVALID_HANDLE],
        ['NtSystemDebugControl', 24, STATUS_NOT_IMPLEMENTED],
        ['DbgUiIssueRemoteBreakin', 4, STATUS_NOT_IMPLEMENTED],
        ['DbgUiConvertStateChangeStructure', 8, STATUS_UNSUCCESSFUL],
        ['NtCreateDebugObject', 16, STATUS_NOT_IMPLEMENTED],
    ];
    for (const [name, argBytes, status] of expected)
    {
        assert.equal(fns[name].argBytes, argBytes, name);
        assert.equal(fns[name].handler([0, 0, 0, 0, 0, 0]), status, name);
        fns[name].handler([0, 0, 0, 0, 0, 0]);
    }
    assert.deepEqual(diverged.sort(), expected.map(([name])=>name).sort());
});
