/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUcrtbaseFunctions } from './ucrtbase.js';
import { moduleKeyOf } from '../../../app.js';

const STANDARD_SNPRINTF_BEHAVIOR = 0x2;
const LEGACY_VSPRINTF_NULL_TERMINATION = 0x1;
const ERRNO = 0x100;
const FMODE = 0x104;
const IOB = 0x1000;

/**
 * The universal runtime over a stand-in for the 2005 runtime's table: the
 * formatter prints the text kept at the format's address, and the heap hands
 * out blocks from a counter, so what is checked is the runtime's own part.
 *
 * @param {Record<number, string>} [texts]  the text each format address prints
 */
function setup(texts = {}){
    const memory = new Uint8Array(0x10000);
    /** @type {any[]} */
    const called = [];
    let next = 0x4000;
    /** @param {number} address */
    const readU32 = address=>new DataView(memory.buffer).getUint32(address, true);
    /** @param {number} buffer @param {string} text */
    const writeText = (buffer, text)=>memory.set([...text].map(c=>c.charCodeAt(0)), buffer);
    /** @type {Record<string, any>} */
    const crt = {
        _errno: { handler: ()=>ERRNO },
        __iob_func: { handler: ()=>IOB },
        __p__fmode: { handler: ()=>FMODE },
        _vscprintf: { handler: (/** @type {number[]} */ [format])=>texts[format].length },
        // msvcrt's: as many characters as fit, terminated only when there is
        // room, -1 when the text does not fit.
        _vsnprintf: {
            /** @param {number[]} args */
            handler: ([buffer, count, format])=>{
                const text = texts[format];
                writeText(buffer, text.slice(0, count));
                if (text.length < count)
                {
                    memory[buffer + text.length] = 0;
                }
                return text.length <= count ? text.length : -1;
            },
        },
        realloc: {
            /** @param {number[]} args */
            handler: ([block, bytes])=>{
                const grown = next;
                next += bytes;
                if (block !== 0)
                {
                    memory.copyWithin(grown, block, block + bytes);
                }
                return grown;
            },
        },
        free: { handler: (/** @type {number[]} */ [block])=>called.push(['free', block]) },
        _invalid_parameter_noinfo: { handler: ()=>called.push('ended') },
        _XcptFilter: { handler: ()=>0 },
        atexit: { handler: ()=>0 },
    };
    const ucrt = createUcrtbaseFunctions(crt, {
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        callGuest: (entry, args)=>{
            called.push(['guest', entry, ...args]);
            return 0;
        },
    });
    /** @param {number} at */
    const textAt = at=>{
        const end = memory.indexOf(0, at);
        return String.fromCharCode(...memory.slice(at, end));
    };
    return { ucrt, memory, called, readU32, textAt };
}

test('the API sets of the universal runtime are ucrtbase, as the schema has them', ()=>{
    assert.equal(moduleKeyOf('api-ms-win-crt-stdio-l1-1-0.dll'), 'ucrtbase');
    assert.equal(moduleKeyOf('API-MS-WIN-CRT-RUNTIME-L1-1-0.DLL'), 'ucrtbase');
    assert.equal(moduleKeyOf('C:\\Windows\\System32\\api-ms-win-crt-math-l1-1-0.dll'), 'ucrtbase');
    assert.equal(moduleKeyOf('ucrtbase.dll'), 'ucrtbase');
    assert.equal(moduleKeyOf('api-ms-win-core-synch-l1-2-0.dll'), 'kernel32',
        'a core set is kernel32\'s (apisets.itest.js)');
});

test('__acrt_iob_func indexes the runtime\'s FILE records', ()=>{
    const { ucrt } = setup();
    assert.deepEqual([0, 1, 2].map(index=>ucrt.__acrt_iob_func.handler([index])),
        [IOB, IOB + 32, IOB + 64]);
});

