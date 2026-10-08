/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mspatcha's entry points over a volume, handles and memory of the test's
 * own, with the outcomes Wine's conformance tests record for Windows: the
 * last error a call leaves, the files it leaves behind, where it leaves a
 * handle, and what it writes into the program's memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMspatchaFunctions } from './functions.js';
import { APPLY_OPTION, PATCH_ERROR, PATCH_OPTION } from './pa19.js';
import { ascii, buildPatch, storedStream } from './pa19.fixture.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_CANCELLED = 1223;
const INVALID_HANDLE_VALUE = 0xffffffff;

const PLAIN = PATCH_OPTION.USE_LZX_A | PATCH_OPTION.NO_REBASE | PATCH_OPTION.NO_RESTIMEFIX
    | PATCH_OPTION.NO_TIMESTAMP;
const TIME = 1555736005;

const OLD = ascii('the old contents of the file');
const NEW = ascii('the new contents, a little longer');
const PATCH = buildPatch({ flags: PLAIN, timestamp: TIME, newBytes: NEW,
    oldFiles: [{ bytes: OLD, stream: storedStream(NEW) }] });

/** The signature of every entry point, as Windows exports it: stdcall, four bytes an argument. */
const ARGUMENTS = {
    ApplyPatchToFileA: 4, ApplyPatchToFileW: 4, ApplyPatchToFileExA: 6, ApplyPatchToFileExW: 6,
    ApplyPatchToFileByHandles: 4, ApplyPatchToFileByHandlesEx: 6, ApplyPatchToFileByBuffers: 11,
    TestApplyPatchToFileA: 3, TestApplyPatchToFileW: 3, TestApplyPatchToFileByHandles: 3,
    TestApplyPatchToFileByBuffers: 6, GetFilePatchSignatureA: 9, GetFilePatchSignatureW: 9,
    GetFilePatchSignatureByHandle: 9, GetFilePatchSignatureByBuffer: 10,
    NormalizeFileForPatchSignature: 10,
};

