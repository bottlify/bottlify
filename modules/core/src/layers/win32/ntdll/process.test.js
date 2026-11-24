/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessFunctions } from './process.js';

const STATUS_SUCCESS = 0;
const STATUS_UNSUCCESSFUL = 0xc0000001;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_CID = 0xc000000b;
const STATUS_INVALID_PARAMETER_MIX = 0xc0000030;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_RESOURCE_TYPE_NOT_FOUND = 0xc000008a;
const STATUS_MESSAGE_NOT_FOUND = 0xc0000109;

const MODULE = 0x400000;
const TABLE = 0x1000;
const OUT = 0x100;
const STRING = 0x200;
const TEB = 0x3000;
const PEB = 0x3100;

function setup(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    let lastError = 0x77;
    let heap = 0x8000;
    /** @type {number[]} */
    const freed = [];
    /** @type {any[]} */
    const created = [];
    /** @type {number[]} */
    const resumed = [];
    let tableSize = 0;
    /** @param {number} address */
    const wideAt = address=>{
        let text = '';
        for (let at = address; view.getUint16(at, true) !== 0; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };
    /** @type {Record<string, { handler: Function }>} */
    const kernel32 = {
        GetLastError: { handler: ()=>lastError },
        SetLastError: { handler: (/** @type {number[]} */ [code])=>{
            lastError = code;
            return 0;
        } },
        ResumeThread: { handler: (/** @type {number[]} */ [handle])=>{
            resumed.push(handle);
            if (handle === 0x10)
            {
                return 2;
            }
            lastError = 6;
            return 0xffffffff;
        } },
        SuspendThread: { handler: (/** @type {number[]} */ [handle])=>{
            if (handle === 0x10)
            {
                return 1;
            }
            lastError = 6;
            return 0xffffffff;
        } },
        // A thread 0x10 whose context reads; 0x20 has ended; the registers are
        // never replaced.
        GetThreadContext: { handler: (/** @type {number[]} */ [handle])=>{
            if (handle === 0x10)
            {
                return 1;
            }
            lastError = handle === 0x20 ? 31 : 6;
            return 0;
        } },
        SetThreadContext: { handler: (/** @type {number[]} */ [handle])=>{
            lastError = handle === 0x10 ? 5 : 6;
            return 0;
        } },
        OpenProcess: { handler: (/** @type {number[]} */ [, , id])=>{
            if (id === 0x1000)
            {
                return 0x44;
            }
            lastError = 87;
            return 0;
        } },
        FindResourceExW: { handler: (/** @type {number[]} */ [base, type, name, language])=>{
            if (base === MODULE && type === 11 && name === 1 && language === 0)
            {
                return 0x5000;
            }
            lastError = 1813;
            return 0;
        } },
        LoadResource: { handler: ()=>TABLE },
        SizeofResource: { handler: ()=>tableSize },
        CreateProcessW: { handler: (/** @type {number[]} */ args)=>{
            const [application, line, , , inherit, flags, environment, folder, startup,
                information] = args;
            created.push({
                application: wideAt(application), line: wideAt(line), inherit, flags,
                environment, folder: folder === 0 ? null : wideAt(folder),
                startupSize: view.getUint32(startup, true),
            });
            if (wideAt(application).endsWith('missing.exe'))
            {
                lastError = 2;
                return 0;
            }
            [0x50, 0x54, 0x1004, 0x1008].forEach((value, at)=>
                view.setUint32(information + at * 4, value, true));
            return 1;
        } },
    };
    const fns = /** @type {Record<string, any>} */ (createProcessFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        kernel32,
        teb: ()=>TEB,
        allocate: size=>{
            const at = heap;
            heap += (size + 7) & ~7;
            return at;
        },
        free: address=>{
            freed.push(address);
            return true;
        },
    }));
    /** A UNICODE_STRING at `at`, its text just after it. @param {number} at @param {string} text */
    const counted = (at, text)=>{
        view.setUint16(at, text.length * 2, true);
        view.setUint16(at + 2, text.length * 2 + 2, true);
        view.setUint32(at + 4, at + 8, true);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + 8 + i * 2, text.charCodeAt(i), true);
        }
        view.setUint16(at + 8 + text.length * 2, 0, true);
        return at;
    };
    return {
        bytes, view, fns, freed, created, resumed, counted, wideAt,
        lastError: ()=>lastError,
        /** @param {number} size */
        setTableSize: size=>{
            tableSize = size;
        },
    };
}

