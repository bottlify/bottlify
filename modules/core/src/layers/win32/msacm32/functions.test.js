/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcmFunctions } from './functions.js';

/** A flat guest and a callback that records what the manager hands it. */
function fixture(){
    const bytes = new Uint8Array(0x20000);
    const view = new DataView(bytes.buffer);
    /** @type {number[][]} */
    const calls = [];
    const fns = createAcmFunctions({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        callGuest: (entry, args)=>{
            calls.push([entry, ...args]);
            return Promise.resolve(1);
        },
        currentThread: ()=>'t',
    });
    /** @param {string} name @param {number[]} args */
    const call = (name, args = [])=>fns[name].handler(args);
    return { bytes, view, fns, calls, call };
}

/**
 * A WAVEFORMATEX at `at`, with the ADPCM formats' samples-per-block after it.
 *
 * @param {DataView} view @param {number} at
 * @param {{ tag: number, channels: number, rate: number, blockAlign: number, bits: number,
 *     samplesPerBlock?: number }} format
 */
function writeFormat(view, at, format){
    view.setUint16(at, format.tag, true);
    view.setUint16(at + 2, format.channels, true);
    view.setUint32(at + 4, format.rate, true);
    view.setUint32(at + 8, format.rate * format.blockAlign, true);
    view.setUint16(at + 12, format.blockAlign, true);
    view.setUint16(at + 14, format.bits, true);
    view.setUint16(at + 16, format.samplesPerBlock === undefined ? 0 : 2, true);
    if (format.samplesPerBlock !== undefined)
    {
        view.setUint16(at + 18, format.samplesPerBlock, true);
    }
}

test('every export pops its stack, and the version is the manager\'s own', ()=>{
    const { fns } = fixture();
    assert.equal(fns.acmGetVersion.handler([]), 0x04000000);
    assert.equal(fns.acmStreamOpen.argBytes, 32, 'eight dwords');
    assert.equal(fns.acmFormatEnumA.argBytes, 20);
    assert.equal(Object.keys(fns).length, 42);
    for (const [name, entry] of Object.entries(fns))
    {
        assert.ok(Number.isInteger(entry.argBytes), `${name} declares its stack width`);
    }
});

test('the drivers a Windows install has are enumerated, described and opened', async()=>{
    const f = fixture();
    assert.equal(await f.call('acmDriverEnum', [0x7777, 0x55, 0]), 0);
    assert.equal(f.calls.length, 3, 'MS ADPCM, IMA ADPCM and the PCM converter');
    assert.deepEqual(f.calls.map(([, , instance, support])=>[instance, support]),
        [[0x55, 1], [0x55, 1], [0x55, 2]]);
    const ima = f.calls[1][1];

    const DETAILS = 0x1000;
    f.view.setUint32(DETAILS, 920, true);
    assert.equal(f.call('acmDriverDetailsA', [ima, DETAILS, 0]), 0);
    assert.equal(f.view.getUint32(DETAILS + 24, true), 1, 'a codec');
    assert.equal(new TextDecoder().decode(f.bytes.subarray(DETAILS + 40, DETAILS + 49)),
        'IMA ADPCM');

    assert.equal(f.call('acmDriverOpen', [0x1400, ima, 0]), 0);
    const opened = f.view.getUint32(0x1400, true);
    assert.equal(f.call('acmMetrics', [opened, 100, 0x1404]), 0);
    assert.equal(f.view.getUint32(0x1404, true), 1, 'DRIVER_SUPPORT of the handle');
    assert.equal(f.call('acmMetrics', [0, 1, 0x1408]), 0);
    assert.equal(f.view.getUint32(0x1408, true), 3, 'three drivers');
    assert.equal(f.call('acmDriverClose', [opened, 0]), 0);
    assert.equal(f.call('acmDriverClose', [opened, 0]), 5, 'closed already');
});

