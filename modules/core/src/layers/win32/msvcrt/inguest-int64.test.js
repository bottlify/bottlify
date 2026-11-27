/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msvcrt's 64-bit integer conversions in the guest against their x86 and
 * x86-64, and the JavaScript against the host's handlers they stand for:
 * _strtoi64, _strtoui64, _atoi64, _i64toa, _ui64toa, _i64tow and _ui64tow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPILED } from './inguest-int64.x86.js';
import { COMPILED as LONG } from './inguest-int64.x64.js';
import * as sources from './inguest-int64.js';
import { createConversionFunctions } from './convert.js';
import { guestThrough } from './guest-window.fixture.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { DATA, DATA_END, equivalence, random } from
    '../../../../scripts/guest-code/equivalence.mjs';

const { same } = equivalence(COMPILED, sources, undefined, LONG);

/**
 * The conversion handlers over a case's memory, their i64 answer whole: EAX
 * and the EDX the handler set.
 */
function handlers(){
    /** @type {Uint8Array} */
    let memory = new Uint8Array(0);
    let edx = 0;
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        createConversionFunctions({
            // Over whichever case's memory is the current one; a string read
            // as the engine's memory reads it, its terminator within reach.
            guest: { ...guestThrough((address, length)=>memory.slice(address, address + length),
                (address, bytes)=>memory.set(bytes, address)),
            cstr: (address, limit = 0)=>{
                const end = memory.indexOf(0, address);
                if (end === -1 || end - address >= limit)
                {
                    throw new Error(`No NUL within ${limit} bytes`);
                }
                return decodeAnsi(memory.subarray(address, end));
            } },
            allocate: ()=>{
                throw new Error('nothing here allocates');
            },
            errno: code=>void errno.push(code),
            setRegisters: values=>{
                edx = values.edx >>> 0;
            },
        }));
    /**
     * A handler as the stand-in of a function handing calls to it: an i64's
     * answer a bigint, a pointer's a number.
     *
     * @param {string} name @param {(args: number[]) => number[]} [args]  the handler's own
     *     arguments, where the stand-in's differ (`_atoi64` by `_strtoi64`'s)
     */
    const host = (name, args = list=>list)=>(
        /** @type {Uint8Array} */ at, /** @type {number[]} */ given)=>
    {
        memory = at;
        edx = 0;
        const eax = table[name].handler(args(given)) >>> 0;
        return name.startsWith('_strto')
            ? BigInt.asIntN(64, BigInt(edx) << 32n | BigInt(eax)) : eax;
    };
    return { host, errno };
}

/** A text's bytes. @param {string} text */
const bytesOf = text=>[...text].map(c=>c.charCodeAt(0) & 0xff);

/** An i64's two stack words. @param {bigint} value */
const words = value=>[Number(BigInt.asUintN(32, value)),
    Number(BigInt.asUintN(32, BigInt.asUintN(64, value) >> 32n))];

const TEXTS = ['', ' ', '0', '-0', '+0', '42', '  -42', '\t\n\v\f\r 42', '+', '-', '- 5', '007',
    '08', '0x', '0X1f', '0x1F', '-0x', '0xg', '12abc', 'zz', '2147483647', '2147483648',
    '4294967295', '4294967296', '-4294967296', '9223372036854775807', '9223372036854775808',
    '-9223372036854775808', '-9223372036854775809', '18446744073709551615',
    '18446744073709551616', '-18446744073709551615', '99999999999999999999',
    '0x7fffffffffffffff', '0x8000000000000000', '0xffffffffffffffff', '0x10000000000000000',
    '1777777777777777777777', '2000000000000000000000', '0000000000000000000000000001',
    '3w5e11264sgsf', '3w5e11264sgsg', '1y2p0ij32e8e7', '1z141z4', '-1', '\u0085 42',
    ' 42', '12345678901234567890', '-12345678901234567890', '1311768467463790320'];

