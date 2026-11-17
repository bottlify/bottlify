/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyOf, formatCall, renderSummary, requestKey, summarize } from './classify.mjs';

/**
 * @param {Partial<import('./classify.mjs').CallEntry>} fields
 * @returns {import('./classify.mjs').CallEntry}
 */
const call = fields=>({ seq: 0, t: 0, name: 'KERNEL32.dll!Sleep', from: 0x401000, args: [],
    strings: null, kind: 'answered', answer: 0, thread: 'main', ...fields });

test('a call goes to its question whichever form of the function was used', ()=>{
    assert.equal(familyOf('ADVAPI32.dll!RegOpenKeyExA'), 'registry');
    assert.equal(familyOf('ADVAPI32.dll!RegQueryValueExW'), 'registry');
    assert.equal(familyOf('KERNEL32.dll!LoadLibraryExA'), 'module');
    assert.equal(familyOf('KERNEL32.dll!GetProcAddress'), 'module');
    assert.equal(familyOf('SHELL32.dll!ShellExecuteW'), 'process');
    assert.equal(familyOf('KERNEL32.dll!OpenFileMappingA'), 'ipc');
    assert.equal(familyOf('KERNEL32.dll!OpenEventA'), 'ipc');
    assert.equal(familyOf('WINTRUST.dll!WinVerifyTrust'), 'crypto');
    assert.equal(familyOf('KERNEL32.dll!IsDebuggerPresent'), 'debug');
    assert.equal(familyOf('KERNEL32.dll!CreateFileA'), 'file');
    assert.equal(familyOf('USER32.dll!MessageBoxA'), 'ui');
    assert.equal(familyOf('<heap-alloc>'), 'other');
});

test('a module handle is shown as the word, not as the "MZ" it points at', ()=>{
    const line = formatCall(call({ name: 'KERNEL32.dll!GetProcAddress',
        args: [0x2000000, 0x500000], strings: ['MZ', 'OpenEventA'], answer: 0x20010f0 }));
    assert.match(line, /GetProcAddress\(0x2000000, "OpenEventA"\) = 0x20010f0/);
});

test('an ordinal asked of GetProcAddress reads as one', ()=>{
    const line = formatCall(call({ name: 'KERNEL32.dll!GetProcAddress', args: [0x2000000, 17],
        strings: ['MZ', null], answer: 0 }));
    assert.match(line, /GetProcAddress\(0x2000000, #17\)/);
});

test('a call that did not answer says how it ended, and a last error is kept', ()=>{
    const line = formatCall(call({ name: 'KERNEL32.dll!WaitForSingleObject', args: [8, 0xffffffff],
        kind: 'parked', answer: undefined, error: 6 }));
    assert.match(line, /WaitForSingleObject\(0x8, 0xffffffff\) = parked err=6$/);
});

test('the same request is one line however many times and with whatever buffers it was made', ()=>{
    const ask = (/** @type {number} */ buffer)=>call({ name: 'ADVAPI32.dll!RegQueryValueExA',
        args: [0x80000001, 0x500000, 0, 0, buffer, 0x600000],
        strings: [null, 'SteamClientDll', null, null, null, null], answer: 2 });
    const families = summarize([ask(0x700000), ask(0x710000),
        call({ name: 'ADVAPI32.dll!RegQueryValueExA', args: [0x80000001, 0x500100],
            strings: [null, 'SteamPath'], answer: 2 })]);
    const registry = families.get('registry') ?? [];
    assert.equal(registry.length, 2);
    assert.equal(registry[0].count, 2);
    assert.equal(registry[0].first.args[4], 0x700000);
});

test('one name asked of two modules is two requests', ()=>{
    const ask = (/** @type {number} */ module)=>requestKey(call({ name: 'KERNEL32.dll!GetProcAddress',
        args: [module, 0x500000], strings: ['MZ', 'CreateInterface'] }));
    assert.notEqual(ask(0x2000000), ask(0x3000000));
    assert.equal(ask(0x2000000), ask(0x2000000));
});

test('a request answered differently over the run lists its answers', ()=>{
    const text = renderSummary(summarize([
        call({ name: 'KERNEL32.dll!OpenEventA', args: [2, 0, 0x500000], strings: [null, null, 'X'],
            answer: 0 }),
        call({ name: 'KERNEL32.dll!OpenEventA', args: [2, 0, 0x500000], strings: [null, null, 'X'],
            answer: 0x40 }),
    ]));
    assert.match(text, /== ipc: 1 requests, 2 calls/);
    assert.match(text, /x2 answers=0x0,0x40/);
});
