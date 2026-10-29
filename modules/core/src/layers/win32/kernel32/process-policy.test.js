/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessPolicyFunctions } from './process-policy.js';
import { createHandleTable } from '../../kernel/internal/handles.js';

const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_BAD_LENGTH = 24;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NOT_FOUND = 1168;
const ERROR_PRIVILEGE_NOT_HELD = 1314;
const CURRENT_PROCESS = 0xffffffff;
const CURRENT_THREAD = 0xfffffffe;

/** A thread whose block says its stack runs from 0x8000 up to 0x9000. */
function machine({ registers = {} } = {}){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    const handles = createHandleTable();
    const thread = { tebAddress: 0x100, cpuMs: 2 };
    view.setUint32(0x104, 0x9000, true);
    view.setUint32(0x108, 0x8000, true);
    const child = { id: 0x2a0 };
    const childHandle = handles.open('process', child);
    const threadHandle = handles.open('thread', thread);
    const kernel = {
        handles,
        createEvent: (/** @type {any} */ options)=>({ kind: 'event', ...options }),
        processCpuMs: ()=>5,
    };
    const fns = /** @type {Record<string, { argBytes: number, handler: Function }>} */ (
        createProcessPolicyFunctions({
            kernel,
            readMemory: (address, length)=>bytes.slice(address, address + length),
            writeMemory: (address, data)=>bytes.set(data, address),
            setLastError: code=>errors.push(code),
            currentThread: ()=>thread,
            registers: ()=>({ eax: 1, ecx: 2, edx: 3, ebx: 4, esi: 5, edi: 6, eflags: 0x246,
                ...registers }),
            threadOf: handle=>((handle >>> 0) === CURRENT_THREAD ? thread
                : handles.has(handle) && handles.typeOf(handle) === 'thread'
                    ? handles.resolve(handle) : null),
            objectOf: (handle, type)=>{
                try
                {
                    return handles.resolve(handle, type);
                }
                catch {
                    return null;
                }
            },
            processId: 0x100,
        }));
    /** @param {string} name @param {...number} args */
    const call = (name, ...args)=>fns[name].handler(args);
    return { bytes, view, errors, handles, call, fns, childHandle, threadHandle };
}

test('RtlCaptureContext is the caller\'s registers as it will be on return', ()=>{
    const { view, call } = machine({ registers: { esp: 0x8f00, ebp: 0x8f40 } });
    view.setUint32(0x8f00, 0x401234, true);
    assert.equal(call('RtlCaptureContext', 0x2000), 0);
    assert.equal(view.getUint32(0x2000, true), 0x10007, 'control, integer and segments');
    assert.equal(view.getUint32(0x2000 + 0xb8, true), 0x401234, 'EIP is the return address');
    assert.equal(view.getUint32(0x2000 + 0xc4, true), 0x8f08, 'ESP past it and the argument');
    assert.equal(view.getUint32(0x2000 + 0xb4, true), 0x8f40);
    assert.equal(view.getUint32(0x2000 + 0xb0, true), 1, 'EAX');
    assert.equal(view.getUint32(0x2000 + 0x9c, true), 6, 'EDI');
    assert.equal(view.getUint32(0x2000 + 0xc0, true), 0x246);
});

test('RtlCaptureStackBackTrace walks the frame chain within the thread\'s stack', ()=>{
    const { view, call } = machine({ registers: { esp: 0x8e00, ebp: 0x8e40 } });
    view.setUint32(0x8e00, 0x401000, true);
    // Three frames up, the last one's link leaving the stack.
    view.setUint32(0x8e40, 0x8e80, true);
    view.setUint32(0x8e44, 0x402000, true);
    view.setUint32(0x8e80, 0x8ec0, true);
    view.setUint32(0x8e84, 0x403000, true);
    view.setUint32(0x8ec0, 0x12345678, true);
    view.setUint32(0x8ec4, 0x404000, true);
    assert.equal(call('RtlCaptureStackBackTrace', 0, 10, 0x3000, 0x3100), 4);
    assert.deepEqual([0, 1, 2, 3].map(index=>view.getUint32(0x3000 + index * 4, true)),
        [0x401000, 0x402000, 0x403000, 0x404000]);
    assert.equal(view.getUint32(0x3100, true), 0x401000 + 0x402000 + 0x403000 + 0x404000);
    assert.equal(call('RtlCaptureStackBackTrace', 1, 2, 0x3000, 0), 2, 'skipped, then two');
    assert.equal(view.getUint32(0x3000, true), 0x402000);
    assert.equal(call('RtlCaptureStackBackTrace', 0, 4, 0, 0), 0, 'nowhere to write');
});

