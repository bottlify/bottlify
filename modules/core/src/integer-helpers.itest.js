/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * kernel32's MulDiv and ntdll's 64-bit helpers through the import, as a
 * compiled program calls them, on cork and on the emulator: each call's
 * EAX, EDX, ECX and EBX written to the console and held to the arithmetic
 * in BigInts -- the stack each leaves checked by the program going on --
 * and none of them crossing into the host.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** @param {bigint} value */
const halves = value=>[Number(BigInt.asUintN(64, value) & 0xffffffffn),
    Number(BigInt.asUintN(64, value) >> 32n)];

/**
 * @typedef {Object} Call
 * @property {string} dll
 * @property {string} name
 * @property {number[]} [stack]  Dwords pushed, the first last.
 * @property {{ eax: number, edx: number, cl: number }} [registers]  A shift's operand and count.
 * @property {(r: { eax: number, edx: number, ecx: number, ebx: number }) => void} check
 */

/** @param {number} low @param {number} high */
const joined = (low, high)=>BigInt(high >>> 0) << 32n | BigInt(low >>> 0);

/**
 * @param {string} name @param {bigint} a @param {bigint} b @param {bigint} expected
 * @returns {Call}
 */
const binary = (name, a, b, expected)=>({
    dll: 'ntdll.dll', name, stack: [...halves(a), ...halves(b)],
    check: r=>assert.equal(joined(r.eax, r.edx), BigInt.asUintN(64, expected),
        `${name}(${a}, ${b})`),
});

/** @type {Call[]} */
const CALLS = [
    { dll: 'KERNEL32.dll', name: 'MulDiv', stack: [1000000, 3000, 2000],
        check: r=>assert.equal(r.eax | 0, 1500000) },
    { dll: 'KERNEL32.dll', name: 'MulDiv', stack: [-7, 3, 2],
        check: r=>assert.equal(r.eax | 0, -11, 'a half rounds away from zero') },
    { dll: 'KERNEL32.dll', name: 'MulDiv', stack: [1, 1, 0],
        check: r=>assert.equal(r.eax | 0, -1, 'no divisor') },
    { dll: 'KERNEL32.dll', name: 'MulDiv', stack: [0x7fffffff, 3, 2],
        check: r=>assert.equal(r.eax | 0, -1, 'past 2^31 - 1') },
    binary('_allmul', 0x123456789n, -0x98765n, 0x123456789n * -0x98765n),
    binary('_alldiv', -0x7123456789abcdefn, 1000n, -0x7123456789abcdefn / 1000n),
    binary('_alldiv', 0x7123456789abcdefn, -0x123456789n, 0x7123456789abcdefn / -0x123456789n),
    binary('_allrem', -0x7123456789abcdefn, 0x123456789n, -0x7123456789abcdefn % 0x123456789n),
    binary('_aulldiv', 0xfedcba9876543210n, 0x100000001n, 0xfedcba9876543210n / 0x100000001n),
    binary('_aullrem', 0xfedcba9876543210n, 7n, 0xfedcba9876543210n % 7n),
    { dll: 'ntdll.dll', name: '_alldvrm', stack: [...halves(-1000000000007n), ...halves(-3n)],
        check: r=>{
            assert.equal(joined(r.eax, r.edx), BigInt.asUintN(64, -1000000000007n / -3n));
            assert.equal(joined(r.ecx, r.ebx), BigInt.asUintN(64, -1000000000007n % -3n),
                'the remainder in EBX:ECX');
        } },
    { dll: 'ntdll.dll', name: '_aulldvrm', stack: [...halves(0xffffffffffffffffn),
        ...halves(0x1234567890n)],
    check: r=>{
        assert.equal(joined(r.eax, r.edx), 0xffffffffffffffffn / 0x1234567890n);
        assert.equal(joined(r.ecx, r.ebx), 0xffffffffffffffffn % 0x1234567890n);
    } },
    { dll: 'ntdll.dll', name: '_allshl', registers: { eax: 0x89abcdef, edx: 0x01234567, cl: 36 },
        check: r=>assert.equal(joined(r.eax, r.edx), 0x0123456789abcdefn << 36n
            & 0xffffffffffffffffn) },
    { dll: 'ntdll.dll', name: '_allshr', registers: { eax: 0, edx: 0x80000000, cl: 70 },
        check: r=>assert.equal(joined(r.eax, r.edx), 0xffffffffffffffffn,
            'past 63 the sign alone') },
    { dll: 'ntdll.dll', name: '_aullshr', registers: { eax: 0x89abcdef, edx: 0x81234567, cl: 5 },
        check: r=>assert.equal(joined(r.eax, r.edx), 0x8123456789abcdefn >> 5n) },
];

