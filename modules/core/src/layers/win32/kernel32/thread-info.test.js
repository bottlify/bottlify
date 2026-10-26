/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREAD_INFO, createThreadInfoFunctions } from './thread-info.js';
import { createProcessors } from './processor.js';
import { TEB } from './teb.js';

const STATUS_SUCCESS = 0;
const STATUS_INVALID_INFO_CLASS = 0xc0000003;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOACCESS = 998;
const CURRENT_THREAD = 0xfffffffe;
const THREAD_HANDLE = 0x40;

/** Guest memory from 0x1000 to 0x4000; anything else is unmapped. */
function setup({ processors: count = 4 } = {}){
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    /** @param {number} address @param {number} length */
    const check = (address, length)=>{
        if (address < 0x1000 || address + length > bytes.length)
        {
            throw new Error(`unmapped ${address}`);
        }
    };
    const self = { id: 0x104, tebAddress: 0x3000, state: 'running', priority: 0 };
    const other = { id: 0x108, tebAddress: 0, state: 'ready', priority: 2 };
    view.setUint32(self.tebAddress + TEB.PROCESS_ID, 0x2a4, true);
    const threads = [self, other];
    /** @type {number[]} */
    const errors = [];
    let free = 0x2000;
    const kernel = {
        handles: {
            /** @param {number} handle */
            resolve: handle=>(handle === THREAD_HANDLE ? other : null),
        },
        threads: ()=>threads,
        clock: { virtualTime: ()=>0 },
        block: ()=>{},
    };
    // The caller runs on processor 1.
    const processors = createProcessors({ processors: ()=>count, threads: ()=>threads,
        processorOf: thread=>(thread === self ? 1 : 0) });
    const fns = /** @type {Record<string, any>} */ (createThreadInfoFunctions({
        kernel,
        processors,
        readMemory: (address, length)=>{
            check(address, length);
            return bytes.subarray(address, address + length);
        },
        writeMemory: (address, data)=>{
            check(address, data.length);
            bytes.set(data, address);
        },
        currentThread: ()=>self,
        park: ()=>'parked',
        setLastError: code=>errors.push(code),
        allocate: size=>{
            const at = free;
            free += size;
            return at;
        },
        threadTimes: (handle, at)=>view.setUint32(at, 0x1234, true),
    }));
    const natives = fns.SetThreadDescription.natives;
    /** @param {number} at */
    const wide = at=>{
        let text = '';
        for (let unit = view.getUint16(at, true); unit !== 0; unit = view.getUint16(at, true))
        {
            text += String.fromCharCode(unit);
            at += 2;
        }
        return text;
    };
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        [...text, '\0'].forEach((c, i)=>view.setUint16(at + i * 2, c.charCodeAt(0), true));
        return at;
    };
    return { fns, natives, view, self, other, threads, errors, processors, wide, putWide };
}

test('ThreadBasicInformation names the thread, its process and its block', ()=>{
    const { natives, view, other } = setup();
    const query = natives.NtQueryInformationThread.handler;

    assert.equal(query([CURRENT_THREAD, THREAD_INFO.BASIC, 0x1000, 28, 0x1100]), STATUS_SUCCESS);
    assert.equal(view.getUint32(0x1000, true), 0x103, 'still running: STATUS_PENDING');
    assert.equal(view.getUint32(0x1004, true), 0x3000);
    assert.equal(view.getUint32(0x1008, true), 0x2a4);
    assert.equal(view.getUint32(0x100c, true), 0x104);
    assert.equal(view.getUint32(0x1010, true), 0xf, 'every processor');
    assert.equal(view.getUint32(0x1100, true), 28);

    Object.assign(other, { state: 'terminated', exitCode: 7 });
    assert.equal(query([THREAD_HANDLE, THREAD_INFO.BASIC, 0x1000, 28, 0]), STATUS_SUCCESS);
    assert.equal(view.getUint32(0x1000, true), 7);
    assert.equal(view.getInt32(0x1018, true), 2, 'the base priority is the relative one');

    assert.equal(query([CURRENT_THREAD, THREAD_INFO.BASIC, 0x1000, 27, 0]),
        STATUS_INFO_LENGTH_MISMATCH);
    assert.equal(query([CURRENT_THREAD, THREAD_INFO.BASIC, 0, 28, 0]), STATUS_ACCESS_VIOLATION);
    assert.equal(query([0x99, THREAD_INFO.BASIC, 0x1000, 28, 0]), STATUS_INVALID_HANDLE);
    assert.equal(query([CURRENT_THREAD, 2, 0x1000, 4, 0]), STATUS_INVALID_INFO_CLASS,
        'a class not answered is refused, not filled with nothing');
});

