/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExceptionFunctions } from './exceptions.js';

const EXCEPTION_EXECUTE_HANDLER = 1;

function fakeHost(){
    const bytes = new Uint8Array(0x400);
    return {
        bytes,
        view: new DataView(bytes.buffer),
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
    };
}

test('installing a filter hands back the one it replaces', ()=>{
    // A program chains to the previous filter from inside its own, so returning
    // zero every time breaks the chain without any other sign.
    const fns = createExceptionFunctions(fakeHost());

    assert.equal(fns.SetUnhandledExceptionFilter.handler([0x401000]), 0, 'none was installed');
    assert.equal(fns.SetUnhandledExceptionFilter.handler([0x402000]), 0x401000);
    assert.equal(fns.SetUnhandledExceptionFilter.handler([0]), 0x402000,
        'and clearing it still reports what was there');
});

test('the default filter tells a caller to run its handler', ()=>{
    const fns = createExceptionFunctions(fakeHost());
    assert.equal(fns.UnhandledExceptionFilter.handler(), EXCEPTION_EXECUTE_HANDLER);
});

test('raising an exception is reported, not swallowed', ()=>{
    // RaiseException does not return on Windows. Returning here would hand
    // control back to code that has already decided it is not running.
    const host = fakeHost();
    const fns = createExceptionFunctions(host);

    assert.throws(()=>fns.RaiseException.handler([0xc0000005, 0, 0, 0]),
        /raised 0xc0000005/);
});

test('the exception arguments travel with the report', ()=>{
    // They are the whole content of a C++ throw, and a report without them
    // names an address rather than a cause.
    const host = fakeHost();
    const fns = createExceptionFunctions(host);
    host.view.setUint32(0x200, 0xdeadbeef, true);
    host.view.setUint32(0x204, 2, true);

    assert.throws(()=>fns.RaiseException.handler([0xe06d7363, 1, 2, 0x200]),
        /arguments 3735928559, 2/);
});

test('unwinding is reported with the frame it was asked to unwind to', ()=>{
    // Returning normally would leave every skipped frame live while the caller
    // proceeds as though they were gone.
    const fns = createExceptionFunctions(fakeHost());

    assert.throws(()=>fns.RtlUnwind.handler([0x12340000, 0x401234, 0, 0]),
        /frame 0x12340000 at 0x401234/);
});

test('argument sizes match what the guest compiled against', ()=>{
    const fns = createExceptionFunctions(fakeHost());

    assert.equal(fns.SetUnhandledExceptionFilter.argBytes, 4);
    assert.equal(fns.UnhandledExceptionFilter.argBytes, 4);
    assert.equal(fns.RaiseException.argBytes, 16);
    assert.equal(fns.RtlUnwind.argBytes, 16);
});
