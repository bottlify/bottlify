/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNtdllFunctions } from './functions.js';
import { STATUS } from './status.js';
import { UNLOAD_KEY } from '../advapi32/functions.js';
import { TOKEN_NATIVES } from '../advapi32/tokens.js';

const PROCESS_HEAP = 0x8;

/**
 * Stands in for the two tables ntdll draws on. Only the entries these tests
 * reach are here; the rest of the surface is exercised where it is implemented.
 *
 * @param {Object} [options]
 * @param {boolean} [options.registers]  Whether the caller wired EDX.
 */
function fakeHost({ registers = true } = {}){
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const allocations = [];
    /** @type {Record<string, number>} */
    const written = {};

    /** @param {number} address @param {number} length */
    const readMemory = (address, length)=>bytes.subarray(address, address + length);
    /** @param {number} address @param {Uint8Array} data */
    const writeMemory = (address, data)=>bytes.set(data, address);

    const kernel32 = {
        GetProcessHeap: { argBytes: 0, handler: ()=>PROCESS_HEAP },
        HeapAlloc: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([heap])=>{
                allocations.push(heap);
                return 0x900;
            },
        },
        HeapFree: { argBytes: 12, handler: ()=>1 },
        HeapReAlloc: { argBytes: 16, handler: ()=>0 },
        HeapSize: { argBytes: 12, handler: ()=>0 },
        HeapWalk: { argBytes: 8, handler: ()=>0 },
        EnterCriticalSection: { argBytes: 4, handler: ()=>0 },
        RtlUnwind: { argBytes: 16, handler: ()=>0 },
        VerSetConditionMask: { argBytes: 16, handler: ()=>0 },
    };

    const crt = {
        memset: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, value, count])=>{
                bytes.fill(value & 0xff, destination, destination + (count >>> 0));
                return destination;
            },
        },
        memmove: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                bytes.set(bytes.slice(source, source + (count >>> 0)), destination);
                return destination;
            },
        },
        memcpy: { convention: 'cdecl', argBytes: 12, handler: ()=>0 },
        strlen: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },
    };

    return {
        bytes,
        allocations,
        written,
        kernel32,
        crt,
        readMemory,
        writeMemory,
        /** @param {number} address */
        readCString: address=>String(address),
        /** @param {number} address */
        readWideString: address=>String(address),
        teb: ()=>0,
        arena: { base: 0x400000, size: 0x100000 },
        setRegisters: registers
            ? (/** @type {Record<string, number>} */ values)=>Object.assign(written, values)
            : undefined,
    };
}

test('the heap family is the very entry kernel32 exports, not a copy of it', ()=>{
    // A program allocates through RtlAllocateHeap and frees through HeapFree in
    // the same breath. Two allocators would each refuse the other's pointers, and
    // the refusal surfaces as a leak or a crash far from the mismatch.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);

    assert.equal(fns.RtlAllocateHeap, host.kernel32.HeapAlloc);
    assert.equal(fns.RtlFreeHeap, host.kernel32.HeapFree);
    assert.equal(fns.RtlReAllocateHeap, host.kernel32.HeapReAlloc);
    assert.equal(fns.RtlSizeHeap, host.kernel32.HeapSize);
});

test('the aliases carry the argument sizes the guest compiled against', ()=>{
    // Aliasing is only safe while the two names describe the same argument list.
    // These are the numbers a caller of the ntdll spelling pushes.
    const fns = createNtdllFunctions(fakeHost());

    // A native call answers to its Zw name as to its Nt one.
    assert.equal(fns.ZwQuerySystemInformation, fns.NtQuerySystemInformation);
    assert.ok(Object.keys(fns).filter(name=>name.startsWith('Nt'))
        .every(name=>fns[`Zw${name.slice(2)}`] !== undefined), 'every Nt has its Zw');

    assert.equal(fns.RtlAllocateHeap.argBytes, 12);
    assert.equal(fns.RtlFreeHeap.argBytes, 12);
    assert.equal(fns.RtlReAllocateHeap.argBytes, 16);
    assert.equal(fns.RtlSizeHeap.argBytes, 12);
    assert.equal(fns.RtlEnterCriticalSection.argBytes, 4);
    assert.equal(fns.RtlUnwind.argBytes, 16);
});