test('an IMA ADPCM block goes through a stream into 16-bit PCM', ()=>{
    const f = fixture();
    const SOURCE = 0x2000;
    const DESTINATION = 0x2100;
    writeFormat(f.view, SOURCE, { tag: 0x11, channels: 1, rate: 22050, blockAlign: 12,
        bits: 4, samplesPerBlock: 17 });
    assert.equal(f.call('acmFormatSuggest', [0, SOURCE, DESTINATION, 18, 0]), 0);
    assert.equal(f.view.getUint16(DESTINATION, true), 1, 'PCM');
    assert.equal(f.view.getUint16(DESTINATION + 14, true), 16);
    assert.equal(f.view.getUint32(DESTINATION + 4, true), 22050);

    assert.equal(f.call('acmStreamOpen', [0, 0, SOURCE, DESTINATION, 0, 0, 0, 1]), 0, 'a query');
    assert.equal(f.call('acmStreamOpen', [0x2200, 0, SOURCE, DESTINATION, 0, 0, 0, 0]), 0);
    const stream = f.view.getUint32(0x2200, true);
    assert.equal(f.call('acmStreamSize', [stream, 24, 0x2204, 0]), 0);
    assert.equal(f.view.getUint32(0x2204, true), 2 * 17 * 2, 'two blocks, 17 samples each');

    const HEADER = 0x3000;
    const IN = 0x3100;
    const OUT = 0x3200;
    f.view.setInt16(IN, 100, true);
    f.bytes[IN + 4] = 0x07;
    f.view.setUint32(HEADER, 84, true);
    f.view.setUint32(HEADER + 12, IN, true);
    f.view.setUint32(HEADER + 16, 12, true);
    f.view.setUint32(HEADER + 28, OUT, true);
    f.view.setUint32(HEADER + 32, 0x100, true);
    assert.equal(f.call('acmStreamConvert', [stream, HEADER, 0]), 0x202, 'not prepared');
    assert.equal(f.call('acmStreamPrepareHeader', [stream, HEADER, 0]), 0);
    assert.equal(f.call('acmStreamConvert', [stream, HEADER, 0]), 0);
    assert.equal(f.view.getUint32(HEADER + 20, true), 12, 'the block was used');
    assert.equal(f.view.getUint32(HEADER + 36, true), 34, '17 samples written');
    assert.equal(f.view.getInt16(OUT, true), 100);
    assert.equal(f.view.getInt16(OUT + 2, true), 111);
    assert.ok((f.view.getUint32(HEADER + 4, true) & 0x10000) !== 0, 'done');
    assert.equal(f.call('acmStreamUnprepareHeader', [stream, HEADER, 0]), 0);
    assert.equal(f.call('acmStreamClose', [stream, 0]), 0);
});

test('what no driver here can do is refused as Windows refuses it', ()=>{
    const f = fixture();
    writeFormat(f.view, 0x2000, { tag: 1, channels: 2, rate: 44100, blockAlign: 4, bits: 16 });
    writeFormat(f.view, 0x2100, { tag: 0x11, channels: 2, rate: 44100, blockAlign: 2048,
        bits: 4, samplesPerBlock: 2041 });
    assert.equal(f.call('acmStreamOpen', [0x2200, 0, 0x2000, 0x2100, 0, 0, 0, 0]), 0x203,
        'encoding is not done here');
    writeFormat(f.view, 0x2100, { tag: 0x11, channels: 2, rate: 22050, blockAlign: 2048,
        bits: 4, samplesPerBlock: 2041 });
    writeFormat(f.view, 0x2000, { tag: 1, channels: 2, rate: 44100, blockAlign: 4, bits: 16 });
    assert.equal(f.call('acmStreamOpen', [0x2200, 0, 0x2100, 0x2000, 0, 0, 0, 0]), 0x203,
        'nor does a codec change the rate on the way');
    writeFormat(f.view, 0x2000, { tag: 1, channels: 2, rate: 44100, blockAlign: 4, bits: 16 });
    writeFormat(f.view, 0x2100, { tag: 1, channels: 1, rate: 44100, blockAlign: 1, bits: 8 });
    assert.equal(f.call('acmStreamOpen', [0x2200, 0, 0x2000, 0x2100, 0, 0, 0, 0]), 0,
        'a change of width and channels is');
});