/** @param {Record<string, Uint8Array>} initial */
function setup(initial = {}){
    const directories = new Set(['c:', 'c:\\dir']);
    /** @type {Map<string, Uint8Array>} */
    const store = new Map(
        Object.entries(initial).map(([path, bytes])=>[path.toLowerCase(), bytes]));
    /** @type {Map<string, number>} */
    const modified = new Map();
    const memory = new Uint8Array(0x10000);
    /** @type {Map<number, { path: string, node: { key: string }, position: number }>} */
    const handles = new Map();
    /** @type {number[][]} */
    const progress = [];
    const state = { lastError: 0xdeadbeef, cancelAt: -1, next: 0x1000, heap: 0x8000 };
    /** @param {string} path */
    const parent = path=>path.slice(0, Math.max(0, path.lastIndexOf('\\'))).toLowerCase();

    const files = {
        /** @param {string} path */
        stat(path){
            const key = path.toLowerCase();
            if (directories.has(key))
            {
                return { exists: true, isDirectory: true, size: 0 };
            }
            const bytes = store.get(key);
            return bytes ? { exists: true, isDirectory: false, size: bytes.length } : null;
        },
        /** @param {string} path @param {{ create?: boolean, truncate?: boolean }} mode */
        open(path, mode){
            const key = path.toLowerCase();
            if (!store.has(key) && (!mode.create || !directories.has(parent(path))))
            {
                return null;
            }
            if (mode.truncate || !store.has(key))
            {
                store.set(key, new Uint8Array(0));
            }
            return { key };
        },
        /** @param {{ key: string }} node @param {number} offset @param {number} length */
        read: (node, offset, length)=>
            /** @type {Uint8Array} */ (store.get(node.key)).slice(offset, offset + length),
        /** @param {{ key: string }} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            const was = /** @type {Uint8Array} */ (store.get(node.key));
            const next = new Uint8Array(Math.max(was.length, offset + bytes.length));
            next.set(was);
            next.set(bytes, offset);
            store.set(node.key, next);
            return bytes.length;
        },
        /** @param {{ key: string }} node @param {number} size */
        truncate(node, size){
            store.set(node.key, /** @type {Uint8Array} */ (store.get(node.key)).slice(0, size));
        },
        close(){},
        /** @param {string} path */
        remove: path=>store.delete(path.toLowerCase()),
        /** @param {string} path @param {number} ms */
        setModified: (path, ms)=>{
            modified.set(path.toLowerCase(), ms);
            return true;
        },
    };

    const fns = createMspatchaFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readCString: (address, maxLength)=>{
            let end = address;
            while (end - address < maxLength && memory[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(memory.subarray(address, end));
        },
        readWideString: (address, maxLength)=>{
            let text = '';
            for (let at = address; text.length < maxLength; at += 2)
            {
                const unit = memory[at] | (memory[at + 1] << 8);
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },
        setLastError: code=>{
            state.lastError = code >>> 0;
        },
        setLastErrorFor: (thread, code)=>{
            assert.equal(thread, 'caller', 'the error goes to the thread that called');
            state.lastError = code >>> 0;
        },
        files,
        handles: { file: handle=>handles.get(handle) ?? null },
        virtualAlloc: bytes=>{
            const at = state.heap;
            state.heap += bytes;
            return at;
        },
        call: (entry, args)=>{
            assert.equal(entry, 0x7000, 'the program\'s progress routine');
            progress.push(args);
            return progress.length - 1 === state.cancelAt ? 0 : 1;
        },
        callerThread: ()=>'caller',
    });

    /** @param {Uint8Array} bytes */
    const plant = bytes=>{
        const at = state.next;
        memory.set(bytes, at);
        state.next += bytes.length + 16;
        return at;
    };
    /** @param {string} text */
    const name = text=>plant(encodeAnsi(`${text}\0`));
    /** @param {string} text */
    const wideName = text=>plant(new Uint8Array(Uint16Array.from(`${text}\0`,
        c=>c.charCodeAt(0)).buffer));
    let nextHandle = 0x40;
    /** @param {string} path */
    const open = path=>{
        const handle = nextHandle++;
        handles.set(handle, { path, node: { key: path.toLowerCase() }, position: 0 });
        return handle;
    };
    /** @param {number} address */
    const u32 = address=>new DataView(memory.buffer).getUint32(address, true);
    /** @param {string} api @param {number[]} args */
    const call = async(api, args)=>/** @type {any} */ (fns)[api].handler(args);
    return { fns, store, memory, state, progress, modified, handles, name, wideName, plant,
        open, u32, call };
}

test('every entry point pops the arguments Windows\' signature has', ()=>{
    const { fns } = setup();
    assert.deepEqual(Object.fromEntries(Object.entries(fns).map(([api, entry])=>
        [api, entry.argBytes / 4])), ARGUMENTS);
});

test('ApplyPatchToFileA writes the new file, dates it, and clears the last error', async()=>{
    const t = setup({ 'c:\\dir\\patch.pa': PATCH, 'c:\\dir\\old.txt': OLD });
    const ok = await t.call('ApplyPatchToFileA', [t.name('C:\\dir\\patch.pa'),
        t.name('C:\\dir\\old.txt'), t.name('C:\\dir\\new.txt'), APPLY_OPTION.FAIL_IF_EXACT]);
    assert.equal(ok, 1);
    assert.equal(t.state.lastError, 0);
    assert.deepEqual(t.store.get('c:\\dir\\new.txt'), NEW);
    assert.equal(t.modified.get('c:\\dir\\new.txt'), TIME * 1000);
});

test('ApplyPatchToFileW reads its names as UTF-16', async()=>{
    const t = setup({ 'c:\\dir\\patch.pa': PATCH, 'c:\\dir\\old.txt': OLD });
    assert.equal(await t.call('ApplyPatchToFileW', [t.wideName('C:\\dir\\patch.pa'),
        t.wideName('C:\\dir\\old.txt'), t.wideName('C:\\dir\\new.txt'), 0]), 1);
    assert.deepEqual(t.store.get('c:\\dir\\new.txt'), NEW);
});

