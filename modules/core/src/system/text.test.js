/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decoderFor, downcaseName, downcaseUnit, foldName, foldUnits, sameName, upcaseUnit,
    utf16be, utf16le, utf8, windows1252 } from './text.js';

test('RtlUpcaseUnicodeChar over Latin-1, as Wine checks it against Windows', ()=>{
    for (let unit = 0; unit <= 0xff; unit++)
    {
        const expected = unit >= 0x61 && unit <= 0x7a ? unit - 0x20
            : unit >= 0xe0 && unit <= 0xfe && unit !== 0xf7 ? unit - 0x20
                : unit === 0xff ? 0x178 : unit;
        assert.equal(upcaseUnit(unit), expected, unit.toString(16));
    }
});

test('RtlDowncaseUnicodeString over Latin-1, as Wine checks it against Windows', ()=>{
    for (let unit = 0; unit <= 0xff; unit++)
    {
        const expected = unit >= 0x41 && unit <= 0x5a ? unit + 0x20
            : unit >= 0xc0 && unit <= 0xde && unit !== 0xd7 ? unit + 0x20 : unit;
        assert.equal(downcaseUnit(unit), expected, unit.toString(16));
    }
    assert.equal(downcaseUnit(0x178), 0xff);
});

test('a mapping that does not round-trip is not in the table', ()=>{
    // The dotless i upper-cases to I in Unicode, and I lower-cases to i: Windows keeps it.
    assert.equal(upcaseUnit(0x131), 0x131);
    // The dotted capital I lower-cases to i, and i upper-cases to I.
    assert.equal(downcaseUnit(0x130), 0x130);
    assert.equal(upcaseUnit(0x69), 0x49);
    // The Kelvin sign and the ohm sign lower-case to letters that do not come back.
    assert.equal(downcaseUnit(0x212a), 0x212a);
    assert.equal(downcaseUnit(0x2126), 0x2126);
    assert.equal(upcaseUnit(0x6b), 0x4b);
    // Final sigma, long s, the titlecase digraph: their capitals lower-case elsewhere.
    assert.equal(upcaseUnit(0x3c2), 0x3c2);
    assert.equal(upcaseUnit(0x3c3), 0x3a3);
    assert.equal(upcaseUnit(0x17f), 0x17f);
    assert.equal(upcaseUnit(0x1c5), 0x1c5);
    assert.equal(upcaseUnit(0x1c6), 0x1c4);
    // The micro sign keeps itself; the Greek capital theta symbol its own lower case.
    assert.equal(upcaseUnit(0xb5), 0xb5);
    assert.equal(downcaseUnit(0x3f4), 0x3f4);
});

test('one unit to one unit: what a longer mapping would replace keeps itself', ()=>{
    assert.equal(upcaseUnit(0xdf), 0xdf);
    assert.equal(upcaseUnit(0x1e9e), 0x1e9e);
    assert.equal(downcaseUnit(0x1e9e), 0x1e9e);
    assert.equal(upcaseUnit(0xfb00), 0xfb00);
    // A small letter with ypogegrammeni takes its simple mapping, the titlecase letter.
    assert.equal(upcaseUnit(0x1f80), 0x1f88);
    assert.equal(downcaseUnit(0x1f88), 0x1f80);
});

test('foldName: length kept, surrogates folded apart and unchanged', ()=>{
    assert.equal(foldName('Program Files\\setup.EXE'), 'PROGRAM FILES\\SETUP.EXE');
    assert.equal(foldName('straße'), 'STRAßE');
    assert.equal(foldName('ÿıi\u{fb00}'), 'ŸıI\u{fb00}');
    const pair = 'a\u{1d400}\u{10428}b';
    assert.equal(foldName(pair), 'A\u{1d400}\u{10428}B');
    assert.equal(foldName('\ud801x'), '\ud801X');
    for (const name of ['straße', 'İstanbul', '\ufb00', 'ǅ', pair, 'x'.repeat(20000) + 'é'])
    {
        assert.equal(foldName(name).length, name.length, name.slice(0, 8));
        assert.equal(downcaseName(name).length, name.length, name.slice(0, 8));
    }
    assert.equal(foldName('x'.repeat(20000) + 'é'), 'X'.repeat(20000) + 'É');
    assert.equal(downcaseName('ÀBÇ\u212a'), 'àbç\u212a');
});

test('sameName: as Windows compares names', ()=>{
    assert.ok(sameName('Kernel32.DLL', 'kernel32.dll'));
    assert.ok(sameName('ÿ', 'Ÿ'));
    assert.ok(!sameName('\u212a', 'k'));
    assert.ok(!sameName('ß', 'SS'));
    assert.ok(!sameName('ı', 'i'));
    assert.ok(!sameName('ς', 'σ'));
});

test('foldUnits folds in place and only the range asked', ()=>{
    const units = Uint16Array.from('abÿc', c=>c.charCodeAt(0));
    assert.equal(foldUnits(units, 1, 3), units);
    assert.equal(String.fromCharCode(...units), 'aBŸc');
});

test('the codecs: UTF-8 both ways, UTF-16 either order, Windows-1252', ()=>{
    const bytes = utf8.encode('aé\u{1f600}');
    assert.deepEqual([...bytes], [0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]);
    assert.equal(utf8.decode(bytes), 'aé\u{1f600}');
    assert.equal(utf8.decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41, 0xff)), 'A\ufffd');
    const into = new Uint8Array(4);
    assert.deepEqual(utf8.encodeInto('héllo', into), { read: 3, written: 4 });
    assert.equal(utf16le.decode(Uint8Array.of(0xff, 0xfe, 0x41, 0, 0x3d, 0xd8)), 'A\ufffd');
    assert.equal(utf16be.decode(Uint8Array.of(0, 0x41, 0x30, 0x42)), 'A\u3042');
    assert.equal(windows1252.decode(Uint8Array.of(0x41, 0x80, 0xe9)), 'A€é');
    assert.equal(utf8.decode(utf8.encode('x').buffer), 'x');
});

test('a view of shared memory decodes as its bytes', ()=>{
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    shared.set([0x61, 0x62, 0x63, 0x64], 2);
    assert.equal(utf8.decode(shared.subarray(2, 5)), 'abc');
    assert.equal(utf16le.decode(shared.subarray(2, 6)), '\u6261\u6463');
});

test('decoderFor makes one decoder per label and mode', ()=>{
    assert.equal(decoderFor('shift_jis'), decoderFor('shift_jis'));
    assert.notEqual(decoderFor('shift_jis'), decoderFor('shift_jis', { fatal: true }));
    assert.equal(decoderFor('shift_jis').decode(Uint8Array.of(0x82, 0xa0)), '\u3042');
    assert.throws(()=>decoderFor('shift_jis', { fatal: true }).decode(Uint8Array.of(0x82)));
    assert.throws(()=>decoderFor('no-such-page'), RangeError);
});
