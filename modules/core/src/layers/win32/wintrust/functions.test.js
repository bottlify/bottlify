/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWintrustFunctions } from './functions.js';
import { certificates, NOW, signedCabinet } from './fixtures.test.js';

const TRUST_E_NOSIGNATURE = 0x800b0100;
const TRUST_E_SUBJECT_FORM_UNKNOWN = 0x800b0003;
const TRUST_E_PROVIDER_UNKNOWN = 0x800b0001;
const CERT_E_CHAINING = 0x800b010a;
const CRYPT_E_FILE_ERROR = 0x80092003;
const ERROR_INVALID_PARAMETER = 87;
const INVALID_HANDLE_VALUE = 0xffffffff;

const WTD_UI_NONE = 2;
const WTD_CHOICE_FILE = 1;
const WTD_CHOICE_CATALOG = 2;
const WTD_STATEACTION_VERIFY = 1;
const WTD_STATEACTION_CLOSE = 2;
const WTD_HASH_ONLY_FLAG = 0x200;

/** {00AAC56B-CD44-11D0-8CC2-00C04FC295EE} */
const GENERIC_VERIFY_V2 = [0x6b, 0xc5, 0xaa, 0x00, 0x44, 0xcd, 0xd0, 0x11,
    0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee];

const chain = certificates();

/** @param {{ roots?: (Uint8Array | string)[] }} [options] */
function machine(options = {}){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @type {Map<number, { type: string, object: any }>} */
    const handles = new Map();
    let nextHandle = 0x100;
    let lastError = 0;
    const divergences = /** @type {string[]} */ ([]);
    const fns = createWintrustFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readWideString(at, max){
            let text = '';
            for (let i = at; i < at + max * 2 && view.getUint16(i, true) !== 0; i += 2)
            {
                text += String.fromCharCode(view.getUint16(i, true));
            }
            return text;
        },
        setLastErrorFor: (_thread, code)=>{
            lastError = code;
        },
        callerThread: ()=>({ id: 1 }),
        files: /** @type {any} */ ({
            stat: (/** @type {string} */ path)=>(files.has(path.toLowerCase())
                ? { size: files.get(path.toLowerCase())?.length, isDirectory: false } : null),
            open: (/** @type {string} */ path)=>({ path: path.toLowerCase() }),
            read: (/** @type {{ path: string }} */ node)=>files.get(node.path),
            close: ()=>{},
        }),
        fullPath: path=>path,
        handles: {
            open(type, object){
                handles.set(nextHandle, { type, object });
                return nextHandle++;
            },
            resolve: (handle, type)=>(handles.get(handle)?.type === type
                ? handles.get(handle)?.object : null),
            close: handle=>handles.delete(handle),
        },
        trustedRoots: ()=>options.roots,
        now: ()=>NOW,
        divergence: (_api, detail)=>divergences.push(detail),
    });

    const action = 0x100;
    memory.set(GENERIC_VERIFY_V2, action);
    const data = 0x200;
    const fileInfo = 0x300;
    const path = 0x400;

    /** @param {string} name @param {Uint8Array} bytes */
    const file = (name, bytes)=>files.set(name.toLowerCase(), bytes);

    /**
     * Fills in WINTRUST_DATA and WINTRUST_FILE_INFO for `name` and calls.
     *
     * @param {string | null} name
     * @param {{ state?: number, flags?: number, choice?: number, size?: number }} [how]
     */
    const verify = (name, how = {})=>{
        memory.fill(0, data, data + 48);
        view.setUint32(data, how.size ?? 48, true);
        view.setUint32(data + 12, WTD_UI_NONE, true);
        view.setUint32(data + 20, how.choice ?? WTD_CHOICE_FILE, true);
        view.setUint32(data + 24, fileInfo, true);
        view.setUint32(data + 28, how.state ?? 0, true);
        view.setUint32(data + 40, how.flags ?? 0, true);
        view.setUint32(fileInfo, 16, true);
        view.setUint32(fileInfo + 4, name === null ? 0 : path, true);
        [...(name ?? ''), '\0'].forEach((ch, i)=>
            view.setUint16(path + i * 2, ch.charCodeAt(0), true));
        return fns.WinVerifyTrust.handler([INVALID_HANDLE_VALUE, action, data]);
    };

    return {
        fns, memory, view, file, verify, action, data, divergences,
        lastError: ()=>lastError,
        setLastError: (/** @type {number} */ code)=>{
            lastError = code;
        },
        stateHandle: ()=>view.getUint32(data + 32, true),
        handleType: (/** @type {number} */ handle)=>handles.get(handle)?.type ?? null,
    };
}

test('a signed cabinet chaining to a configured root is trusted, and says so in the last error',
    ()=>{
        const m = machine({ roots: [chain.root] });
        m.file('C:\\DirectX\\signed.cab', signedCabinet());
        m.setLastError(0xdeadbeef);
        assert.equal(m.verify('C:\\DirectX\\signed.cab'), 0);
        assert.equal(m.lastError(), 0);
        assert.equal(m.fns.WinVerifyTrust.argBytes, 12);
    });

