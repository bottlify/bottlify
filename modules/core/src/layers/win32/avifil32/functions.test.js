/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AVIERR_BADHANDLE, AVIERR_FILEOPEN, AVIERR_UNSUPPORTED, createAvifilFunctions,
} from './functions.js';

const make = ()=>{
    const memory = new Uint8Array(64).fill(0xcc);
    const fns = createAvifilFunctions({ writeMemory: (at, bytes)=>memory.set(bytes, at) });
    const dword = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    return { fns, memory, dword };
};

test('the error codes are vfw.h\'s MAKE_AVIERR values', ()=>{
    assert.equal(AVIERR_UNSUPPORTED, 0x80044065);
    assert.equal(AVIERR_BADHANDLE, 0x8004406c);
    assert.equal(AVIERR_FILEOPEN, 0x8004406f);
});

test('no file opens: the out pointer is cleared and AVIERR_FILEOPEN answered', ()=>{
    const { fns, dword, memory } = make();
    assert.equal(fns.AVIFileOpenA.handler([8, 0x100, 0x1001, 0]), AVIERR_FILEOPEN);
    assert.equal(dword(8), 0);
    assert.equal(memory[12], 0xcc, 'only the pointer is written');
    assert.equal(fns.AVIFileOpenW.handler([0, 0x100, 0, 0]), AVIERR_FILEOPEN,
        'a null out pointer is not written');
    assert.equal(fns.AVIFileOpenA.argBytes, 16);
});

test('calls on a file or stream nobody holds fail without writing past their outputs', ()=>{
    const { fns, dword } = make();
    assert.equal(fns.AVIFileCreateStreamA.handler([0, 16, 0]), AVIERR_BADHANDLE);
    assert.equal(dword(16), 0);
    assert.equal(fns.AVIStreamWrite.handler([0, 0, 1, 0, 0, 0, 20, 24]), AVIERR_BADHANDLE);
    assert.equal(dword(20), 0);
    assert.equal(dword(24), 0);
    assert.equal(fns.AVIStreamWrite.argBytes, 32);
    assert.equal(fns.AVIMakeCompressedStream.handler([28, 0, 0, 0]), AVIERR_UNSUPPORTED);
    assert.equal(dword(28), 0);
    assert.equal(fns.AVIFileRelease.handler(), 0);
    assert.equal(fns.AVIStreamRelease.handler(), 0);
    assert.equal(fns.AVIFileInit.handler(), 0);
    assert.equal(fns.AVIFileExit.handler(), 0);
});

test('the reading calls a film player links fail as for a stream nobody holds', ()=>{
    const { fns, dword, memory } = make();
    assert.equal(fns.AVIFileGetStream.handler([0, 32, 0x73646976, 0]), AVIERR_BADHANDLE);
    assert.equal(dword(32), 0);
    assert.equal(fns.AVIStreamRead.handler([0, 0, 1, 0, 0, 36, 40]), AVIERR_BADHANDLE);
    assert.equal(dword(36), 0);
    assert.equal(dword(40), 0);
    assert.equal(memory[44], 0xcc, 'nothing past the counts is written');
    assert.equal(fns.AVIStreamRead.argBytes, 28);
    assert.equal(fns.AVIFileInfoA.handler([0, 0, 0]), AVIERR_BADHANDLE);
    assert.equal(fns.AVIStreamInfoA.handler([0, 0, 0]), AVIERR_BADHANDLE);
    assert.equal(fns.AVIStreamReadFormat.handler([0, 0, 0, 0]), AVIERR_BADHANDLE);
    assert.equal(fns.AVIStreamStart.handler([0]), -1);
    assert.equal(fns.AVIStreamLength.handler([0]), -1);
    assert.equal(fns.AVIStreamGetFrameOpen.handler([0, 0]), 0);
    assert.equal(fns.AVIStreamGetFrame.handler([0, 0]), 0);
    assert.equal(fns.AVIStreamGetFrameClose.handler([0]), AVIERR_BADHANDLE);
    assert.equal(fns.AVISaveOptions.handler([0, 0, 1, 0, 0]), 0);
    assert.equal(fns.AVISaveOptions.argBytes, 20);
});
