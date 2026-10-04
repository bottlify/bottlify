/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWideFunctions, createMultiByteFunctions } from './mbstring.js';
import { createMsvcrtFunctions } from './functions.js';
import { fakeMemory } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    return {
        memory,
        table: /** @type {Record<string, any>} */ (createWideFunctions(memory)),
    };
};

test('wcslen counts units, not bytes', ()=>{
    const { memory, table } = build();
    assert.equal(table.wcslen.handler([memory.putWide('abcd')]), 4);
});

test('wcscpy and wcscat write terminated wide strings', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    table.wcscpy.handler([destination, memory.putWide('one')]);
    table.wcscat.handler([destination, memory.putWide('two')]);
    assert.equal(memory.wide(destination), 'onetwo');
});

test('_wcsdup copies onto the heap, and duplicates no string to null', ()=>{
    const { memory, table } = build();
    const copy = table._wcsdup.handler([memory.putWide('あb')]);
    assert.equal(memory.wide(copy), 'あb');
    assert.equal(table._wcsdup.handler([0]), 0);
    const without = /** @type {Record<string, any>} */ (createWideFunctions({
        ...memory, allocate: undefined,
    }));
    assert.equal(without._wcsdup, undefined, 'no heap, no export');
});

test('wcsncpy pads to the count and does not terminate when it truncates', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    memory.writeMemory(destination, new Uint8Array(64).fill(0xff));
    table.wcsncpy.handler([destination, memory.putWide('abcdef'), 3]);
    assert.equal(memory.wide(destination, 3), 'abc');
    assert.equal(new DataView(memory.bytes.buffer).getUint16(destination + 6, true), 0xffff,
        'nothing was written past the count');
});

test('wcschr answers a pointer into the caller\'s own string, two bytes per unit', ()=>{
    const { memory, table } = build();
    const string = memory.putWide('abc');
    assert.equal(table.wcschr.handler([string, 'b'.charCodeAt(0)]), string + 2);
    assert.equal(table.wcschr.handler([string, 'z'.charCodeAt(0)]), 0);
    assert.equal(table.wcschr.handler([string, 0]), string + 6, 'the terminator is findable');
});

test('wcsstr and wcsrchr scale their index the same way', ()=>{
    const { memory, table } = build();
    const string = memory.putWide('abcabc');
    assert.equal(table.wcsstr.handler([string, memory.putWide('ca')]), string + 4);
    assert.equal(table.wcsrchr.handler([string, 'a'.charCodeAt(0)]), string + 6);
});

test('a wide string that ends where its region does is read no further than its end', ()=>{
    // The memory layer refuses a read past a region, as it does an image's
    // last page: every wide function reads to the terminator and stops.
    const memory = fakeMemory();
    const end = 0x12000;
    const table = /** @type {Record<string, any>} */ (createWideFunctions({
        ...memory,
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>{
            if (address + length > end)
            {
                throw new RangeError(`read of ${length} bytes at 0x${address.toString(16)} `
                    + 'runs past the end of the region');
            }
            return memory.readMemory(address, length);
        },
    }));
    const put = (/** @type {string} */ text)=>{
        const at = end - (text.length + 1) * 2;
        memory.writeMemory(at, Uint8Array.from([...text, '\0']
            .flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >>> 8])));
        return at;
    };
    const string = put('abcAbc');
    const other = memory.putWide('ABCabd');
    const destination = memory.allocate(64);
    assert.equal(table.wcslen.handler([string]), 6);
    assert.equal(table.wcschr.handler([string, 'c'.charCodeAt(0)]), string + 4);
    assert.equal(table.wcsrchr.handler([string, 'b'.charCodeAt(0)]), string + 8);
    assert.equal(table.wcsstr.handler([string, memory.putWide('cA')]), string + 4);
    assert.equal(table.wcscmp.handler([string, other]), 1);
    assert.equal(table.wcsncmp.handler([string, other, 1]), 1);
    assert.equal(table._wcsicmp.handler([string, other]), -1);
    table.wcscpy.handler([destination, string]);
    table.wcscat.handler([destination, string]);
    assert.equal(memory.wide(destination), 'abcAbcabcAbc');
    table.wcsncpy.handler([destination, string, 3]);
    assert.equal(memory.wide(destination, 3), 'abc');
});

test('the wide comparisons are ordered and case folding is ASCII', ()=>{
    const { memory, table } = build();
    assert.equal(table.wcscmp.handler([memory.putWide('a'), memory.putWide('b')]), -1);
    assert.equal(table.wcsncmp.handler([memory.putWide('abz'), memory.putWide('aby'), 2]), 0);
    assert.equal(table._wcsicmp.handler([memory.putWide('ABC'), memory.putWide('abc')]), 0);
});

test('mbstowcs with a null destination answers the length it would need', ()=>{
    const { memory, table } = build();
    assert.equal(table.mbstowcs.handler([0, memory.put('hello'), 0]), 5);
});

