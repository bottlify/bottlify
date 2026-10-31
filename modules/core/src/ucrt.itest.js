/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program of the universal runtime: it imports the C library through the
 * `api-ms-win-crt-*` API sets, which Windows 10 resolves to ucrtbase.dll by its
 * schema, prints through `__stdio_common_vfprintf` to the stream
 * `__acrt_iob_func` hands it, and never loads msvcrt.dll -- whose image held
 * the standard streams, so they were records at address zero before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

const STDIO = 'api-ms-win-crt-stdio-l1-1-0.dll';
const RUNTIME = 'api-ms-win-crt-runtime-l1-1-0.dll';

test('a program of the universal runtime prints through its API sets, bound to ucrtbase',
    { timeout: 60000 }, async t=>{
        const executable = buildExe({
            imports: {
                [STDIO]: ['__acrt_iob_func', '__stdio_common_vfprintf'],
                [RUNTIME]: ['exit'],
                'KERNEL32.dll': ['GetModuleHandleA'],
            },
            data: {
                format: cString('%s %d\n'),
                word: cString('ucrt'),
                set: cString(STDIO),
                ucrt: cString('ucrtbase.dll'),
            },
            codeSize: 0x80,
            code: ({ iat, at })=>[
                0x6a, 42, //                                    push 42
                0x68, ...u32(at('word')), //                    push "ucrt": the va_list
                0x89, 0xe6, //                                  mov esi, esp
                0x6a, 0x01, //                                  push 1: stdout
                0xff, 0x15, ...u32(iat('__acrt_iob_func')),
                0x83, 0xc4, 0x04, //                            add esp, 4
                0x56, //                                        push esi: args
                0x6a, 0x00, //                                  push 0: locale
                0x68, ...u32(at('format')), //                  push format
                0x50, //                                        push eax: the stream
                0x6a, 0x00, 0x6a, 0x00, //                      push 0, 0: the options
                0xff, 0x15, ...u32(iat('__stdio_common_vfprintf')),
                0x83, 0xc4, 0x20, //                            add esp, 24 + the two values
                0x68, ...u32(at('set')),
                0xff, 0x15, ...u32(iat('GetModuleHandleA')),
                0x89, 0xc3, //                                  mov ebx, eax
                0x68, ...u32(at('ucrt')),
                0xff, 0x15, ...u32(iat('GetModuleHandleA')),
                0x39, 0xd8, //                                  cmp eax, ebx
                0x0f, 0x95, 0xc0, //                            setne al
                0x0f, 0xb6, 0xc0, //                            movzx eax, al
                0x85, 0xdb, //                                  test ebx, ebx
                0x75, 0x05, //                                  jnz +5
                0xb8, ...u32(2), //                             mov eax, 2: no module at all
                0x50, //                                        push eax
                0xff, 0x15, ...u32(iat('exit')),
            ],
        });
        const app = await createApp({ executable, engine: 'cork' });
        t.after(()=>app.dispose());
        let printed = '';
        app.on('output', (/** @type {{ text: string }} */ { text })=>{
            printed += text;
        });

        const code = await app.run({ timeoutMs: 30000 });

        assert.equal(printed, 'ucrt 42\n', 'printed to the stream __acrt_iob_func gave');
        assert.equal(code, 0, 'the API set is ucrtbase.dll by handle, as Windows answers it');
    });

const MATH = 'api-ms-win-crt-math-l1-1-0.dll';
const LOCALE = 'api-ms-win-crt-locale-l1-1-0.dll';
const STRING = 'api-ms-win-crt-string-l1-1-0.dll';
const CONVERT = 'api-ms-win-crt-convert-l1-1-0.dll';

/** A double's eight bytes. @param {number} value */
const f64 = value=>[...new Uint8Array(Float64Array.of(value).buffer)];
/** A float's four. @param {number} value */
const f32 = value=>[...new Uint8Array(Float32Array.of(value).buffer)];
/** UTF-16 and its terminator. @param {string} text */
const wide = text=>[...text].flatMap(c=>[c.charCodeAt(0), 0]).concat(0, 0);

/**
 * @typedef {{ f64: (name: string) => number, f32: (name: string) => number,
 *     u32: (name: string) => number, u64: (name: string) => bigint,
 *     textAt: (at: number) => string, wideAt: (at: number) => string,
 *     read: (at: number, length: number) => DataView }} Answers
 */