test('unwinding is the walk kernel32 already drives', ()=>{
    // There is one handler chain per thread and it lives in the thread block. A
    // second dispatcher walking it would call handlers the first had already
    // called, and would publish its own idea of the head afterwards.
    const host = fakeHost();
    assert.equal(createNtdllFunctions(host).RtlUnwind, host.kernel32.RtlUnwind);
});

test('VerSetConditionMask is the entry kernel32 exports', ()=>{
    // kernel32.spec forwards it to ntdll's: one function under two names, so
    // a mask built through either is read the same by VerifyVersionInfo and
    // RtlVerifyVersionInfo.
    const host = fakeHost();
    assert.equal(createNtdllFunctions(host).VerSetConditionMask, host.kernel32.VerSetConditionMask);
});

test('the processor a thread is on is kernel32\'s answer under both native names', ()=>{
    // kernel32's GetCurrentProcessorNumber is forwarded to the Rtl one, and
    // the Nt one is the system call beneath it.
    const host = fakeHost();
    const current = { argBytes: 0, handler: ()=>3 };
    const fns = createNtdllFunctions({ ...host,
        kernel32: { ...host.kernel32, GetCurrentProcessorNumber: current } });
    assert.equal(fns.NtGetCurrentProcessorNumber, current);
    assert.equal(fns.RtlGetCurrentProcessorNumber, current);
});

test('LdrUnloadDll is FreeLibrary as a status', ()=>{
    // A program linked with the Microsoft Layer for Unicode tells NT from
    // Windows 9x by whether ntdll has this name; without it, it loads
    // unicows.dll as on 9x.
    const host = fakeHost();
    /** @type {number[]} */
    const freed = [];
    /** @type {any} */ (host.kernel32).FreeLibrary = { argBytes: 4,
        handler: (/** @type {number[]} */ [module])=>(freed.push(module), module === 0x10000000 ? 1 : 0) };
    const { LdrUnloadDll } = createNtdllFunctions(host);
    assert.equal(LdrUnloadDll.argBytes, 4);
    assert.equal(LdrUnloadDll.handler([0x10000000]), STATUS.SUCCESS);
    assert.equal(LdrUnloadDll.handler([0x20000000]) >>> 0, STATUS.DLL_NOT_FOUND);
    assert.deepEqual(freed, [0x10000000, 0x20000000]);
});

test('a name the other table does not have stays unexported', ()=>{
    // An unresolved import names the function that is missing. An export bound to
    // nothing fails on the call instead, with nothing saying which name it was.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);

    assert.ok(!('RtlLeaveCriticalSection' in fns),
        'the fake kernel32 has no LeaveCriticalSection to alias');
    assert.ok(!('qsort' in fns), 'nor a runtime qsort');
    assert.equal(fns.memset, host.crt.memset, 'while what is there is shared, not copied');
    assert.equal(fns.memset.convention, 'cdecl',
        'and keeps the convention it was declared with');
});

test('the memory helpers take their arguments in ntdll order, not the runtime one', ()=>{
    // The fill value is last here and second in memset, and the length swaps with
    // it. An argument list passed straight through fills memory with the length
    // and writes as many bytes as the value.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);

    fns.RtlFillMemory.handler([0x100, 4, 0xab]);
    assert.deepEqual([...host.bytes.subarray(0x100, 0x105)], [0xab, 0xab, 0xab, 0xab, 0]);

    host.bytes.fill(0xff, 0x200, 0x204);
    fns.RtlZeroMemory.handler([0x200, 3]);
    assert.deepEqual([...host.bytes.subarray(0x200, 0x204)], [0, 0, 0, 0xff]);
});