test('mbstowcs terminates only when the terminator fits inside the count', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    memory.writeMemory(destination, new Uint8Array(64).fill(0xff));
    assert.equal(table.mbstowcs.handler([destination, memory.put('hello'), 3]), 3);
    assert.equal(memory.wide(destination, 3), 'hel');
    assert.equal(new DataView(memory.bytes.buffer).getUint16(destination + 6, true), 0xffff,
        'a full buffer comes back unterminated');
});

test('mbstowcs widens a byte to the unit of its value, as mbtowc does and wcstombs undoes', ()=>{
    // The C locale's conversion is one byte to one unit of the same number:
    // 0x80 is U+0080 there, not the euro sign the ANSI page reads it as, so a
    // string and its characters widen alike and narrow back to the same bytes.
    const { memory, table } = build();
    const source = memory.allocate(8);
    memory.writeMemory(source, Uint8Array.of(0x80, 0x99, 0x97, 0));
    const wide = memory.allocate(16);
    assert.equal(table.mbstowcs.handler([wide, source, 8]), 3);
    const units = new DataView(memory.bytes.buffer);
    assert.deepEqual([0, 1, 2, 3].map(at=>units.getUint16(wide + at * 2, true)),
        [0x80, 0x99, 0x97, 0]);
    const unit = memory.allocate(4);
    table.mbtowc.handler([unit, source, 1]);
    assert.equal(units.getUint16(unit, true), units.getUint16(wide, true));
    const narrow = memory.allocate(8);
    assert.equal(table.wcstombs.handler([narrow, wide, 8]), 3);
    assert.deepEqual([...memory.bytes.subarray(narrow, narrow + 4)], [0x80, 0x99, 0x97, 0]);
});

test('wcstombs narrows, and answers the count without a destination', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    assert.equal(table.wcstombs.handler([0, memory.putWide('abc'), 0]), 3);
    table.wcstombs.handler([destination, memory.putWide('abc'), 8]);
    assert.equal(memory.text(destination), 'abc');
});

test('wcstombs terminates only when the null character comes within the count', ()=>{
    // "the multibyte character string at mbstr is null-terminated only if
    // wcstombs encounters a wide-character NULL character during
    // conversion": a string as long as the count, or longer, is not.
    const { memory, table } = build();
    const destination = memory.allocate(16);
    for (const [text, count, answer] of /** @type {[string, number, number][]} */ ([
        ['abc', 3, 3], ['abcdef', 3, 3], ['ab', 3, 2],
    ]))
    {
        memory.writeMemory(destination, new Uint8Array(8).fill(0x7c));
        assert.equal(table.wcstombs.handler([destination, memory.putWide(text), count]), answer);
        assert.deepEqual([...memory.bytes.subarray(destination, destination + 4)],
            [...`${text.slice(0, count)}${text.length < count ? '\0' : ''}`.padEnd(4, '|')]
                .map(character=>character.charCodeAt(0)), `${text} into ${count}`);
    }
});

test('wcstombs refuses a character the C locale has no byte for with -1 and EILSEQ', ()=>{
    // "If wcstombs encounters a wide character it can't convert to a
    // multibyte character, it returns -1 cast to type size_t and sets errno
    // to EILSEQ" -- as wctomb does for the same character.
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (
        createWideFunctions({ ...memory, errno: code=>errno.push(code) }));
    const destination = memory.allocate(16);
    const text = memory.putWide('ab☺');
    assert.equal(table.wcstombs.handler([destination, text, 8]), -1);
    assert.equal(table.wcstombs.handler([0, text, 0]), -1, 'nor can it say how many bytes');
    assert.equal(table.wcstombs.handler([destination, text, 2]), 2, 'the count ends before it');
    assert.equal(table.wcstombs.handler([destination, memory.putWide('caf\xe9'), 8]), 4);
    assert.equal(memory.text(destination), 'caf\xe9');
    const EILSEQ = 42;
    assert.deepEqual(errno, [EILSEQ, EILSEQ]);
});

test('wctomb writes a character to U+00FF as its byte, and refuses one past it with EILSEQ', ()=>{
    // "If the conversion isn't possible in the current locale, wctomb returns
    // -1 and errno is set to EILSEQ." The C locale has a byte for each of the
    // first 256 characters and none past them: Wine's msvcrt
    // test__wcstombs_s_l finds L"\xfffd" EILSEQ there.
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (
        createWideFunctions({ ...memory, errno: code=>errno.push(code) }));
    const out = memory.allocate(4);
    assert.equal(table.wctomb.handler([out, 0xe9]), 1);
    assert.equal(memory.bytes[out], 0xe9);
    assert.equal(table.wctomb.handler([out, 0x263a]), -1);
    assert.equal(table.wctomb.handler([out, 0x100]), -1, 'not its low byte');
    assert.equal(memory.bytes[out], 0xe9, 'nothing written');
    assert.equal(table.wctomb.handler([out, 0]), 1, 'the null character is one byte');
    assert.equal(table.wctomb.handler([0, 0x263a]), 0, 'no encoding here keeps a state');
    const EILSEQ = 42;
    assert.deepEqual(errno, [EILSEQ, EILSEQ]);
});