/**
 * Runs a program to its end and hands `check` what it left at the
 * addresses it stored its answers in.
 *
 * @param {Uint8Array} executable @param {Record<string, number>} where
 * @param {string} commandLine @param {(got: Answers) => void} check
 */
async function answers(executable, where, commandLine, check){
    const app = await createApp({ executable, engine: 'cork', commandLine });
    try
    {
        const code = await app.run({ timeoutMs: 30000 });
        assert.equal(code, 0, 'the program ran to its end');
        /** @param {number} at @param {number} length */
        const read = (at, length)=>new DataView(app.debug.read(at, length).slice().buffer);
        check({
            f64: (/** @type {string} */ name)=>read(where[name], 8).getFloat64(0, true),
            f32: (/** @type {string} */ name)=>read(where[name], 4).getFloat32(0, true),
            u32: (/** @type {string} */ name)=>read(where[name], 4).getUint32(0, true),
            u64: (/** @type {string} */ name)=>read(where[name], 8).getBigUint64(0, true),
            /** @param {number} at */
            textAt: at=>{
                const raw = app.debug.read(at, 64);
                return String.fromCharCode(...raw.slice(0, raw.indexOf(0)));
            },
            /** @param {number} at */
            wideAt: at=>{
                const raw = new Uint16Array(app.debug.read(at, 128).slice().buffer);
                return String.fromCharCode(...raw.slice(0, raw.indexOf(0)));
            },
            read,
        });
    }
    finally
    {
        await app.dispose();
    }
}