test('NtResumeThread is ResumeThread as a status, the last error left alone', ()=>{
    const { view, fns, lastError } = setup();
    assert.equal(fns.NtResumeThread.handler([0x10, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), 2, 'the count before');
    assert.equal(fns.NtResumeThread.handler([0x10, 0]), STATUS_SUCCESS, 'no count asked for');
    assert.equal(fns.NtResumeThread.handler([0x99, OUT]), STATUS_INVALID_HANDLE);
    assert.equal(lastError(), 0x77, 'a native call leaves no last error');
    assert.equal(fns.NtResumeThread.argBytes, 8);
});

test('NtSuspendThread is SuspendThread as a status', ()=>{
    const { view, fns, lastError } = setup();
    assert.equal(fns.NtSuspendThread.handler([0x10, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), 1, 'the count before');
    assert.equal(fns.NtSuspendThread.handler([0x99, OUT]), STATUS_INVALID_HANDLE);
    assert.equal(lastError(), 0x77, 'a native call leaves no last error');
    assert.equal(fns.NtSuspendThread.argBytes, 8);
});

test('Nt[GS]etContextThread answer the status the thread call\'s failure is made from', ()=>{
    const { fns, lastError } = setup();
    assert.equal(fns.NtGetContextThread.handler([0x10, OUT]), STATUS_SUCCESS);
    assert.equal(fns.NtGetContextThread.handler([0x99, OUT]), STATUS_INVALID_HANDLE);
    assert.equal(fns.NtGetContextThread.handler([0x20, OUT]), STATUS_UNSUCCESSFUL,
        'a thread that has ended: ERROR_GEN_FAILURE is STATUS_UNSUCCESSFUL');
    assert.equal(fns.NtSetContextThread.handler([0x10, OUT]), STATUS_ACCESS_DENIED,
        'the registers refused as SetThreadContext refuses them');
    assert.equal(fns.NtSetContextThread.handler([0x99, OUT]), STATUS_INVALID_HANDLE);
    assert.equal(lastError(), 0x77, 'a native call leaves no last error');
    assert.equal(fns.NtGetContextThread.argBytes, 8);
    assert.equal(fns.NtSetContextThread.argBytes, 8);
});

test('NtOpenProcess opens by the client id, and refuses what names nothing', ()=>{
    const { view, fns, lastError } = setup();
    view.setUint32(0x300, 0x1000, true);
    view.setUint32(0x304, 0, true);
    assert.equal(fns.NtOpenProcess.handler([OUT, 0x1f0fff, 0, 0x300]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), 0x44);
    view.setUint32(0x300, 0x2000, true);
    assert.equal(fns.NtOpenProcess.handler([OUT, 0x1f0fff, 0, 0x300]), STATUS_INVALID_CID);
    assert.equal(fns.NtOpenProcess.handler([OUT, 0x1f0fff, 0, 0]), STATUS_INVALID_PARAMETER_MIX);
    assert.equal(fns.NtOpenProcess.handler([0, 0x1f0fff, 0, 0x300]), STATUS_ACCESS_VIOLATION);
    assert.equal(lastError(), 0x77);
    assert.equal(fns.NtOpenProcess.argBytes, 16);
});

test('RtlFindMessage walks the message table to the entry, in the module\'s own image', ()=>{
    const { view, fns, setTableSize } = setup();
    // Two blocks: ids 1-2, then 100. Entries: a length, flags, then the text.
    view.setUint32(TABLE, 2, true);
    view.setUint32(TABLE + 4, 1, true);
    view.setUint32(TABLE + 8, 2, true);
    view.setUint32(TABLE + 12, 28, true);
    view.setUint32(TABLE + 16, 100, true);
    view.setUint32(TABLE + 20, 100, true);
    view.setUint32(TABLE + 24, 44, true);
    view.setUint16(TABLE + 28, 8, true);
    view.setUint16(TABLE + 36, 8, true);
    view.setUint16(TABLE + 44, 8, true);
    setTableSize(52);

    assert.equal(fns.RtlFindMessage.handler([MODULE, 11, 0, 1, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), TABLE + 28);
    assert.equal(fns.RtlFindMessage.handler([MODULE, 11, 0, 2, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), TABLE + 36, 'past the first by its own length');
    assert.equal(fns.RtlFindMessage.handler([MODULE, 11, 0, 100, OUT]), STATUS_SUCCESS);
    assert.equal(view.getUint32(OUT, true), TABLE + 44);
    assert.equal(fns.RtlFindMessage.handler([MODULE, 11, 0, 3, OUT]), STATUS_MESSAGE_NOT_FOUND);
    assert.equal(fns.RtlFindMessage.handler([MODULE, 6, 0, 1, OUT]),
        STATUS_RESOURCE_TYPE_NOT_FOUND, 'no table of that type');
    assert.equal(fns.RtlFindMessage.argBytes, 20);
});

test('RtlCreateProcessParameters builds the block with offsets, the image as the command line',
    ()=>{
        const { bytes, view, fns, counted, freed } = setup();
        // The running process's own block, normalised, with a directory to inherit.
        const own = 0x4000;
        view.setUint32(TEB + 0x30, PEB, true);
        view.setUint32(PEB + 0x10, own, true);
        view.setUint32(own + 8, 1, true);
        counted(0x4400, 'C:\\game\\');
        bytes.copyWithin(own + 0x24, 0x4400, 0x4408);
        view.setUint32(own + 0x48, 0x6000, true);
        bytes.set(new Uint8Array(Uint16Array.from('A=1\0\0', c=>c.charCodeAt(0)).buffer), 0x6000);

        const image = counted(STRING, 'C:\\game\\child.exe');
        assert.equal(fns.RtlCreateProcessParameters.handler(
            [OUT, image, 0, 0, 0, 0, 0, 0, 0, 0]), STATUS_SUCCESS);
        const block = view.getUint32(OUT, true);
        const size = view.getUint32(block + 4, true);
        assert.equal(view.getUint32(block, true), size, 'AllocationSize is Size');
        assert.equal(view.getUint32(block + 8, true), 0, 'not normalised: offsets');
        /** @param {number} field */
        const text = field=>{
            const length = view.getUint16(block + field, true);
            const offset = view.getUint32(block + field + 4, true);
            assert.ok(offset >= 0x298 && offset + length <= size && offset % 4 === 0,
                `0x${field.toString(16)}`);
            return String.fromCharCode(...new Uint16Array(
                bytes.slice(block + offset, block + offset + length).buffer));
        };
        assert.equal(text(0x38), 'C:\\game\\child.exe');
        assert.equal(view.getUint16(block + 0x3a, true), 36, 'the image\'s own room');
        assert.equal(text(0x40), 'C:\\game\\child.exe', 'the command line is the image');
        assert.equal(text(0x24), 'C:\\game\\', 'the directory the process has');
        assert.equal(view.getUint16(block + 0x26, true), 520, 'a directory has MAX_PATH');
        assert.equal(text(0x70), '');
        assert.equal(view.getUint16(block + 0x72, true), 2, 'an empty title: room for its end');
        assert.equal(view.getUint16(block + 0x8a, true), 0, 'no runtime data: no room');
        assert.equal(view.getUint32(block + 0x8c, true), 0, 'and no buffer');
        assert.equal(view.getUint32(block + 0x48, true), block + size,
            'the environment copied after the strings');
        assert.equal(String.fromCharCode(...new Uint16Array(
            bytes.slice(block + size, block + size + 6).buffer)), 'A=1');
        assert.equal(view.getUint32(block + 0x290, true), 12, 'EnvironmentSize: what is left');

        assert.equal(fns.RtlDestroyProcessParameters.handler([block]), STATUS_SUCCESS);
        assert.deepEqual(freed, [block]);
        assert.equal(fns.RtlCreateProcessParameters.handler([OUT, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            0xc000000d, 'no image is STATUS_INVALID_PARAMETER');
        assert.equal(fns.RtlCreateProcessParameters.argBytes, 40);
    });

test('RtlCreateProcessParametersEx with RTL_USER_PROC_PARAMS_NORMALIZED hands out addresses',
    ()=>{
        const { bytes, view, fns, counted } = setup();
        const image = counted(STRING, 'C:\\game\\child.exe');
        assert.equal(fns.RtlCreateProcessParametersEx.argBytes, 44);
        assert.equal(fns.RtlCreateProcessParametersEx.handler(
            [OUT, image, 0, 0, 0, 0, 0, 0, 0, 0, 1]), STATUS_SUCCESS);
        const block = view.getUint32(OUT, true);
        assert.equal(view.getUint32(block + 8, true), 1, 'its Flags say normalised');
        const address = view.getUint32(block + 0x38 + 4, true);
        assert.ok(address > block, 'the image name is an address in the block');
        const length = view.getUint16(block + 0x38, true);
        assert.equal(String.fromCharCode(...new Uint16Array(
            bytes.slice(address, address + length).buffer)), 'C:\\game\\child.exe');

        assert.equal(fns.RtlCreateProcessParametersEx.handler(
            [OUT, image, 0, 0, 0, 0, 0, 0, 0, 0, 0]), STATUS_SUCCESS);
        const plain = view.getUint32(OUT, true);
        assert.equal(view.getUint32(plain + 8, true), 0, 'without the flag: offsets');
        assert.ok(view.getUint32(plain + 0x38 + 4, true) < view.getUint32(plain, true));
    });

test('RtlCreateUserProcess is CreateProcessW over the parameters, its thread suspended', ()=>{
    const { view, fns, counted, created, lastError } = setup();
    const image = counted(STRING, 'C:\\game\\child.exe');
    const line = counted(0x500, '"C:\\game\\child.exe" -x');
    assert.equal(fns.RtlCreateProcessParameters.handler(
        [OUT, image, 0, 0, line, 0x6000, 0, 0, 0, 0]), STATUS_SUCCESS);
    const parameters = view.getUint32(OUT, true);
    const name = counted(0x600, '\\??\\C:\\game\\child.exe');
    const INFO = 0x700;
    assert.equal(fns.RtlCreateUserProcess.handler(
        [name, 0, parameters, 0, 0, 0, 1, 0, 0, INFO]), STATUS_SUCCESS);
    assert.deepEqual(created[0], {
        application: 'C:\\game\\child.exe', line: '"C:\\game\\child.exe" -x', inherit: 1,
        flags: 0x404, environment: view.getUint32(parameters + 0x48, true), folder: null,
        startupSize: 68,
    }, 'the environment the parameters copied');
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>view.getUint32(INFO + at, true)),
        [0x44, 0x50, 0x54, 0x1004, 0x1008], 'the size, both handles and the client id');

    const missing = counted(0x800, '\\??\\C:\\game\\missing.exe');
    assert.equal(fns.RtlCreateUserProcess.handler(
        [missing, 0, parameters, 0, 0, 0, 0, 0, 0, INFO]), STATUS_OBJECT_NAME_NOT_FOUND);
    assert.equal(lastError(), 0x77);
    assert.equal(fns.RtlCreateUserProcess.argBytes, 40);
});

test('NtCreateUserProcess makes the child its attribute list names, suspended when asked', ()=>{
    const { bytes, view, fns, counted, created, resumed, lastError } = setup();
    const PATH = 0x900;
    const path = '\\??\\C:\\game\\child.exe';
    const image = counted(STRING, path);
    assert.equal(fns.RtlCreateProcessParametersEx.handler(
        [OUT, image, 0, 0, 0, 0, 0, 0, 0, 0, 1]), STATUS_SUCCESS);
    const parameters = view.getUint32(OUT, true);
    // PS_ATTRIBUTE_LIST: the image's name by pointer, then where the client
    // id goes; each attribute four dwords after the list's TotalLength.
    const LIST = 0xa00;
    const CLIENT = 0xb00;
    for (let i = 0; i < path.length; i++)
    {
        view.setUint16(PATH + i * 2, path.charCodeAt(i), true);
    }
    [36, 0x20005, path.length * 2, PATH, 0, 0x10003, 8, CLIENT, 0].forEach((value, at)=>
        view.setUint32(LIST + at * 4, value, true));
    const INFO = 0xc00;
    view.setUint32(INFO, 0x48, true);
    const PROCESS = 0xd00;
    const THREAD = 0xd04;
    const call = (/** @type {number} */ threadFlags, /** @type {number} */ processFlags = 0)=>
        fns.NtCreateUserProcess.handler([PROCESS, THREAD, 0x1fffff, 0x1fffff, 0, 0,
            processFlags, threadFlags, parameters, INFO, LIST]);

    assert.equal(call(0x1 | 0x4), 0xc000000d,
        'a new process\'s first thread is not hidden from a debugger');
    assert.equal(created.length, 0);

    assert.equal(call(0x1), STATUS_SUCCESS);
    assert.deepEqual(created[0], {
        application: 'C:\\game\\child.exe', line: path, inherit: 0, flags: 0x404,
        environment: view.getUint32(parameters + 0x48, true), folder: null, startupSize: 68,
    }, 'the parameters\' command line, the image without its \\??\\');
    assert.deepEqual([view.getUint32(PROCESS, true), view.getUint32(THREAD, true)],
        [0x50, 0x54]);
    assert.deepEqual([view.getUint32(CLIENT, true), view.getUint32(CLIENT + 4, true)],
        [0x1004, 0x1008], 'the client id where the attribute asks');
    assert.equal(view.getUint32(INFO + 4, true), 6, 'PsCreateSuccess');
    assert.deepEqual(resumed, [], 'left suspended');

    assert.equal(call(0, 0x4), STATUS_SUCCESS);
    assert.equal(created[1].inherit, 1, 'PROCESS_CREATE_FLAGS_INHERIT_HANDLES');
    assert.deepEqual(resumed, [0x54], 'not asked to stay suspended, it runs');

    view.setUint32(LIST, 4, true);
    assert.equal(call(0x1), 0xc000000d, 'no image named');
    assert.equal(lastError(), 0x77);
    assert.equal(fns.NtCreateUserProcess.argBytes, 44);
    void bytes;
});

test('NtTerminateProcess with no handle ends the other threads, then the process', ()=>{
    /** @type {any[][]} */
    const calls = [];
    let lastError = 0x77;
    /** @param {string} name @param {(args: number[]) => number} answer */
    const entry = (name, answer)=>({ handler: (/** @type {number[]} */ args)=>{
        calls.push([name, ...args]);
        return answer(args);
    } });
    const kernel32 = {
        GetLastError: { handler: ()=>lastError },
        SetLastError: { handler: (/** @type {number[]} */ [code])=>{
            lastError = code;
            return 0;
        } },
        GetCurrentThreadId: entry('GetCurrentThreadId', ()=>7),
        OpenThread: entry('OpenThread', ([, , id])=>0x100 + id),
        TerminateThread: entry('TerminateThread', ()=>1),
        CloseHandle: entry('CloseHandle', ()=>1),
        TerminateProcess: entry('TerminateProcess', ([handle])=>{
            if (handle === 0x66)
            {
                lastError = 6;
                return 0;
            }
            return 1;
        }),
    };
    const fns = /** @type {Record<string, any>} */ (createProcessFunctions({
        readMemory: ()=>new Uint8Array(4),
        writeMemory: ()=>{},
        kernel32,
        teb: ()=>0,
        allocate: ()=>0,
        free: ()=>true,
        processes: ()=>[{ id: 1, threads: [5, 7, 9] }, { id: 2, threads: [11] }],
        terminate: ()=>calls.push(['ending']),
    }));
    const terminations = ()=>calls.filter(([name])=>name !== 'GetCurrentThreadId');

    assert.equal(fns.NtTerminateProcess.handler([0, 0xdead]), STATUS_SUCCESS, 'it returns');
    assert.deepEqual(calls.shift(), ['ending'], 'the process is ending before its threads end');
    assert.deepEqual(terminations(), [
        ['OpenThread', 1, 0, 5], ['TerminateThread', 0x105, 0xdead], ['CloseHandle', 0x105],
        ['OpenThread', 1, 0, 9], ['TerminateThread', 0x109, 0xdead], ['CloseHandle', 0x109],
    ], 'every thread of this process but the caller, none of another\'s');
    calls.length = 0;
    fns.NtTerminateProcess.handler([0, 2]);
    assert.deepEqual(terminations(), [['TerminateProcess', 0xffffffff, 0xdead]],
        'the caller was the last: the process ends with the status kept the first time');

    calls.length = 0;
    assert.equal(fns.NtTerminateProcess.handler([0x44, 3]), STATUS_SUCCESS,
        'a process handle: TerminateProcess');
    assert.deepEqual(calls, [['TerminateProcess', 0x44, 3]]);
    assert.equal(fns.NtTerminateProcess.handler([0x66, 3]), STATUS_INVALID_HANDLE);
    assert.equal(lastError, 0x77, 'the last error left alone');
    assert.equal(fns.NtTerminateProcess.argBytes, 8);
});

test('NtCreateThreadEx and RtlCreateUserThread are CreateRemoteThreadEx, their flags read', ()=>{
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    /** @type {any[][]} */
    const calls = [];
    let lastError = 0x77;
    let heap = 0x2000;
    // The new thread's block: SameTebFlags at 0xfca, its TLS array pointer at 0x2c.
    const TEB_AT = 0x3000;
    view.setUint16(TEB_AT + 0xfca, 0x0400, true);
    view.setUint32(TEB_AT + 0x2c, 0x1234, true);
    /** @param {string} name @param {(args: number[]) => any} answer */
    const entry = (name, answer)=>({ handler: (/** @type {number[]} */ args)=>{
        calls.push([name, ...args]);
        return answer(args);
    } });
    const kernel32 = {
        GetLastError: { handler: ()=>lastError },
        SetLastError: { handler: (/** @type {number[]} */ [code])=>{
            lastError = code;
            return 0;
        } },
        CreateRemoteThreadEx: entry('CreateRemoteThreadEx', ([process, , , , , , , idOut])=>{
            if (process === 0x66)
            {
                lastError = 6;
                return 0;
            }
            view.setUint32(idOut, 0x120, true);
            return 0x80;
        }),
        GetProcessIdOfThread: entry('GetProcessIdOfThread', ()=>0x1000),
        GetCurrentThreadId: entry('GetCurrentThreadId', ()=>7),
        OpenThread: entry('OpenThread', ([, , id])=>0x100 + id),
        SuspendThread: entry('SuspendThread', ()=>0),
        ResumeThread: entry('ResumeThread', ()=>1),
        CloseHandle: entry('CloseHandle', ()=>1),
    };
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {Record<string, any>} */ (createProcessFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        kernel32,
        teb: ()=>0,
        allocate: size=>{
            const at = heap;
            heap += (size + 7) & ~7;
            return at;
        },
        free: ()=>true,
        processes: ()=>[{ id: 0x1000, threads: [7, 0x120, 9] }],
        native: name=>(name === 'NtSetInformationThread'
            ? entry('NtSetInformationThread', ()=>STATUS_SUCCESS)
            : name === 'NtQueryInformationThread'
                ? entry('NtQueryInformationThread', ([, , out])=>{
                    view.setUint32(out + 4, TEB_AT, true);
                    return STATUS_SUCCESS;
                })
                : undefined),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    }));
    const RESULT = 0x100;
    const START = 0x401000;

    // Suspended (1), hidden from a debugger (4), bypassing a freeze (0x40),
    // a reserve of 1 MiB.
    assert.equal(fns.NtCreateThreadEx.handler([RESULT, 0x1fffff, 0, 0xffffffff, START, 7,
        0x45, 0, 0x1000, 0x100000, 0]), STATUS_SUCCESS);
    assert.deepEqual(calls[0].slice(0, 8),
        ['CreateRemoteThreadEx', 0xffffffff, 0, 0x100000, START, 7, 0x10004, 0],
        'CREATE_SUSPENDED and the reserve as the size, STACK_SIZE_PARAM_IS_A_RESERVATION');
    assert.deepEqual(calls[1], ['NtSetInformationThread', 0x80, 17, 0, 0], 'marked hidden');
    assert.equal(view.getUint32(RESULT, true), 0x80);
    assert.deepEqual(said, []);

    calls.length = 0;
    assert.equal(fns.NtCreateThreadEx.handler([RESULT, 0, 0, 0xffffffff, START, 7, 0, 0,
        0x2000, 0, 0]), STATUS_SUCCESS);
    assert.deepEqual(calls[0].slice(0, 7),
        ['CreateRemoteThreadEx', 0xffffffff, 0, 0x2000, START, 7, 0], 'a commit, running');
    assert.equal(calls.length, 1, 'not hidden');

    // Skipping the attach: made stopped, its block marked, then let go.
    calls.length = 0;
    assert.equal(fns.NtCreateThreadEx.handler([RESULT, 0, 0, 0xffffffff, START, 7, 0x2, 0,
        0x2000, 0, 0]), STATUS_SUCCESS);
    assert.deepEqual(calls.map(([name, ...args])=>(name === 'CreateRemoteThreadEx'
        ? [name, args[5]] : [name, args[0]])),
    [['CreateRemoteThreadEx', 4], ['NtQueryInformationThread', 0x80], ['ResumeThread', 0x80]]);
    assert.equal(view.getUint16(TEB_AT + 0xfca, true), 0x0408, 'SkipThreadAttach, the rest kept');
    assert.equal(view.getUint32(TEB_AT + 0x2c, true), 0, 'no thread-local storage array');
    calls.length = 0;
    fns.NtCreateThreadEx.handler([RESULT, 0, 0, 0xffffffff, START, 7, 0x3, 0, 0, 0, 0]);
    assert.ok(!calls.some(([name])=>name === 'ResumeThread'), 'asked suspended: left stopped');
    assert.deepEqual(said, []);

    // Another process's thread is told of all the same, and that is said.
    fns.NtCreateThreadEx.handler([RESULT, 0, 0, 0x88, START, 7, 0x2, 0, 0, 0, 0]);
    assert.equal(said.length, 1);
    said.length = 0;
    assert.equal(fns.NtCreateThreadEx.handler([RESULT, 0, 0, 0x66, START, 7, 0, 0, 0, 0, 0]),
        STATUS_INVALID_HANDLE);
    assert.equal(lastError, 0x77, 'the last error left alone');

    calls.length = 0;
    const CLIENT = 0x200;
    assert.equal(fns.RtlCreateUserThread.handler([0xffffffff, 0, 1, 0, 0, 0x3000, START, 9,
        RESULT, CLIENT]), STATUS_SUCCESS);
    assert.deepEqual(calls[0].slice(0, 7),
        ['CreateRemoteThreadEx', 0xffffffff, 0, 0x3000, START, 9, 0x4]);
    assert.deepEqual([view.getUint32(CLIENT, true), view.getUint32(CLIENT + 4, true)],
        [0x1000, 0x120], 'the client id');

    // The thread made to bypass a freeze (0x120) is left running, the caller
    // (7) is the one asking, so only thread 9 is suspended.
    calls.length = 0;
    assert.equal(fns.NtSuspendProcess.handler([0xffffffff]), STATUS_SUCCESS);
    assert.deepEqual(calls.filter(([name])=>name === 'SuspendThread'),
        [['SuspendThread', 0x109], ['SuspendThread', 0xfffffffe]],
        'the others, then the caller itself');
    calls.length = 0;
    assert.equal(fns.NtResumeProcess.handler([0xffffffff]), STATUS_SUCCESS);
    assert.deepEqual(calls.filter(([name])=>name === 'ResumeThread'),
        [['ResumeThread', 0x109]]);
    assert.equal(fns.NtSuspendProcess.handler([0x44]), 0xc0000002, 'another process: said');
    assert.equal(said.length, 1);
    assert.deepEqual([fns.NtCreateThreadEx.argBytes, fns.RtlCreateUserThread.argBytes,
        fns.NtSuspendProcess.argBytes], [44, 40, 4]);
});

test('NtGetNextProcess and NtGetNextThread walk the system\'s list, opening what lets them', ()=>{
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {any[]} */
    const opened = [];
    // Handles: 0x100 + id for a process, 0x200 + id for a thread; 0x2a refuses.
    const kernel32 = {
        GetLastError: { handler: ()=>0 },
        SetLastError: { handler: ()=>0 },
        GetProcessId: { handler: (/** @type {number[]} */ [handle])=>
            (handle === 0xffffffff ? 4 : handle > 0x100 && handle < 0x200 ? handle - 0x100 : 0) },
        GetThreadId: { handler: (/** @type {number[]} */ [handle])=>
            (handle > 0x200 && handle < 0x300 ? handle - 0x200 : 0) },
        OpenProcess: { handler: (/** @type {number[]} */ [access, inherit, id])=>{
            opened.push(['process', access, inherit, id]);
            return id === 0x2a ? 0 : 0x100 + id;
        } },
        OpenThread: { handler: (/** @type {number[]} */ [access, inherit, id])=>{
            opened.push(['thread', access, inherit, id]);
            return 0x200 + id;
        } },
    };
    const fns = /** @type {Record<string, any>} */ (createProcessFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        kernel32,
        teb: ()=>0,
        allocate: ()=>0,
        free: ()=>true,
        processes: ()=>[
            { id: 4, parent: 0, path: 'a.exe', threads: [8, 12, 16] },
            { id: 0x2a, parent: 4, path: 'b.exe', threads: [0x30] },
            { id: 0x40, parent: 4, path: 'c.exe', threads: [0x44] },
        ],
    }));
    const NO_MORE_ENTRIES = 0x8000001a;
    const INVALID_HANDLE = STATUS_INVALID_HANDLE;
    const STATUS_INVALID_PARAMETER = 0xc000000d;
    /** @param {string} name @param {number[]} args */
    const next = (name, args)=>{
        view.setUint32(OUT, 0xdeadbeef, true);
        const status = fns[name].handler([...args, OUT]) >>> 0;
        return [status, view.getUint32(OUT, true)];
    };

    assert.deepEqual(next('NtGetNextProcess', [0, 0x1000, 2, 0]), [STATUS_SUCCESS, 0x104]);
    assert.deepEqual(next('NtGetNextProcess', [0x104, 0x1000, 0, 0]), [STATUS_SUCCESS, 0x140],
        'the one that refuses the access passed over');
    assert.deepEqual(next('NtGetNextProcess', [0x140, 0x1000, 0, 0]), [NO_MORE_ENTRIES, 0]);
    assert.deepEqual(next('NtGetNextProcess', [0, 0x1000, 0, 1]), [STATUS_SUCCESS, 0x140],
        'backwards, the last first');
    assert.deepEqual(next('NtGetNextProcess', [0, 0x1000, 0, 2]).slice(0, 1),
        [STATUS_INVALID_PARAMETER]);
    assert.deepEqual(next('NtGetNextProcess', [0x5, 0x1000, 0, 0]), [INVALID_HANDLE, 0]);
    assert.deepEqual(opened[0], ['process', 0x1000, 1, 4], 'OBJ_INHERIT: an inheritable handle');

    assert.deepEqual(next('NtGetNextThread', [0xffffffff, 0, 0x800, 0, 0]),
        [STATUS_SUCCESS, 0x208], 'the process\'s first thread');
    assert.deepEqual(next('NtGetNextThread', [0xffffffff, 0x20c, 0x800, 0, 0]),
        [STATUS_SUCCESS, 0x210]);
    assert.deepEqual(next('NtGetNextThread', [0xffffffff, 0x210, 0x800, 0, 0]),
        [NO_MORE_ENTRIES, 0]);
    assert.deepEqual(next('NtGetNextThread', [0x7, 0, 0x800, 0, 0]), [INVALID_HANDLE, 0]);
    assert.deepEqual(next('NtGetNextThread', [0xffffffff, 0x7, 0x800, 0, 0]), [INVALID_HANDLE, 0]);
    assert.equal(fns.NtGetNextThread.handler([0xffffffff, 0, 0x800, 0, 0, 0]) >>> 0,
        STATUS_ACCESS_VIOLATION);
});