test('mbtowc reports one byte consumed, and zero at the terminator', ()=>{
    const { memory, table } = build();
    const unit = memory.allocate(4);
    const source = memory.put('x');
    assert.equal(table.mbtowc.handler([unit, source, 4]), 1);
    assert.equal(memory.wide(unit, 1), 'x');
    assert.equal(table.mbtowc.handler([unit, source + 1, 4]), 0);
});

test('the multi-byte names a page cannot change are bound to the byte functions themselves',
    ()=>{
        const memory = fakeMemory();
        const narrow = /** @type {Record<string, any>} */ (createMsvcrtFunctions({
            ...memory,
            write: ()=>{},
            callGuest: async()=>0,
        }));
        const multi = /** @type {Record<string, any>} */ (createMultiByteFunctions(narrow,
            memory));
        assert.equal(multi._mbscpy, narrow.strcpy, 'one implementation, two names');
        assert.equal(multi._mbscat, narrow.strcat);
        assert.equal(multi._ismbcspace, narrow.isspace, 'a classifier, bound the same way');
        assert.equal(multi._ismbcspace.handler([' '.charCodeAt(0)]), 1);
        assert.equal(multi._ismbcspace.handler(['x'.charCodeAt(0)]), 0);
        assert.equal(multi._ismbcdigit, narrow.isdigit);
        assert.notEqual(multi._mbslen, narrow.strlen, 'a length counts characters by the page');
    });

/**
 * The multi-byte family over a fake memory, with the runtime's byte table it
 * binds to and what it told errno.
 */
const multiByte = ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const narrow = /** @type {Record<string, any>} */ (createMsvcrtFunctions({
        ...memory,
        write: ()=>{},
        callGuest: async()=>0,
    }));
    const table = /** @type {Record<string, any>} */ (createMultiByteFunctions(narrow, {
        ...memory,
        errno: code=>void errno.push(code),
    }));
    /** @param {number[]} bytes */
    const put = bytes=>{
        const at = memory.allocate(bytes.length + 16);
        memory.writeMemory(at, Uint8Array.from(bytes));
        return at;
    };
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>table[name].handler(args);
    return { memory, table, errno, put, call };
};

test('under the single-byte page a program starts in, a character is one byte and nothing '
    + 'leads', ()=>{
    const { table, put, call } = multiByte();
    const text = put([0x41, 0xb0, 0xb1, 0x62, 0]);
    assert.equal(call('_getmbcp'), 0);
    assert.equal(call('_mbslen', text), 4);
    assert.equal(call('_mbclen', text + 1), 1);
    assert.equal(call('_ismbblead', 0xb0), 0);
    assert.equal(call('_mbsinc', text + 1), text + 2);
    assert.equal(call('_mbsdec', text, text + 3), text + 2);
    assert.equal(call('_mbsdec', text, text), 0, 'nothing before the start');
    assert.equal(call('_mbschr', text, 0x1b1), text + 2, 'a search takes the low byte');
    const flags = [...table._mbctype.data()];
    assert.deepEqual([flags[0x42], flags[0x64], flags[0x41 + 1], flags[0xb0 + 1]],
        [0x10, 0x20, 0x10, 0], 'the ASCII letters have their case, and nothing leads');
});

test('_setmbcp takes the pages Windows has, by number or selector, and refuses the rest', ()=>{
    const { call, errno } = multiByte();
    assert.equal(call('_setmbcp', 1250), 0);
    assert.equal(call('_getmbcp'), 1250);
    assert.equal(call('_setmbcp', -3), 0, '_MB_CP_ANSI');
    assert.equal(call('_getmbcp'), 1252);
    assert.equal(call('_setmbcp', -2), 0, '_MB_CP_OEM');
    assert.equal(call('_getmbcp'), 437);
    assert.equal(call('_setmbcp', 932), 0);
    assert.deepEqual(errno, []);
    assert.equal(call('_setmbcp', 939), -1, 'an EBCDIC page is not one Windows has');
    assert.deepEqual(errno, [22]);
    assert.equal(call('_getmbcp'), 932, 'the page before it stays');
    assert.equal(call('_setmbcp', 0), 0, '_MB_CP_SBCS');
    assert.equal(call('_getmbcp'), 0);
});

