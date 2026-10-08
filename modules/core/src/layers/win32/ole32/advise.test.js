/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// The advise holders as MSDN documents IDataAdviseHolder and
// IOleAdviseHolder: connections numbered from one, a reference on each
// sink, and the ADVF_* flags of each connection honoured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdviseFunctions } from './advise.js';
import { E_INVALIDARG, S_FALSE, S_OK, oleProcess } from './ole2.fixture.js';

const OLE_E_NOCONNECTION = 0x80040004 | 0;
const ADVF_NODATA = 1;
const ADVF_PRIMEFIRST = 2;
const ADVF_ONLYONCE = 4;
const CF_TEXT = 1;

/** IDataAdviseHolder's and IOleAdviseHolder's slots. */
const DATA = Object.freeze({ ADVISE: 3, UNADVISE: 4, ENUM: 5, SEND: 6 });
const OLE = Object.freeze({ ADVISE: 3, UNADVISE: 4, ENUM: 5, RENAME: 6, SAVE: 7, CLOSE: 8 });

function setup(){
    const p = oleProcess();
    const fns = createAdviseFunctions(p.env);
    /** @type {string[]} */
    const told = [];
    /** A sink of the program's that writes down what it is told. @param {string} name */
    const sink = name=>p.guestObject([], {
        3: ([format, medium])=>{
            told.push(`${name} data ${p.u32(format)} ${p.u32(medium)}`);
        },
        5: ([moniker])=>{
            told.push(`${name} rename ${moniker}`);
        },
        6: ()=>{
            told.push(`${name} save`);
        },
        7: ()=>{
            told.push(`${name} close`);
        },
    });
    /** A data object of the program's whose GetData hands out a block of text. */
    const data = p.guestObject([], {
        3: ([, medium])=>{
            const block = p.heap.allocate(4);
            p.put(medium, 1);
            p.put(medium + 4, block);
            p.put(medium + 8, 0);
            return S_OK;
        },
    });
    const format = p.out(0, 20);
    p.put(format, CF_TEXT);
    p.put(format + 8, 1);
    p.put(format + 12, -1);
    p.put(format + 16, 1);
    return { p, fns, told, sink, data, format };
}

test('a data advise holder tells each sink of a change, with the data it asked for', async()=>{
    const { p, fns, told, sink, data, format } = setup();
    assert.equal(fns.CreateDataAdviseHolder.argBytes, 4);
    assert.equal(fns.CreateDataAdviseHolder.handler([0]), E_INVALIDARG);
    const out = p.out();
    assert.equal(fns.CreateDataAdviseHolder.handler([out]), S_OK);
    const holder = p.u32(out);

    const first = sink('first');
    const second = sink('second');
    const connection = p.out();
    assert.equal(await p.callMethod(holder, DATA.ADVISE, [0, format, 0, first.pointer,
        connection]), S_OK);
    assert.equal(p.u32(connection), 1, 'numbered from one');
    assert.equal(await p.callMethod(holder, DATA.ADVISE, [0, format, ADVF_NODATA,
        second.pointer, connection]), S_OK);
    assert.equal(p.u32(connection), 2);
    assert.deepEqual([first.refs, second.refs], [2, 2], 'the holder holds each');

    assert.equal(await p.callMethod(holder, DATA.SEND, [data.pointer, 0, 0]), S_OK);
    assert.equal(told.length, 2);
    assert.match(told[0], /^first data 1 1$/, 'the format, and an HGLOBAL medium');
    assert.equal(told[1], 'second data 1 0', 'ADVF_NODATA: an empty medium');
    assert.equal(p.releasedMedia.length, 1, 'the data released after the notice');

    assert.equal(await p.callMethod(holder, DATA.UNADVISE, [1]), S_OK);
    assert.equal(first.refs, 1);
    assert.equal(await p.callMethod(holder, DATA.UNADVISE, [1]), OLE_E_NOCONNECTION);
    assert.equal(await p.callMethod(holder, DATA.ADVISE, [0, 0, 0, first.pointer, connection]),
        E_INVALIDARG, 'no format');
    assert.equal(p.u32(connection), 0);

    assert.equal(await p.callMethod(holder, 2, []), 0);
    assert.equal(second.refs, 1, 'the last release lets every sink go');
});

