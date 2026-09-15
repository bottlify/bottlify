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

test('wcstombs narrows, and answers the count without a destination', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    assert.equal(table.wcstombs.handler([0, memory.putWide('abc'), 0]), 3);
    table.wcstombs.handler([destination, memory.putWide('abc'), 8]);
    assert.equal(memory.text(destination), 'abc');
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
    const narrow = createMsvcrtFunctions({
        ...memory,
        write: ()=>{},
        callGuest: async()=>0,
    });
    const multi = /** @type {Record<string, any>} */ (createMultiByteFunctions(narrow));
    assert.equal(multi._mbscpy, narrow.strcpy, 'one implementation, two names');
    assert.equal(multi._mbslen, narrow.strlen);
    assert.equal(multi._mbsicmp, narrow._stricmp);
});

test('under a single-byte locale a character is one byte and nothing leads', ()=>{
    const multi = /** @type {Record<string, any>} */ (createMultiByteFunctions({}));
    assert.equal(multi._mbclen.handler([0]), 1);
    assert.equal(multi._ismbblead.handler([0x81]), 0);
    assert.equal(multi._mbsinc.handler([0x1000]), 0x1001);
    assert.equal(multi._mbsdec.handler([0x1000, 0x1004]), 0x1003);
    assert.equal(multi._mbsdec.handler([0x1000, 0x1000]), 0, 'nothing before the start');
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