test('a driver\'s formats of one tag go to the callback with their details filled', async()=>{
    const f = fixture();
    await f.call('acmDriverEnum', [0x7777, 0, 0]);
    const ima = f.calls[1][1];
    f.calls.length = 0;
    assert.equal(f.call('acmDriverOpen', [0x1400, ima, 0]), 0);
    const opened = f.view.getUint32(0x1400, true);
    const DETAILS = 0x1800;
    const FORMAT = 0x1900;
    f.view.setUint32(DETAILS, 152, true);
    f.view.setUint32(DETAILS + 16, FORMAT, true);
    f.view.setUint32(DETAILS + 20, 50, true);
    f.view.setUint16(FORMAT, 0x11, true);
    assert.equal(await f.call('acmFormatEnumA', [opened, DETAILS, 0x8888, 0x99, 0x10000]), 0);
    assert.equal(f.calls.length, 8, 'four rates, mono and stereo');
    assert.ok(f.calls.every(([entry, id, details, instance])=>entry === 0x8888 && id === ima
        && details === DETAILS && instance === 0x99));
    // The last one stays in the caller's structure: 44.1 kHz stereo.
    assert.equal(f.view.getUint16(FORMAT, true), 0x11);
    assert.equal(f.view.getUint16(FORMAT + 2, true), 2);
    assert.equal(f.view.getUint32(FORMAT + 4, true), 44100);
    assert.equal(f.view.getUint16(FORMAT + 12, true), 2048);
    assert.equal(f.view.getUint16(FORMAT + 18, true), 2041, 'samples per block');
});

test('the PCM converter changes the rate, joining one piece to the next', ()=>{
    const f = fixture();
    writeFormat(f.view, 0x2000, { tag: 1, channels: 1, rate: 8000, blockAlign: 2, bits: 16 });
    writeFormat(f.view, 0x2100, { tag: 1, channels: 2, rate: 16000, blockAlign: 4, bits: 16 });
    assert.equal(f.call('acmStreamOpen', [0x2200, 0, 0x2000, 0x2100, 0, 0, 0, 0]), 0);
    const stream = f.view.getUint32(0x2200, true);
    assert.equal(f.call('acmStreamSize', [stream, 8, 0x2204, 0]), 0);
    assert.equal(f.view.getUint32(0x2204, true), 8 * 4, 'four frames become eight, stereo');
    const HEADER = 0x3000;
    const IN = 0x3100;
    const OUT = 0x3200;
    /** @param {number[]} samples */
    const convert = samples=>{
        samples.forEach((value, index)=>f.view.setInt16(IN + index * 2, value, true));
        f.view.setUint32(HEADER, 84, true);
        f.view.setUint32(HEADER + 4, 0, true);
        f.view.setUint32(HEADER + 12, IN, true);
        f.view.setUint32(HEADER + 16, samples.length * 2, true);
        f.view.setUint32(HEADER + 28, OUT, true);
        f.view.setUint32(HEADER + 32, 0x100, true);
        assert.equal(f.call('acmStreamPrepareHeader', [stream, HEADER, 0]), 0);
        assert.equal(f.call('acmStreamConvert', [stream, HEADER, 0]), 0);
        const written = f.view.getUint32(HEADER + 36, true) / 4;
        return Array.from({ length: written }, (_, frame)=>f.view.getInt16(OUT + frame * 4, true));
    };
    // Halfway between each pair; the last frame waits for the one after it.
    assert.deepEqual(convert([0, 100, 200, 300]), [0, 50, 100, 150, 200, 250]);
    assert.equal(f.view.getUint32(HEADER + 20, true), 8, 'the whole piece was taken');
    assert.deepEqual(convert([400, 500]), [300, 350, 400, 450], 'joined at the seam');
});
