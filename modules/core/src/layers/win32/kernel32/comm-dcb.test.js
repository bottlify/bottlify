/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommSettings, parseCommString } from './comm-dcb.js';

/**
 * The DCB a string makes of one filled with `fill`, as its fields.
 *
 * @param {string} text @param {number} fill
 */
function build(text, fill){
    const settings = parseCommString(text);
    const dcb = new Uint8Array(28).fill(fill);
    const timeouts = new Uint8Array(20).fill(fill);
    if (settings)
    {
        applyCommSettings(settings, dcb, timeouts);
    }
    const view = new DataView(dcb.buffer);
    const bits = view.getUint32(8, true);
    const times = new DataView(timeouts.buffer);
    return {
        ok: settings !== null,
        length: view.getUint32(0, true), baud: view.getUint32(4, true),
        binary: bits & 1, parity: (bits >>> 1) & 1, cts: (bits >>> 2) & 1, dsr: (bits >>> 3) & 1,
        dtr: (bits >>> 4) & 3, dsrSense: (bits >>> 6) & 1, outX: (bits >>> 8) & 1,
        inX: (bits >>> 9) & 1, rts: (bits >>> 12) & 3,
        size: dcb[18], parityKind: dcb[19], stop: dcb[20],
        timeouts: [0, 4, 8, 12, 16].map(at=>times.getUint32(at, true)),
    };
}

test('the new form sets what it names, and one stop bit unless told otherwise', ()=>{
    const first = build('baud=9600 parity=e data=5 stop=1 xon=on odsr=off octs=off dtr=on '
        + 'rts=on idsr=on', 0);
    assert.deepEqual([first.ok, first.baud, first.parityKind, first.size, first.stop],
        [true, 9600, 2, 5, 0]);
    assert.deepEqual([first.outX, first.inX, first.dsr, first.cts, first.dtr, first.rts,
        first.dsrSense], [1, 1, 0, 0, 1, 1, 1]);
    assert.equal(first.parity, 0, 'fParity is left alone');

    const kept = build('PaRiTy=s           Data=7          DTR=on', 0xff);
    assert.deepEqual([kept.ok, kept.baud, kept.parityKind, kept.size, kept.stop, kept.dtr],
        [true, 0xffffffff, 4, 7, 0, 1], 'unnamed fields kept, the stop bits set to one');
    assert.deepEqual([kept.length, kept.binary, kept.parity, kept.rts], [0xffffffff, 1, 1, 3]);

    const big = build('BAUD=4000000000 parity=n data=7 stop=2 to=off', 0xff);
    assert.deepEqual([big.baud, big.stop, big.timeouts], [4000000000, 2, [0, 0, 0, 0, 0]]);
    assert.deepEqual(build('Baud=115200 Parity=O Data=8 To=On', 0xff).timeouts,
        [0, 0, 0, 0, 60000]);
    assert.deepEqual(build('baud=0 parity=M data=6 stop=1.5', 0xff).timeouts,
        [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], 'no to=: untouched');
    assert.equal(build('COM3 : xon=on odsr=off', 0xff).dsr, 0);
});

test('the old form sets the flow control, and takes the two-digit baud rates', ()=>{
    const none = build('30 ,E, 5,1.5', 0xff);
    assert.deepEqual([none.baud, none.parityKind, none.size, none.stop], [300, 2, 5, 1]);
    assert.deepEqual([none.cts, none.dsr, none.dtr, none.rts, none.outX, none.inX],
        [0, 0, 1, 1, 0, 0]);
    const hardware = build('48,n,8,1,p', 0);
    assert.deepEqual([hardware.baud, hardware.cts, hardware.dsr, hardware.dtr, hardware.rts,
        hardware.outX], [4800, 1, 1, 2, 2, 0]);
    const software = build('96,N,8,1 , x ', 0);
    assert.deepEqual([software.baud, software.outX, software.inX, software.dtr, software.rts],
        [9600, 1, 1, 1, 1]);
    assert.equal(build('4000000000,O,7,1.5,X', 0).baud, 4000000000);
    assert.equal(build('COM1:  11,E,7,2', 0).baud, 110);
});

test('what Windows refuses changes nothing', ()=>{
    for (const text of ['data=4', 'data=9', 'parity=no', 'stop=0', 'stop=1.501', 'stop=3',
        'to=foobar', ' baud=9600', 'baud= 9600', 'baud=9600,data=8', '96,N,8,1 to=on',
        '96,NO,8,1', '96,N,4,1', '96,N,9,1', '96,N,8,0', '96,N,8,3', '96,N,8,1,K',
        'COM0:baud=115200', 'COM0:9600,N,8,1'])
    {
        const result = build(text, 0xff);
        assert.equal(result.ok, false, text);
        assert.deepEqual([result.baud, result.size, result.timeouts[4]],
            [0xffffffff, 0xff, 0xffffffff], text);
    }
});