test('_mbctype marks each double-byte page\'s lead and trail bytes, and Shift-JIS\'s katakana',
    ()=>{
        const memory = fakeMemory();
        const at = memory.allocate(257);
        const table = /** @type {Record<string, any>} */ (createMultiByteFunctions({}, {
            ...memory,
            addressOf: name=>(name === '_mbctype' ? at : 0),
        }));
        /** @param {number} byte */
        const flags = byte=>memory.bytes[at + 1 + byte];
        table._setmbcp.handler([932]);
        assert.deepEqual([0x40, 0x41, 0x61, 0x7f, 0x80, 0x81, 0x9f, 0xa0, 0xa1, 0xa6, 0xdf, 0xe0,
            0xfc, 0xfd].map(flags),
        [0x08, 0x18, 0x28, 0, 0x08, 0x0c, 0x0c, 0x08, 0x0a, 0x09, 0x09, 0x0c, 0x0c, 0]);
        assert.equal(memory.bytes[at], 0, 'EOF has no flags');
        table._setmbcp.handler([936]);
        assert.deepEqual([0x3f, 0x40, 0x7f, 0x80, 0x81, 0xfe, 0xff].map(flags),
            [0, 0x08, 0x08, 0x08, 0x0c, 0x0c, 0]);
        table._setmbcp.handler([949]);
        assert.deepEqual([0x40, 0x41, 0x5b, 0x81, 0xfe].map(flags), [0, 0x18, 0x08, 0x0c, 0x0c]);
        table._setmbcp.handler([950]);
        assert.deepEqual([0x40, 0x7e, 0x7f, 0x80, 0x81, 0xa0, 0xa1, 0xfe].map(flags),
            [0x08, 0x08, 0, 0, 0x04, 0x04, 0x0c, 0x0c]);
        table._setmbcp.handler([1361]);
        assert.deepEqual([0x31, 0x81, 0xd3, 0xd7, 0xd8, 0xf9, 0xfa].map(flags),
            [0x08, 0x0c, 0x0c, 0x08, 0x0c, 0x0c, 0x08]);
        table._setmbcp.handler([1252]);
        assert.deepEqual([0x42, 0x64, 0x80, 0x81].map(flags), [0x10, 0x20, 0, 0]);
    });

test('under a double-byte page a lead byte and the byte after it are one character, and a '
    + 'lead byte the terminator follows ends the string', ()=>{
    const { put, call } = multiByte();
    call('_setmbcp', 936);
    // A lead byte whose next byte cannot trail is still a pair.
    const text = put([0xb0, 0xb1, 0xb2, 0x20, 0xb3, 0xb4, 0x20, 0xb5, 0]);
    const valid = put([0xb0, 0xb1, 0xb2, 0xb3, 0x51, 0xb4, 0xb5, 0]);
    const onlyLead = put([0xb0, 0, 0xb1, 0xb2, 0x20, 0xb3, 0]);
    assert.equal(call('_ismbblead', 0x1234b0), 1, 'the low byte is the one asked about');
    assert.equal(call('_ismbbtrail', 0x20), 0);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i=>call('_ismbslead', text, text + i)),
        [-1, 0, -1, 0, -1, 0, 0, -1, 0]);
    assert.deepEqual([0, 1, 2, 5].map(i=>call('_ismbslead', onlyLead, onlyLead + i)),
        [-1, 0, 0, 0]);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i=>call('_ismbstrail', text, text + i)),
        [0, -1, 0, -1, 0, -1, 0, 0, -1]);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i=>call('_mbsbtype', text, i)),
        [1, 2, 1, -1, 1, 2, 0, 1, -1]);
    assert.equal(call('_mbsbtype', 0, 0), -1);
    assert.deepEqual([call('_mbsnextc', text), call('_mbsnextc', text + 2),
        call('_mbsnextc', text + 3)], [0xb0b1, 0xb220, 0x20]);
    assert.deepEqual([call('_mbclen', text), call('_mbclen', text + 3), call('_mbclen', onlyLead)],
        [2, 1, 1]);
    assert.deepEqual([call('_mbslen', valid), call('_mbslen', onlyLead), call('_mbslen', text)],
        [4, 0, 4]);
    assert.equal(call('_mbsinc', text) - text, 2);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 17].map(n=>call('_mbsninc', valid, n) - valid),
        [0, 2, 4, 5, 7, 7, 7]);
    assert.equal(call('_mbsninc', onlyLead, 2), onlyLead);
    assert.equal(call('_mbsdec', text, text + 4), text + 2);
    assert.equal(call('_mbschr', text, 0xb3b4), text + 4);
    assert.equal(call('_mbsrchr', text, 0x20), text + 6);
    assert.equal(call('_mbscmp', text, valid), -1, 'pairs compared as pairs');
});