test('moving memory survives the regions overlapping', ()=>{
    // The name is the promise: this is the call a program uses precisely when the
    // regions overlap, and a byte-at-a-time copy would rewrite its own source.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);
    host.bytes.set([1, 2, 3, 4], 0x300);

    fns.RtlMoveMemory.handler([0x301, 0x300, 3]);

    assert.deepEqual([...host.bytes.subarray(0x300, 0x305)], [1, 1, 2, 3, 0]);
});

test('RtlCompareMemory counts matching bytes and does not order them', ()=>{
    // It returns how far two blocks agree, so a complete match is the largest
    // number it can answer. Code that reads it as memcmp sees equality as
    // "greater than" and takes the wrong branch every time.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);
    host.bytes.set([1, 2, 3, 4], 0x400);
    host.bytes.set([1, 2, 9, 4], 0x410);

    assert.equal(fns.RtlCompareMemory.handler([0x400, 0x410, 4]), 2);
    assert.equal(fns.RtlCompareMemory.handler([0x400, 0x400, 4]), 4,
        'identical blocks match all the way');
    assert.equal(fns.RtlCompareMemory.handler([0x400, 0x410, 0]), 0);
});

test('a status translation is exported and reads its argument unsigned', ()=>{
    const fns = createNtdllFunctions(fakeHost());

    assert.equal(fns.RtlNtStatusToDosError.argBytes, 4);
    assert.equal(fns.RtlNtStatusToDosError.handler([0xc0000022 | 0]), 5);
});

test('the counted-string family allocates out of the process heap', ()=>{
    // Not out of an allocator of its own: RtlFreeUnicodeString and RtlFreeHeap
    // are both valid ways to give one of these buffers back.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);
    // A source of one character, and a destination with no buffer of its own.
    host.bytes.set([1, 0, 2, 0, 0x40, 0x00, 0x00, 0x00], 0x20);

    fns.RtlAnsiStringToUnicodeString.handler([0x10, 0x20, 1]);

    assert.deepEqual(host.allocations, [PROCESS_HEAP]);
});

test('the 64-bit helpers appear only when there is a register to answer in', ()=>{
    // Their answer is two registers wide and the dispatcher writes one. Without
    // the seam they would hand back half an answer, so they are not exported at
    // all and an import that needs one says so.
    assert.ok('_allmul' in createNtdllFunctions(fakeHost()));
    assert.ok(!('_allmul' in createNtdllFunctions(fakeHost({ registers: false }))));
});

test('a kernel32 entry\'s native calls are published under their own names', ()=>{
    // NtQueueApcThread and NtTestAlert are built over the APC queues, which
    // only kernel32's table holds, and ride on QueueUserAPC's entry.
    const host = fakeHost();
    const native = { argBytes: 20, handler: ()=>0 };
    Object.assign(host.kernel32, {
        QueueUserAPC: { argBytes: 12, handler: ()=>1, natives: { NtQueueApcThread: native } },
    });
    const fns = createNtdllFunctions(host);
    assert.equal(fns.NtQueueApcThread, native);
    assert.ok(!('QueueUserAPC' in fns), 'the entry itself stays kernel32\'s');
});

test('RtlWalkHeap is HeapWalk answered as a status, its end STATUS_NO_MORE_ENTRIES', ()=>{
    // kernel32's heap tests loop `while (!RtlWalkHeap(heap, &entry))`: the end
    // of the walk has to be a status that is not zero.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);

    assert.equal(fns.RtlWalkHeap.handler([PROCESS_HEAP, 0x100]) >>> 0, 0x8000001a);
    host.kernel32.HeapWalk.handler = ()=>1;
    assert.equal(fns.RtlWalkHeap.handler([PROCESS_HEAP, 0x100]), 0, 'an entry is success');
    assert.equal(fns.RtlWalkHeap.argBytes, 8);
    assert.equal(fns.RtlNtStatusToDosError.handler([0x8000001a]), 259,
        'and it reads as ERROR_NO_MORE_ITEMS');
});

