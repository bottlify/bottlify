/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { createEnvironmentFunctions } from './environment.js';
import { STATUS } from './status.js';

const NAME = 0x100;
const VALUE = 0x110;
const TEXT = 0x200;
const OUT = 0x400;
const WHERE = 0x500;

/** Guest memory, a bump heap, and a kernel32 store of variables. */
function machine(){
    const bytes = new Uint8Array(0x8000);
    const view = new DataView(bytes.buffer);
    let next = 0x2000;
    /** @type {Map<string, string>} */
    const store = new Map([['Path', 'C:\\WINDOWS'], ['TEMP', 'C:\\TEMP']]);
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
        view.setUint16(at + text.length * 2, 0, true);
    };
    /** @param {number} at */
    const getWide = at=>{
        let text = '';
        for (let code; (code = view.getUint16(at, true)) !== 0; at += 2)
        {
            text += String.fromCharCode(code);
        }
        return text;
    };
    const allocate = (/** @type {number} */ size)=>{
        const at = next;
        next += size + 8;
        return at;
    };
    const kernel32 = {
        GetEnvironmentStringsW: { handler: ()=>{
            const at = allocate(0x400);
            putWide(at, `${[...store].map(([k, v])=>`${k}=${v}`).join('\0')}\0`);
            return at;
        } },
        FreeEnvironmentStringsW: { handler: ()=>1 },
        SetEnvironmentVariableW: { handler: (/** @type {number[]} */ [name, value])=>{
            if (value === 0)
            {
                store.delete(getWide(name));
            }
            else
            {
                store.set(getWide(name), getWide(value));
            }
            return 1;
        } },
    };
    const table = createEnvironmentFunctions({
        guest: guestOver(bytes),
        kernel32, allocate, free: ()=>true,
    });
    /** A UNICODE_STRING at `at` over text at `buffer`, with room. */
    /**
     * @param {number} at @param {number} buffer @param {string} text
     * @param {number} [room]
     */
    const counted = (at, buffer, text, room = 0x40)=>{
        putWide(buffer, text);
        view.setUint16(at, text.length * 2, true);
        view.setUint16(at + 2, room, true);
        view.setUint32(at + 4, buffer, true);
    };
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>table[name].handler(args);
    return { view, store, call, counted, getWide, putWide };
}

test('a variable of the process, its name in any case, and one too long for the buffer', ()=>{
    const { view, call, counted, getWide } = machine();
    counted(NAME, TEXT, 'PATH');
    counted(VALUE, OUT, '', 0x40);
    assert.equal(call('RtlQueryEnvironmentVariable_U', 0, NAME, VALUE), STATUS.SUCCESS);
    assert.equal(getWide(OUT), 'C:\\WINDOWS');
    assert.equal(view.getUint16(VALUE, true), 20);
    view.setUint16(VALUE + 2, 4, true);
    assert.equal(call('RtlQueryEnvironmentVariable_U', 0, NAME, VALUE), STATUS.BUFFER_TOO_SMALL);
    assert.equal(view.getUint16(VALUE, true), 20, 'the length it needs');
    counted(NAME, TEXT, 'NOPE');
    assert.equal(call('RtlQueryEnvironmentVariable_U', 0, NAME, VALUE), 0xc0000100);
});

test('a block of its own: set into it, query it, expand against it', ()=>{
    const { view, call, counted, getWide, store } = machine();
    assert.equal(call('RtlCreateEnvironment', 0, WHERE), STATUS.SUCCESS);
    counted(NAME, TEXT, 'foo');
    counted(VALUE, TEXT + 0x20, 'bar');
    assert.equal(call('RtlSetEnvironmentVariable', WHERE, NAME, VALUE), STATUS.SUCCESS);
    const block = view.getUint32(WHERE, true);
    assert.equal(getWide(block), 'foo=bar');
    assert.equal(store.has('foo'), false, 'the process\'s store is untouched');
    counted(NAME, TEXT, 'x%FOO%y%none%');
    counted(VALUE, OUT, '', 0x40);
    assert.equal(call('RtlExpandEnvironmentStrings_U', block, NAME, VALUE, WHERE + 8),
        STATUS.SUCCESS);
    assert.equal(getWide(OUT), 'xbary%none%');
    assert.equal(view.getUint32(WHERE + 8, true), 24, 'bytes with the terminator');
    counted(NAME, TEXT, 'a=b');
    assert.equal(call('RtlSetEnvironmentVariable', WHERE, NAME, VALUE), STATUS.INVALID_PARAMETER);
});

test('a block made the process\'s replaces every variable, and the old ones come back', ()=>{
    const { view, call, putWide, store } = machine();
    putWide(TEXT, 'ONE=1\0TWO=2\0');
    assert.equal(call('RtlSetCurrentEnvironment', TEXT, WHERE), STATUS.SUCCESS);
    assert.deepEqual([...store], [['ONE', '1'], ['TWO', '2']]);
    assert.notEqual(view.getUint32(WHERE, true), 0, 'the old block handed back');
    assert.equal(call('RtlSetCurrentEnvironment', 0, 0), STATUS.SUCCESS);
    assert.equal(store.size, 0, 'no block, no variables');
});

test('an expansion that does not fit is written as far as it goes, and stops there', ()=>{
    const { view, call, putWide, getWide } = machine();
    // TEMP is C:\TEMP: seven characters.
    /** @param {string} source @param {number} count */
    const expanded = (source, count)=>{
        putWide(TEXT, source);
        putWide(OUT, 'abcdefghijklmnopqrstuv');
        const status = call('RtlExpandEnvironmentStrings', 0, TEXT, source.length, OUT, count,
            WHERE);
        return { status, text: getWide(OUT), length: view.getUint32(WHERE, true) };
    };
    assert.deepEqual(expanded('Long value', 3),
        { status: STATUS.BUFFER_TOO_SMALL, text: 'Locdefghijklmnopqrstuv', length: 11 },
        'text: one place kept for a terminator, none written');
    assert.equal(expanded('%TEMP% x', 4).text, '', 'a value that does not fit: a terminator alone');
    assert.equal(expanded('%TEMP% x', 8).text, 'C:\\TEMP', 'a value that fits: terminated');
    assert.equal(expanded('%TEMP% x', 9).text, 'C:\\TEMP ijklmnopqrstuv',
        'text after it written over the terminator, none of its own');
    assert.equal(expanded('%TEMP% %TEMP%', 12).text, 'C:\\TEMP ',
        'a second value that does not fit ends the writing');
    assert.deepEqual(expanded('%TEMP% x', 10), { status: STATUS.SUCCESS, text: 'C:\\TEMP x',
        length: 10 });
    assert.equal(expanded('%NONE% x', 2).text, '%bcdefghijklmnopqrstuv', 'no variable: text');
});