test('the small classes: times, last thread, priority boost', ()=>{
    const { natives, view, self, other } = setup();
    const query = natives.NtQueryInformationThread.handler;

    assert.equal(query([CURRENT_THREAD, THREAD_INFO.TIMES, 0x1000, 32, 0]), STATUS_SUCCESS);
    assert.equal(view.getUint32(0x1000, true), 0x1234, 'GetThreadTimes\' four FILETIMEs');

    assert.equal(query([CURRENT_THREAD, THREAD_INFO.AM_I_LAST_THREAD, 0x1000, 4, 0]),
        STATUS_SUCCESS);
    assert.equal(view.getUint32(0x1000, true), 0, 'another thread is alive');
    other.state = 'terminated';
    query([CURRENT_THREAD, THREAD_INFO.AM_I_LAST_THREAD, 0x1000, 4, 0]);
    assert.equal(view.getUint32(0x1000, true), 1);

    /** @type {any} */ (self).priorityBoostDisabled = true;
    assert.equal(query([CURRENT_THREAD, THREAD_INFO.PRIORITY_BOOST, 0x1000, 4, 0]), STATUS_SUCCESS);
    assert.equal(view.getUint32(0x1000, true), 1);
});

test('ThreadAffinityMask takes every bit as every processor, and refuses one past them', ()=>{
    const { natives, view, self, processors } = setup();
    const set = natives.NtSetInformationThread.handler;

    view.setUint32(0x1000, 0xffffffff, true);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.AFFINITY_MASK, 0x1000, 4]), STATUS_SUCCESS);
    assert.equal(processors.threadMask(self), 0xf);
    view.setUint32(0x1000, 0x10, true);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.AFFINITY_MASK, 0x1000, 4]),
        STATUS_INVALID_PARAMETER);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.AFFINITY_MASK, 0x1000, 8]),
        STATUS_INFO_LENGTH_MISMATCH);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.HIDE_FROM_DEBUGGER, 0, 0]), STATUS_SUCCESS);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.HIDE_FROM_DEBUGGER, 0x1000, 4]),
        STATUS_INFO_LENGTH_MISMATCH);
    assert.equal(set([CURRENT_THREAD, 2, 0x1000, 4]), STATUS_INVALID_INFO_CLASS);
});