test('RtlGetCurrentPeb reads the process block out of the running thread\'s', ()=>{
    const host = /** @type {any} */ (fakeHost());
    host.teb = ()=>0x200;
    host.bytes.set([0x00, 0x30, 0x40, 0x7f], 0x230);
    assert.equal(createNtdllFunctions(host).RtlGetCurrentPeb.handler([]), 0x7f403000);
    host.teb = ()=>0;
    assert.equal(createNtdllFunctions(host).RtlGetCurrentPeb.handler([]), 0);
});

test('RtlImageNtHeader finds the PE headers an image points at, and nothing in anything else', ()=>{
    // Wine's kernel32 process.c test_SuspendProcessState (create_process)
    // patches a mapped image's subsystem through what this answers.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);
    const image = 0x400;
    host.bytes.set([0x4d, 0x5a], image);
    host.bytes.set([0x80, 0, 0, 0], image + 0x3c);
    host.bytes.set([0x50, 0x45, 0, 0], image + 0x80);
    assert.equal(fns.RtlImageNtHeader.handler([image]), image + 0x80);
    host.bytes[image + 0x81] = 0;
    assert.equal(fns.RtlImageNtHeader.handler([image]), 0, 'no PE signature');
    assert.equal(fns.RtlImageNtHeader.handler([image + 4]), 0, 'no DOS stub');
    assert.equal(fns.RtlImageNtHeader.handler([0]), 0);
    assert.equal(fns.RtlImageNtHeader.argBytes, 4);
});

test('the token calls are advapi32\'s own entries; a shutdown is not implemented', ()=>{
    const entry = { argBytes: 12, handler: ()=>0 };
    /** @type {string[]} */
    const diverged = [];
    const fns = createNtdllFunctions({ ...fakeHost(), advapi32: {
        [TOKEN_NATIVES]: { NtOpenProcessToken: entry },
    }, divergence: api=>diverged.push(api) });
    assert.equal(fns.NtOpenProcessToken, entry, 'one table of tokens, not a second');
    assert.equal(fns.NtShutdownSystem.argBytes, 4);
    assert.equal(fns.NtShutdownSystem.handler([1]), 0xc0000002, 'STATUS_NOT_IMPLEMENTED');
    assert.deepEqual(diverged, ['NtShutdownSystem']);
});

test('NtUnloadKey names a hive the native way and unloads it through the registry', ()=>{
    // advapi32's registry test: a hive with a handle open on it cannot be
    // unloaded, and the user's default hive is no loaded one.
    const host = fakeHost();
    /** @type {[number, string][]} */
    const asked = [];
    const fns = createNtdllFunctions({ ...host, advapi32: {
        [UNLOAD_KEY]: (/** @type {number} */ root, /** @type {string} */ path)=>{
            asked.push([root, path]);
            return 0xc0000121;
        },
    } });
    /** @param {string} name */
    const attributes = name=>{
        const view = new DataView(host.bytes.buffer);
        for (let at = 0; at < name.length; at++)
        {
            view.setUint16(0x300 + at * 2, name.charCodeAt(at), true);
        }
        view.setUint16(0x200, name.length * 2, true);
        view.setUint16(0x202, name.length * 2, true);
        view.setUint32(0x204, 0x300, true);
        view.setUint32(0x100, 24, true);
        view.setUint32(0x108, 0x200, true);
        return 0x100;
    };
    const unload = fns.NtUnloadKey;
    assert.equal(unload.argBytes, 4);
    assert.equal(unload.handler([attributes('\\REGISTRY\\Machine\\Test')]), 0xc0000121);
    assert.equal(unload.handler([attributes('\\REGISTRY\\User\\.Default')]), 0xc0000121);
    assert.deepEqual(asked, [[0x80000002, 'Test'], [0x80000003, '.Default']]);
    assert.equal(unload.handler([attributes('\\Somewhere\\Else')]), 0xc0000034);
    assert.equal(unload.handler([0]), 0xc000000d);
    assert.ok(!('NtUnloadKey' in createNtdllFunctions(host)), 'without a registry, unexported');
});

