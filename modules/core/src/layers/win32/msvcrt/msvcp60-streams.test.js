/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsvcp60Functions } from './msvcp60.js';
import { LAYOUT, OPENMODE } from './msvcp60-streams.js';

const T = (/** @type {'D' | 'G'} */ E)=>`${E}U?$char_traits@${E}@std@@`;
const STRING = (/** @type {'D' | 'G'} */ E)=>
    `?$basic_string@${T(E)}V?$allocator@${E}@2@@std@@`;
const SS = (/** @type {'D' | 'G'} */ E)=>`?$basic_stringstream@${T(E)}V?$allocator@${E}@2@@std@@`;
const IS = (/** @type {'D' | 'G'} */ E)=>`?$basic_istream@${T(E)}@std@@`;
const OS = (/** @type {'D' | 'G'} */ E)=>`?$basic_ostream@${T(E)}@std@@`;
const IOSB = 'ios_base@std@@';
const { IOS } = LAYOUT;

/**
 * The library over a memory of its own, its exports laid out as the loader
 * lays a module: data where its bytes are, its pointers to other exports
 * filled in; a code export at an address of its own. The runtime's
 * allocator, files (by name, in memory) and stdout are small models.
 *
 * @param {Record<string, string>} [files]
 */
function setup(files = {}){
    const memory = new Uint8Array(0x100000);
    const view = new DataView(memory.buffer);
    let next = 0x40000;
    /** @type {string[]} */
    const said = [];
    /** @type {number[][]} */
    const thrown = [];
    /** @type {Map<number, { text: number[], at: number, name: string }>} */
    const open = new Map();
    const IOB = 0x3000;
    /** stdin, stdout, stderr. */
    for (const index of [0, 1, 2])
    {
        open.set(IOB + index * 32, { text: [], at: 0, name: `std${index}` });
    }
    /** @param {number} at */
    const cString = at=>{
        let text = '';
        while (memory[at] !== 0)
        {
            text += String.fromCharCode(memory[at++]);
        }
        return text;
    };
    let nextFile = 0x3100;
    /** @type {Record<string, { handler: (args: number[]) => any }>} */
    const crt = {
        '??2@YAPAXI@Z': { handler: ([size])=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        } },
        '??3@YAXPAX@Z': { handler: ()=>0 },
        malloc: { handler: ([size])=>crt['??2@YAPAXI@Z'].handler([size]) },
        free: { handler: ()=>0 },
        __iob_func: { handler: ()=>IOB },
        fopen: { handler: ([name, mode])=>{
            const path = cString(name);
            const how = cString(mode);
            if (!(path in files) && how.startsWith('r'))
            {
                return 0;
            }
            if (how.startsWith('w'))
            {
                files[path] = '';
            }
            const fp = nextFile;
            nextFile += 32;
            open.set(fp, { text: [...files[path]].map(c=>c.charCodeAt(0)), at: 0, name: path });
            return fp;
        } },
        fclose: { handler: ([fp])=>{
            const f = open.get(fp);
            if (f)
            {
                files[f.name] = String.fromCharCode(...f.text);
                open.delete(fp);
            }
            return 0;
        } },
        fgetc: { handler: ([fp])=>{
            const f = /** @type {{ text: number[], at: number }} */ (open.get(fp));
            return f.at < f.text.length ? f.text[f.at++] : -1;
        } },
        ungetc: { handler: ([c, fp])=>{
            const f = /** @type {{ text: number[], at: number }} */ (open.get(fp));
            f.at--;
            return c;
        } },
        fputc: { handler: ([c, fp])=>{
            const f = /** @type {{ text: number[], at: number }} */ (open.get(fp));
            f.text[f.at++] = c & 0xff;
            return c & 0xff;
        } },
        fflush: { handler: ()=>0 },
        fseek: { handler: ([fp, off, way])=>{
            const f = /** @type {{ text: number[], at: number }} */ (open.get(fp));
            const to = (way === 0 ? 0 : way === 1 ? f.at : f.text.length) + (off | 0);
            if (to < 0)
            {
                return -1;
            }
            f.at = to;
            return 0;
        } },
        fgetpos: { handler: ([fp, pos])=>{
            view.setBigInt64(pos, BigInt(/** @type {{ at: number }} */ (open.get(fp)).at), true);
            return 0;
        } },
        fsetpos: { handler: ([fp, pos])=>{
            /** @type {{ at: number }} */ (open.get(fp)).at = Number(view.getBigInt64(pos, true));
            return 0;
        } },
        _CxxThrowException: { handler: ([object, info])=>{
            thrown.push([object, info]);
            return Promise.resolve(0);
        } },
        '??0exception@@QAE@ABV0@@Z': { handler: ([self])=>self },
        '??1exception@@UAE@XZ': { handler: ()=>0 },
        '??4exception@@QAEAAV0@ABV0@@Z': { handler: ([self])=>self },
    };
    /** @type {Map<string, number>} */
    const placed = new Map();
    const fns = createMsvcp60Functions(crt, {
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        addressOf: name=>placed.get(name) ?? 0,
        divergence: (api, detail, kind)=>said.push(`${api}: ${detail}${kind ? ` (${kind})` : ''}`),
    });
    let code = 0x10000;
    let data = 0x20000;
    for (const [name, entry] of Object.entries(fns))
    {
        if (entry.data)
        {
            const bytes = entry.data();
            data = (data + 15) & ~15;
            memory.set(bytes, data);
            placed.set(name, data + (entry.entry ?? 0));
            data += bytes.length;
        }
        else
        {
            placed.set(name, code);
            code += 16;
        }
    }
    for (const [name, entry] of Object.entries(fns))
    {
        for (const { at, to, offset = 0 } of entry.pointers ?? [])
        {
            const base = /** @type {number} */ (placed.get(name)) - (entry.entry ?? 0);
            view.setUint32(base + at, /** @type {number} */ (placed.get(to)) + offset, true);
        }
    }
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>{
        assert.ok(fns[name]?.handler, name);
        return fns[name].handler(args);
    };
    /** A string of the element at a fresh place. @param {string} text @param {1 | 2} unit */
    const string = (text, unit = 1)=>{
        const self = next;
        next += 16;
        const at = next;
        next += (text.length + 1) * unit + 16;
        for (let i = 0; i <= text.length; i++)
        {
            const c = i < text.length ? text.charCodeAt(i) : 0;
            memory[at + i * unit] = c & 0xff;
            if (unit === 2)
            {
                memory[at + i * 2 + 1] = c >>> 8;
            }
        }
        const E = unit === 1 ? 'D' : 'G';
        call(`??0${STRING(E)}QAE@PB${E}ABV?$allocator@${E}@1@@Z`, self, at, 0);
        return self;
    };
    /** A string's text. @param {number} self @param {1 | 2} unit */
    const text = (self, unit = 1)=>{
        const E = unit === 1 ? 'D' : 'G';
        let at = call(`?c_str@${STRING(E)}QBEPB${E}XZ`, self);
        let out = '';
        for (;;)
        {
            const c = unit === 1 ? memory[at] : view.getUint16(at, true);
            if (c === 0)
            {
                return out;
            }
            out += String.fromCharCode(c);
            at += unit;
        }
    };
    /** Room for an object. @param {number} size */
    const room = size=>{
        const at = next;
        next += (size + 15) & ~15;
        memory.fill(0xcc, at, at + size);
        return at;
    };
    /** A C string at a fresh place. @param {string} value */
    const cstr = value=>{
        const at = room(value.length + 1);
        memory.set([...value, '\0'].map(c=>c.charCodeAt(0)), at);
        return at;
    };
    return { memory, view, call, string, text, room, cstr, placed, fns, said, thrown, open, files,
        IOB };
}

