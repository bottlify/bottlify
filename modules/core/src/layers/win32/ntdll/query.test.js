/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueryFunctions, systemProcessInformation } from './query.js';
import { STATUS } from './status.js';
import { PEB, TEB, createProcessBlocks } from '../kernel32/teb.js';
import { VER, WINDOWS_VERSIONS, setCondition } from '../kernel32/versions.js';
import { createProcessors } from '../kernel32/processor.js';

const TEB_AT = 0x1000;
const PEB_AT = 0x2000;
const BUFFER = 0x100;
const RETURN_LENGTH = 0x80;

const OSVERSIONINFOW_SIZE = 276;
const OSVERSIONINFOEXW_SIZE = 284;
const PAGE_SIZE = 0x1000;

/**
 * @param {Object} [options]
 * @param {boolean} [options.blocks]  Whether the process has its blocks yet.
 * @param {number} [options.arenaSize]
 */
function fakeHost({ blocks = true, arenaSize = 64 * 1024 * 1024 } = {}){
    const bytes = new Uint8Array(0x3000);
    const view = new DataView(bytes.buffer);
    if (blocks)
    {
        view.setUint32(TEB_AT + TEB.PEB, PEB_AT, true);
        view.setUint32(TEB_AT + TEB.PROCESS_ID, 0x1234, true);
        view.setUint32(PEB_AT + PEB.OS_MAJOR_VERSION, 5, true);
        view.setUint32(PEB_AT + PEB.OS_MINOR_VERSION, 1, true);
        view.setUint16(PEB_AT + PEB.OS_BUILD_NUMBER, 2600, true);
        view.setUint16(PEB_AT + PEB.OS_CSD_VERSION, 0x0300, true);
        view.setUint32(PEB_AT + PEB.OS_PLATFORM_ID, 2, true);
    }
    return {
        bytes,
        view,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        teb: ()=>(blocks ? TEB_AT : 0),
        arena: { base: 0x400000, size: arenaSize },
    };
}

test('RtlGetVersion reports what the process block holds', ()=>{
    // Not constants of its own: this is where Windows keeps the version, and a
    // program that reads the block directly must find the same numbers as one
    // that asks. Two sources drift the moment either is edited.
    const host = fakeHost();
    const fns = createQueryFunctions(host);
    host.view.setUint32(BUFFER, OSVERSIONINFOW_SIZE, true);

    assert.equal(fns.RtlGetVersion.handler([BUFFER]), STATUS.SUCCESS);
    assert.equal(host.view.getUint32(BUFFER + 4, true), 5, 'major');
    assert.equal(host.view.getUint32(BUFFER + 8, true), 1, 'minor');
    assert.equal(host.view.getUint32(BUFFER + 12, true), 2600, 'build');
    assert.equal(host.view.getUint32(BUFFER + 16, true), 2, 'VER_PLATFORM_WIN32_NT');
    assert.equal(host.view.getUint32(BUFFER, true), OSVERSIONINFOW_SIZE,
        'and the size the caller declared is left alone');
});

test('RtlGetVersion answers each Windows the process block was built for', ()=>{
    // The block as the loader writes it, read back through the call: the
    // service pack comes from the block's own WORD and string, and the suite
    // and product type, which live in the kernel's shared page on Windows,
    // from the version the host names.
    for (const version of Object.values(WINDOWS_VERSIONS))
    {
        const bytes = new Uint8Array(0x10000);
        const view = new DataView(bytes.buffer);
        let next = 0x4000;
        const blocks = createProcessBlocks({
            allocate: size=>{
                const at = next;
                next += size + 15 & ~15;
                return at;
            },
            writeMemory: (at, data)=>bytes.set(data, at),
            processId: 0x1234,
            version,
            imageBase: 0x400000,
        });
        const { teb } = blocks.createThreadBlock({ id: 1, stackBase: 0x3000, stackLimit: 0x2000 });
        const fns = createQueryFunctions({
            readMemory: (address, length)=>bytes.subarray(address, address + length),
            writeMemory: (address, data)=>bytes.set(data, address),
            teb: ()=>teb,
            arena: { base: 0x400000, size: 0x100000 },
            version,
        });
        bytes.fill(0xcd, BUFFER, BUFFER + OSVERSIONINFOEXW_SIZE);
        view.setUint32(BUFFER, OSVERSIONINFOEXW_SIZE, true);

        assert.equal(fns.RtlGetVersion.handler([BUFFER]), STATUS.SUCCESS);
        assert.deepEqual([4, 8, 12, 16].map(at=>view.getUint32(BUFFER + at, true)),
            [version.major, version.minor, version.build, 2], version.name);
        const csd = String.fromCharCode(...Array.from({ length: version.csdVersion.length },
            (_, index)=>view.getUint16(BUFFER + 20 + index * 2, true)));
        assert.equal(csd, version.csdVersion, version.name);
        assert.equal(view.getUint16(BUFFER + 20 + version.csdVersion.length * 2, true), 0);
        assert.equal(view.getUint16(BUFFER + 0x114, true), version.servicePackMajor);
        assert.equal(view.getUint16(BUFFER + 0x116, true), version.servicePackMinor);
        assert.equal(view.getUint16(BUFFER + 0x118, true), version.suiteMask, version.name);
        assert.equal(bytes[BUFFER + 0x11a], version.productType);
    }
});