test('NtQuerySystemTime is GetSystemTimeAsFileTime answered as a status', ()=>{
    const host = fakeHost();
    /** @type {number[]} */
    const asked = [];
    host.kernel32 = /** @type {any} */ ({ ...host.kernel32, GetSystemTimeAsFileTime: { argBytes: 4,
        handler: (/** @type {number[]} */ [out])=>{
            asked.push(out);
            host.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], out);
            return 0;
        } } });
    const fns = createNtdllFunctions(host);
    assert.equal(fns.NtQuerySystemTime.handler([0x180]), 0);
    assert.deepEqual(asked, [0x180]);
    assert.deepEqual([...host.bytes.subarray(0x180, 0x188)], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(fns.NtQuerySystemTime.handler([0]), 0xc0000005, 'nowhere to put it');
});

test('a heap block keeps a user value and user flags, and a pointer no block is refused', ()=>{
    // kernel32's heap test: RtlSetUserValueHeap, RtlSetUserFlagsHeap, RtlGetUserInfoHeap.
    const host = fakeHost();
    /** @type {number[]} */
    const errors = [];
    host.kernel32 = /** @type {any} */ ({ ...host.kernel32,
        HeapValidate: { argBytes: 12, handler: (/** @type {number[]} */ [, , block])=>
            (block === 0x2000 ? 1 : 0) },
        SetLastError: { argBytes: 4, handler: (/** @type {number[]} */ [code])=>errors.push(code) },
    });
    const fns = createNtdllFunctions(host);
    const view = new DataView(host.bytes.buffer);
    assert.equal(fns.RtlGetUserInfoHeap.handler([0x10, 0, 0x2000, 0x180, 0x184]), 1);
    assert.deepEqual([view.getUint32(0x180, true), view.getUint32(0x184, true)], [0, 0x200]);
    assert.equal(fns.RtlSetUserValueHeap.handler([0x10, 0, 0x2000, 0xdeadbeef]), 1);
    assert.equal(fns.RtlSetUserFlagsHeap.handler([0x10, 0, 0x2000, 0, 0x1000]), 0,
        'a flag no program may set');
    assert.equal(fns.RtlSetUserFlagsHeap.handler([0x10, 0, 0x2000, 0x400, 0x800]), 1);
    fns.RtlGetUserInfoHeap.handler([0x10, 0, 0x2000, 0x180, 0x184]);
    assert.deepEqual([view.getUint32(0x180, true), view.getUint32(0x184, true)],
        [0xdeadbeef, 0xa00]);
    assert.equal(fns.RtlGetUserInfoHeap.handler([0x10, 0, 0x3000, 0x180, 0x184]), 0,
        'no block there');
    assert.deepEqual(errors, [87, 87]);
});

test('the debugging calls are in the table, and the process calls only over kernel32\'s', ()=>{
    const host = fakeHost();
    const fns = /** @type {Record<string, any>} */ (createNtdllFunctions(host));
    assert.deepEqual([...fns.DbgBreakPoint.code()], [0xcc, 0xc3], 'code of its own');
    assert.equal(fns.ZwCreateDebugObject, fns.NtCreateDebugObject);
    assert.equal(fns.ZwWaitForDebugEvent, fns.NtWaitForDebugEvent);
    assert.equal(fns.DbgPrint.convention, 'cdecl');
    assert.equal(fns.NtResumeThread, undefined, 'no ResumeThread to answer with');

    const more = /** @type {Record<string, any>} */ (host.kernel32);
    for (const name of ['ResumeThread', 'OpenProcess', 'FindResourceExW', 'LoadResource',
        'SizeofResource'])
    {
        more[name] = { argBytes: 4, handler: ()=>0 };
    }
    const full = /** @type {Record<string, any>} */ (createNtdllFunctions(host));
    for (const name of ['NtResumeThread', 'ZwResumeThread', 'NtOpenProcess', 'ZwOpenProcess',
        'RtlFindMessage', 'RtlCreateProcessParameters', 'RtlDestroyProcessParameters',
        'RtlCreateUserProcess'])
    {
        assert.equal(typeof full[name]?.handler, 'function', name);
    }
});