const SS_SIZE = 140;
const IOS_AT = 88;

test('every stream class reaches its basic_ios through vbtables the library exports', ()=>{
    const { view, placed } = setup();
    // The offsets Visual C++ 6's MSVCP60 has, from the istream or ostream part to basic_ios.
    const expected = {
        [`??_8${SS('D')}7B?$basic_istream@${T('D')}@1@@`]: 0x58,
        [`??_8${SS('D')}7B?$basic_ostream@${T('D')}@1@@`]: 0x50,
        [`??_8?$basic_fstream@${T('G')}@std@@7B?$basic_istream@${T('G')}@1@@`]: 0x60,
        [`??_8?$basic_fstream@${T('G')}@std@@7B?$basic_ostream@${T('G')}@1@@`]: 0x58,
        [`??_8?$basic_ifstream@${T('D')}@std@@7B@`]: 0x5c,
        [`??_8?$basic_ofstream@${T('D')}@std@@7B@`]: 0x58,
        [`??_8?$basic_istringstream@${T('D')}V?$allocator@D@2@@std@@7B@`]: 0x54,
        [`??_8?$basic_ostringstream@${T('G')}V?$allocator@G@2@@std@@7B@`]: 0x50,
        [`??_8?$basic_iostream@${T('D')}@std@@7B?$basic_istream@${T('D')}@1@@`]: 0xc,
        [`??_8?$basic_iostream@${T('D')}@std@@7B?$basic_ostream@${T('D')}@1@@`]: 0x4,
        [`??_8${IS('D')}7B@`]: 0x8,
        [`??_8${OS('G')}7B@`]: 0x4,
    };
    for (const [name, offset] of Object.entries(expected))
    {
        const at = /** @type {number} */ (placed.get(name));
        assert.ok(at, name);
        assert.deepEqual([view.getInt32(at, true), view.getInt32(at + 4, true)], [0, offset], name);
    }
});

