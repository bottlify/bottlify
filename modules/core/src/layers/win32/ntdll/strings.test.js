/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTED_STRING, createCountedStringFunctions } from './strings.js';
import { STATUS } from './status.js';

/** Where each test puts its descriptors and its characters. */
const DESTINATION = 0x10;
const SOURCE_STRING = 0x20;
const TEXT = 0x100;
const BUFFER = 0x200;

function fakeHost(){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const released = [];
    let next = 0x800;

    return {
        bytes,
        view,
        released,
        // A view onto the memory rather than a copy, which is what the memory
        // layer really hands back and what a descriptor read has to survive.
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address */
        readCString: address=>{
            let text = '';
            for (let at = address; bytes[at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[at]);
            }
            return text;
        },
        /** @param {number} address */
        readWideString: address=>{
            let text = '';
            for (let at = address; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        /** @param {number} size */
        allocate: size=>{
            const at = next;
            next += size + 7 & ~7;
            return at;
        },
        /** @param {number} address */
        free: address=>{
            released.push(address);
            return true;
        },
    };
}

/** @param {ReturnType<typeof fakeHost>} host @param {number} at @param {string} text */
function putAnsi(host, at, text){
    for (let index = 0; index < text.length; index++)
    {
        host.bytes[at + index] = text.charCodeAt(index);
    }
    host.bytes[at + text.length] = 0;
}

/** @param {ReturnType<typeof fakeHost>} host @param {number} at @param {string} text */
function putWide(host, at, text){
    for (let index = 0; index < text.length; index++)
    {
        host.view.setUint16(at + index * 2, text.charCodeAt(index), true);
    }
    host.view.setUint16(at + text.length * 2, 0, true);
}

/** @param {ReturnType<typeof fakeHost>} host @param {number} at */
function descriptorAt(host, at){
    return {
        length: host.view.getUint16(at + COUNTED_STRING.LENGTH, true),
        maximumLength: host.view.getUint16(at + COUNTED_STRING.MAXIMUM_LENGTH, true),
        buffer: host.view.getUint32(at + COUNTED_STRING.BUFFER, true),
    };
}

/**
 * @param {ReturnType<typeof fakeHost>} host @param {number} at
 * @param {{ length: number, maximumLength: number, buffer: number }} string
 */
function putDescriptor(host, at, string){
    host.view.setUint16(at + COUNTED_STRING.LENGTH, string.length, true);
    host.view.setUint16(at + COUNTED_STRING.MAXIMUM_LENGTH, string.maximumLength, true);
    host.view.setUint32(at + COUNTED_STRING.BUFFER, string.buffer, true);
}

test('a counted string is eight bytes, laid out the way the process block is', ()=>{
    // The process parameter block writes these fields at these offsets, and a
    // program reads both with the same code. A second opinion about the layout
    // here would surface as a length read out of the wrong half of a word.
    assert.deepEqual(COUNTED_STRING, {
        LENGTH: 0, MAXIMUM_LENGTH: 2, BUFFER: 4, SIZE: 8,
    });
});

test('RtlInitAnsiString counts the characters and reserves room for the terminator', ()=>{
    // Length excludes the terminator and MaximumLength includes it. That
    // asymmetry is how a caller tells a full buffer from one with room left, and
    // getting it wrong shows up as a string one byte short every time it is used.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putAnsi(host, TEXT, 'C:\\WINDOWS');

    fns.RtlInitAnsiString.handler([DESTINATION, TEXT]);

    assert.deepEqual(descriptorAt(host, DESTINATION),
        { length: 10, maximumLength: 11, buffer: TEXT });
});

test('a NULL source leaves no room rather than room for a terminator', ()=>{
    // There is no buffer, so there is nothing to reserve. A MaximumLength of one
    // would tell a later conversion it may write a byte through a null pointer.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);

    fns.RtlInitAnsiString.handler([DESTINATION, 0]);

    assert.deepEqual(descriptorAt(host, DESTINATION),
        { length: 0, maximumLength: 0, buffer: 0 });
});

test('RtlInitUnicodeString measures in bytes, not characters', ()=>{
    // Both lengths are byte counts even for the wide string. Counting characters
    // here is the single most common way to be wrong by a factor of two, and it
    // truncates every wide string in the program at its midpoint.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putWide(host, TEXT, 'abcd');

    fns.RtlInitUnicodeString.handler([DESTINATION, TEXT]);

    assert.deepEqual(descriptorAt(host, DESTINATION),
        { length: 8, maximumLength: 10, buffer: TEXT });
});

test('widening into a caller-supplied buffer needs room for the terminator too', ()=>{
    // A buffer sized for the characters alone is refused rather than filled: the
    // caller would read one character past the end of what it owns.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putAnsi(host, TEXT, 'abc');
    putDescriptor(host, SOURCE_STRING, { length: 3, maximumLength: 4, buffer: TEXT });
    putDescriptor(host, DESTINATION, { length: 0, maximumLength: 6, buffer: BUFFER });

    assert.equal(fns.RtlAnsiStringToUnicodeString.handler([DESTINATION, SOURCE_STRING, 0]),
        STATUS.BUFFER_OVERFLOW);
    assert.equal(host.view.getUint16(BUFFER, true), 0, 'and nothing was written');

    putDescriptor(host, DESTINATION, { length: 0, maximumLength: 8, buffer: BUFFER });
    assert.equal(fns.RtlAnsiStringToUnicodeString.handler([DESTINATION, SOURCE_STRING, 0]),
        STATUS.SUCCESS);
    assert.deepEqual(descriptorAt(host, DESTINATION),
        { length: 6, maximumLength: 8, buffer: BUFFER });
    assert.equal(host.readWideString(BUFFER), 'abc');
});

test('the allocate flag is one byte of the argument slot, not four', ()=>{
    // BOOLEAN is a byte pushed into a four-byte slot, and the bytes above it are
    // whatever the caller's register held. Testing the whole word would allocate
    // for a caller that asked for no such thing and leak the block.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putAnsi(host, TEXT, 'abc');
    putDescriptor(host, SOURCE_STRING, { length: 3, maximumLength: 4, buffer: TEXT });
    putDescriptor(host, DESTINATION, { length: 0, maximumLength: 8, buffer: BUFFER });

    assert.equal(fns.RtlAnsiStringToUnicodeString.handler(
        [DESTINATION, SOURCE_STRING, 0xdead00]), STATUS.SUCCESS);
    assert.equal(descriptorAt(host, DESTINATION).buffer, BUFFER,
        'a zero low byte is FALSE however the rest of the slot looks');
});

test('asking for the buffer gets one from the heap the caller can free', ()=>{
    // It has to come from the process heap: a program frees these with
    // RtlFreeUnicodeString and with RtlFreeHeap interchangeably, and a block from
    // anywhere else belongs to neither.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putAnsi(host, TEXT, 'abc');
    putDescriptor(host, SOURCE_STRING, { length: 3, maximumLength: 4, buffer: TEXT });
    putDescriptor(host, DESTINATION, { length: 0, maximumLength: 0, buffer: 0 });

    assert.equal(fns.RtlAnsiStringToUnicodeString.handler([DESTINATION, SOURCE_STRING, 1]),
        STATUS.SUCCESS);
    const written = descriptorAt(host, DESTINATION);
    assert.notEqual(written.buffer, 0);
    assert.deepEqual({ length: written.length, maximumLength: written.maximumLength },
        { length: 6, maximumLength: 8 });

    fns.RtlFreeUnicodeString.handler([DESTINATION]);
    assert.deepEqual(host.released, [written.buffer]);
});

test('narrowing into a short buffer truncates and terminates rather than refusing', ()=>{
    // The opposite of the widening direction, and deliberately so: a caller that
    // ignores the status still holds a valid string. Refusing here would leave it
    // reading whatever was in the buffer before.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putWide(host, TEXT, 'abcdef');
    putDescriptor(host, SOURCE_STRING, { length: 12, maximumLength: 14, buffer: TEXT });
    putDescriptor(host, DESTINATION, { length: 0, maximumLength: 4, buffer: BUFFER });

    assert.equal(fns.RtlUnicodeStringToAnsiString.handler([DESTINATION, SOURCE_STRING, 0]),
        STATUS.BUFFER_OVERFLOW);
    assert.deepEqual(descriptorAt(host, DESTINATION),
        { length: 3, maximumLength: 4, buffer: BUFFER });
    assert.equal(host.readCString(BUFFER), 'abc');
});

test('an ANSI string is the ANSI page\'s, widened and narrowed', ()=>{
    // The Rtl conversions are the ANSI code page's, as MultiByteToWideChar
    // (CP_ACP) is: 0x80 is the euro sign in Windows-1252, 0x99 the trade mark
    // and 0x97 an em dash, and a character the page lacks narrows to the
    // default character.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    host.bytes.set([0x80, 0x99, 0x97], TEXT);
    putDescriptor(host, SOURCE_STRING, { length: 3, maximumLength: 3, buffer: TEXT });
    putDescriptor(host, DESTINATION, { length: 0, maximumLength: 8, buffer: BUFFER });
    assert.equal(fns.RtlAnsiStringToUnicodeString.handler([DESTINATION, SOURCE_STRING, 0]),
        STATUS.SUCCESS);
    assert.equal(host.readWideString(BUFFER), '€™—');

    putWide(host, TEXT, '€—Ж');
    putDescriptor(host, SOURCE_STRING, { length: 6, maximumLength: 8, buffer: TEXT });
    putDescriptor(host, DESTINATION, { length: 0, maximumLength: 8, buffer: BUFFER });
    assert.equal(fns.RtlUnicodeStringToAnsiString.handler([DESTINATION, SOURCE_STRING, 0]),
        STATUS.SUCCESS);
    assert.deepEqual([...host.bytes.subarray(BUFFER, BUFFER + 4)], [0x80, 0x97, 0x3f, 0]);
});

test('a destination with no room at all is refused before anything is written', ()=>{
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putWide(host, TEXT, 'ab');
    putDescriptor(host, SOURCE_STRING, { length: 4, maximumLength: 6, buffer: TEXT });
    putDescriptor(host, DESTINATION, { length: 0, maximumLength: 0, buffer: BUFFER });
    host.bytes[BUFFER] = 0x55;

    assert.equal(fns.RtlUnicodeStringToAnsiString.handler([DESTINATION, SOURCE_STRING, 0]),
        STATUS.BUFFER_OVERFLOW);
    assert.equal(host.bytes[BUFFER], 0x55, 'not even the terminator fits');
});

test('freeing a string clears the descriptor so a second free frees nothing', ()=>{
    // Double frees happen in cleanup paths that run twice. A cleared descriptor
    // turns the second one into a no-op instead of a release of whatever now
    // occupies that address.
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putDescriptor(host, DESTINATION, { length: 6, maximumLength: 8, buffer: BUFFER });

    fns.RtlFreeAnsiString.handler([DESTINATION]);
    fns.RtlFreeAnsiString.handler([DESTINATION]);

    assert.deepEqual(host.released, [BUFFER]);
    assert.deepEqual(descriptorAt(host, DESTINATION),
        { length: 0, maximumLength: 0, buffer: 0 });
});

test('RtlFreeOemString frees an OEM_STRING as RtlFreeAnsiString frees its twin', ()=>{
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putDescriptor(host, DESTINATION, { length: 6, maximumLength: 8, buffer: BUFFER });
    assert.equal(fns.RtlFreeOemString.argBytes, 4);
    fns.RtlFreeOemString.handler([DESTINATION]);
    assert.deepEqual(host.released, [BUFFER]);
    assert.deepEqual(descriptorAt(host, DESTINATION), { length: 0, maximumLength: 0, buffer: 0 });
});

test('argument sizes match what the guest compiled against', ()=>{
    const fns = createCountedStringFunctions(fakeHost());

    assert.equal(fns.RtlInitAnsiString.argBytes, 8);
    assert.equal(fns.RtlInitString.argBytes, 8);
    assert.equal(fns.RtlInitUnicodeString.argBytes, 8);
    assert.equal(fns.RtlAnsiStringToUnicodeString.argBytes, 12);
    assert.equal(fns.RtlUnicodeStringToAnsiString.argBytes, 12);
    assert.equal(fns.RtlFreeAnsiString.argBytes, 4);
    assert.equal(fns.RtlFreeUnicodeString.argBytes, 4);
});

test('RtlCreateUnicodeStringFromAsciiz widens into a buffer of its own, for freeing', ()=>{
    const host = fakeHost();
    const fns = createCountedStringFunctions(host);
    putAnsi(host, TEXT, 'testlib.dll');
    assert.equal(fns.RtlCreateUnicodeStringFromAsciiz.argBytes, 8);
    assert.equal(fns.RtlCreateUnicodeStringFromAsciiz.handler([DESTINATION, TEXT]), 1);
    const made = descriptorAt(host, DESTINATION);
    assert.deepEqual({ ...made, buffer: 0 }, { length: 22, maximumLength: 24, buffer: 0 });
    assert.equal(host.readWideString(made.buffer), 'testlib.dll');
    assert.equal(fns.RtlFreeUnicodeString.handler([DESTINATION]), 0);
    assert.deepEqual(host.released, [made.buffer]);
});