test('ADVF_PRIMEFIRST tells a sink at once, ADVF_ONLYONCE only once', async()=>{
    const { p, fns, told, sink, data, format } = setup();
    const out = p.out();
    fns.CreateDataAdviseHolder.handler([out]);
    const holder = p.u32(out);
    const once = sink('once');
    const connection = p.out();
    assert.equal(await p.callMethod(holder, DATA.ADVISE, [data.pointer, format,
        ADVF_PRIMEFIRST, once.pointer, connection]), S_OK);
    assert.equal(told.length, 1, 'told on advising');
    assert.equal(await p.callMethod(holder, DATA.ADVISE, [data.pointer, format, ADVF_ONLYONCE,
        once.pointer, connection]), S_OK);
    await p.callMethod(holder, DATA.SEND, [data.pointer, 0, 0]);
    await p.callMethod(holder, DATA.SEND, [data.pointer, 0, 0]);
    assert.equal(told.length, 1 + 2 + 1, 'the once-only sink told one time');
    assert.equal(once.refs, 2, 'and let go of');
    await p.callMethod(holder, 2, []);
    assert.equal(once.refs, 1);
});

test('EnumAdvise lists the connections, each sink handed out with a reference', async()=>{
    const { p, fns, sink, format } = setup();
    const out = p.out();
    fns.CreateDataAdviseHolder.handler([out]);
    const holder = p.u32(out);
    const one = sink('one');
    await p.callMethod(holder, DATA.ADVISE, [0, format, ADVF_NODATA, one.pointer, 0]);
    const enumOut = p.out();
    assert.equal(await p.callMethod(holder, DATA.ENUM, [enumOut]), S_OK);
    const enumerator = p.u32(enumOut);
    const statdata = p.out(0, 64);
    const fetched = p.out();
    assert.equal(await p.callMethod(enumerator, 3, [2, statdata, fetched]), S_FALSE);
    assert.equal(p.u32(fetched), 1);
    assert.deepEqual([p.u32(statdata), p.u32(statdata + 20), p.u32(statdata + 24),
        p.u32(statdata + 28)], [CF_TEXT, ADVF_NODATA, one.pointer, 1]);
    assert.equal(one.refs, 4, 'the holder, the snapshot and the caller');
    await p.callMethod(one.pointer, 2, []);
    await p.callMethod(enumerator, 2, []);
    assert.equal(one.refs, 2);
});

test('an OLE advise holder sends renames, saves and closes to every sink', async()=>{
    const { p, fns, told, sink } = setup();
    assert.equal(fns.CreateOleAdviseHolder.argBytes, 4);
    const out = p.out();
    assert.equal(fns.CreateOleAdviseHolder.handler([out]), S_OK);
    const holder = p.u32(out);
    const a = sink('a');
    const b = sink('b');
    const connection = p.out();
    assert.equal(await p.callMethod(holder, OLE.ADVISE, [a.pointer, connection]), S_OK);
    assert.equal(p.u32(connection), 1);
    assert.equal(await p.callMethod(holder, OLE.ADVISE, [b.pointer, connection]), S_OK);
    assert.equal(await p.callMethod(holder, OLE.ADVISE, [b.pointer, 0]), E_INVALIDARG);
    assert.equal(await p.callMethod(holder, OLE.RENAME, [0x1234]), S_OK);
    assert.equal(await p.callMethod(holder, OLE.SAVE, []), S_OK);
    assert.equal(await p.callMethod(holder, OLE.UNADVISE, [1]), S_OK);
    assert.equal(await p.callMethod(holder, OLE.CLOSE, []), S_OK);
    assert.deepEqual(told, [`a rename ${0x1234}`, `b rename ${0x1234}`, 'a save', 'b save',
        'b close']);
    assert.equal(await p.callMethod(holder, OLE.UNADVISE, [7]), OLE_E_NOCONNECTION);
    const enumOut = p.out();
    assert.equal(await p.callMethod(holder, OLE.ENUM, [enumOut]), S_OK);
    await p.callMethod(p.u32(enumOut), 2, []);
    await p.callMethod(holder, 2, []);
    assert.deepEqual([a.refs, b.refs], [1, 1]);
});
