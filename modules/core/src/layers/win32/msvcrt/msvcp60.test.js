/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsvcp60Functions } from './msvcp60.js';

const STRING = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@';
const WSTRING = '?$basic_string@GU?$char_traits@G@std@@V?$allocator@G@2@@std@@';
const NULLSTR = `?_C@?1??_Nullstr@${STRING}CAPBDXZ@4DB`;

function setup(){
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let next = 0x10000;
    /** @type {Map<number, number>} */
    const blocks = new Map();
    /** @type {string[]} */
    const names = [];
    /** @type {number[][]} */
    const thrown = [];
    /** @type {Record<string, { handler: (args: number[]) => any }>} */
    const crt = {
        '??2@YAPAXI@Z': { handler: ([size])=>{
            const at = next;
            next += (size + 15) & ~15;
            blocks.set(at, size);
            return at;
        } },
        '??3@YAXPAX@Z': { handler: ([at])=>{
            assert.ok(blocks.delete(at), `freed ${at.toString(16)} not allocated`);
        } },
        malloc: { handler: ([size])=>crt['??2@YAPAXI@Z'].handler([size]) },
        free: { handler: ([at])=>crt['??3@YAXPAX@Z'].handler([at]) },
        '??0exception@@QAE@ABV0@@Z': { handler: ([self, other])=>{
            memory.copyWithin(self, other, other + 12);
            view.setUint32(self + 8, 0, true);
            return self;
        } },
        '??1exception@@UAE@XZ': { handler: ([self])=>{
            if (view.getUint32(self + 8, true) !== 0)
            {
                crt.free.handler([view.getUint32(self + 4, true)]);
            }
            return 0;
        } },
        '??4exception@@QAEAAV0@ABV0@@Z': { handler: ([self])=>self },
        _CxxThrowException: { handler: ([object, info])=>{
            thrown.push([object, info]);
            return Promise.resolve(0);
        } },
    };
    const fns = createMsvcp60Functions(crt, {
        // The first page closed, as a process's is: a null text is never touched.
        readMemory: (address, length)=>{
            assert.ok(address >= 0x100, `read of ${length} at ${address}`);
            return memory.slice(address, address + length);
        },
        writeMemory: (address, bytes)=>{
            assert.ok(address >= 0x100, `write of ${bytes.length} at ${address}`);
            memory.set(bytes, address);
        },
        addressOf: name=>(name === NULLSTR ? 0x500 : names.indexOf(name) + 0x600),
    });
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>{
        assert.ok(fns[name], name);
        return fns[name].handler(args);
    };
    /** @param {string} text */
    const put = text=>{
        const at = next;
        next += text.length + 16;
        memory.set(new TextEncoder().encode(`${text}\0`), at);
        return at;
    };
    /** @param {number} at */
    const text = at=>{
        let end = at;
        while (memory[end] !== 0)
        {
            end++;
        }
        return new TextDecoder().decode(memory.subarray(at, end));
    };
    /** @param {number} self */
    const str = self=>text(call(`?c_str@${STRING}QBEPBDXZ`, self));
    const fields = (/** @type {number} */ self)=>({ ptr: view.getUint32(self + 4, true),
        len: view.getUint32(self + 8, true), res: view.getUint32(self + 12, true) });
    names.push(...Object.keys(fns));
    return { fns, memory, view, call, put, str, text, fields, blocks, thrown, names };
}

test('an empty string has no text and reads as the static empty one', ()=>{
    const { call, fields, str } = setup();
    call(`??0${STRING}QAE@ABV?$allocator@D@1@@Z`, 0x100, 0);
    assert.deepEqual(fields(0x100), { ptr: 0, len: 0, res: 0 });
    assert.equal(call(`?c_str@${STRING}QBEPBDXZ`, 0x100), 0x500);
    assert.equal(str(0x100), '');
    call(`??1${STRING}QAE@XZ`, 0x100);
});

test('text is held after a count byte, in room rounded to 31, two extra elements allocated', ()=>{
    const { call, put, fields, str, blocks, memory } = setup();
    call(`??0${STRING}QAE@PBDABV?$allocator@D@1@@Z`, 0x100, put('hello'), 0);
    const { ptr, len, res } = fields(0x100);
    assert.equal(len, 5);
    assert.equal(res, 31);
    assert.equal(blocks.get(ptr - 1), 33);
    assert.equal(memory[ptr - 1], 0);
    assert.equal(str(0x100), 'hello');
    call(`??1${STRING}QAE@XZ`, 0x100);
    assert.equal(blocks.size, 0);
});