test('a stringstream reads numbers in the C locale and in a named one', ()=>{
    const { call, string, room, cstr, view } = setup();
    /** @param {string} input @param {string | null} locale */
    const read = (input, locale)=>{
        const ss = room(SS_SIZE);
        call(`??0${SS('D')}QAE@ABV${STRING('D').replace(/std@@$/, '')}1@H@Z`, ss, string(input),
            OPENMODE.IN | OPENMODE.OUT, 1);
        if (locale)
        {
            const lcl = room(4);
            call('??0locale@std@@QAE@PBDH@Z', lcl, cstr(locale), 0x3f);
            call(`?imbue@?$basic_ios@${T('D')}@std@@QAE?AVlocale@2@ABV32@@Z`, ss + IOS_AT,
                room(4), lcl);
        }
        const value = room(8);
        view.setFloat64(value, 42, true);
        call(`??5${IS('D')}QAEAAV01@AAN@Z`, ss, value);
        const state = call(`?rdstate@${IOSB}QBEHXZ`, ss + IOS_AT);
        const next = call(`?get@${IS('D')}QAEHXZ`, ss) | 0;
        call(`??_D${SS('D')}QAEXXZ`, ss);
        return [view.getFloat64(value, true), state, next];
    };
    assert.deepEqual(read('  -12.5e2x', null), [-1250, 0, 'x'.charCodeAt(0)]);
    assert.deepEqual(read('1,5', null), [1, 0, ','.charCodeAt(0)]);
    assert.deepEqual(read('1,5', 'German'), [1.5, 1, -1]);
    assert.deepEqual(read('1.0e999', null), [42, 3, -1]);
    assert.deepEqual(read('1.0ee1', null), [42, 2, -1]);
});