test('a structure size nobody recognises is refused rather than partly filled', ()=>{
    // The size field is how the caller says which structure it allocated. Writing
    // the larger one into the smaller runs past the end of the caller's object.
    const host = fakeHost();
    const fns = createQueryFunctions(host);
    host.view.setUint32(BUFFER, 200, true);

    assert.equal(fns.RtlGetVersion.handler([BUFFER]), STATUS.INVALID_PARAMETER);
    assert.equal(host.view.getUint32(BUFFER + 4, true), 0, 'nothing was written');
});

test('the extended structure carries the product type', ()=>{
    const host = fakeHost();
    const fns = createQueryFunctions(host);
    host.view.setUint32(BUFFER, OSVERSIONINFOEXW_SIZE, true);

    assert.equal(fns.RtlGetVersion.handler([BUFFER]), STATUS.SUCCESS);
    assert.equal(host.bytes[BUFFER + 0x11a], 1, 'VER_NT_WORKSTATION');
});

test('no process block means no version, not a version of zero', ()=>{
    // Zeros read as a system older than any Windows, and a program that checks a
    // minimum refuses to run on the strength of a structure nobody filled in.
    const host = fakeHost({ blocks: false });
    const fns = createQueryFunctions(host);
    host.view.setUint32(BUFFER, OSVERSIONINFOW_SIZE, true);

    assert.equal(fns.RtlGetVersion.handler([BUFFER]), STATUS.UNSUCCESSFUL);
});

test('an information class this engine cannot answer is refused', ()=>{
    // A plausible structure of invented numbers is indistinguishable from a real
    // one to the caller, and it gets acted on long before anybody finds out.
    const host = fakeHost();
    const fns = createQueryFunctions(host);

    assert.equal(
        fns.NtQuerySystemInformation.handler([2, BUFFER, 0x100, 0]),
        STATUS.INVALID_INFO_CLASS);
    assert.equal(
        fns.NtQueryInformationProcess.handler([0, 1, BUFFER, 0x100, 0]),
        STATUS.INVALID_INFO_CLASS);
});

test('data runs as code, permanently, and a program asking to change that is refused', ()=>{
    // No page refuses to execute here, so the execute flags are those of a
    // system whose DEP is always off: enabled, and permanent -- which is what
    // makes Windows refuse a change, as it is refused here.
    const MEM_EXECUTE_OPTION_ENABLE = 0x2;
    const MEM_EXECUTE_OPTION_PERMANENT = 0x8;
    const host = fakeHost();
    const fns = createQueryFunctions(host);
    assert.equal(fns.NtQueryInformationProcess.handler([-1, 0x22, BUFFER, 4, RETURN_LENGTH]),
        STATUS.SUCCESS);
    assert.equal(host.view.getUint32(BUFFER, true),
        MEM_EXECUTE_OPTION_ENABLE | MEM_EXECUTE_OPTION_PERMANENT);
    host.view.setUint32(BUFFER, 0x1, true);
    assert.equal(fns.NtSetInformationProcess.handler([-1, 0x22, BUFFER, 4]),
        STATUS.ACCESS_DENIED);
    assert.equal(fns.NtSetInformationProcess.handler([-1, 12, BUFFER, 4]), STATUS.SUCCESS,
        'any other class is taken');
});