test('a copy shares the text by count; a change gives the changed string its own', ()=>{
    const { call, put, fields, str, blocks, memory } = setup();
    call(`??0${STRING}QAE@PBDABV?$allocator@D@1@@Z`, 0x100, put('shared'), 0);
    call(`??0${STRING}QAE@ABV01@@Z`, 0x200, 0x100);
    assert.equal(fields(0x200).ptr, fields(0x100).ptr);
    assert.equal(memory[fields(0x100).ptr - 1], 1);
    call(`?append@${STRING}QAEAAV12@PBD@Z`, 0x200, put('!'));
    assert.notEqual(fields(0x200).ptr, fields(0x100).ptr);
    assert.equal(memory[fields(0x100).ptr - 1], 0);
    assert.equal(str(0x100), 'shared');
    assert.equal(str(0x200), 'shared!');
    call(`??1${STRING}QAE@XZ`, 0x100);
    call(`??1${STRING}QAE@XZ`, 0x200);
    assert.equal(blocks.size, 0);
});

test('a text handed out to write through is frozen and never shared again', ()=>{
    const { call, put, fields, memory } = setup();
    call(`??0${STRING}QAE@PBDABV?$allocator@D@1@@Z`, 0x100, put('abc'), 0);
    const at = call(`??A${STRING}QAEAADI@Z`, 0x100, 1);
    assert.equal(at, fields(0x100).ptr + 1);
    assert.equal(memory[fields(0x100).ptr - 1], 255);
    call(`??0${STRING}QAE@ABV01@@Z`, 0x200, 0x100);
    assert.notEqual(fields(0x200).ptr, fields(0x100).ptr);
});

test('edits: erase, insert, replace, substr, find, compare and the free operators', ()=>{
    const { call, put, str } = setup();
    call(`??0${STRING}QAE@PBDABV?$allocator@D@1@@Z`, 0x100, put('hello world'), 0);
    call(`?erase@${STRING}QAEAAV12@II@Z`, 0x100, 5, 6);
    assert.equal(str(0x100), 'hello');
    call(`?insert@${STRING}QAEAAV12@IPBD@Z`, 0x100, 0, put('>> '));
    assert.equal(str(0x100), '>> hello');
    call(`?replace@${STRING}QAEAAV12@IIPBD@Z`, 0x100, 3, 5, put('there'));
    assert.equal(str(0x100), '>> there');
    call(`?substr@${STRING}QBE?AV12@II@Z`, 0x100, 0x200, 3, 3);
    assert.equal(str(0x200), 'the');
    assert.equal(call(`?find@${STRING}QBEIPBDI@Z`, 0x100, put('re'), 0), 6);
    assert.equal(call(`?find@${STRING}QBEIDI@Z`, 0x100, 'z'.charCodeAt(0), 0), 0xffffffff);
    assert.equal(call(`?rfind@${STRING}QBEIDI@Z`, 0x100, 'e'.charCodeAt(0), 0xffffffff), 7);
    assert.equal(call(`?compare@${STRING}QBEHPBD@Z`, 0x200, put('thf')), -1);
    assert.equal(call(`?compare@${STRING}QBEHPBD@Z`, 0x200, put('the')), 0);
    call(`??H${'std@@'}YA?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@ABV10@PBD@Z`,
        0x300, 0x200, put('ory'));
    assert.equal(str(0x300), 'theory');
    assert.equal(call(`??8std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@`
        + 'V?$allocator@D@2@@0@PBD@Z', 0x300, put('theory')), 1);
});

test('a position past the end throws out_of_range: a message, its type data, the call left', ()=>{
    const { call, put, str, view, text, thrown, names } = setup();
    call(`??0${STRING}QAE@PBDABV?$allocator@D@1@@Z`, 0x100, put('ab'), 0);
    const answer = call(`?erase@${STRING}QAEAAV12@II@Z`, 0x100, 3, 1);
    assert.ok(answer instanceof Promise);
    assert.equal(str(0x100), 'ab');
    assert.equal(thrown.length, 1);
    const [object, info] = thrown[0];
    assert.equal(info, names.indexOf('_TI??_R0?AVout_of_range@std@@@8') + 0x600);
    assert.equal(view.getUint32(object, true), names.indexOf('??_7out_of_range@std@@6B@') + 0x600);
    const what = call('?what@logic_error@std@@UBEPBDXZ', object);
    assert.equal(text(what), 'invalid string position');
    call('??1out_of_range@std@@UAE@XZ', object);
});