test('numbers written as printf of the format flags, padded to the width', ()=>{
    const { call, room, text } = setup();
    /** @param {(ss: number) => void} write @param {1 | 2} [unit] */
    const written = (write, unit = 1)=>{
        const E = unit === 1 ? 'D' : 'G';
        const ss = room(SS_SIZE);
        call(`??0${SS(E)}QAE@H@Z`, ss, OPENMODE.IN | OPENMODE.OUT, 1);
        write(ss);
        const out = room(16);
        call(`?str@${SS(E)}QBE?AV${STRING(E).replace(/std@@$/, '')}2@XZ`, ss, out);
        call(`??_D${SS(E)}QAEXXZ`, ss);
        return text(out, unit);
    };
    /** @param {number} value */
    const dwords = value=>{
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, value, true);
        return [view.getUint32(0, true), view.getUint32(4, true)];
    };
    const double = `??6${OS('D')}QAEAAV01@N@Z`;
    assert.equal(written(ss=>call(double, ss + 8, ...dwords(123456.789))), '123457');
    assert.equal(written(ss=>call(double, ss + 8, ...dwords(-1e9))), '-1e+009');
    assert.equal(written(ss=>{
        call(`?setf@${IOSB}QAEHHH@Z`, ss + IOS_AT, 0x1000, 0x3000);
        call(`?precision@${IOSB}QAEHH@Z`, ss + IOS_AT, 9);
        call(double, ss + 8, ...dwords(123456.789));
    }), '1.234567890e+005');
    assert.equal(written(ss=>{
        call(`?setf@${IOSB}QAEHHH@Z`, ss + IOS_AT, 0x2000, 0x3000);
        call(`?precision@${IOSB}QAEHH@Z`, ss + IOS_AT, 0);
        call(double, ss + 8, ...dwords(0.123));
    }), '0');
    assert.equal(written(ss=>{
        call(`?width@${IOSB}QAEHH@Z`, ss + IOS_AT, 6);
        call(`?setf@${IOSB}QAEHHH@Z`, ss + IOS_AT, 0x800 | 0x8, 0xe00 | 0x8);
        call(`??6${OS('D')}QAEAAV01@H@Z`, ss + 8, 255);
        call(`??6${OS('D')}QAEAAV01@H@Z`, ss + 8, 1);
    }), '  0xff0x1');
    assert.equal(written(ss=>call(`??6${OS('G')}QAEAAV01@G@Z`, ss + 8, 65), 2), '65');
});

test('a stringbuf grows past its storage and str() answers all that was written', ()=>{
    const { call, room, text, cstr } = setup();
    const ss = room(SS_SIZE);
    call(`??0${SS('D')}QAE@H@Z`, ss, OPENMODE.OUT, 1);
    const line = cstr('0123456789');
    const put = `??6std@@YAAAV?$basic_ostream@${T('D')}@0@AAV10@PBD@Z`;
    for (let i = 0; i < 10; i++)
    {
        call(put, ss + 8, line);
    }
    const out = room(16);
    call(`?str@${SS('D')}QBE?AV${STRING('D').replace(/std@@$/, '')}2@XZ`, ss, out);
    assert.equal(text(out), '0123456789'.repeat(10));
    call(`??_D${SS('D')}QAEXXZ`, ss);
});

test('istream: ignore up to a delimiter, getline into a string, peek at the end', ()=>{
    const { call, string, room, text } = setup();
    const ss = room(SS_SIZE);
    call(`??0${SS('D')}QAE@ABV${STRING('D').replace(/std@@$/, '')}1@H@Z`, ss,
        string('key = value\nnext'), OPENMODE.IN | OPENMODE.OUT, 1);
    call(`?ignore@${IS('D')}QAEAAV12@HH@Z`, ss, 0x7fffffff, '='.charCodeAt(0));
    const line = string('');
    const getline = `??$getline@${T('D')}V?$allocator@D@2@@std@@YAAAV?$basic_istream@${T('D')}@0@`
        + `AAV10@AAV?$basic_string@${T('D')}V?$allocator@D@2@@0@D@Z`;
    call(getline, ss, line, 0x0a);
    assert.equal(text(line), ' value');
    call(getline, ss, line, 0x0a);
    assert.equal(text(line), 'next');
    assert.equal(call(`?rdstate@${IOSB}QBEHXZ`, ss + IOS_AT), 1);
    call(`?clear@${IOSB}QAEXH_N@Z`, ss + IOS_AT, 0, 0);
    assert.equal(call(`?peek@${IS('D')}QAEHXZ`, ss) | 0, -1);
    assert.equal(call(`?rdstate@${IOSB}QBEHXZ`, ss + IOS_AT), 1);
    call(`??_D${SS('D')}QAEXXZ`, ss);
});

