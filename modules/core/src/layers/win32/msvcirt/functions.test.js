/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIostreamFunctions } from './functions.js';
import { formatToString } from '../msvcrt/format.js';

/**
 * A flat memory, a bump heap, an export address per name, and guest methods
 * as JS functions at addresses of their own.
 *
 * @param {{ files?: Record<string, string> }} [options]
 */
function harness({ files = {} } = {}){
    const memory = new Uint8Array(1 << 20);
    let next = 0x1000;
    /** @type {Map<string, number>} */
    const exports = new Map();
    /** @type {Map<number, Function>} */
    const guest = new Map();
    /** @type {{ entry: number, args: number[], ecx: number }[]} */
    const calls = [];
    /** @type {Map<number, { text: string, at: number }>} */
    const descriptors = new Map();
    const readCString = (/** @type {number} */ at, /** @type {number} */ max)=>{
        let text = '';
        for (let i = at; i < at + max && memory[i] !== 0; i++)
        {
            text += String.fromCharCode(memory[i]);
        }
        return text;
    };
    const table = createIostreamFunctions({
        readMemory: (at, length)=>memory.slice(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readCString,
        addressOf: name=>{
            if (!exports.has(name))
            {
                exports.set(name, 0x80000 + exports.size * 16);
            }
            return /** @type {number} */ (exports.get(name));
        },
        allocate: bytes=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        release: ()=>{},
        locks: { init: ()=>0, remove: ()=>0, enter: ()=>0, leave: ()=>0 },
        crt: {
            open: path=>{
                const name = readCString(path, 260);
                if (!(name in files))
                {
                    return -1;
                }
                descriptors.set(3, { text: files[name], at: 0 });
                return 3;
            },
            close: fd=>(descriptors.delete(fd) ? 0 : -1),
            read: (fd, buffer, count)=>{
                const file = descriptors.get(fd);
                if (!file)
                {
                    return -1;
                }
                const piece = file.text.slice(file.at, file.at + count);
                memory.set(Uint8Array.from(piece, c=>c.charCodeAt(0)), buffer);
                file.at += piece.length;
                return piece.length;
            },
            write: ()=>-1,
            seek: (fd, offset, origin)=>{
                const file = /** @type {{ text: string, at: number }} */ (descriptors.get(fd));
                file.at = [0, file.at, file.text.length][origin] + offset;
                return file.at;
            },
            setmode: ()=>0x8000,
        },
        call: async({ entry, args, ecx })=>{
            calls.push({ entry, args, ecx });
            return /** @type {Function} */ (guest.get(entry))(ecx, ...args);
        },
        callerThread: ()=>({}),
        format: (format, words)=>formatToString(format, words, ()=>''),
    });
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>table[name].handler(args);
    const u32 = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    /** @param {string} text */
    const string = text=>{
        const at = next;
        memory.set(Uint8Array.from(`${text}\0`, c=>c.charCodeAt(0)), at);
        next += (text.length + 16) & ~15;
        return at;
    };
    /** @param {number} bytes */
    const object = bytes=>{
        const at = next;
        next += (bytes + 15) & ~15;
        return at;
    };
    return { memory, table, call, u32, string, object, readCString, exports, guest, calls };
}

const IOS_STATE = 8;
const EOF = -1;

test('an istrstream reads its buffer through the ios the vbtable names', ()=>{
    const h = harness();
    const text = h.string('ab\ncd');
    const stream = h.object(0x5c);
    assert.equal(h.call('??0istrstream@@QAE@PADH@Z', stream, text, 5, 1), stream);
    const ios = stream + h.u32(h.u32(stream) + 4);
    assert.equal(ios, stream + 12, 'the ios follows the istream fields');
    assert.equal(h.u32(ios + IOS_STATE), 0, 'good, with a buffer');
    assert.equal(h.u32(ios + 36) & 1, 1, 'skipws');

    assert.equal(h.call('?get@istream@@QAEHXZ', stream), 0x61);
    assert.equal(h.call('?tellg@istream@@QAEJXZ', stream), 1);
    const into = h.object(8);
    h.call('?read@istream@@QAEAAV1@PADH@Z', stream, into, 3);
    assert.equal(h.readCString(into, 3), 'b\nc');
    assert.equal(h.u32(stream + 8), 3, 'gcount');
    h.call('?read@istream@@QAEAAV1@PADH@Z', stream, into, 4);
    assert.equal(h.u32(stream + 8), 1, 'only what was left');
    assert.equal(h.u32(ios + IOS_STATE), 3, 'eof and fail');
    assert.equal(h.call('?get@istream@@QAEHXZ', stream), EOF, 'a failed stream reads nothing');

    h.call('?clear@ios@@QAEXH@Z', ios, 0);
    h.call('?seekg@istream@@QAEAAV1@J@Z', stream, 3);
    assert.equal(h.call('?get@istream@@QAEHXZ', stream), 0x63);
    h.call('?seekg@istream@@QAEAAV1@JW4seek_dir@ios@@@Z', stream, -1, 2);
    assert.equal(h.call('?get@istream@@QAEHXZ', stream), 0x64);
    h.call('??_Distrstream@@QAEXXZ', stream);
    assert.equal(h.u32(ios + 4), 0, 'the buffer went with the stream');
});

test('an ostrstream formats numbers by the flags and grows its own buffer', ()=>{
    const h = harness();
    const stream = h.object(0x58);
    h.call('??0ostrstream@@QAE@XZ', stream, 1);
    const ios = stream + 8;
    h.call('??6ostream@@QAEAAV0@PBD@Z', stream, h.string('x='));
    h.call('??6ostream@@QAEAAV0@H@Z', stream, -42);
    h.call('??6ostream@@QAEAAV0@E@Z', stream, 0x20);
    new DataView(h.memory.buffer).setUint32(ios + 36, 0x40 | 0x80 | 0x200, true);
    h.call('??6ostream@@QAEAAV0@K@Z', stream, 255);
    new DataView(h.memory.buffer).setUint32(ios + 36, 0x2, true);
    new DataView(h.memory.buffer).setUint32(ios + 48, 5, true);
    h.memory[ios + 44] = 0x2a;
    h.call('??6ostream@@QAEAAV0@I@Z', stream, 7);
    const words = new DataView(new ArrayBuffer(8));
    words.setFloat64(0, 2.5, true);
    new DataView(h.memory.buffer).setUint32(ios + 36, 0, true);
    h.call('??6ostream@@QAEAAV0@N@Z', stream, words.getUint32(0, true), words.getUint32(4, true));
    h.call('?ends@@YAAAVostream@@AAV1@@Z', stream);
    const sb = h.u32(ios + 4);
    const text = h.call('?str@strstreambuf@@QAEPADXZ', sb);
    assert.equal(h.readCString(text, 100), 'x=-42 0XFF7****2.5');
    assert.equal(h.u32(ios + 48), 0, 'the width is used once');
});

test('a strstreambuf of the program\'s own is called through its own vtable', async()=>{
    const h = harness();
    const sb = h.object(0x64);
    h.call('??0strstreambuf@@QAE@H@Z', sb, 16);
    // The program's class: this library's vtable with overflow its own.
    const vtable = h.object(44);
    h.memory.copyWithin(vtable, h.u32(sb), h.u32(sb) + 44);
    const override = 0x90000;
    new DataView(h.memory.buffer).setUint32(vtable + 7 * 4, override, true);
    new DataView(h.memory.buffer).setUint32(sb, vtable, true);
    const overflow = h.exports.get('?overflow@strstreambuf@@UAEHH@Z');
    h.guest.set(override, (/** @type {number} */ self, /** @type {number} */ c)=>
        h.table['?overflow@strstreambuf@@UAEHH@Z'].handler([self, c]));

    const stream = h.object(0x60);
    h.call('??0iostream@@QAE@PAVstreambuf@@@Z', stream, sb, 1);
    assert.equal(h.u32(stream + 0x14 + 4), sb, 'the ios holds the program\'s buffer');
    await h.call('??6ostream@@QAEAAV0@PBD@Z', stream + 12, h.string('hi'));
    assert.ok(h.calls.some(call=>call.entry === override && call.ecx === sb),
        'the override ran, with this in ecx');
    assert.ok(overflow);
    assert.equal(h.call('?get@istream@@QAEHXZ', stream), 0x68, 'and what it wrote reads back');
});

test('an ifstream reads a file through its filebuf', ()=>{
    const h = harness({ files: { 'a.txt': 'line' } });
    const stream = h.object(0x5c);
    h.call('??0ifstream@@QAE@PBDHH@Z', stream, h.string('a.txt'), 1, 0x180, 1);
    assert.equal(h.u32(stream + 12 + IOS_STATE), 0);
    const into = h.object(8);
    h.call('?read@istream@@QAEAAV1@PADH@Z', stream, into, 4);
    assert.equal(h.readCString(into, 4), 'line');
    h.call('?close@ifstream@@QAEXXZ', stream);
    assert.equal(h.u32(stream + 12 + IOS_STATE), 0);

    const missing = h.object(0x5c);
    h.call('??0ifstream@@QAE@PBDHH@Z', missing, h.string('b.txt'), 1, 0x180, 1);
    assert.equal(h.u32(missing + 12 + IOS_STATE) & 2, 2, 'a file that is not there fails');
});

test('each virtual method pops what its caller pushed', ()=>{
    const { table } = harness();
    assert.equal(table['?seekoff@strstreambuf@@UAEJJW4seek_dir@ios@@H@Z'].argBytes, 16);
    assert.equal(table['?underflow@strstreambuf@@UAEHXZ'].argBytes, 4);
    assert.equal(table['?xsputn@streambuf@@UAEHPBDH@Z'].argBytes, 12);
    assert.equal(table['??_Eistrstream@@UAEPAXI@Z'].argBytes, 8);
    assert.equal(table['??0istrstream@@QAE@PADH@Z'].argBytes, 16, 'buffer, length, most derived');
    assert.equal(table._mtlock.convention, 'cdecl');
});