test('__stdio_common_vsprintf is C99 snprintf or the legacy _vsnprintf, as its options say', ()=>{
    const format = 0x200;
    const buffer = 0x2000;
    const { ucrt, memory, textAt } = setup({ [format]: 'abcdef' });
    const print = (/** @type {number} */ options, /** @type {number} */ to,
        /** @type {number} */ count)=>
        ucrt.__stdio_common_vsprintf.handler([options, 0, to, count, format, 0, 0]);

    assert.equal(print(STANDARD_SNPRINTF_BEHAVIOR, 0, 0), 6, 'no buffer: the length it needs');
    memory.fill(0xff, buffer, buffer + 16);
    assert.equal(print(STANDARD_SNPRINTF_BEHAVIOR, buffer, 4), 6,
        'C99: the length it would have had');
    assert.equal(textAt(buffer), 'abc', 'cut to fit and terminated');

    memory.fill(0xff, buffer, buffer + 16);
    assert.equal(print(0, buffer, 4), -1, 'legacy: -1 when it does not fit');
    assert.deepEqual([...memory.slice(buffer, buffer + 5)], [0x61, 0x62, 0x63, 0x64, 0xff],
        'and no terminator');
    memory.fill(0xff, buffer, buffer + 16);
    assert.equal(print(LEGACY_VSPRINTF_NULL_TERMINATION, buffer, 4), -1);
    assert.equal(textAt(buffer), 'abc', 'unless asked to terminate it after all');

    assert.equal(print(STANDARD_SNPRINTF_BEHAVIOR, buffer, 16), 6);
    assert.equal(textAt(buffer), 'abcdef', 'what fits is the whole text');
});

test('a DLL\'s exit table grows as it is registered to, and runs last first, once', async()=>{
    const { ucrt, called, readU32 } = setup();
    const table = 0x300;
    assert.equal(ucrt._initialize_onexit_table.handler([table]), 0);
    assert.deepEqual([readU32(table), readU32(table + 4), readU32(table + 8)], [0, 0, 0]);
    for (let fn = 1; fn <= 9; fn++)
    {
        assert.equal(ucrt._register_onexit_function.handler([table, 0x7000 + fn]), 0);
    }
    const first = readU32(table);
    assert.equal(readU32(table + 4) - first, 9 * 4, 'nine entries, past the first block of eight');

    assert.equal(await ucrt._execute_onexit_table.handler([table]), 0);
    assert.deepEqual(called.filter(entry=>entry[0] === 'guest').map(entry=>entry[1]),
        [9, 8, 7, 6, 5, 4, 3, 2, 1].map(fn=>0x7000 + fn));
    assert.deepEqual(called.filter(entry=>entry[0] === 'free'), [['free', first]]);
    assert.deepEqual([readU32(table), readU32(table + 4), readU32(table + 8)], [0, 0, 0],
        'emptied, so a second run calls nothing');
    assert.equal(ucrt._register_onexit_function.handler([0, 1]), -1, 'no table');
});

test('an installed invalid-parameter handler is called and the caller goes on', async()=>{
    const { ucrt, called } = setup();
    await ucrt._invalid_parameter_noinfo.handler([]);
    assert.deepEqual(called, ['ended'], 'none installed: the process ends');

    called.length = 0;
    assert.equal(ucrt._set_invalid_parameter_handler.handler([0x5000]), 0);
    assert.equal(ucrt._get_invalid_parameter_handler.handler([]), 0x5000);
    assert.equal(await ucrt._invalid_parameter_noinfo.handler([]), 0);
    assert.deepEqual(called, [['guest', 0x5000, 0, 0, 0, 0, 0]]);
    assert.equal(ucrt._set_invalid_parameter_handler.handler([0]), 0x5000, 'the one before');
});

test('_set_fmode takes the modes there are, and _get_fmode reads the same variable', ()=>{
    const { ucrt, readU32 } = setup();
    assert.equal(ucrt._set_fmode.handler([0x8000]), 0);
    assert.equal(readU32(FMODE), 0x8000);
    const out = 0x400;
    assert.equal(ucrt._get_fmode.handler([out]), 0);
    assert.equal(readU32(out), 0x8000);
    assert.equal(ucrt._set_fmode.handler([0x1234]), 22, 'EINVAL');
    assert.equal(readU32(ERRNO), 22);
    assert.equal(ucrt._get_fmode.handler([0]), 22);
});