test('a missing patch or old file, or a bad new path, fails before anything is made', async()=>{
    const t = setup({ 'c:\\dir\\patch.pa': PATCH, 'c:\\dir\\old.txt': OLD });
    const target = t.name('C:\\dir\\new.txt');
    assert.equal(await t.call('ApplyPatchToFileA', [t.name('C:\\dir\\none.pa'),
        t.name('C:\\dir\\old.txt'), target, 0]), 0);
    assert.equal(t.state.lastError, ERROR_FILE_NOT_FOUND);
    assert.equal(await t.call('ApplyPatchToFileA', [t.name('C:\\dir\\patch.pa'),
        t.name('C:\\dir\\gone.txt'), target, 0]), 0);
    assert.equal(t.state.lastError, ERROR_FILE_NOT_FOUND);
    assert.equal(t.store.has('c:\\dir\\new.txt'), false);
    assert.equal(await t.call('ApplyPatchToFileA', [t.name('C:\\dir\\patch.pa'),
        t.name('C:\\dir\\old.txt'), t.name('up\\down\\left\\right'), 0]), 0);
    assert.equal(t.state.lastError, ERROR_PATH_NOT_FOUND);
});

test('a failed apply leaves its error and no new file', async()=>{
    const t = setup({ 'c:\\dir\\patch.pa': PATCH, 'c:\\dir\\other.txt': ascii('another file') });
    assert.equal(await t.call('ApplyPatchToFileA', [t.name('C:\\dir\\patch.pa'),
        t.name('C:\\dir\\other.txt'), t.name('C:\\dir\\new.txt'), 0]), 0);
    assert.equal(t.state.lastError, PATCH_ERROR.WRONG_FILE);
    assert.equal(t.store.has('c:\\dir\\new.txt'), false);
    // A null old file where the patch needs one is a wrong file too.
    assert.equal(await t.call('ApplyPatchToFileA', [t.name('C:\\dir\\patch.pa'), 0,
        t.name('C:\\dir\\new.txt'), 0]), 0);
    assert.equal(t.state.lastError, PATCH_ERROR.WRONG_FILE);
});

test('ApplyPatchToFileExA tells its progress routine the start and the end, and stops on FALSE',
    async()=>{
        const t = setup({ 'c:\\dir\\patch.pa': PATCH, 'c:\\dir\\old.txt': OLD });
        const args = [t.name('C:\\dir\\patch.pa'), t.name('C:\\dir\\old.txt'),
            t.name('C:\\dir\\new.txt'), 0, 0x7000, 0x1234];
        assert.equal(await t.call('ApplyPatchToFileExA', args), 1);
        assert.deepEqual(t.progress, [[0x1234, 0, NEW.length], [0x1234, NEW.length, NEW.length]]);

        t.progress.length = 0;
        t.store.delete('c:\\dir\\new.txt');
        t.state.cancelAt = 0;
        assert.equal(await t.call('ApplyPatchToFileExA', args), 0);
        assert.equal(t.state.lastError, ERROR_CANCELLED);
        assert.equal(t.store.has('c:\\dir\\new.txt'), false);
    });

test('ApplyPatchToFileByHandles cuts the new file, writes it whole and leaves it at its end',
    async()=>{
        const t = setup({ 'c:\\dir\\patch.pa': PATCH, 'c:\\dir\\old.txt': OLD,
            'c:\\dir\\new.txt': new Uint8Array(100).fill(0x55) });
        const patch = t.open('c:\\dir\\patch.pa');
        const old = t.open('c:\\dir\\old.txt');
        const target = t.open('c:\\dir\\new.txt');
        assert.equal(await t.call('ApplyPatchToFileByHandles',
            [patch, old, target, APPLY_OPTION.FAIL_IF_EXACT]), 1);
        assert.equal(t.state.lastError, 0);
        assert.deepEqual(t.store.get('c:\\dir\\new.txt'), NEW, 'nothing of the longer file before');
        assert.equal(t.handles.get(target)?.position, NEW.length);
        assert.equal(t.handles.get(patch)?.position, 0);
        assert.equal(t.handles.get(old)?.position, 0);

        assert.equal(await t.call('TestApplyPatchToFileByHandles', [patch, old, 0]), 1);
        assert.equal(t.state.lastError, 0);
        assert.equal(await t.call('ApplyPatchToFileByHandles', [0x999, old, target, 0]), 0);
        assert.equal(t.state.lastError, ERROR_INVALID_HANDLE);
        assert.equal(await t.call('ApplyPatchToFileByHandlesEx',
            [patch, old, target, 0, 0x7000, 9]), 1);
        assert.deepEqual(t.progress.map(([context])=>context), [9, 9]);
    });