test('an exception holds its message as a string, the base\'s named empty and its own', ()=>{
    const { call, put, view, text, memory } = setup();
    call(`??0${STRING}QAE@PBDABV?$allocator@D@1@@Z`, 0x100, put('test'), 0);
    memory.fill(0, 0x300, 0x300 + 28);
    assert.equal(text(call('?what@runtime_error@std@@UBEPBDXZ', 0x300)), '');
    memory.fill(0xff, 0x300, 0x300 + 28);
    call('??0range_error@std@@QAE@ABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@1@@Z',
        0x300, 0x100);
    assert.equal(text(view.getUint32(0x304, true)), '');
    assert.equal(view.getUint32(0x308, true), 1);
    assert.equal(text(call('?what@runtime_error@std@@UBEPBDXZ', 0x300)), 'test');
    call('??0range_error@std@@QAE@ABV01@@Z', 0x340, 0x300);
    assert.equal(text(call('?what@runtime_error@std@@UBEPBDXZ', 0x340)), 'test');
    call('??1range_error@std@@UAE@XZ', 0x300);
    call('??1range_error@std@@UAE@XZ', 0x340);
});

test('a string of no text is replaced, erased and copied without touching a null text', ()=>{
    const { call, put, str } = setup();
    call(`??0${STRING}QAE@ABV?$allocator@D@1@@Z`, 0x100, 0);
    call(`?replace@${STRING}QAEAAV12@IIPBD@Z`, 0x100, 0, 10, put(''));
    assert.equal(str(0x100), '');
    call(`?erase@${STRING}QAEAAV12@II@Z`, 0x100, 0, 1);
    assert.equal(call(`?copy@${STRING}QBEIPADII@Z`, 0x100, 0x400, 5, 0), 0);
    call(`?replace@${STRING}QAEAAV12@IIID@Z`, 0x100, 0, 0, 0, 'x'.charCodeAt(0));
    assert.equal(str(0x100), '');
    call(`?append@${STRING}QAEAAV12@PBDI@Z`, 0x100, put('x'), 0);
    call(`??1${STRING}QAE@XZ`, 0x100);
});

test('wide strings hold UTF-16 elements', ()=>{
    const { call, memory, fields } = setup();
    const at = 0x4000;
    memory.set(new Uint8Array(Uint16Array.from([0x41, 0x416, 0]).buffer), at);
    call(`??0${WSTRING}QAE@PBGABV?$allocator@G@1@@Z`, 0x100, at, 0);
    assert.equal(fields(0x100).len, 2);
    assert.equal(call(`?size@${WSTRING}QBEIXZ`, 0x100), 2);
    assert.equal(call(`?max_size@${WSTRING}QBEIXZ`, 0x100), 0x7ffffffd);
    const text = call(`?c_str@${WSTRING}QBEPBGXZ`, 0x100);
    assert.deepEqual([...new Uint16Array(memory.slice(text, text + 6).buffer)], [0x41, 0x416, 0]);
});

test('set searches, iterator edits and reverse iterators', ()=>{
    const { call, put, str, fields, memory } = setup();
    call(`??0${STRING}QAE@PBDABV?$allocator@D@1@@Z`, 0x100, put('  key = value  '), 0);
    const spaces = put(' ');
    assert.equal(call(`?find_first_not_of@${STRING}QBEIPBDI@Z`, 0x100, spaces, 0), 2);
    assert.equal(call(`?find_last_not_of@${STRING}QBEIPBDI@Z`, 0x100, spaces, 0xffffffff), 12);
    assert.equal(call(`?find_first_of@${STRING}QBEIDI@Z`, 0x100, '='.charCodeAt(0), 0), 6);
    assert.equal(call(`?find_last_of@${STRING}QBEIPBDII@Z`, 0x100, put('ky'), 0xffffffff, 2), 4);
    assert.equal(call(`?find_first_of@${STRING}QBEIPBDI@Z`, 0x100, put(''), 0), 0xffffffff);
    const begin = call(`?begin@${STRING}QAEPADXZ`, 0x100);
    call(`?replace@${STRING}QAEAAV12@PAD0PBD@Z`, 0x100, begin + 2, begin + 5, put('name'));
    assert.equal(str(0x100), '  name = value  ');
    call(`?insert@${STRING}QAEXPADID@Z`, 0x100, fields(0x100).ptr, 2, '#'.charCodeAt(0));
    assert.equal(str(0x100), '##  name = value  ');
    assert.equal(call(`?rend@${STRING}QBE?AV?$reverse_iterator@PBDDABDPBDH@2@XZ`, 0x100, 0x180),
        0x180);
    assert.equal(new DataView(memory.buffer).getUint32(0x180, true), fields(0x100).ptr);
});