test('the length a class needs is reported even when the buffer is too small', ()=>{
    // This is the two-call protocol every caller of these uses: ask with nothing,
    // allocate what it was told, ask again. Withholding the length on the failing
    // call leaves the caller with no way to make the second one succeed.
    const host = fakeHost();
    const fns = createQueryFunctions(host);

    assert.equal(fns.NtQuerySystemInformation.handler([0, BUFFER, 4, RETURN_LENGTH]),
        STATUS.INFO_LENGTH_MISMATCH);
    assert.equal(host.view.getUint32(RETURN_LENGTH, true), 0x2c);
});

test('the memory reported is the memory the process actually has', ()=>{
    // A program sizes a cache from this figure, and one told about memory that is
    // not there allocates until it fails.
    const host = fakeHost({ arenaSize: 32 * PAGE_SIZE });
    const fns = createQueryFunctions(host);

    assert.equal(fns.NtQuerySystemInformation.handler([0, BUFFER, 0x2c, RETURN_LENGTH]),
        STATUS.SUCCESS);
    assert.equal(host.view.getUint32(BUFFER + 0x08, true), PAGE_SIZE, 'page size');
    assert.equal(host.view.getUint32(BUFFER + 0x0c, true), 32, 'physical pages');
    assert.equal(host.view.getUint32(BUFFER + 0x18, true), 0x10000, 'granularity');
    assert.equal(host.bytes[BUFFER + 0x28], 1, 'one processor');
});

test('the machine\'s processors are counted and masked, whatever the process is narrowed to',
    ()=>{
        // SystemBasicInformation is what GetProcessAffinityMask's system mask
        // and GetSystemInfo are made of; ProcessBasicInformation's mask is the
        // process's (Wine's ntdll test_affinity).
        const processors = createProcessors({ processors: ()=>4 });
        const host = { ...fakeHost(), processors };
        const fns = createQueryFunctions(host);
        processors.setProcessMask(6);

        assert.equal(fns.NtQuerySystemInformation.handler([0, BUFFER, 0x2c, 0]), STATUS.SUCCESS);
        assert.equal(host.view.getUint32(BUFFER + 0x24, true), 0xf, 'ActiveProcessorsAffinityMask');
        assert.equal(host.bytes[BUFFER + 0x28], 4, 'NumberOfProcessors');
        assert.equal(fns.NtQueryInformationProcess.handler([-1, 0, BUFFER, 0x18, 0]),
            STATUS.SUCCESS);
        assert.equal(host.view.getUint32(BUFFER + 0x08, true), 6, 'AffinityMask');

        const alone = fakeHost();
        createQueryFunctions(alone).NtQueryInformationProcess.handler([-1, 0, BUFFER, 0x18, 0]);
        assert.equal(alone.view.getUint32(BUFFER + 0x08, true), 1, 'one processor, by default');
    });

test('the process reports the block a program would have found itself', ()=>{
    // The address of the process block is the only thing most callers of this
    // want, and they compare it against the one FS already gave them.
    const host = fakeHost();
    const fns = createQueryFunctions(host);

    assert.equal(fns.NtQueryInformationProcess.handler([-1, 0, BUFFER, 0x18, RETURN_LENGTH]),
        STATUS.SUCCESS);
    assert.equal(host.view.getUint32(BUFFER + 0x04, true), PEB_AT, 'PebBaseAddress');
    assert.equal(host.view.getUint32(BUFFER + 0x10, true), 0x1234, 'UniqueProcessId');
    assert.equal(host.view.getUint32(BUFFER + 0x00, true), STATUS.PENDING,
        'a running process has no exit status yet');
    assert.equal(host.view.getUint32(RETURN_LENGTH, true), 0x18);
    assert.equal(host.view.getUint32(BUFFER + 0x14, true), 0, 'nothing started it');

    const child = { ...fakeHost(), processes: ()=>[
        { id: 0x1234, parent: 0x2a4, path: 'C:\\child.exe', threads: [0x1238] }] };
    createQueryFunctions(child).NtQueryInformationProcess.handler([-1, 0, BUFFER, 0x18, 0]);
    assert.equal(child.view.getUint32(BUFFER + 0x14, true), 0x2a4,
        'InheritedFromUniqueProcessId: the process that started it');
});

test('there is no debugger, and the answer says so rather than declining', ()=>{
    // This is asked by code that means to behave differently under a debugger. A
    // refusal reads as "something is hiding"; zero is simply the truth here.
    const host = fakeHost();
    const fns = createQueryFunctions(host);
    host.view.setUint32(BUFFER, 0xdeadbeef, true);

    assert.equal(fns.NtQueryInformationProcess.handler([-1, 7, BUFFER, 4, RETURN_LENGTH]),
        STATUS.SUCCESS);
    assert.equal(host.view.getUint32(BUFFER, true), 0);
});