test('ApplyPatchToFileByHandles takes INVALID_HANDLE_VALUE for no old file', async()=>{
    const fresh = buildPatch({ flags: PLAIN, newBytes: NEW,
        oldFiles: [{ bytes: new Uint8Array(0), stream: storedStream(NEW) }] });
    const t = setup({ 'c:\\dir\\patch.pa': fresh, 'c:\\dir\\new.txt': new Uint8Array(0) });
    assert.equal(await t.call('ApplyPatchToFileByHandles', [t.open('c:\\dir\\patch.pa'),
        INVALID_HANDLE_VALUE, t.open('c:\\dir\\new.txt'), 0]), 1);
    assert.deepEqual(t.store.get('c:\\dir\\new.txt'), NEW);
});

test('TestApplyPatchToFileA reads the header against the old file and makes nothing', async()=>{
    const header = buildPatch({ flags: PLAIN, timestamp: TIME, newBytes: NEW, headerOnly: true,
        oldFiles: [{ bytes: OLD, stream: storedStream(NEW) }] });
    const t = setup({ 'c:\\dir\\header.pa': header, 'c:\\dir\\old.txt': OLD,
        'c:\\dir\\other.txt': ascii('not it') });
    assert.equal(await t.call('TestApplyPatchToFileA', [t.name('C:\\dir\\header.pa'),
        t.name('C:\\dir\\old.txt'), 0]), 1);
    assert.equal(t.state.lastError, 0);
    assert.equal(await t.call('TestApplyPatchToFileW', [t.wideName('C:\\dir\\header.pa'),
        t.wideName('C:\\dir\\other.txt'), 0]), 0);
    assert.equal(t.state.lastError, PATCH_ERROR.WRONG_FILE);
    assert.equal(t.store.size, 3);
});

test('ApplyPatchToFileByBuffers: a buffer of its own, the size, the time', async()=>{
    const t = setup();
    const patch = t.plant(PATCH);
    const old = t.plant(OLD);
    const slot = t.plant(new Uint8Array(4));
    const size = t.plant(new Uint8Array(4));
    const time = t.plant(new Uint8Array(8));
    t.state.lastError = 0xdeadbeef;
    assert.equal(await t.call('ApplyPatchToFileByBuffers', [patch, PATCH.length, old, OLD.length,
        slot, 0, size, time, 0, 0, 0]), 1);
    assert.equal(t.state.lastError, 0xdeadbeef, 'left alone on success');
    const made = t.u32(slot);
    assert.ok(made >= 0x8000, 'VirtualAlloc\'s memory');
    assert.deepEqual(t.memory.subarray(made, made + NEW.length), NEW);
    assert.equal(t.u32(size), NEW.length);
    const ticks = (BigInt(TIME) + 11644473600n) * 10000000n;
    assert.equal(t.u32(time), Number(ticks & 0xffffffffn));
    assert.equal(t.u32(time + 4), Number(ticks >> 32n));
});