test('the default store holds Microsoft\'s root and nothing a test made', ()=>{
    const m = machine();
    m.file('C:\\signed.cab', signedCabinet());
    assert.equal(m.verify('C:\\signed.cab'), CERT_E_CHAINING);
    assert.equal(m.lastError(), CERT_E_CHAINING, 'the answer is the last error too');
});

test('a configured root may be base64, and one that is not a certificate is passed over', ()=>{
    const m = machine({
        roots: ['not base64 at all!', Buffer.from(chain.root).toString('base64')],
    });
    m.file('C:\\signed.cab', signedCabinet());
    assert.equal(m.verify('C:\\signed.cab'), 0);
    assert.equal(m.divergences.length, 1);
});

test('an empty file is a form no provider knows, an unsigned cabinet has no signature', ()=>{
    // Wine's wintrust tests, test_wintrust: the answer is also the last error.
    const m = machine({ roots: [chain.root] });
    m.file('C:\\empty', new Uint8Array(0));
    m.file('C:\\unsigned.cab', signedCabinet({ unsigned: true }));
    assert.equal(m.verify('C:\\empty'), TRUST_E_SUBJECT_FORM_UNKNOWN);
    assert.equal(m.lastError(), TRUST_E_SUBJECT_FORM_UNKNOWN);
    assert.equal(m.verify('C:\\unsigned.cab'), TRUST_E_NOSIGNATURE);
    assert.equal(m.lastError(), TRUST_E_NOSIGNATURE);
    assert.equal(m.verify('C:\\missing.cab'), CRYPT_E_FILE_ERROR);
});

test('WTD_STATEACTION_VERIFY hands back state that WTD_STATEACTION_CLOSE frees', ()=>{
    // test_wintrust: the close answers S_OK and leaves the last error alone.
    const m = machine({ roots: [chain.root] });
    m.file('C:\\signed.cab', signedCabinet());
    assert.equal(m.verify('C:\\signed.cab', { state: WTD_STATEACTION_VERIFY }), 0);
    const state = m.stateHandle();
    assert.equal(m.handleType(state), 'wintrust-state');
    m.setLastError(0xdeadbeef);
    m.view.setUint32(m.data + 28, WTD_STATEACTION_CLOSE, true);
    assert.equal(m.fns.WinVerifyTrust.handler([INVALID_HANDLE_VALUE, m.action, m.data]), 0);
    assert.equal(m.lastError(), 0xdeadbeef);
    assert.equal(m.handleType(state), null);
    assert.equal(m.stateHandle(), 0);
    assert.equal(m.verify('C:\\signed.cab'), 0, 'the ignore action keeps no state');
    assert.equal(m.stateHandle(), 0);
});

test('WTD_HASH_ONLY_FLAG trusts an intact file without asking who signed it', ()=>{
    const m = machine({ roots: [] });
    m.file('C:\\signed.cab', signedCabinet());
    assert.equal(m.verify('C:\\signed.cab', { flags: WTD_HASH_ONLY_FLAG }), 0);
    assert.equal(m.verify('C:\\signed.cab'), CERT_E_CHAINING);
});

test('CryptCATOpen opens a catalog file and CryptCATClose closes it', ()=>{
    const m = machine();
    m.file('C:\\catalog.cat', new Uint8Array([1, 2, 3]));
    const name = 0x500;
    [...'C:\\catalog.cat', '\0'].forEach((ch, i)=>
        m.view.setUint16(name + i * 2, ch.charCodeAt(0), true));
    const handle = m.fns.CryptCATOpen.handler([name, 0, 0, 0, 0]);
    assert.notEqual(handle, 0);
    assert.equal(m.handleType(handle), 'wintrust-catalog');
    assert.equal(m.fns.CryptCATClose.handler([handle]), 1);
    assert.equal(m.handleType(handle), null, 'the handle is gone');

    [...'C:\\missing.cat', '\0'].forEach((ch, i)=>
        m.view.setUint16(name + i * 2, ch.charCodeAt(0), true));
    assert.equal(m.fns.CryptCATOpen.handler([name, 0, 0, 0, 0]), 0);
    assert.equal(m.lastError(), 2, 'ERROR_FILE_NOT_FOUND');
});

test('an unknown action, another subject form and missing arguments are refused', ()=>{
    const m = machine({ roots: [chain.root] });
    m.file('C:\\signed.cab', signedCabinet());
    m.memory[m.action] ^= 1;
    assert.equal(m.verify('C:\\signed.cab'), TRUST_E_PROVIDER_UNKNOWN);
    m.memory[m.action] ^= 1;
    assert.equal(m.verify('C:\\signed.cab', { choice: WTD_CHOICE_CATALOG }),
        TRUST_E_SUBJECT_FORM_UNKNOWN);
    assert.equal(m.verify(null), ERROR_INVALID_PARAMETER, 'no path');
    assert.equal(m.verify('C:\\signed.cab', { size: 12 }), ERROR_INVALID_PARAMETER);
    assert.equal(m.fns.WinVerifyTrust.handler([0, m.action, 0]), ERROR_INVALID_PARAMETER);
    assert.equal(m.fns.WinVerifyTrustEx.handler([0, m.action, 0]), ERROR_INVALID_PARAMETER);
});
