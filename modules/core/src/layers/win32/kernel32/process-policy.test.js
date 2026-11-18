/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessPolicyFunctions } from './process-policy.js';
import { createHandleTable } from '../../kernel/internal/handles.js';
import { createNamedObjects } from './named-objects.js';

const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_BAD_LENGTH = 24;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NOT_FOUND = 1168;
const ERROR_PRIVILEGE_NOT_HELD = 1314;
const CURRENT_PROCESS = 0xffffffff;
const CURRENT_THREAD = 0xfffffffe;

/**
 * A thread whose block says its stack runs from 0x8000 up to 0x9000.
 *
 * @param {{ registers?: Record<string, number>,
 *     setRegisters?: (values: Record<string, number>) => void,
 *     divergence?: (api: string, detail: string) => void,
 *     flushProcessWrites?: () => true | Promise<true>,
 *     processors?: { count: () => number, systemMask: () => number },
 *     namedObjects?: any }} [given]
 */
function machine(given = {}){
    const { registers = {}, setRegisters, divergence, flushProcessWrites, processors,
        namedObjects } = given;
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    const handles = createHandleTable();
    const thread = { tebAddress: 0x100, cpuMs: 2 };
    view.setUint32(0x104, 0x9000, true);
    view.setUint32(0x108, 0x8000, true);
    /** @type {any} */
    const child = { id: 0x2a0 };
    /** @type {any[]} */
    const ended = [];
    const childHandle = handles.open('process', child);
    const threadHandle = handles.open('thread', thread);
    const kernel = {
        handles,
        createEvent: (/** @type {any} */ options)=>({ kind: 'event', ...options }),
        setEvent: (/** @type {any} */ event)=>{
            event.signalled = true;
        },
        processCpuMs: ()=>5,
        flushProcessWrites,
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
            namedObjects,
            // Each process ended, in order: a child takes the code as its exit.
            terminateProcess: (process, code)=>{
                ended.push(process);
                if (process)
                {
                    process.exitCode = code;
                }
                return 1;
            },
            setRegisters,
            divergence,
            processors,
        }));
    /** @param {string} name @param {...number} args */
    const call = (name, ...args)=>(name === 'NtContinue'
        ? /** @type {any} */ (fns.RtlCaptureContext).natives.NtContinue : fns[name]).handler(args);
    return { bytes, view, errors, handles, call, fns, childHandle, threadHandle, thread, child,
        ended };
}

test('RtlCaptureContext is the caller\'s registers as it will be on return', ()=>{
    const { view, call } = machine({ registers: { esp: 0x8f00, ebp: 0x8f40 } });
    view.setUint32(0x8f00, 0x401234, true);
    new Uint8Array(view.buffer).fill(0xee, 0x2000, 0x2000 + 0x2cc);
    assert.equal(call('RtlCaptureContext', 0x2000), 0);
    assert.deepEqual([view.getUint32(0x2004, true), view.getUint32(0x2088, true),
        view.getUint32(0x2000 + 0xcc, true)], [0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee],
    'the debug and floating-point groups and the extended registers are not written');
    assert.equal(view.getUint32(0x2000, true), 0x10007, 'control, integer and segments');
    assert.equal(view.getUint32(0x2000 + 0xb8, true), 0x401234, 'EIP is the return address');
    assert.equal(view.getUint32(0x2000 + 0xc4, true), 0x8f08, 'ESP past it and the argument');
    assert.equal(view.getUint32(0x2000 + 0xb4, true), 0x8f40);
    assert.equal(view.getUint32(0x2000 + 0xb0, true), 1, 'EAX');
    assert.equal(view.getUint32(0x2000 + 0x9c, true), 6, 'EDI');
    assert.equal(view.getUint32(0x2000 + 0xc0, true), 0x246);
});

test('NtContinue goes on from the groups a context names and answers its EAX', ()=>{
    /** @type {Record<string, number>[]} */
    const set = [];
    /** @type {string[]} */
    const said = [];
    const { view, call } = machine({ registers: { esp: 0x8f00, ebp: 0x8f40 },
        setRegisters: values=>set.push(values), divergence: (api, detail)=>said.push(detail) });
    view.setUint32(0x8f00, 0x401234, true);
    call('RtlCaptureContext', 0x2000);
    view.setUint32(0x2000 + 0xb0, 0x77, true);
    assert.equal(call('NtContinue', 0x2000, 0), 0x77);
    assert.deepEqual(set.at(-1), { edi: 6, esi: 5, ebx: 4, edx: 3, ecx: 2, eax: 0x77,
        ebp: 0x8f40, eip: 0x401234, eflags: 0x246, esp: 0x8f08 });
    view.setUint32(0x2000, 0x10001, true);
    assert.equal(call('NtContinue', 0x2000, 0), 1, 'no integer group: EAX stays');
    assert.deepEqual(Object.keys(set.at(-1) ?? {}), ['ebp', 'eip', 'eflags', 'esp']);
    assert.equal(said.length, 0);
    view.setUint32(0x2000, 0x1000b, true);
    call('NtContinue', 0x2000, 0);
    assert.match(said.join(), /floating-point/);
});