test('the multi-byte copies count characters or bytes, and cut no pair in two', ()=>{
    const { memory, put, call, errno } = multiByte();
    call('_setmbcp', 936);
    const text = put([0xb0, 0xb1, 0xb2, 0x20, 0xb3, 0xb4, 0x20, 0xb5, 0]);
    const valid = put([0xb0, 0xb1, 0xb2, 0xb3, 0x51, 0xb4, 0xb5, 0]);
    const onlyLead = put([0xb0, 0, 0xb1, 0xb2, 0x20, 0xb3, 0]);
    const buffer = memory.allocate(16);
    /** @param {() => void} run @param {number} length */
    const copied = (run, length)=>{
        memory.bytes.fill(0xff, buffer, buffer + 16);
        run();
        return [...memory.bytes.subarray(buffer, buffer + length)];
    };
    assert.deepEqual(copied(()=>call('_mbccpy', buffer, text), 3), [0xb0, 0xb1, 0xff]);
    assert.deepEqual(copied(()=>call('_mbsncpy', buffer, text, 2), 5),
        [0xb0, 0xb1, 0xb2, 0x20, 0xff]);
    assert.deepEqual(copied(()=>call('_mbsncpy', buffer, text, 5), 10),
        [0xb0, 0xb1, 0xb2, 0x20, 0xb3, 0xb4, 0x20, 0, 0, 0xff],
        'a lead byte left alone is two zeros');
    assert.deepEqual(copied(()=>call('_mbsncpy', buffer, onlyLead, 6), 8),
        [0, 0, 0, 0, 0, 0, 0, 0xff]);
    assert.deepEqual(copied(()=>call('_mbsnbcpy', buffer, valid, 3), 4), [0xb0, 0xb1, 0, 0xff],
        'the pair the count cuts is not begun');
    assert.deepEqual(copied(()=>call('_mbsnbcpy', buffer, onlyLead, 5), 6),
        [0, 0, 0, 0, 0, 0xff]);
    assert.equal(call('_mbsncpy', 0, text, 1), 0);
    assert.equal(call('_mbsncpy', buffer, 0, 1), 0);
    assert.deepEqual(errno, [22, 22]);
    assert.equal(call('_mbsncpy', 0, text, 0), 0, 'no count is the destination as it is');
    assert.equal(call('_mbsncpy', buffer, 0, 0), buffer);
    assert.deepEqual(errno, [22, 22]);
});

test('the multi-byte spans take a pair as one character of the set', ()=>{
    const { memory, put, call } = multiByte();
    const word = put([...'cabernet'].map(c=>c.charCodeAt(0)).concat(0));
    const abc = put([0x61, 0x62, 0x63, 0]);
    assert.equal(call('_mbsspnp', word, abc), word + 3);
    assert.equal(call('_mbsspnp', word, put([...'abcenrt'].map(c=>c.charCodeAt(0)).concat(0))),
        0, 'a string wholly of the set has no rest');
    call('_setmbcp', 932);
    const text = put([0x20, 0x32, 0x30, 0x31, 0x39, 0x94, 0x4e, 0x36, 0x8c, 0x8e, 0x32, 0x39,
        0x93, 0xfa, 0]);
    const digits = put([...'0123456789 '].map(c=>c.charCodeAt(0)).concat(0x94, 0x4e, 0));
    const pairs = put([0x20, 0x94, 0x4e, 0x8c, 0x8e, 0]);
    const lone = put([0x8e, 0]);
    assert.deepEqual([call('_mbsspn', text, digits), call('_mbsspn', text, pairs),
        call('_mbsspn', text + 8, pairs), call('_mbsspn', text, lone)], [8, 1, 2, 14],
    'a lead byte that ends the set matches every character');
    assert.deepEqual([call('_mbscspn', text, digits), call('_mbscspn', text + 8, digits),
        call('_mbscspn', text, lone)], [0, 2, 0]);
    assert.equal(call('_mbsspnp', text, digits), text + 8);
    const reversed = put([0x36, 0x8c, 0x8e, 0]);
    call('_mbsrev', reversed);
    assert.deepEqual([...memory.bytes.subarray(reversed, reversed + 4)], [0x8c, 0x8e, 0x36, 0]);
    const cut = put([0x36, 0x8c, 0]);
    call('_mbsrev', cut);
    assert.deepEqual([...memory.bytes.subarray(cut, cut + 2)], [0x36, 0],
        'a lead byte the terminator follows is dropped');
});

test('_mbbtype and _ismbclegal answer by the page', ()=>{
    const { call } = multiByte();
    assert.deepEqual([call('_mbbtype', 0x41, 0), call('_mbbtype', 0x0a, 0),
        call('_mbbtype', 0x41, 1)], [0, -1, -1]);
    call('_setmbcp', 932);
    assert.deepEqual([call('_mbbtype', 0x81, 0), call('_mbbtype', 0x40, 1),
        call('_mbbtype', 0x7f, 1)], [1, 2, -1]);
    assert.deepEqual([0x8140, 0x817f, 0x9ffc, 0xa040, 0xe040, 0xfd40, 0x40].map(c=>
        call('_ismbclegal', c)), [1, 0, 1, 0, 1, 0, 0]);
    const shiftJis = multiByte();
    shiftJis.call('_setmbcp', 932);
    assert.equal(shiftJis.call('_mbscmp', shiftJis.put([0xa6, 0]), shiftJis.put([0x81, 0x40, 0])),
        -1, 'a katakana byte stands before any pair, whatever its value');
});

test('_mbstok keeps a position of its own, apart from strtok\'s', ()=>{
    const { memory, table, put, call } = multiByte();
    const narrow = /** @type {Record<string, any>} */ (createMsvcrtFunctions({
        ...memory,
        write: ()=>{},
        callGuest: async()=>0,
    }));
    const text = put([...'!.!test'].map(c=>c.charCodeAt(0)).concat(0));
    narrow.strtok.handler([text, put([0x21, 0])]);
    assert.equal(call('_mbstok', 0, put([0x74, 0])), 0);
    const words = put([...'a b  c'].map(c=>c.charCodeAt(0)).concat(0));
    const space = put([0x20, 0]);
    assert.equal(table._mbstok.handler([words, space]), words);
    assert.equal(call('_mbstok', 0, space), words + 2);
    assert.equal(call('_mbstok', 0, space), words + 5);
    assert.equal(call('_mbstok', 0, space), 0);
});