test('group affinity reads and sets the thread\'s mask, 0 handing it back to the process', ()=>{
    // Wine's kernel32 test_thread_processor.
    const { fns, natives, view, self, other, errors, processors } = setup();

    assert.equal(fns.GetThreadGroupAffinity.handler([CURRENT_THREAD, 0x1000]), 1);
    assert.equal(view.getUint32(0x1000, true), 0xf);
    assert.equal(view.getUint16(0x1004, true), 0, 'group 0');
    assert.equal(fns.GetThreadGroupAffinity.handler([CURRENT_THREAD, 0]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);

    view.setUint32(0x1100, 0x6, true);
    assert.equal(fns.SetThreadGroupAffinity.handler([CURRENT_THREAD, 0x1100, 0x1200]), 1);
    assert.equal(view.getUint32(0x1200, true), 0xf, 'the previous one');
    assert.equal(processors.threadMask(self), 0x6);
    view.setUint32(0x1100, 0x1, true);
    assert.equal(fns.SetThreadGroupAffinity.handler([CURRENT_THREAD, 0x1100, 0x1200]), 'parked',
        'moved off its processor, it runs again on one of its new ones before it is answered');
    assert.equal(view.getUint32(0x1200, true), 0x6);

    // The process narrowed puts every thread on its mask.
    processors.setProcessMask(0x2);
    assert.equal(processors.threadMask(other), 0x2);
    view.setUint32(0x1100, 0, true);
    assert.equal(fns.SetThreadGroupAffinity.handler([CURRENT_THREAD, 0x1100, 0x1200]), 1);
    processors.setProcessMask(0xf);
    assert.equal(fns.GetThreadGroupAffinity.handler([CURRENT_THREAD, 0x1000]), 1);
    assert.equal(view.getUint32(0x1000, true), 0xf, 'the process\'s mask, whatever it is now');

    view.setUint32(0x1100, 0xffffffff, true);
    assert.equal(fns.SetThreadGroupAffinity.handler([CURRENT_THREAD, 0x1100, 0]), 0,
        'no every-processor shorthand for a group');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    view.setUint32(0x1100, 1, true);
    view.setUint16(0x1104, 1, true);
    assert.equal(fns.SetThreadGroupAffinity.handler([CURRENT_THREAD, 0x1100, 0]), 0, 'group 1');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(fns.SetThreadGroupAffinity.handler([CURRENT_THREAD, 0, 0]), 0);
    assert.equal(errors.at(-1), ERROR_NOACCESS);
    assert.equal(natives.NtSetInformationThread.handler([CURRENT_THREAD, THREAD_INFO.GROUP, 0, 12]),
        STATUS_ACCESS_VIOLATION);
});

test('a thread description is set and read through either spelling', ()=>{
    // Wine's kernel32 test_thread_description.
    const { fns, natives, view, wide, putWide } = setup();
    const query = natives.NtQueryInformationThread.handler;
    const set = natives.NtSetInformationThread.handler;
    const description = ()=>{
        assert.equal(fns.GetThreadDescription.handler([CURRENT_THREAD, 0x1f00]), 0);
        return wide(view.getUint32(0x1f00, true));
    };

    assert.equal(description(), '', 'none is the empty one');
    assert.equal(query([CURRENT_THREAD, THREAD_INFO.NAME, 0, 0, 0x1100]), STATUS_BUFFER_TOO_SMALL);
    assert.equal(view.getUint32(0x1100, true), 8);
    assert.equal(query([CURRENT_THREAD, THREAD_INFO.NAME, 0x1200, 8, 0x1100]), STATUS_SUCCESS);
    assert.equal(view.getUint16(0x1200, true), 0);
    assert.equal(view.getUint32(0x1204, true), 0x1208, 'the buffer is just past the structure');

    const named = putWide(0x1300, 'thread_desc');
    assert.equal(fns.SetThreadDescription.handler([CURRENT_THREAD, named]), 0);
    assert.equal(description(), 'thread_desc');
    assert.equal(query([CURRENT_THREAD, THREAD_INFO.NAME, 0x1200, 128, 0x1100]), STATUS_SUCCESS);
    assert.equal(view.getUint32(0x1100, true), 8 + 22);
    assert.equal(view.getUint16(0x1200, true), 22);
    assert.equal(view.getUint16(0x1202, true), 22);
    assert.equal(wide(0x1208), 'thread_desc');
    assert.equal(query([CURRENT_THREAD, THREAD_INFO.NAME, 0x1200, 8 + 20, 0x1100]),
        STATUS_BUFFER_TOO_SMALL, 'a partial answer is no answer');

    // A UNICODE_STRING counts its own length; nothing has to end it.
    view.setUint16(0x1400, 8, true);
    view.setUint16(0x1402, 8, true);
    view.setUint32(0x1404, putWide(0x1408, 'descXYZ'), true);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.NAME, 0x1400, 8]), STATUS_SUCCESS);
    assert.equal(description(), 'desc');
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.NAME, 0x1400, 7]), STATUS_INFO_LENGTH_MISMATCH);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.NAME, 0, 8]), STATUS_ACCESS_VIOLATION);
    view.setUint32(0x1404, 0, true);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.NAME, 0x1400, 8]), STATUS_ACCESS_VIOLATION);

    assert.equal(fns.SetThreadDescription.handler([CURRENT_THREAD, 0]), 0, 'NULL empties it');
    assert.equal(description(), '');
    view.setUint32(0x1400, 0, true);
    view.setUint32(0x1404, 0, true);
    assert.equal(set([CURRENT_THREAD, THREAD_INFO.NAME, 0x1400, 8]), STATUS_SUCCESS,
        'so does an empty string with no buffer');

    assert.equal(fns.SetThreadDescription.handler([0x99, 0]),
        (STATUS_INVALID_HANDLE | 0x10000000) >>> 0,
        'HRESULT_FROM_NT');
    assert.equal(fns.SetThreadDescription.handler([THREAD_HANDLE, putWide(0x1300, 'other')]), 0);
    assert.equal(fns.GetThreadDescription.handler([THREAD_HANDLE, 0x1f00]), 0);
    assert.equal(wide(view.getUint32(0x1f00, true)), 'other', 'each thread has its own');
});
