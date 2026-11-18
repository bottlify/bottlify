/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    checkAddresses, checkReturns, checkText, layoutOf, pointersOf, resultOf, returnsPointer,
    cutAddresses,
} from './check-wide-arguments.mjs';

test('a signature is laid out as the 32-bit stack has it', ()=>{
    const layout = layoutOf('AUDCLNT_SHAREMODE mode, DWORD flags, REFERENCE_TIME duration,'
        + ' REFERENCE_TIME period, const WAVEFORMATEX *format, LPCGUID session');
    assert.deepEqual(layout.quad, [2, 4]);
    assert.deepEqual(layoutOf('double x, float y, GUID g, POINT p').floats, { 0: 'f64', 2: 'f32' });
    assert.deepEqual(layoutOf('CLSID clsid, POINT pt').structs, { 0: 4 });
    assert.deepEqual(layoutOf('void').quad, []);
});

test('a spec is held to its signature: undeclared, misdeclared, declared, by a helper', ()=>{
    const problem = (/** @type {string} */ text)=>checkText(text).map(one=>one.problem);
    const signature = '/** HRESULT Seek(LARGE_INTEGER move, DWORD origin, ULARGE_INTEGER *out) */\n';
    assert.match(String(problem(`${signature}{ name: 'Seek', argBytes: 20, invoke: ()=>0 },`)[0]),
        /quadwords .* not declared/);
    assert.match(String(problem(
        `${signature}{ name: 'Seek', argBytes: 20, quadwords: [2], invoke: ()=>0 },`)[0]),
    /where the signature has/);
    assert.deepEqual(problem(
        `${signature}{ name: 'Seek', argBytes: 20, quadwords: [1], invoke: ()=>0 },`), [null]);
    assert.deepEqual(problem('const make = n=>({ argBytes: 12, quadwords: [0], handler: ()=>0 });\n'
        + '/** BOOL Free(TRACEHANDLE handle) */\nFree: make(1),'), [null],
    'a helper\'s own literal');
    assert.deepEqual(problem('/** float Late(int a, int b, int c, int d, float e) */\n'
        + 'Late: { argBytes: 20, handler: ()=>0 },'), [null],
    'a float past the fourth slot needs nothing');
});

test('a return type is an address by its star, its LP prefix or its name', ()=>{
    for (const type of ['LPVOID', 'void *', 'const char*', 'PVOID', 'HMODULE', 'SIZE_T', 'FARPROC',
        'IDirect3D9*', 'LPWSTR'])
    {
        assert.equal(returnsPointer(type), true, type);
    }
    for (const type of ['HANDLE', 'LRESULT', 'BOOL', 'DWORD', 'HRESULT', 'LONG_PTR', 'HWND', 'int'])
    {
        assert.equal(returnsPointer(type), false, type);
    }
});

test('the dwords that hold an address, as the 32-bit layout counts them', ()=>{
    assert.deepEqual(pointersOf('LPVOID at, SIZE_T size, DWORD type, DWORD protect'), [0, 1]);
    assert.deepEqual(pointersOf('HANDLE file, LONGLONG offset, PVOID out, const char *name'),
        [3, 4]);
    assert.deepEqual(pointersOf('GUID g, void *p'), [4]);
    assert.deepEqual(pointersOf('void'), []);
});

test('a spec answering an address says so, and one answering none does not', ()=>{
    const problem = (/** @type {string} */ text)=>checkReturns(text).map(one=>one.problem);
    const alloc = '/** LPVOID VirtualAlloc(LPVOID at, SIZE_T size, DWORD type, DWORD protect) */\n';
    assert.match(String(problem(`${alloc}VirtualAlloc: { argBytes: 16, handler: ()=>0 },`)[0]),
        /without returns: 'pointer'/);
    assert.deepEqual(problem(
        `${alloc}VirtualAlloc: { returns: 'pointer', argBytes: 16, handler: ()=>0 },`), [null]);
    assert.match(String(problem('/** HANDLE CreateFileA(LPCSTR name) */\n'
        + 'CreateFileA: { returns: \'pointer\', argBytes: 4, handler: ()=>0 },')[0]), /no address/);
    assert.match(String(problem(`${alloc}VirtualAlloc: make(16),`)[0]), /without returns/,
        'a helper\'s spec is not taken on trust');
    assert.deepEqual(problem(`${alloc}VirtualAlloc: { ...make(16), returns: 'pointer' },`), [null]);
    assert.deepEqual(problem('/** PSTR StrChrA(PCSTR s, WORD c) */\n'
        + '...both(\'StrChr\', 8, ()=>0, { returns: \'pointer\' }),'), [null]);
    assert.match(String(problem('const allocator = { argBytes: 4, handler: ()=>0 };\n'
        + '/** void *malloc(size_t size) */\nmalloc: allocator,')[0]), /without returns/,
    'a spec named by a constant is that constant');
    assert.deepEqual(problem('/** void *Prose(int) is what it would be */\nconst x = 1;'), [],
        'a comment over no spec');
});