test('mblen and _mbstrlen answer by the C locale, a byte a character', ()=>{
    const { put, call } = multiByte();
    call('_setmbcp', 936);
    const text = put([0xb0, 0xb1, 0xb2, 0]);
    assert.deepEqual([call('mblen', text, 3), call('mblen', text + 3, 1), call('mblen', 0, 1),
        call('mblen', text, 0)], [1, 0, 0, -1]);
    assert.equal(call('_mbstrlen', text), 3);
});

/**
 * The whole runtime's table, because the wide classifiers are bound to the
 * answers of the byte ones.
 */
const runtime = ()=>{
    const memory = fakeMemory();
    return /** @type {Record<string, any>} */ (createMsvcrtFunctions({
        ...memory,
        write: ()=>{},
        callGuest: async()=>0,
    }));
};

test('iswspace classifies the spaces the C locale has, and a code unit it has not got', ()=>{
    const fns = runtime();
    assert.equal(fns.iswspace.handler([0x20]), 1);
    assert.equal(fns.iswspace.handler([0x09]), 1);
    assert.equal(fns.iswspace.handler(['x'.charCodeAt(0)]), 0);
    assert.equal(fns.iswspace.handler([0x85]), 0, 'NEL is a control in msvcrt.dll\'s table');
    assert.equal(fns.iswspace.handler([0xa0]), 1, 'the no-break space is a space');
    assert.equal(fns.iswspace.handler([0x4e2d]), 0, 'a CJK unit is nothing');
    assert.equal(fns.iswspace.handler([0xffff]), 0, 'and WEOF is nothing at all');
});

test('the Latin-1 letters are alpha with their case, the two signs among them are not', ()=>{
    const fns = runtime();
    assert.equal(fns.iswalpha.handler([0xc0]), 1);
    assert.equal(fns.iswalpha.handler([0xff]), 1);
    assert.equal(fns.iswalnum.handler([0xc0]), 1, 'alpha carries alnum');
    assert.equal(fns.iswalpha.handler([0xd7]), 0, 'multiplication is not a letter');
    assert.equal(fns.iswalpha.handler([0xf7]), 0, 'and neither is division');
    assert.equal(fns.iswpunct.handler([0xd7]), 1, 'it is punctuation');
    assert.equal(fns.iswupper.handler([0xc9]), 1, 'É is upper');
    assert.equal(fns.iswlower.handler([0xc9]), 0);
    assert.equal(fns.iswlower.handler([0xe9]), 1, 'é is lower');
    assert.equal(fns.iswlower.handler([0xdf]), 1, 'ß is lower, though it has no upper here');
    assert.equal(fns.iswlower.handler([0xff]), 1);
    assert.equal(fns.iswprint.handler([0xe9]), 1, 'a letter prints');
    assert.equal(fns.iswgraph.handler([0xe9]), 1, 'and is graphic');
    assert.equal(fns.towupper.handler([0xe9]), 0xe9, 'the C locale maps no case past ASCII');
    assert.equal(fns.iswalpha.handler([0x4e2d]), 0, 'a CJK unit is not alpha here');
    assert.equal(fns.iswalpha.handler([0xffff]), 0);
});

test('the Latin-1 signs are punctuation, three of them digits, none of them letters', ()=>{
    // msvcrt.dll's own table, older than the Unicode that calls the ordinal
    // indicators and the micro sign letters.
    const fns = runtime();
    for (let code = 0xa1; code <= 0xbf; code++)
    {
        assert.equal(fns.iswpunct.handler([code]), 1, `0x${code.toString(16)}`);
        assert.equal(fns.iswalpha.handler([code]), 0, `0x${code.toString(16)}`);
        assert.equal(fns.iswgraph.handler([code]), 1, `0x${code.toString(16)}`);
    }
    assert.equal(fns.iswpunct.handler([0xa9]), 1, '©');
    assert.equal(fns.iswalpha.handler([0xaa]), 0, 'ª');
    assert.equal(fns.iswlower.handler([0xb5]), 0, 'µ');
    assert.deepEqual([0xb2, 0xb3, 0xb9, 0xbc].map(code=>fns.iswdigit.handler([code])),
        [1, 1, 1, 0], 'the superscripts two, three and one; a fraction is not');
    assert.equal(fns.iswxdigit.handler([0xb2]), 0);
});