test('a job holds processes, keeps its limits and reads them back', ()=>{
    const { view, call, errors, childHandle } = machine();
    const job = call('CreateJobObjectW', 0, 0);
    assert.notEqual(job, 0);
    assert.equal(call('IsProcessInJob', CURRENT_PROCESS, 0, 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 0, 'in no job yet');
    assert.equal(call('AssignProcessToJobObject', job, childHandle), 1);
    assert.equal(call('AssignProcessToJobObject', job, CURRENT_PROCESS), 1);
    assert.equal(call('IsProcessInJob', childHandle, job, 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 1);

    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE in the extended limits' LimitFlags.
    view.setUint32(0x2100 + 16, 0x2000, true);
    assert.equal(call('SetInformationJobObject', job, 9, 0x2100, 112), 1);
    assert.equal(call('SetInformationJobObject', job, 9, 0x2100, 48), 0);
    assert.equal(errors.at(-1), ERROR_BAD_LENGTH);
    assert.equal(call('QueryInformationJobObject', job, 2, 0x2300, 48, 0x2400), 1);
    assert.equal(view.getUint32(0x2300 + 16, true), 0x2000, 'the basic limits are the extended');
    assert.equal(view.getUint32(0x2400, true), 48);
    assert.equal(call('QueryInformationJobObject', 0, 9, 0x2500, 112, 0), 1,
        'no handle: the job this process is in');
    assert.equal(call('QueryInformationJobObject', job, 9, 0x2500, 100, 0), 0);
    assert.equal(errors.at(-1), ERROR_BAD_LENGTH);

    assert.equal(call('QueryInformationJobObject', job, 3, 0x2600, 12, 0), 0);
    assert.equal(errors.at(-1), ERROR_MORE_DATA, 'room for one id of two');
    assert.deepEqual([0, 4, 8].map(at=>view.getUint32(0x2600 + at, true)), [2, 1, 0x2a0]);
    assert.equal(call('QueryInformationJobObject', job, 3, 0x2600, 16, 0), 1);
    assert.equal(view.getUint32(0x260c, true), 0x100);
    assert.equal(call('QueryInformationJobObject', job, 1, 0x2700, 48, 0), 1);
    assert.equal(view.getUint32(0x2700 + 36, true), 2, 'two processes in it');

    assert.equal(call('SetInformationJobObject', job, 99, 0x2100, 4), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(call('TerminateJobObject', job, 1), 1);
    assert.equal(call('AssignProcessToJobObject', job, childHandle), 0);
    assert.equal(errors.at(-1), ERROR_ACCESS_DENIED, 'a terminated job takes no more');
    assert.equal(call('AssignProcessToJobObject', 0x12340, childHandle), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
});

test('mitigation and DEP policies are kept and read back, DEP permanent once on', ()=>{
    const { view, call, errors } = machine();
    assert.equal(call('GetProcessMitigationPolicy', CURRENT_PROCESS, 0, 0x2000, 8), 1);
    assert.deepEqual([view.getUint32(0x2000, true), view.getUint32(0x2004, true)], [1, 0]);
    view.setUint32(0x2100, 0x1, true);
    // ProcessSignaturePolicy (8): MicrosoftSignedOnly.
    assert.equal(call('SetProcessMitigationPolicy', 8, 0x2100, 4), 1);
    assert.equal(call('GetProcessMitigationPolicy', CURRENT_PROCESS, 8, 0x2200, 4), 1);
    assert.equal(view.getUint32(0x2200, true), 1);
    assert.equal(call('GetProcessMitigationPolicy', CURRENT_PROCESS, 8, 0x2200, 8), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER, 'the size is the policy\'s');
    assert.equal(call('SetProcessMitigationPolicy', 1, 0x2100, 4), 0, 'ASLR is not the process\'s');
    assert.equal(call('SetProcessMitigationPolicy', 40, 0x2100, 4), 0);

    assert.equal(call('SetProcessDEPPolicy', 2), 0, 'ATL thunks off needs DEP on');
    assert.equal(call('SetProcessDEPPolicy', 3), 1);
    assert.equal(call('GetProcessDEPPolicy', CURRENT_PROCESS, 0x2300, 0x2304), 1);
    assert.deepEqual([view.getUint32(0x2300, true), view.getUint32(0x2304, true)], [3, 1]);
    assert.equal(call('SetProcessDEPPolicy', 0), 0);
    assert.equal(errors.at(-1), ERROR_ACCESS_DENIED);
});

test('the information classes are taken at their sizes, others refused', ()=>{
    const { call, errors, threadHandle } = machine();
    assert.equal(call('SetProcessInformation', CURRENT_PROCESS, 0, 0x2000, 4), 1);
    assert.equal(call('SetProcessInformation', CURRENT_PROCESS, 4, 0x2000, 12), 1);
    assert.equal(call('SetProcessInformation', CURRENT_PROCESS, 4, 0x2000, 8), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(call('SetProcessInformation', 0x9990, 0, 0x2000, 4), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(call('SetThreadInformation', CURRENT_THREAD, 3, 0x2000, 12), 1);
    assert.equal(call('SetThreadInformation', threadHandle, 0, 0x2000, 4), 1);
    assert.equal(call('SetThreadInformation', threadHandle, 9, 0x2000, 4), 0);
});

test('cycle times are the processor time at the processor\'s rate', ()=>{
    const { view, call } = machine();
    assert.equal(call('QueryThreadCycleTime', CURRENT_THREAD, 0x2000), 1);
    assert.equal(view.getBigUint64(0x2000, true), 2_000_000n, 'two milliseconds at 1 GHz');
    assert.equal(call('QueryProcessCycleTime', CURRENT_PROCESS, 0x2000), 1);
    assert.equal(view.getBigUint64(0x2000, true), 5_000_000n);
    assert.equal(call('QueryThreadCycleTime', 0x9990, 0x2000), 0);
});

test('the handle count, debugging, power and memory notifications', ()=>{
    const { view, call, errors, handles, childHandle } = machine();
    assert.equal(call('GetProcessHandleCount', CURRENT_PROCESS, 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 2, 'the child and its thread\'s handles');
    assert.equal(call('GetProcessHandleCount', childHandle, 0x2000), 0);
    assert.equal(call('CheckRemoteDebuggerPresent', CURRENT_PROCESS, 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 0);
    assert.equal(call('DebugActiveProcess', 0x2a0), 0);
    assert.equal(errors.at(-1), ERROR_ACCESS_DENIED);
    assert.equal(call('DebugActiveProcess', 0), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(call('CancelSynchronousIo', CURRENT_THREAD), 0);
    assert.equal(errors.at(-1), ERROR_NOT_FOUND);

    const request = call('PowerCreateRequest', 0x2100);
    assert.equal(handles.typeOf(request), 'power-request');
    assert.equal(call('PowerSetRequest', request, 1), 1);
    assert.equal(handles.resolve(request).types, 2);
    assert.equal(call('PowerClearRequest', request, 1), 1);
    assert.equal(call('PowerSetRequest', request, 7), 0);
    assert.equal(call('PowerSetRequest', childHandle, 1), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);

    const low = call('CreateMemoryResourceNotification', 0);
    const high = call('CreateMemoryResourceNotification', 1);
    assert.equal(call('QueryMemoryResourceNotification', low, 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 0, 'never short of memory');
    assert.equal(call('QueryMemoryResourceNotification', high, 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 1);
    assert.equal(call('CreateMemoryResourceNotification', 2), 0);

    assert.equal(call('GetNumaHighestNodeNumber', 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 0);
    assert.equal(call('GetFirmwareType', 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 2, 'UEFI');
    assert.equal(call('SetSystemPowerState', 1, 0), 0);
    assert.equal(errors.at(-1), ERROR_PRIVILEGE_NOT_HELD);
    assert.equal(call('WerRegisterRuntimeExceptionModule', 0x2000, 0), 0, 'S_OK');
    assert.equal(call('FlushProcessWriteBuffers'), 0);
});