test('ApplyPatchToFileByBuffers: the caller\'s buffer, too small, absent, or tested', async()=>{
    const t = setup();
    const patch = t.plant(PATCH);
    const old = t.plant(OLD);
    const buffer = t.plant(new Uint8Array(64));
    const slot = t.plant(Uint8Array.from([buffer & 0xff, buffer >> 8, 0, 0]));
    const size = t.plant(new Uint8Array(4));
    assert.equal(await t.call('ApplyPatchToFileByBuffers', [patch, PATCH.length, old, OLD.length,
        slot, 64, size, 0, 0, 0, 0]), 1);
    assert.equal(t.u32(slot), buffer, 'the pointer is not touched');
    assert.deepEqual(t.memory.subarray(buffer, buffer + NEW.length), NEW);

    assert.equal(await t.call('ApplyPatchToFileByBuffers', [patch, PATCH.length, old, OLD.length,
        slot, 8, size, 0, 0, 0, 0]), 0);
    assert.equal(t.state.lastError, ERROR_INSUFFICIENT_BUFFER);
    assert.equal(t.u32(size), NEW.length, 'the size is told all the same');

    assert.equal(await t.call('ApplyPatchToFileByBuffers', [patch, PATCH.length, old, OLD.length,
        0, 0, size, 0, 0, 0, 0]), 0);
    assert.equal(t.state.lastError, ERROR_INVALID_PARAMETER);
    assert.equal(await t.call('ApplyPatchToFileByBuffers', [patch, PATCH.length, old, OLD.length,
        0, 0, size, 0, APPLY_OPTION.TEST_ONLY, 0, 0]), 1);

    t.memory.fill(0, size, size + 4);
    assert.equal(await t.call('TestApplyPatchToFileByBuffers',
        [patch, PATCH.length, old, OLD.length, size, 0]), 1);
    assert.equal(t.u32(size), NEW.length);
    assert.equal(await t.call('TestApplyPatchToFileByBuffers',
        [patch, PATCH.length, t.plant(ascii('wrong')), 5, 0, 0]), 0);
    assert.equal(t.state.lastError, PATCH_ERROR.WRONG_FILE);
});

test('GetFilePatchSignature: eight hex digits of CRC, thirty-two of MD5, by name, handle or buffer',
    async()=>{
        const t = setup({ 'c:\\dir\\file.bin': OLD });
        const buffer = t.plant(new Uint8Array(80));
        assert.equal(await t.call('GetFilePatchSignatureA', [t.name('C:\\dir\\file.bin'), 0, 0,
            0, 0, 0, 0, 9, buffer]), 1);
        const signature = decodeAnsi(t.memory.subarray(buffer, buffer + 8));
        assert.match(signature, /^[0-9a-f]{8}$/);
        assert.equal(t.memory[buffer + 8], 0);

        assert.equal(await t.call('GetFilePatchSignatureA', [t.name('C:\\dir\\file.bin'), 0, 0,
            0, 0, 0, 0, 8, buffer]), 0);
        assert.equal(t.state.lastError, ERROR_INSUFFICIENT_BUFFER);

        assert.equal(await t.call('GetFilePatchSignatureW', [t.wideName('C:\\dir\\file.bin'), 0, 0,
            0, 0, 0, 0, 9, buffer]), 1);
        assert.equal(String.fromCharCode(...new Uint16Array(t.memory.slice(buffer, buffer + 16)
            .buffer)), signature);

        assert.equal(await t.call('GetFilePatchSignatureByHandle', [t.open('c:\\dir\\file.bin'), 0,
            0, 0, 0, 0, 0, 9, buffer]), 1);
        assert.equal(decodeAnsi(t.memory.subarray(buffer, buffer + 8)), signature);

        // The first four bytes set aside: the same as the file with them zeroed.
        const zeroed = OLD.slice();
        zeroed.fill(0, 0, 4);
        const range = t.plant(Uint8Array.from([0, 0, 0, 0, 4, 0, 0, 0]));
        assert.equal(await t.call('GetFilePatchSignatureByBuffer', [t.plant(OLD), OLD.length,
            PATCH_OPTION.SIGNATURE_MD5, 0, 1, range, 0, 0, 33, buffer]), 1);
        const md5 = decodeAnsi(t.memory.subarray(buffer, buffer + 32));
        assert.match(md5, /^[0-9a-f]{32}$/);
        const other = t.plant(new Uint8Array(40));
        assert.equal(await t.call('GetFilePatchSignatureByBuffer', [t.plant(zeroed), OLD.length,
            PATCH_OPTION.SIGNATURE_MD5, 0, 0, 0, 0, 0, 33, other]), 1);
        assert.equal(decodeAnsi(t.memory.subarray(other, other + 32)), md5);
    });

test('NormalizeFileForPatchSignature is refused', async()=>{
    const t = setup();
    assert.equal(await t.call('NormalizeFileForPatchSignature', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0);
    assert.equal(t.state.lastError, ERROR_CALL_NOT_IMPLEMENTED);
});