test('iswctype answers by the real msvcrt bit values, over the Latin-1 range', ()=>{
    const fns = runtime();
    const UPPER = 0x0001;
    const LOWER = 0x0002;
    const DIGIT = 0x0004;
    const SPACE = 0x0008;
    const CONTROL = 0x0020;
    const BLANK = 0x0040;
    const ALPHA = 0x0103;
    assert.equal(fns.iswctype.handler(['A'.charCodeAt(0), UPPER]), 1);
    assert.equal(fns.iswctype.handler(['a'.charCodeAt(0), UPPER]), 0);
    assert.equal(fns.iswctype.handler(['5'.charCodeAt(0), DIGIT]), 1);
    assert.notEqual(fns.iswctype.handler([0xc0, ALPHA]), 0);
    assert.equal(fns.iswctype.handler([0xc0, UPPER]), 1);
    assert.equal(fns.iswctype.handler([0xe0, LOWER]), 1);
    assert.equal(fns.iswctype.handler([0xd7, ALPHA]), 0, 'multiplication is not a letter');
    assert.equal(fns.iswctype.handler([0x09, BLANK]), 1, 'the tab is blank in the wide table');
    assert.equal(fns.iswctype.handler([0xa0, BLANK]), 1, 'and the no-break space');
    assert.equal(fns.iswctype.handler([0x0a, BLANK]), 0);
    assert.equal(fns.iswctype.handler([0x85, SPACE]), 0);
    assert.equal(fns.iswctype.handler([0x85, CONTROL]), 1);
    assert.equal(fns.iswctype.handler([0xb2, DIGIT]), 1);
    // WEOF and anything past the Latin-1 table classify as nothing.
    assert.equal(fns.iswctype.handler([0xffff, UPPER | DIGIT | ALPHA]), 0);
    assert.equal(fns.iswctype.handler([0x4e2d, ALPHA]), 0, 'a CJK unit is nothing here');
});

test('the wide classifiers answer every ASCII code unit what the byte ones answer', ()=>{
    // But for the tab, which msvcrt's wide table calls blank, and iswprint
    // asks for the blanks: the byte table has only the space blank.
    const fns = runtime();
    for (const [wide, byte] of Object.entries({
        iswalpha: 'isalpha', iswdigit: 'isdigit', iswalnum: 'isalnum',
        iswspace: 'isspace', iswupper: 'isupper', iswlower: 'islower',
        iswxdigit: 'isxdigit', iswpunct: 'ispunct', iswcntrl: 'iscntrl',
        iswprint: 'isprint',
    }))
    {
        for (let code = 0; code < 0x80; code++)
        {
            const expected = wide === 'iswprint' && code === 0x09 ? 1 : fns[byte].handler([code]);
            assert.equal(fns[wide].handler([code]), expected, `${wide}(0x${code.toString(16)})`);
        }
    }
});

test('the wide classifiers that have no byte twin still answer the C locale', ()=>{
    const fns = runtime();
    assert.equal(fns.iswdigit.handler(['7'.charCodeAt(0)]), 1);
    assert.equal(fns.iswdigit.handler(['a'.charCodeAt(0)]), 0);
    assert.equal(fns.iswxdigit.handler(['F'.charCodeAt(0)]), 1);
    assert.equal(fns.iswxdigit.handler(['G'.charCodeAt(0)]), 0);
    assert.equal(fns.iswupper.handler(['Z'.charCodeAt(0)]), 1);
    assert.equal(fns.iswlower.handler(['z'.charCodeAt(0)]), 1);
    assert.equal(fns.iswpunct.handler(['!'.charCodeAt(0)]), 1);
    assert.equal(fns.iswpunct.handler([0xa0]), 0, 'the no-break space is not punctuation');
    assert.equal(fns.iswcntrl.handler([0x01]), 1);
    assert.equal(fns.iswcntrl.handler([0x80]), 1, 'the C1 controls are controls');
    assert.equal(fns.iswcntrl.handler([0x9f]), 1);
    assert.equal(fns.iswcntrl.handler([0x85]), 1);
    assert.equal(fns.iswprint.handler([0x20]), 1);
    assert.equal(fns.iswprint.handler([0x09]), 1, 'the tab is blank, and blanks print');
    assert.equal(fns.iswprint.handler([0xa0]), 1, 'as the no-break space does');
    assert.equal(fns.iswprint.handler([0x85]), 0);
    assert.equal(fns.iswgraph.handler(['!'.charCodeAt(0)]), 1);
    assert.equal(fns.iswgraph.handler([0x20]), 0, 'graph is print without the blanks');
    assert.equal(fns.iswgraph.handler([0xa0]), 0);
    assert.equal(fns.iswascii.handler(['a'.charCodeAt(0)]), 1);
    assert.equal(fns.iswascii.handler([0x7f]), 1);
    assert.equal(fns.iswascii.handler([0x80]), 0, 'iswascii answers the range, not a class');
    assert.equal(fns.iswascii.handler([0xffff]), 0);
});

test('towupper and towlower fold the ASCII letters and pass the rest through', ()=>{
    const fns = runtime();
    assert.equal(fns.towupper.handler(['a'.charCodeAt(0)]), 0x41);
    assert.equal(fns.towupper.handler(['Z'.charCodeAt(0)]), 0x5a);
    assert.equal(fns.towupper.handler(['0'.charCodeAt(0)]), 0x30);
    assert.equal(fns.towupper.handler([0xe9]), 0xe9, 'the C locale folds no accent');
    assert.equal(fns.towupper.handler([0xffff]), 0xffff, 'WEOF passes through as any unit does');
    assert.equal(fns.towlower.handler(['Z'.charCodeAt(0)]), 0x7a);
    assert.equal(fns.towlower.handler(['a'.charCodeAt(0)]), 0x61);
    assert.equal(fns.towlower.handler([0xc0]), 0xc0);
    assert.equal(fns.towlower.handler([0xffff]), 0xffff);
});