/** Each call, its four registers stored after it; then all of them written out as hex. */
function buildHelpersExe(){
    /** @type {Record<string, string[]>} */
    const imports = { 'KERNEL32.dll': ['ExitProcess', 'GetStdHandle', 'WriteFile'] };
    for (const { dll, name } of CALLS)
    {
        imports[dll] = [...new Set([...imports[dll] ?? [], name])];
    }
    const bytes = CALLS.length * 16;
    /** @type {Record<string, number[]>} */
    const data = {
        results: new Array(bytes).fill(0),
        hex: new Array(bytes * 2).fill(0),
        digits: [...'0123456789abcdef'].map(c=>c.charCodeAt(0)),
        written: [0, 0, 0, 0],
    };
    return buildExe({
        imports,
        data,
        codeSize: 0x1000,
        code: ({ iat, at })=>{
            /** @type {number[]} */
            const code = [];
            CALLS.forEach(({ name, stack = [], registers }, i)=>{
                for (const word of [...stack].reverse())
                {
                    code.push(0x68, ...u32(word >>> 0));
                }
                if (registers)
                {
                    code.push(0xb8, ...u32(registers.eax), 0xba, ...u32(registers.edx),
                        0xb1, registers.cl);                         // mov eax; mov edx; mov cl
                }
                code.push(0xff, 0x15, ...u32(iat(name)));
                const slot = at('results') + i * 16;
                code.push(0xa3, ...u32(slot), 0x89, 0x15, ...u32(slot + 4),
                    0x89, 0x0d, ...u32(slot + 8), 0x89, 0x1d, ...u32(slot + 12));
            });
            const byte = [
                0x0f, 0xb6, 0x06, 0x89, 0xc2, 0xc1, 0xe8, 0x04, 0x83, 0xe2, 0x0f,
                0x8a, 0x80, ...u32(at('digits')), 0x88, 0x07,
                0x8a, 0x92, ...u32(at('digits')), 0x88, 0x57, 0x01,
                0x46, 0x83, 0xc7, 0x02, 0x49,
            ];
            code.push(0xbe, ...u32(at('results')), 0xbf, ...u32(at('hex')), 0xb9, ...u32(bytes),
                ...byte, 0x75, 0x100 - byte.length - 2,
                0x6a, 0x00, 0x68, ...u32(at('written')), 0x68, ...u32(bytes * 2),
                0x68, ...u32(at('hex')), 0x6a, 0xf5, 0xff, 0x15, ...u32(iat('GetStdHandle')), 0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')));
            return code;
        },
    });
}

/** @param {'cork' | 'emulator'} engine */
async function run(engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable: buildHelpersExe(),
        engine,
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    /** @type {string[]} */
    const output = [];
    app.on('output', (/** @type {any} */ payload)=>output.push(payload.text));
    try
    {
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, 'the program exits 0');
        const bridge = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge');
        const text = output.join('');
        const view = new DataView(Uint8Array.from({ length: text.length >> 1 },
            (_, i)=>parseInt(text.slice(i * 2, i * 2 + 2), 16)).buffer);
        return {
            registers: CALLS.map((_, i)=>({ eax: view.getUint32(i * 16, true),
                edx: view.getUint32(i * 16 + 4, true), ecx: view.getUint32(i * 16 + 8, true),
                ebx: view.getUint32(i * 16 + 12, true) })),
            crossed: new Map(/** @type {[string, number][]} */ (bridge?.metrics?.hot ?? [])),
        };
    }
    finally
    {
        await app.dispose();
    }
}

for (const engine of /** @type {const} */ (['cork', 'emulator']))
{
    test(`MulDiv and the 64-bit helpers through the import, under ${engine}`,
        { timeout: 120000 }, async()=>{
            const { registers, crossed } = await run(engine);
            CALLS.forEach((call, i)=>call.check(registers[i]));
            for (const { dll, name } of CALLS)
            {
                assert.equal(crossed.get(`${dll}!${name}`) ?? 0, 0, `${name} stays in the guest`);
            }
        });
}