test('a size result is sign-extended, a pointer-sized integer either way (A273)', ()=>{
    const problem = (/** @type {string} */ text)=>checkReturns(text).map(one=>one.problem);
    const mbrtowc = '/** size_t mbrtowc(wchar_t *dest, const char *s, size_t n, mbstate_t *ps) */\n';
    assert.match(String(problem(
        `${mbrtowc}mbrtowc: { returns: 'pointer', argBytes: 16, handler: ()=>0xfffffffe },`)[0]),
    /no address/, '(size_t)-2 answered as a dword must come back as -2');
    assert.deepEqual(problem(`${mbrtowc}mbrtowc: { argBytes: 16, handler: ()=>0 },`), [null]);
    assert.equal(resultOf('SIZE_T'), 'value');
    assert.equal(resultOf('size_t *'), 'address');
    for (const type of ['ULONG_PTR', 'UINT_PTR', 'DWORD_PTR', 'uintptr_t', 'WPARAM'])
    {
        assert.equal(resultOf(type), 'either', type);
        const head = `/** ${type} GetClassLongPtrA(HWND hWnd, int nIndex) */\nGetClassLongPtrA: { `;
        assert.deepEqual(problem(`${head}returns: 'pointer', argBytes: 8, handler: ()=>0 },`),
            [null]);
        assert.deepEqual(problem(`${head}argBytes: 8, handler: ()=>0 },`), [null]);
    }
});

test('an address result by a P typedef, an address handle, a later line, an ordinal key', ()=>{
    const problem = (/** @type {string} */ text)=>checkReturns(text).map(one=>one.problem);
    assert.equal(resultOf('PSID_IDENTIFIER_AUTHORITY'), 'address');
    assert.equal(resultOf('PTP_POOL'), 'address');
    for (const type of ['POINT', 'LPARAM', 'PDH_STATUS'])
    {
        assert.equal(resultOf(type), 'value', type);
    }
    assert.match(String(problem('/** HANDLE GetProcessHeap(void) */\n'
        + 'GetProcessHeap: { argBytes: 0, handler: ()=>0 },')[0]), /without returns/,
    'a heap handle is its base');
    assert.match(String(problem('/**\n * Why it answers what it does.\n'
        + ' * PDWORD GetSidSubAuthority(PSID sid, DWORD n)\n */\n'
        + 'GetSidSubAuthority: { argBytes: 8, handler: ()=>0 },')[0]), /without returns/,
    'the signature on a later line of its comment');
    const ordinal = checkReturns('/** LPVOID Alloc(DWORD cb) - #71 */\n'
        + '\'#71\': { argBytes: 4, handler: ()=>0 },');
    assert.match(String(ordinal[0]?.problem), /without returns/, 'a spec under a quoted key');
    assert.equal(ordinal[0]?.key, '#71');
});

test('the gate tries only addresses: a size is wide but no address', ()=>{
    assert.deepEqual(pointersOf('LPVOID at, SIZE_T size', { addresses: true }), [0]);
    assert.deepEqual(pointersOf('ULONG_PTR key, void *p', { addresses: true }), [1]);
});

test('an argument a spec takes whole is an address of its signature', ()=>{
    const problem = (/** @type {string} */ text)=>checkAddresses(text).map(one=>one.problem);
    const head = '/** HANDLE CreateThread(LPSECURITY_ATTRIBUTES sa, SIZE_T stack,'
        + ' LPTHREAD_START_ROUTINE start, LPVOID parameter, DWORD flags, LPDWORD id) */\n'
        + 'CreateThread: { argBytes: 24, ';
    assert.deepEqual(problem(`${head}addresses: [2, 3], handler: ()=>0 },`), [null]);
    assert.match(String(problem(`${head}addresses: [1, 3], handler: ()=>0 },`)[0]),
        /names dword 1/, 'a size is no address');
    assert.match(String(problem(`${head}addresses: [4], handler: ()=>0 },`)[0]),
        /names dword 4/, 'nor a DWORD');
    assert.deepEqual(problem(`${head}handler: ()=>0 },`), [], 'a spec that declares none');
    // A COM method's dwords count its interface pointer first.
    assert.deepEqual(problem('/** HRESULT Advise(IUnknown *sink, DWORD *cookie) */\n'
        + '{ name: \'Advise\', argBytes: 12, addresses: [1], invoke: ()=>0 },'), [null]);
});

test('a handler that cuts an address it takes whole back to a dword is found', ()=>{
    const spec = `{ argBytes: 16, addresses: [1, 3],
        handler: ([type, proc, module, context])=>{
            if ((proc >>> 0) === 0) { return 0; }
            return keep(wholeAddress(proc), module >>> 0, context >>> 0);
        } }`;
    assert.deepEqual(cutAddresses(spec, [1, 3]), ['context >>> 0'],
        'the null test of proc and the undeclared module are let be');
    assert.deepEqual(cutAddresses(
        '{ addresses: [2], handler: args=>start(args[2] | 0, args[1] >>> 0) }', [2]),
    ['args[2] | 0']);
    assert.deepEqual(cutAddresses(
        '{ addresses: [0], handler: ([start])=>run(wholeAddress(start)) }', [0]), []);
});