test('a wide string near the end of its region is read to its terminator, not past it', ()=>{
    // A path in a stack buffer a few hundred bytes below the stack's top: the
    // memory layer refuses a read that runs past the region, and one wide
    // window of the longest string would.
    const memory = fakeMemory();
    const end = memory.bytes.length;
    const readMemory = (/** @type {number} */ address, /** @type {number} */ length)=>{
        if (address + length > end)
        {
            throw new Error(`read of ${length} bytes at ${address} runs past the end of region`);
        }
        return memory.readMemory(address, length);
    };
    const table = /** @type {Record<string, any>} */ (createWideFunctions({ ...memory, readMemory }));
    const text = 'C:/App/System';
    const at = end - 0x40;
    for (const [index, character] of [...`${text}\0`].entries())
    {
        memory.bytes[at + index * 2] = character.charCodeAt(0);
        memory.bytes[at + index * 2 + 1] = 0;
    }
    assert.equal(table.wcschr.handler([at, 'S'.charCodeAt(0)]), at + text.indexOf('S') * 2);
    assert.equal(table.wcslen.handler([at]), text.length);
});

test('_wcslwr and _wcsupr fold ASCII in place, as the C locale does, and answer the string', ()=>{
    const { memory, table } = build();
    const string = memory.putWide('MiXeD Éé 1');
    assert.equal(table._wcslwr.handler([string]), string);
    assert.equal(memory.wide(string), 'mixed Éé 1', 'nothing past ASCII changes');
    assert.equal(table._wcsupr.handler([string]), string);
    assert.equal(memory.wide(string), 'MIXED Éé 1');
});

test('_wcsrev reverses the units in place', ()=>{
    const { memory, table } = build();
    const string = memory.putWide('abcあ');
    assert.equal(table._wcsrev.handler([string]), string);
    assert.equal(memory.wide(string), 'あcba');
    const empty = memory.putWide('');
    assert.equal(table._wcsrev.handler([empty]), empty);
    assert.equal(memory.wide(empty), '');
});

test('_wcsnicmp compares at most the count, ASCII folded, and stops at the terminator', ()=>{
    const { memory, table } = build();
    const upper = memory.putWide('HELLO world');
    const lower = memory.putWide('hello WORLD');
    assert.equal(table._wcsnicmp.handler([upper, lower, 11]), 0);
    assert.equal(table._wcsnicmp.handler([memory.putWide('abcX'), memory.putWide('ABCy'), 3]), 0);
    assert.ok(table._wcsnicmp.handler([memory.putWide('abcX'), memory.putWide('ABCy'), 4]) < 0);
    assert.ok(table._wcsnicmp.handler([memory.putWide('ab'), memory.putWide('a'), 5]) > 0);
    assert.equal(table._wcsnicmp.handler([memory.putWide('ab'), memory.putWide('AB'), 9]), 0);
    assert.equal(table._wcsnicmp.handler([upper, memory.putWide('z'), 0]), 0, 'none compared');
});

test('wcsspn, wcscspn and wcspbrk measure and find by a set of units', ()=>{
    const { memory, table } = build();
    const string = memory.putWide('  \tあx=1');
    assert.equal(table.wcsspn.handler([string, memory.putWide(' \t')]), 3);
    assert.equal(table.wcscspn.handler([string, memory.putWide('=あ')]), 3);
    assert.equal(table.wcscspn.handler([string, memory.putWide('#')]), 7, 'none is the length');
    assert.equal(table.wcspbrk.handler([string, memory.putWide('x=')]), string + 4 * 2);
    assert.equal(table.wcspbrk.handler([string, memory.putWide('#')]), 0);
    assert.equal(table.wcspbrk.handler([string, memory.putWide('')]), 0);
});

test('wcstok splits a wide string in place and carries on when handed null', ()=>{
    const { memory, table } = build();
    const string = memory.putWide(',,a.ocx, bあ.dll,,');
    const delimiters = memory.putWide(', ');
    const first = table.wcstok.handler([string, delimiters]);
    assert.equal(first, string + 4);
    assert.equal(memory.wide(first), 'a.ocx');
    const second = table.wcstok.handler([0, delimiters]);
    assert.equal(memory.wide(second), 'bあ.dll');
    assert.equal(table.wcstok.handler([0, delimiters]), 0, 'only delimiters left');
    assert.equal(table.wcstok.handler([0, delimiters]), 0, 'and still nothing');
    const last = memory.putWide('tail');
    assert.equal(table.wcstok.handler([last, delimiters]), last);
    assert.equal(table.wcstok.handler([0, delimiters]), 0);
});