test('a 32-bit program of the universal runtime is answered its C99 maths, classifiers,'
    + ' SSE2 entries, WinMain line, ctype table, tokens and conversions', { timeout: 60000 },
async()=>{
    /** @type {Record<string, number>} */
    const where = {};
    const names = ['sin', 'pow', 'sinf', 'trunc', 'round', 'truncf', 'dclass', 'fdclass',
        'dtest', 'dsign', 'line', 'ctype', 'first', 'second', 'third', 'tofloat', 'low', 'high',
        'except', 'nerr'];
    const executable = buildExe({
        imports: {
            [MATH]: ['__libm_sse2_sin', '_libm_sse2_pow_precise', '__libm_sse2_sinf', 'trunc',
                'round', 'truncf', '_dclass', '_fdclass', '_dtest', '_dsign', '_except1'],
            [RUNTIME]: ['_get_narrow_winmain_command_line', '__sys_nerr'],
            [LOCALE]: ['__pctype_func'],
            [STRING]: ['strtok_s'],
            [CONVERT]: ['strtof', '_wtoi64'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        data: {
            half: f64(0.5), two: f64(2), ten: f64(10), halfSingle: f32(0.5),
            minusTwoSeven: f64(-2.7), minusTwoHalf: f64(-2.5), twoSevenSingle: f32(2.7),
            subnormal: f64(5e-324), infinity: f32(Infinity), nan: f64(NaN), minusOne: f64(-1),
            big: f64(1e308), list: cString('a,,b'), comma: cString(','), context: u32(0),
            decimal: cString('0.1'), number: wide('-12345678901'),
            ...Object.fromEntries(names.map(name=>[name, new Array(8).fill(0)])),
        },
        codeSize: 0x200,
        code: ({ iat, at })=>{
            names.forEach(name=>{
                where[name] = at(name);
            });
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** Pushes the double at `name`, its high half first. @param {string} name */
            const pushDouble = name=>[0xff, 0x35, ...u32(at(name) + 4),
                0xff, 0x35, ...u32(at(name))];
            /** @param {string} name */
            const storeEax = name=>[0xa3, ...u32(at(name))];
            /** @param {number} bytes */
            const drop = bytes=>[0x83, 0xc4, bytes];
            return [
                0xf2, 0x0f, 0x10, 0x05, ...u32(at('half')), //         movsd xmm0, [half]
                ...call('__libm_sse2_sin'),
                0xf2, 0x0f, 0x11, 0x05, ...u32(at('sin')), //          movsd [sin], xmm0
                0xf2, 0x0f, 0x10, 0x05, ...u32(at('two')),
                0xf2, 0x0f, 0x10, 0x0d, ...u32(at('ten')), //          movsd xmm1, [ten]
                ...call('_libm_sse2_pow_precise'),
                0xf2, 0x0f, 0x11, 0x05, ...u32(at('pow')),
                0xf3, 0x0f, 0x10, 0x05, ...u32(at('halfSingle')), //  movss xmm0, [halfSingle]
                ...call('__libm_sse2_sinf'),
                0xf3, 0x0f, 0x11, 0x05, ...u32(at('sinf')), //         movss [sinf], xmm0
                ...pushDouble('minusTwoSeven'), ...call('trunc'), ...drop(8),
                0xdd, 0x1d, ...u32(at('trunc')), //                    fstp qword [trunc]
                ...pushDouble('minusTwoHalf'), ...call('round'), ...drop(8),
                0xdd, 0x1d, ...u32(at('round')),
                0xff, 0x35, ...u32(at('twoSevenSingle')), ...call('truncf'), ...drop(4),
                0xd9, 0x1d, ...u32(at('truncf')), //                   fstp dword [truncf]
                ...pushDouble('subnormal'), ...call('_dclass'), ...drop(8), ...storeEax('dclass'),
                0xff, 0x35, ...u32(at('infinity')), ...call('_fdclass'), ...drop(4),
                ...storeEax('fdclass'),
                0x68, ...u32(at('nan')), ...call('_dtest'), ...drop(4), ...storeEax('dtest'),
                ...pushDouble('minusOne'), ...call('_dsign'), ...drop(8), ...storeEax('dsign'),
                // _except1(overflow, 0, arg, result, every exception masked, 0)
                0x6a, 0x00, 0x68, ...u32(0x27f), ...pushDouble('big'), ...pushDouble('big'),
                0x6a, 0x00, 0x6a, 0x01, ...call('_except1'), ...drop(0x20),
                0xdd, 0x1d, ...u32(at('except')),
                ...call('_get_narrow_winmain_command_line'), ...storeEax('line'),
                ...call('__pctype_func'), ...storeEax('ctype'),
                ...call('__sys_nerr'), ...storeEax('nerr'),
                0x68, ...u32(at('context')), 0x68, ...u32(at('comma')), 0x68, ...u32(at('list')),
                ...call('strtok_s'), ...drop(12), ...storeEax('first'),
                0x68, ...u32(at('context')), 0x68, ...u32(at('comma')), 0x6a, 0x00,
                ...call('strtok_s'), ...drop(12), ...storeEax('second'),
                0x68, ...u32(at('context')), 0x68, ...u32(at('comma')), 0x6a, 0x00,
                ...call('strtok_s'), ...drop(12), ...storeEax('third'),
                0x6a, 0x00, 0x68, ...u32(at('decimal')), ...call('strtof'), ...drop(8),
                0xd9, 0x1d, ...u32(at('tofloat')),
                0x68, ...u32(at('number')), ...call('_wtoi64'), ...drop(4),
                ...storeEax('low'), 0x89, 0x15, ...u32(at('high')), //  mov [high], edx
                0x6a, 0x00, ...call('ExitProcess'),
            ];
        },
    });
    await answers(executable, where, '"C:\\a b.exe"  one "two"', got=>{
        assert.equal(got.f64('sin'), Math.sin(0.5), 'sin in XMM0');
        assert.equal(got.f64('pow'), 1024, 'pow of XMM0 and XMM1');
        assert.equal(got.f32('sinf'), Math.fround(Math.sin(0.5)), 'sinf in the low lane of XMM0');
        assert.equal(got.f64('trunc'), -2, 'trunc toward zero');
        assert.equal(got.f64('round'), -3, 'round half away from zero');
        assert.equal(got.f32('truncf'), 2, 'truncf');
        assert.equal(got.u32('dclass') & 0xffff, 0xfffe, '_dclass: FP_SUBNORMAL');
        assert.equal(got.u32('fdclass') & 0xffff, 1, '_fdclass: FP_INFINITE');
        assert.equal(got.u32('dtest') & 0xffff, 2, '_dtest: FP_NAN');
        assert.equal(got.u32('dsign'), 0x8000, '_dsign: the sign bit');
        assert.equal(got.f64('except'), Infinity, 'a masked overflow answers an infinity');
        assert.equal(got.textAt(got.u32('line')), 'one "two"', 'the WinMain line past the name');
        assert.equal(got.read(got.u32('ctype') + 0x41 * 2, 2).getUint16(0, true) & 0x1, 1,
            '__pctype_func: "A" is upper case');
        assert.equal(got.read(got.u32('nerr'), 4).getUint32(0, true), 43, '__sys_nerr');
        assert.equal(got.textAt(got.u32('first')), 'a', 'the first token');
        assert.equal(got.textAt(got.u32('second')), 'b', 'the second, past the empty one');
        assert.equal(got.u32('third'), 0, 'and no third');
        assert.equal(got.f32('tofloat'), Math.fround(0.1), 'strtof');
        assert.equal(BigInt.asIntN(64, BigInt(got.u32('high')) << 32n | BigInt(got.u32('low'))),
            -12345678901n, '_wtoi64 in EDX:EAX');
    });
});

test('a 64-bit program of the universal runtime is answered its float maths in XMM0, its'
    + ' quadwords in RAX, and its exit table in three quadwords', { timeout: 60000 }, async()=>{
    /** @type {Record<string, number>} */
    const where = {};
    const names = ['truncf', 'modff', 'whole', 'copysignf', 'fmaxf', 'dclass', 'strtoll', 'line',
        'locale', 'token', 'table', 'except', 'context'];
    const executable = buildExe({
        bits: 64,
        imports: {
            [MATH]: ['truncf', 'modff', 'copysignf', 'fmaxf', '_dclass', '_except1'],
            [CONVERT]: ['strtoll'],
            [RUNTIME]: ['_get_wide_winmain_command_line', '_initialize_onexit_table',
                '_register_onexit_function'],
            [LOCALE]: ['___lc_locale_name_func'],
            [STRING]: ['strtok_s'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        data: {
            twoSeven: f32(2.7), threeQuarters: f32(-3.25), minus: f32(-0), nan: f32(NaN),
            one: f32(1), zero: f64(0), big: f64(-1e308), number: cString('-9000000000'),
            list: cString(' x y'), space: cString(' '),
            ...Object.fromEntries(names.map(name=>[name, new Array(24).fill(0x55)])),
        },
        codeSize: 0x200,
        code: ({ iat, at, code })=>{
            names.forEach(name=>{
                where[name] = at(name);
            });
            /** @type {number[]} */
            const bytes = [];
            /** @param {number[]} op @param {number} to  a RIP-relative operand */
            const rip = (op, to)=>bytes.push(...op,
                ...u32(to - (code(bytes.length) + op.length + 4)));
            const call = (/** @type {string} */ name)=>rip([0xff, 0x15], iat(name));
            const loadSingle = (/** @type {string} */ name, register = 0)=>
                rip([0xf3, 0x0f, 0x10, 0x05 | register << 3], at(name));
            const storeSingle = (/** @type {string} */ name)=>rip([0xf3, 0x0f, 0x11, 0x05],
                at(name));
            const storeRax = (/** @type {string} */ name)=>rip([0x48, 0x89, 0x05], at(name));
            /** lea rcx, [name] @param {string} name */
            const firstArgument = name=>rip([0x48, 0x8d, 0x0d], at(name));
            /** lea rdx, [name] @param {string} name */
            const secondArgument = name=>rip([0x48, 0x8d, 0x15], at(name));
            bytes.push(0x48, 0x83, 0xec, 0x38); //                         sub rsp, 56
            loadSingle('twoSeven');
            call('truncf');
            storeSingle('truncf');
            loadSingle('threeQuarters');
            secondArgument('whole');
            call('modff');
            storeSingle('modff');
            loadSingle('one');
            loadSingle('minus', 1);
            call('copysignf');
            storeSingle('copysignf');
            loadSingle('nan');
            loadSingle('one', 1);
            call('fmaxf');
            storeSingle('fmaxf');
            rip([0xf2, 0x0f, 0x10, 0x05], at('zero')); //                  movsd xmm0, [zero]
            call('_dclass');
            storeRax('dclass');
            // _except1(overflow, 0, arg, result, MXCSR with every mask, 0)
            bytes.push(0xb9, ...u32(1), 0x31, 0xd2); //                    mov ecx, 1; xor edx, edx
            rip([0xf2, 0x0f, 0x10, 0x15], at('big')); //                   movsd xmm2, [big]
            rip([0xf2, 0x0f, 0x10, 0x1d], at('big')); //                   movsd xmm3, [big]
            bytes.push(0x48, 0xc7, 0x44, 0x24, 0x20, ...u32(0x1f80)); //   [rsp+32] = 0x1f80
            bytes.push(0x48, 0xc7, 0x44, 0x24, 0x28, ...u32(0)); //        [rsp+40] = 0
            call('_except1');
            rip([0xf2, 0x0f, 0x11, 0x05], at('except')); //                movsd [except], xmm0
            firstArgument('number');
            bytes.push(0x31, 0xd2, 0x41, 0xb8, ...u32(10)); //             xor edx, edx; mov r8d, 10
            call('strtoll');
            storeRax('strtoll');
            call('_get_wide_winmain_command_line');
            storeRax('line');
            call('___lc_locale_name_func');
            storeRax('locale');
            firstArgument('list');
            secondArgument('space');
            rip([0x4c, 0x8d, 0x05], at('context')); //                     lea r8, [context]
            call('strtok_s');
            storeRax('token');
            firstArgument('table');
            call('_initialize_onexit_table');
            for (let n = 0; n < 2; n++)
            {
                firstArgument('table');
                secondArgument('twoSeven'); //                             any address will do
                call('_register_onexit_function');
            }
            bytes.push(0x31, 0xc9); //                                     xor ecx, ecx
            call('ExitProcess');
            return bytes;
        },
    });
    await answers(executable, where, '"C:\\x64.exe" alpha', got=>{
        assert.equal(got.f32('truncf'), 2, 'truncf in XMM0');
        assert.equal(got.f32('modff'), -0.25, 'the fraction modff answers');
        assert.equal(got.f32('whole'), -3, 'and the whole part it stores through RDX');
        assert.ok(Object.is(got.f32('copysignf'), -1), 'copysignf of XMM0 and XMM1');
        assert.equal(got.f32('fmaxf'), 1, 'fmaxf: a NaN loses');
        assert.equal(got.u32('dclass') & 0xffff, 0, '_dclass: FP_ZERO');
        assert.equal(got.f64('except'), -Infinity, 'a masked overflow, its sign kept');
        assert.equal(BigInt.asIntN(64, got.u64('strtoll')), -9000000000n, 'strtoll whole in RAX');
        assert.equal(got.wideAt(got.u32('line')), 'alpha', 'the wide WinMain line');
        const locale = got.read(got.u32('locale'), 48);
        assert.ok(got.u32('locale') !== 0 && [0, 8, 16, 24, 32, 40]
            .every(at=>locale.getBigUint64(at, true) === 0n), 'six names, none: the C locale');
        assert.equal(got.textAt(got.u32('token')), 'x', 'strtok_s');
        assert.equal(got.u64('context') >> 32n, 0n, 'its context written as a whole quadword');
        const table = got.read(where.table, 24);
        const first = table.getBigUint64(0, true);
        assert.ok(first !== 0n, 'the table has an array');
        assert.equal(table.getBigUint64(8, true) - first, 16n, 'two functions, a quadword each');
        assert.ok(table.getBigUint64(16, true) >= first + 16n, 'and room past them');
    });
});

test('a 32-bit program of the universal runtime splits paths into bounded buffers, opens'
    + ' through _sopen_s, prints wide text bounded, reads a wide double and writes to the'
    + ' console', { timeout: 60000 }, async()=>{
    /** @type {Record<string, number>} */
    const where = {};
    const names = ['drive', 'dir', 'name', 'ext', 'split', 'wdrive', 'wdir', 'wname', 'wext',
        'wsplit', 'cwd', 'cwdAnswer', 'fd', 'opened', 'printed', 'printBuffer', 'tofloat',
        'cputs'];
    const executable = buildExe({
        imports: {
            'api-ms-win-crt-filesystem-l1-1-0.dll': ['_splitpath_s', '_wsplitpath_s'],
            'api-ms-win-crt-environment-l1-1-0.dll': ['_wgetcwd'],
            [STDIO]: ['_sopen_s', '__stdio_common_vswprintf_s'],
            [CONVERT]: ['_wtof'],
            'api-ms-win-crt-conio-l1-1-0.dll': ['_cputs'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        data: {
            path: cString('C:\\dir\\name.ext'), widePath: wide('C:\\dir\\name.ext'),
            missing: cString('C:\\no such file.txt'), format: wide('%s'), hello: wide('hello'),
            list: u32(0), number: wide('2.5'), console: cString('x'),
            ...Object.fromEntries(names.map(name=>[name, new Array(32).fill(0x55)])),
        },
        codeSize: 0x200,
        code: ({ iat, at })=>{
            names.forEach(name=>{
                where[name] = at(name);
            });
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {string} name */
            const push = name=>[0x68, ...u32(at(name))];
            /** @param {number} value */
            const pushValue = value=>[0x68, ...u32(value)];
            /** @param {string} name */
            const storeEax = name=>[0xa3, ...u32(at(name))];
            /** @param {number} bytes */
            const drop = bytes=>[0x83, 0xc4, bytes];
            return [
                // _splitpath_s(path, drive, 3, dir, 16, name, 16, ext, 8): fits
                ...pushValue(8), ...push('ext'), ...pushValue(16), ...push('name'),
                ...pushValue(16), ...push('dir'), ...pushValue(3), ...push('drive'),
                ...push('path'), ...call('_splitpath_s'), ...drop(36), ...storeEax('split'),
                // _wsplitpath_s(path, drive, 3, dir, 16, name, 16, ext, 2): ".ext" does not
                ...pushValue(2), ...push('wext'), ...pushValue(16), ...push('wname'),
                ...pushValue(16), ...push('wdir'), ...pushValue(3), ...push('wdrive'),
                ...push('widePath'), ...call('_wsplitpath_s'), ...drop(36), ...storeEax('wsplit'),
                ...pushValue(16), ...push('cwd'), ...call('_wgetcwd'), ...drop(8),
                ...storeEax('cwdAnswer'),
                // _sopen_s(&fd, missing, _O_RDONLY, _SH_DENYNO, 0)
                ...pushValue(0), ...pushValue(0x40), ...pushValue(0), ...push('missing'),
                ...push('fd'), ...call('_sopen_s'), ...drop(20), ...storeEax('opened'),
                // __stdio_common_vswprintf_s(0, buffer, 4, L"%s", 0, {L"hello"})
                0xc7, 0x05, ...u32(at('list')), ...u32(at('hello')), //   mov [list], hello
                ...push('list'), ...pushValue(0), ...push('format'), ...pushValue(4),
                ...push('printBuffer'), ...pushValue(0), ...pushValue(0),
                ...call('__stdio_common_vswprintf_s'), ...drop(28), ...storeEax('printed'),
                ...push('number'), ...call('_wtof'), ...drop(4),
                0xdd, 0x1d, ...u32(at('tofloat')), //                   fstp qword [tofloat]
                ...push('console'), ...call('_cputs'), ...drop(4), ...storeEax('cputs'),
                0x6a, 0x00, ...call('ExitProcess'),
            ];
        },
    });
    await answers(executable, where, '"C:\\paths.exe"', got=>{
        assert.equal(got.u32('split'), 0, '_splitpath_s answers 0');
        assert.deepEqual(['drive', 'dir', 'name', 'ext'].map(name=>got.textAt(where[name])),
            ['C:', '\\dir\\', 'name', '.ext'], 'and the four parts');
        assert.equal(got.u32('wsplit'), 34, '_wsplitpath_s: a part too long is ERANGE');
        assert.deepEqual(['wdrive', 'wdir', 'wname', 'wext'].map(name=>got.wideAt(where[name])),
            ['', '', '', ''], 'and every buffer left empty');
        assert.equal(got.u32('cwdAnswer'), where.cwd, '_wgetcwd answers its buffer');
        assert.match(got.wideAt(where.cwd), /^[A-Z]:\\/, 'holding the current directory');
        assert.equal(got.u32('opened'), 2, '_sopen_s of no file: ENOENT');
        assert.equal(got.u32('fd') | 0, -1, 'and -1 for the descriptor');
        assert.equal(got.u32('printed') | 0, -1, 'a wide print that does not fit is -1');
        assert.equal(got.wideAt(where.printBuffer), '', 'its buffer emptied');
        assert.equal(got.f64('tofloat'), 2.5, '_wtof');
        assert.equal(got.u32('cputs'), 0, '_cputs');
    });
});