test('argument sizes match what the guest compiled against', ()=>{
    const fns = createQueryFunctions(fakeHost());

    assert.equal(fns.RtlGetVersion.argBytes, 4);
    assert.equal(fns.NtQuerySystemInformation.argBytes, 16);
    assert.equal(fns.NtQueryInformationProcess.argBytes, 20);
});

test('RtlVerifyVersionInfo compares against the version the process block holds', ()=>{
    // The truth, as RtlGetVersion answers it: Windows 10 tells a program with
    // no manifest 6.2 through kernel32, and ntdll still says 10.0.
    const version = WINDOWS_VERSIONS.win10;
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    let next = 0x4000;
    const blocks = createProcessBlocks({
        allocate: size=>{
            const at = next;
            next += size + 15 & ~15;
            return at;
        },
        writeMemory: (at, data)=>bytes.set(data, at),
        processId: 0x1234,
        version,
        imageBase: 0x400000,
    });
    const { teb } = blocks.createThreadBlock({ id: 1, stackBase: 0x3000, stackLimit: 0x2000 });
    const fns = createQueryFunctions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        teb: ()=>teb,
        arena: { base: 0x400000, size: 0x100000 },
        version,
    });
    const types = VER.MAJORVERSION | VER.MINORVERSION | VER.SERVICEPACKMAJOR;
    const atLeast = [VER.MAJORVERSION, VER.MINORVERSION, VER.SERVICEPACKMAJOR]
        .reduce((mask, type)=>setCondition(mask, type, 3), 0n);
    /** @param {number} major @param {number} minor @param {number} [typeMask] */
    const ask = (major, minor, typeMask = types)=>{
        bytes.fill(0, BUFFER, BUFFER + OSVERSIONINFOEXW_SIZE);
        view.setUint32(BUFFER, OSVERSIONINFOEXW_SIZE, true);
        view.setUint32(BUFFER + 4, major, true);
        view.setUint32(BUFFER + 8, minor, true);
        return fns.RtlVerifyVersionInfo.handler([BUFFER, typeMask,
            Number(atLeast & 0xffffffffn), Number(atLeast >> 32n)]) >>> 0;
    };

    assert.equal(ask(10, 0), STATUS.SUCCESS, 'Windows 10 is at least 10.0');
    assert.equal(ask(6, 3), STATUS.SUCCESS);
    assert.equal(ask(10, 1), STATUS.REVISION_MISMATCH);
    assert.equal(ask(10, 0, 0), STATUS.INVALID_PARAMETER, 'a request that names nothing');
    assert.equal(fns.RtlVerifyVersionInfo.argBytes, 16);
});

test('NtQueryObject lists the object types whatever handle is given', ()=>{
    // Wine's test_query_object_types: asked with NULL, the size first, then
    // the list; each name follows its entry, and the next entry starts past
    // the name rounded to a pointer. A protection walks it for DebugObject.
    const host = fakeHost({ blocks: false });
    const fns = createQueryFunctions(host);

    assert.equal(fns.NtQueryObject.handler([0, 3, BUFFER, 4, RETURN_LENGTH]),
        STATUS.INFO_LENGTH_MISMATCH);
    const needed = host.view.getUint32(RETURN_LENGTH, true);
    assert.ok(needed > 4 && BUFFER + needed <= host.bytes.length, `size ${needed}`);

    assert.equal(fns.NtQueryObject.handler([0, 3, BUFFER, needed, RETURN_LENGTH]),
        STATUS.SUCCESS);
    const count = host.view.getUint32(BUFFER, true);
    /** @type {string[]} */
    const names = [];
    let entry = BUFFER + 4;
    for (let i = 0; i < count; i++)
    {
        const length = host.view.getUint16(entry, true);
        const maximum = host.view.getUint16(entry + 2, true);
        const text = host.view.getUint32(entry + 4, true);
        assert.equal(text, entry + 0x60, 'the name follows its entry');
        assert.equal(maximum, length + 2, 'and is terminated');
        assert.equal(host.bytes[entry + 0x52], i + 2, 'types are numbered from two');
        names.push(String.fromCharCode(...new Uint16Array(
            host.bytes.slice(text, text + length).buffer)));
        assert.equal(host.view.getUint32(entry + 8, true), 0, 'no objects counted');
        entry = text + ((maximum + 3) & ~3);
    }
    assert.equal(entry, BUFFER + needed, 'the entries fill the size told');
    assert.ok(names.includes('DebugObject') && names.includes('File'), names.join());
});