test('an fstream seeks and tells through the runtime\'s FILE', ()=>{
    const { call, room, cstr, view, files } = setup({ 'data.txt': 'ABCDEF' });
    const FS = `?$basic_fstream@${T('D')}@std@@`;
    const fs = room(148);
    call(`??0${FS}QAE@PBDH@Z`, fs, cstr('data.txt'), OPENMODE.IN | OPENMODE.OUT, 1);
    assert.equal(call(`?rdstate@${IOSB}QBEHXZ`, fs + 96), 0);
    call(`?seekg@${IS('D')}QAEAAV12@JW4seekdir@ios_base@2@@Z`, fs, 3, 0);
    assert.equal(call(`?get@${IS('D')}QAEHXZ`, fs), 'D'.charCodeAt(0));
    const pos = room(24);
    call(`?tellg@${IS('D')}QAE?AV?$fpos@H@2@XZ`, fs, pos);
    assert.deepEqual([view.getInt32(pos, true), Number(view.getBigInt64(pos + 8, true))], [0, 4]);
    call(`??6std@@YAAAV?$basic_ostream@${T('D')}@0@AAV10@D@Z`, fs + 8, 'x'.charCodeAt(0));
    call(`??_D${FS}QAEXXZ`, fs);
    assert.equal(files['data.txt'], 'ABCDxF');
    const missing = room(148);
    call(`??0${FS}QAE@PBDH@Z`, missing, cstr('none.txt'), OPENMODE.IN, 1);
    assert.equal(call(`?rdstate@${IOSB}QBEHXZ`, missing + 96), 2);
});

test('cout is laid out whole before any call and writes to stdout', ()=>{
    const { call, placed, view, cstr, open, IOB } = setup();
    const cout = /** @type {number} */ (placed.get(`?cout@std@@3V?$basic_ostream@${T('D')}@1@A`));
    const cin = /** @type {number} */ (placed.get(`?cin@std@@3V?$basic_istream@${T('D')}@1@A`));
    assert.equal(view.getInt32(view.getUint32(cout, true) + 4, true), 4);
    assert.equal(view.getUint32(cin + 8 + IOS.TIE, true), cout);
    assert.equal(call(`?flags@${IOSB}QBEHXZ`, cout + 4), 0x201);
    call(`??6std@@YAAAV?$basic_ostream@${T('D')}@0@AAV10@PBD@Z`, cout, cstr('hi '));
    call(`??6${OS('D')}QAEAAV01@H@Z`, cout, 42);
    const endl = /** @type {number} */ (placed.get(`?endl@std@@YAAAV?$basic_ostream@${T('D')}@1@AAV21@@Z`));
    call(`??6${OS('D')}QAEAAV01@P6AAAV01@AAV01@@Z@Z`, cout, endl);
    assert.equal(String.fromCharCode(.../** @type {{ text: number[] }} */ (open.get(IOB + 32)).text), 'hi 42\n');
});

test('a locale by name says its decimal point; a name that is none is runtime_error', ()=>{
    const { call, room, cstr, text, thrown } = setup();
    const lcl = room(4);
    call('??0locale@std@@QAE@PBDH@Z', lcl, cstr('German_Germany.1252'), 0x3f);
    const name = room(16);
    call(`?name@locale@std@@QBE?AV${STRING('D').replace(/std@@$/, '')}2@XZ`, lcl, name);
    assert.equal(text(name), 'German_Germany.1252');
    call('??1locale@std@@QAE@XZ', lcl);
    const bad = room(4);
    assert.ok(call('??0locale@std@@QAE@PBDH@Z', bad, cstr('Klingon'), 0x3f) instanceof Promise);
    assert.equal(thrown.length, 1);
});

test('a stream buffer of the program\'s own class is not run, said once as a loss', ()=>{
    const { call, room, said, view } = setup();
    const buffer = room(LAYOUT.SB.SIZE);
    call(`??0?$basic_streambuf@${T('D')}@std@@IAE@XZ`, buffer);
    // A vtable of the program's: its slots are code the library does not have.
    view.setUint32(buffer, room(52), true);
    const is = room(60);
    call(`??0${IS('D')}QAE@PAV?$basic_streambuf@${T('D')}@1@_N@Z`, is, buffer, 0, 1);
    assert.equal(call(`?get@${IS('D')}QAEHXZ`, is) | 0, -1);
    call(`?clear@${IOSB}QAEXH_N@Z`, is + 8, 0, 0);
    call(`?get@${IS('D')}QAEHXZ`, is);
    assert.equal(said.filter(line=>line.includes('own class')).length, 1);
    assert.match(said[0], /\(loss\)$/);
});
