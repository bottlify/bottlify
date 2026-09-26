/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueryFunctions } from './query.js';
import { STATUS } from './status.js';
import { PEB, TEB, createProcessBlocks } from '../kernel32/teb.js';
import { WINDOWS_VERSIONS } from '../kernel32/versions.js';

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
        fns.NtQueryInformationProcess.handler([0, 34, BUFFER, 0x100, 0]),
        STATUS.INVALID_INFO_CLASS);
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