test('NtQueryObject answers the basic class for a handle that names something', ()=>{
    /** @type {string[]} */
    const said = [];
    const host = fakeHost();
    const fns = createQueryFunctions({
        ...host,
        handleType: handle=>(handle === 0x44 ? 'event' : null),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    assert.equal(fns.NtQueryObject.argBytes, 20);

    assert.equal(fns.NtQueryObject.handler([0x44, 0, BUFFER, 0x38, RETURN_LENGTH]),
        STATUS.SUCCESS);
    assert.equal(host.view.getUint32(RETURN_LENGTH, true), 0x38);
    assert.equal(host.view.getUint32(BUFFER + 4, true), 0x001fffff, 'every right');
    assert.equal(host.view.getUint32(BUFFER + 8, true), 1, 'one handle');
    assert.ok(said.some(line=>line.startsWith('NtQueryObject: granted access')),
        'the untracked access is reported');

    assert.equal(fns.NtQueryObject.handler([0xffffffff, 0, BUFFER, 0x38, 0]), STATUS.SUCCESS,
        'the current-process pseudo-handle names something without a table entry');
    assert.equal(fns.NtQueryObject.handler([0x44, 0, BUFFER, 0x37, RETURN_LENGTH]),
        STATUS.INFO_LENGTH_MISMATCH);
    assert.equal(host.view.getUint32(RETURN_LENGTH, true), 0x38, 'the size needed is still told');
    assert.equal(fns.NtQueryObject.handler([0x48, 0, BUFFER, 0x38, 0]), STATUS.INVALID_HANDLE);
    assert.equal(fns.NtQueryObject.handler([0x44, 2, BUFFER, 0x100, 0]),
        STATUS.INVALID_INFO_CLASS);
    assert.ok(said.some(line=>line.includes('class 2')), 'a refused class is reported');
});

test('the debug-help queries are refused as unsupported and say so', ()=>{
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {Record<string, any>} */ (createQueryFunctions({ ...fakeHost(),
        divergence: api=>said.push(api) }));
    assert.deepEqual(['NtOpenThread', 'RtlCreateQueryDebugBuffer',
        'RtlDestroyQueryDebugBuffer', 'RtlQueryProcessDebugInformation']
        .map(name=>fns[name].argBytes), [16, 8, 4, 12]);
    assert.equal(fns.NtOpenThread.handler([0, 0, 0, 0]), STATUS.NOT_IMPLEMENTED);
    assert.equal(fns.RtlCreateQueryDebugBuffer.handler([0, 0]), 0, 'no buffer');
    assert.equal(fns.RtlDestroyQueryDebugBuffer.handler([0]), STATUS.INVALID_PARAMETER);
    assert.equal(fns.RtlDestroyQueryDebugBuffer.handler([0x1000]), STATUS.SUCCESS);
    assert.equal(fns.RtlQueryProcessDebugInformation.handler([0, 0, 0]), STATUS.NOT_IMPLEMENTED);
    assert.equal(said.length, 3);
});

test('SystemProcessInformation chains the idle process and each process with its threads', ()=>{
    // The class the Toolhelp snapshot is built on: a walker follows
    // NextEntryOffset, reads the id, the parent, the threads and the name.
    const base = 0x10000;
    const chain = systemProcessInformation([
        { id: 0x1000, parent: 0, path: 'C:\\Games\\game.exe', threads: [0x1004, 0x1008] },
    ], base);
    const view = new DataView(chain.buffer);
    const next = view.getUint32(0, true);
    assert.equal(view.getUint32(0x44, true), 0, 'the idle process first');
    assert.equal(view.getUint16(0x38, true), 0, 'with no name');
    assert.equal(view.getUint32(next, true), 0, 'the last entry ends the chain');
    assert.equal(view.getUint32(next + 0x04, true), 2, 'two threads');
    assert.equal(view.getUint32(next + 0x44, true), 0x1000, 'UniqueProcessId');
    assert.equal(view.getUint32(next + 0xb8 + 0x40 + 0x24, true), 0x1008, 'second thread id');
    assert.equal(view.getUint32(next + 0xb8 + 0x20, true), 0x1000, 'thread owner');
    const length = view.getUint16(next + 0x38, true);
    const name = view.getUint32(next + 0x3c, true) - base;
    assert.equal(String.fromCharCode(...new Uint16Array(chain.buffer.slice(name, name + length))),
        'game.exe');

    const host = fakeHost();
    const asked = createQueryFunctions({ ...host, processes: ()=>[
        { id: 0x1000, parent: 0, path: 'C:\\game.exe', threads: [0x1004] }] });
    assert.equal(asked.NtQuerySystemInformation.handler([5, BUFFER, 8, BUFFER + 0x400]),
        STATUS.INFO_LENGTH_MISMATCH, 'too small a buffer is told the size');
    const needed = host.view.getUint32(BUFFER + 0x400, true);
    assert.ok(needed > 0xb8 * 2);
});

test('the system file cache is sized by a well-formed request, and nothing else is set', ()=>{
    // SystemFileCacheInformation (21) with its 36-byte structure is what a program
    // lifting the cache's bounds sends; there is no cache here to bound.
    const host = fakeHost();
    const fns = createQueryFunctions(host);
    assert.equal(fns.NtSetSystemInformation.argBytes, 12);
    assert.equal(fns.NtSetSystemInformation.handler([21, BUFFER, 36]), STATUS.SUCCESS);
    assert.equal(fns.NtSetSystemInformation.handler([21, BUFFER, 32]),
        STATUS.INFO_LENGTH_MISMATCH);
    assert.equal(fns.NtSetSystemInformation.handler([21, 0, 36]), STATUS.ACCESS_VIOLATION);
    assert.equal(fns.NtSetSystemInformation.handler([0, BUFFER, 0x2c]),
        STATUS.INVALID_INFO_CLASS);
});

test('a child\'s handle is answered by the child about itself, or from its record once gone',
    async()=>{
        // Wine's kernel32 process.c reads a child's PROCESS_BASIC_INFORMATION
        // through its handle: its own id, its parent, its block, and its exit
        // status once it has ended.
        const host = /** @type {any} */ (fakeHost());
        /** @type {any[]} */
        const asked = [];
        const answer = new Uint8Array(0x18);
        new DataView(answer.buffer).setUint32(0x04, 0x7ffd0000, true);
        new DataView(answer.buffer).setUint32(0x10, 0x2000, true);
        const child = { id: 0x2000, parentId: 0x1234, exitCode: 259 };
        host.processOf = (/** @type {number} */ handle)=>(handle === 0x40 ? child : null);
        host.askChild = (/** @type {any} */ record, /** @type {any} */ call)=>{
            asked.push([record, call]);
            return Promise.resolve({ result: 0, error: null,
                outs: [null, null, answer, null, new Uint8Array([0x18, 0, 0, 0])] });
        };
        const fns = createQueryFunctions(host);

        assert.equal(await fns.NtQueryInformationProcess.handler(
            [0x40, 0, BUFFER, 0x18, RETURN_LENGTH]), STATUS.SUCCESS);
        assert.deepEqual(asked, [[child, { call: 'NtQueryInformationProcess',
            args: [0xffffffff, 0, { out: 0x18 }, 0x18, { out: 4 }] }]]);
        assert.equal(host.view.getUint32(BUFFER + 0x04, true), 0x7ffd0000, 'the child\'s block');
        assert.equal(host.view.getUint32(BUFFER + 0x10, true), 0x2000);
        assert.equal(host.view.getUint32(RETURN_LENGTH, true), 0x18);

        // Ended: its record says what is left of it.
        Object.assign(child, { completed: true, exitCode: 7 });
        host.bytes.fill(0xcc, BUFFER, BUFFER + 0x18);
        assert.equal(fns.NtQueryInformationProcess.handler([0x40, 0, BUFFER, 0x18, 0]),
            STATUS.SUCCESS);
        assert.deepEqual([0, 4, 0x10, 0x14].map(at=>host.view.getUint32(BUFFER + at, true)),
            [7, 0, 0x2000, 0x1234], 'its code, no block, its id and its parent');
        assert.equal(fns.NtQueryInformationProcess.handler([0x40, 7, BUFFER, 4, 0]),
            STATUS.INVALID_INFO_CLASS, 'and nothing else');
        assert.equal(asked.length, 1);
    });