test('_strtoi64 and _strtoui64: signs, prefixes, bases, the end pointer, the host at the limits',
    ()=>{
        const next = random(64);
        const { host, errno } = handlers();
        const texts = [...TEXTS];
        const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFXYZ .+-';
        for (let i = 0; i < 80; i++)
        {
            const digits = Array.from({ length: next() % 24 },
                ()=>alphabet[next() % alphabet.length]).join('');
            texts.push(`${' '.repeat(next() % 3)}${['', '-', '+'][next() % 3]}${
                ['', '', '0', '0x'][next() % 4]}${digits}`);
        }
        const others = [2, 8, 36, 2 + next() % 35];
        const refused = [1, 37, 0xffffffff, 0x80000000];
        let handed = 0;
        for (const [i, text] of texts.entries())
        {
            const bytes = bytesOf(text);
            for (const base of [0, 10, 16, others[i % others.length], refused[i % refused.length]])
            {
                for (const name of ['_strtoi64', '_strtoui64'])
                {
                    const end = base === 10 ? 0 : DATA + 0x800;
                    /** @type {import('../../../../scripts/guest-code/equivalence.mjs').Case} */
                    const input = { stack: [DATA, end, base], memory: [[DATA, [...bytes, 0]]] };
                    const js = same(name, input, { host: host(name) });
                    handed += js.handedOver ? 1 : 0;
                    const memory = new Uint8Array(1 << 20);
                    memory.set([...bytes, 0], DATA);
                    const answer = /** @type {bigint} */ (host(name)(memory, [DATA, end, base]));
                    const what = `${name}(${JSON.stringify(text)}, ${base | 0})`;
                    assert.deepEqual([js.eax, js.edx >>> 0], words(answer),
                        `${what}: the handler's answer`);
                    assert.deepEqual(js.data, memory.slice(DATA, DATA_END),
                        `${what}: the handler's end pointer`);
                }
            }
        }
        assert.ok(handed > 0, 'some calls handed to the host');
        assert.ok(errno.length > 0, 'the host set errno for what it clamped');
    });

test('_atoi64: white space, a sign, decimal digits, and the host past 64 bits', ()=>{
    const { host } = handlers();
    // _atoi64 clamps as _strtoi64 does, base ten and no end pointer.
    const stand = host('_strtoi64', ([text])=>[text, 0, 10]);
    let handed = 0;
    for (const text of [...TEXTS, '123 456', '9'.repeat(30), '-'.concat('9'.repeat(19))])
    {
        const bytes = bytesOf(text);
        const js = same('_atoi64', { stack: [DATA], memory: [[DATA, [...bytes, 0]]] },
            { host: stand });
        handed += js.handedOver ? 1 : 0;
        const memory = new Uint8Array(1 << 20);
        memory.set([...bytes, 0], DATA);
        assert.deepEqual([js.eax, js.edx >>> 0], words(/** @type {bigint} */ (stand(memory, [DATA]))),
            `_atoi64(${JSON.stringify(text)})`);
    }
    assert.ok(handed > 0, 'a value past 64 bits handed to the host');
});

test('_i64toa, _ui64toa and the wide forms: ten signed, the powers of two by bits, any other '
    + 'radix the host\'s', ()=>{
    const next = random(65);
    const { host } = handlers();
    const values = [0n, 1n, -1n, 9n, 10n, 0xffffffffn, 0x100000000n, -0x100000000n,
        2n ** 63n - 1n, -(2n ** 63n), 10n ** 19n, 10n ** 19n - 1n, 18446744073709551615n,
        0x123456789abcdefn, -987654321987654321n, 1311768467463790320n];
    for (let i = 0; i < 60; i++)
    {
        values.push(BigInt.asIntN(64, BigInt(next()) << 32n | BigInt(next())));
    }
    for (const value of values)
    {
        for (const radix of [10, 2, 4, 8, 16, 32, 3, 36, 1, 37])
        {
            for (const name of ['_i64toa', '_ui64toa', '_i64tow', '_ui64tow'])
            {
                const stack = [...words(value), DATA, radix];
                const js = same(name, { stack }, { host: host(name) });
                const memory = new Uint8Array(1 << 20);
                const eax = /** @type {number} */ (host(name)(memory, stack));
                const what = `${name}(${value}, ${radix})`;
                assert.equal(js.eax, eax, `${what}: the handler's answer`);
                assert.deepEqual(js.data, memory.slice(DATA, DATA_END), `${what}: its text`);
            }
        }
    }
});

test('every function has x86-64 code, none refused at 64 bits', ()=>{
    assert.deepEqual(Object.keys(COMPILED).filter(name=>!Object.hasOwn(LONG, name)), []);
});