test('ntdll\'s printers are the runtime\'s own, the wide one with them', ()=>{
    // Wine's shlwapi test_printf_format checks wnsprintf against ntdll's two.
    const host = fakeHost();
    const printer = { convention: 'cdecl', argBytes: 12 + 4 * 32, handler: ()=>0 };
    Object.assign(host.crt, { _snprintf: printer, _snwprintf: { ...printer } });
    const fns = createNtdllFunctions(host);
    assert.equal(fns._snprintf, /** @type {any} */ (host.crt)._snprintf);
    assert.equal(fns._snwprintf, /** @type {any} */ (host.crt)._snwprintf,
        'msvcrt\'s formatting, entry and convention');
});

test('the status an error was made from is the thread\'s to read back', ()=>{
    const host = { ...fakeHost(), teb: ()=>0x400 };
    const fns = createNtdllFunctions(host);
    assert.equal(fns.RtlGetLastNtStatus.argBytes, 0);
    assert.equal(fns.RtlNtStatusToDosError.handler([0xc0000034 | 0]), 2);
    assert.equal(fns.RtlGetLastNtStatus.handler([]) >>> 0, 0xc0000034,
        'kept in TEB.LastStatusValue');
    assert.equal(new DataView(host.bytes.buffer).getUint32(0x400 + 0xbf4, true), 0xc0000034);
});

test('the current user\'s key path names the user\'s SID under \\REGISTRY\\USER', ()=>{
    const host = fakeHost();
    const fns = createNtdllFunctions(host);
    assert.equal(fns.RtlFormatCurrentUserKeyPath.handler([0x40]), STATUS.SUCCESS);
    const view = new DataView(host.bytes.buffer);
    const length = view.getUint16(0x40, true);
    assert.equal(view.getUint16(0x42, true), length + 2, 'room for the terminator');
    assert.equal(view.getUint32(0x44, true), 0x900, 'from the process heap');
    const text = new TextDecoder('utf-16le').decode(host.bytes.subarray(0x900, 0x900 + length));
    assert.match(text, /^\\REGISTRY\\USER\\S-1-5-21-\d+-\d+-\d+-1000$/);
    assert.deepEqual(host.allocations, [PROCESS_HEAP]);
});

test('NtOpenKeyEx is NtOpenKey with the open options it knows', async()=>{
    const { REGISTRY_NATIVES } = await import('../advapi32/functions.js');
    /** @type {number[][]} */
    const opened = [];
    const host = { ...fakeHost(), advapi32: { [REGISTRY_NATIVES]: { entries: {
        NtOpenKey: { argBytes: 12, handler: (/** @type {number[]} */ args)=>{
            opened.push(args);
            return 0;
        } },
    } } } };
    const fns = createNtdllFunctions(host);
    assert.equal(fns.NtOpenKeyEx.argBytes, 16);
    assert.equal(fns.NtOpenKeyEx.handler([0x10, 0x20019, 0x30, 0x8]), 0);
    assert.deepEqual(opened, [[0x10, 0x20019, 0x30]]);
    assert.equal(fns.NtOpenKeyEx.handler([0x10, 0x20019, 0x30, 0x1]) >>> 0,
        STATUS.INVALID_PARAMETER);
    assert.equal(fns.ZwOpenKeyEx, fns.NtOpenKeyEx);
});
