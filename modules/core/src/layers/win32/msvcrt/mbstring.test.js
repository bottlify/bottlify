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

test('the multi-byte names are bound to the byte functions themselves', ()=>{
    const memory = fakeMemory();
    const narrow = /** @type {Record<string, any>} */ (createMsvcrtFunctions({
        ...memory,
        write: ()=>{},
        callGuest: async()=>0,
    }));
    const multi = /** @type {Record<string, any>} */ (createMultiByteFunctions(narrow));
    assert.equal(multi._mbscpy, narrow.strcpy, 'one implementation, two names');
    assert.equal(multi._mbslen, narrow.strlen);
    assert.equal(multi._mbsicmp, narrow._stricmp);
    assert.equal(multi._ismbcspace, narrow.isspace, 'a classifier, bound the same way');
    assert.equal(multi._ismbcspace.handler([' '.charCodeAt(0)]), 1);
    assert.equal(multi._ismbcspace.handler(['x'.charCodeAt(0)]), 0);
    assert.equal(multi._mbsnbcmp, narrow.strncmp, 'a byte count is a character count here');
    assert.equal(multi._mbspbrk, narrow.strpbrk);
    assert.equal(multi._ismbcdigit, narrow.isdigit);
});

test('under a single-byte locale a character is one byte and nothing leads', ()=>{
    const multi = /** @type {Record<string, any>} */ (createMultiByteFunctions({}));
    assert.equal(multi._mbclen.handler([0]), 1);
    assert.equal(multi._ismbblead.handler([0x81]), 0);
    assert.equal(multi._mbsinc.handler([0x1000]), 0x1001);
    assert.equal(multi._mbsdec.handler([0x1000, 0x1004]), 0x1003);
    assert.equal(multi._mbsdec.handler([0x1000, 0x1000]), 0, 'nothing before the start');
    assert.deepEqual([...multi._mbctype.data()], new Array(257).fill(0), 'no byte leads or trails');
    /** @type {string[]} */
    const said = [];
    const told = /** @type {Record<string, any>} */ (createMultiByteFunctions({},
        (/** @type {string} */ api)=>said.push(api)));
    assert.equal(told._setmbcp.handler([1252]), 0);
    assert.equal(told._setmbcp.handler([-3]), 0);
    assert.deepEqual(said, [], 'the ANSI page is the page it has');
    assert.equal(told._setmbcp.handler([932]), 0);
    assert.deepEqual(said, ['_setmbcp'], 'a double-byte page is not, and says so');
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
    assert.equal(fns.iswspace.handler([0x85]), 1, 'NEL is a space');
    assert.equal(fns.iswspace.handler([0xa0]), 1, 'the no-break space is a space');
    assert.equal(fns.iswspace.handler([0x4e2d]), 0, 'a CJK unit is nothing');
    assert.equal(fns.iswspace.handler([0xffff]), 0, 'and WEOF is nothing at all');
});

test('the Latin-1 letters are alpha, the two signs among them are not', ()=>{
    const fns = runtime();
    assert.equal(fns.iswalpha.handler([0xc0]), 1);
    assert.equal(fns.iswalpha.handler([0xff]), 1);
    assert.equal(fns.iswalnum.handler([0xc0]), 1, 'alpha carries alnum');
    assert.equal(fns.iswalpha.handler([0xd7]), 0, 'multiplication is not a letter');
    assert.equal(fns.iswalpha.handler([0xf7]), 0, 'and neither is division');
    assert.equal(fns.iswupper.handler([0xc0]), 0, 'the C locale gives them no case');
    assert.equal(fns.iswlower.handler([0xc0]), 0);
    assert.equal(fns.iswalpha.handler([0x4e2d]), 0, 'a CJK unit is not alpha here');
    assert.equal(fns.iswalpha.handler([0xffff]), 0);
});

test('iswctype answers by the real msvcrt bit values, over the Latin-1 range', ()=>{
    const fns = runtime();
    const UPPER = 0x0001;
    const DIGIT = 0x0004;
    const ALPHA = 0x0103;
    assert.equal(fns.iswctype.handler(['A'.charCodeAt(0), UPPER]), 1);
    assert.equal(fns.iswctype.handler(['a'.charCodeAt(0), UPPER]), 0);
    assert.equal(fns.iswctype.handler(['5'.charCodeAt(0), DIGIT]), 1);
    // The Latin-1 extension iswalpha itself carries: alpha, but no case.
    assert.notEqual(fns.iswctype.handler([0xc0, ALPHA]), 0);
    assert.equal(fns.iswctype.handler([0xc0, UPPER]), 0, 'the C locale gives it no case');
    assert.equal(fns.iswctype.handler([0xd7, ALPHA]), 0, 'multiplication is not a letter');
    // WEOF and anything past the Latin-1 table classify as nothing.
    assert.equal(fns.iswctype.handler([0xffff, UPPER | DIGIT | ALPHA]), 0);
    assert.equal(fns.iswctype.handler([0x4e2d, ALPHA]), 0, 'a CJK unit is nothing here');
});

test('the wide classifiers answer every ASCII code unit what the byte ones answer', ()=>{
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
            assert.equal(fns[wide].handler([code]), fns[byte].handler([code]),
                `${wide}(0x${code.toString(16)})`);
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
    assert.equal(fns.iswcntrl.handler([0x85]), 0, 'NEL is a space here, not a control');
    assert.equal(fns.iswprint.handler([0x20]), 1);
    assert.equal(fns.iswprint.handler([0xa0]), 0, 'print stops with the ASCII page');
    assert.equal(fns.iswgraph.handler(['!'.charCodeAt(0)]), 1);
    assert.equal(fns.iswgraph.handler([0x20]), 0, 'graph is print without the space');
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
    assert.equal(fns.towupper.handler([0xffff]), 0, 'WEOF answers zero, as everywhere');
    assert.equal(fns.towlower.handler(['Z'.charCodeAt(0)]), 0x7a);
    assert.equal(fns.towlower.handler(['a'.charCodeAt(0)]), 0x61);
    assert.equal(fns.towlower.handler([0xc0]), 0xc0);
    assert.equal(fns.towlower.handler([0xffff]), 0);
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