test('NtContinue gives the thread the debug registers its context names', ()=>{
    const { view, call, thread } = machine({ setRegisters: ()=>{} });
    view.setUint32(0x2000, 0x10010, true);
    [0x42424242, 0, 0x100f0fe7, 0x0abebabe, 0, 0x115].forEach((value, index)=>
        view.setUint32(0x2004 + index * 4, value, true));
    call('NtContinue', 0x2000, 0);
    assert.deepEqual(/** @type {any} */ (thread).debugRegisters,
        { dr0: 0x42424242, dr1: 0, dr2: 0x100f0fe7, dr3: 0x0abebabe, dr6: 0, dr7: 0x115 });
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
    const { view, call, errors, childHandle, handles, child, ended } = machine();
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
    // Wine's process test_TerminateJobObject and test_WaitForJobObject.
    const waitable = handles.resolve(job, 'job').waitable;
    assert.equal(waitable.signalled, false, 'a job is not signalled while it runs');
    assert.equal(call('TerminateJobObject', job, 123), 1);
    assert.deepEqual(ended, [child, null], 'the child ended, this process last');
    assert.equal(child.exitCode, 123);
    assert.equal(waitable.signalled, true, 'signalled for good');
    assert.equal(call('QueryInformationJobObject', job, 1, 0x2700, 48, 0), 1);
    assert.deepEqual([36, 40].map(at=>view.getUint32(0x2700 + at, true)), [2, 1],
        'two ever assigned, this process alone still running');
    assert.equal(call('AssignProcessToJobObject', job, childHandle), 0);
    assert.equal(errors.at(-1), ERROR_ACCESS_DENIED, 'a process that has ended joins nothing');
    const another = handles.open('process', { id: 0x2b0 });
    assert.equal(call('AssignProcessToJobObject', job, another), 1,
        'a terminated job still takes a running process');
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

test('GetProcessInformation answers what was set, or Windows\' default', ()=>{
    const { call, view } = machine();
    assert.equal(call('GetProcessInformation', CURRENT_PROCESS, 0, 0x2400, 4), 1);
    assert.equal(view.getUint32(0x2400, true), 5, 'MEMORY_PRIORITY_NORMAL');
    assert.equal(call('GetProcessInformation', CURRENT_PROCESS, 4, 0x2400, 12), 1);
    assert.equal(view.getUint32(0x2400, true), 1, 'a power throttling state, version 1');
    view.setUint32(0x2000, 2, true);
    assert.equal(call('SetProcessInformation', CURRENT_PROCESS, 0, 0x2000, 4), 1);
    assert.equal(call('GetProcessInformation', CURRENT_PROCESS, 0, 0x2400, 4), 1);
    assert.equal(view.getUint32(0x2400, true), 2, 'what was set');
    assert.equal(call('GetProcessInformation', CURRENT_PROCESS, 0, 0x2400, 8), 0);
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
    // Wine's debugger test_RemoteDebugger and test_debug_children.
    const debugged = handles.open('process', { id: 0x2c0, debugEvents: ['create', 'exit'] });
    assert.equal(call('CheckRemoteDebuggerPresent', debugged, 0x2000), 1);
    assert.equal(view.getUint32(0x2000, true), 1, 'a child started with DEBUG_PROCESS');
    view.setUint32(0x2000, 7, true);
    assert.equal(call('CheckRemoteDebuggerPresent', 0, 0x2000), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER, 'no handle is a bad parameter');
    assert.equal(view.getUint32(0x2000, true), 7, 'and nothing is written');
    assert.equal(call('CheckRemoteDebuggerPresent', CURRENT_PROCESS, 0), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
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
    // The .NET Framework 4.8's ngen sets its flags first thing; they come back as set.
    assert.equal(call('WerSetFlags', 0x7), 0, 'S_OK');
    assert.equal(call('WerGetFlags', 0xffffffff, 0x2000), 0);
    assert.equal(view.getUint32(0x2000, true), 0x7, 'the flags set');
    assert.equal(call('WerGetFlags', childHandle, 0x2000), 0x80070057, 'not another process');
    assert.equal(call('WerGetFlags', 0xffffffff, 0), 0x80070057, 'nowhere to answer');
    assert.equal(call('WerRegisterFile', 0x2000, 1, 0), 0);
    assert.equal(call('WerRegisterMemoryBlock', 0x2000, 16), 0);
    assert.equal(call('FlushProcessWriteBuffers'), 0);
});

test('the one NUMA node holds every processor, and no other node or processor is one', ()=>{
    // MSDN GetNumaNodeProcessorMask(Ex), GetNumaProcessorNode(Ex); one node, as
    // GetNumaHighestNodeNumber says.
    const { view, errors, call } = machine({ processors: { count: ()=>4, systemMask: ()=>0xf } });
    assert.equal(call('GetNumaNodeProcessorMask', 0, 0x2000), 1);
    assert.equal(view.getBigUint64(0x2000, true), 0xfn);
    assert.equal(call('GetNumaNodeProcessorMask', 1, 0x2000), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(call('GetNumaNodeProcessorMaskEx', 0, 0x2010), 1);
    assert.deepEqual([view.getUint32(0x2010, true), view.getUint16(0x2014, true)], [0xf, 0],
        'the mask, in group 0');

    assert.equal(call('GetNumaProcessorNode', 3, 0x2020), 1);
    assert.equal(view.getUint8(0x2020), 0);
    assert.equal(call('GetNumaProcessorNode', 4, 0x2020), 0, 'a fifth processor is none');
    assert.equal(view.getUint8(0x2020), 0xff);
    view.setUint32(0x2030, 0x00020000, true);
    assert.equal(call('GetNumaProcessorNodeEx', 0x2030, 0x2040), 1, 'group 0, number 2');
    assert.equal(view.getUint16(0x2040, true), 0);
    view.setUint32(0x2030, 0x00000001, true);
    assert.equal(call('GetNumaProcessorNodeEx', 0x2030, 0x2040), 0, 'group 1 is none');
    assert.equal(view.getUint16(0x2040, true), 0xffff);
});

test('FlushProcessWriteBuffers returns once the other executors have passed a barrier', async()=>{
    /** @type {(value: true) => void} */
    let passed = ()=>{};
    const { call } = machine({
        flushProcessWrites: ()=>new Promise(resolve=>{ passed = resolve; }) });
    let returned = null;
    const answer = call('FlushProcessWriteBuffers').then((/** @type {number} */ value)=>{
        returned = value;
    });
    await Promise.resolve();
    assert.equal(returned, null, 'the caller waits while an executor is still in its run');
    passed(true);
    await answer;
    assert.equal(returned, 0);
    assert.equal(machine({ flushProcessWrites: ()=>true }).call('FlushProcessWriteBuffers'), 0,
        'nothing running elsewhere: returned at once');
});

test('a job made by name is the one OpenJobObject and NtOpenJobObject find', ()=>{
    const namedObjects = createNamedObjects();
    const { view, call, errors, fns, handles } = machine({ namedObjects });
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        [...text, '\0'].forEach((c, i)=>view.setUint16(at + i * 2, c.charCodeAt(0), true));
        return at;
    };
    const job = call('CreateJobObjectW', 0, wide(0x3000, 'jobs'));
    assert.notEqual(job, 0);
    assert.equal(errors.at(-1), 0);
    assert.equal(handles.resolve(call('CreateJobObjectW', 0, 0x3000)), handles.resolve(job),
        'the same name opens the same job');
    assert.equal(errors.at(-1), 183, 'ERROR_ALREADY_EXISTS');
    assert.equal(handles.resolve(call('OpenJobObjectW', 0x1f001f, 0, 0x3000)),
        handles.resolve(job));
    assert.equal(call('OpenJobObjectW', 0x1f001f, 0, wide(0x3100, 'none')), 0);
    assert.equal(errors.at(-1), 2, 'ERROR_FILE_NOT_FOUND');

    const natives = /** @type {any} */ (fns.CreateJobObjectW).natives;
    const path = '\\Sessions\\1\\BaseNamedObjects\\jobs';
    view.setUint32(0x3200, 24, true);
    view.setUint32(0x3208, 0x3220, true);
    view.setUint16(0x3220, path.length * 2, true);
    view.setUint32(0x3224, 0x3240, true);
    [...path].forEach((c, i)=>view.setUint16(0x3240 + i * 2, c.charCodeAt(0), true));
    assert.equal(natives.NtOpenJobObject.handler([0x3400, 0x1f001f, 0x3200]), 0);
    assert.equal(handles.resolve(view.getUint32(0x3400, true)), handles.resolve(job));
    assert.equal(natives.NtCreateJobObject.handler([0x3400, 0x1f001f, 0x3200]) >>> 0, 0xc0000035,
        'STATUS_OBJECT_NAME_COLLISION');
    view.setUint32(0x320c, 0x80, true);
    assert.equal(natives.NtCreateJobObject.handler([0x3400, 0x1f001f, 0x3200]) >>> 0, 0x40000000,
        'OBJ_OPENIF: STATUS_OBJECT_NAME_EXISTS');
});
