/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChunks, chunkOf, listOf, wideString, parseSegment, parseWave, parseTempo,
    musicToMs } from './riff.js';
import { ascii, chunk, concat, wide, dmsgSegment, wavFile, tempoItem }
    from './test-fixtures.js';

test('a RIFF of chunks reads back with each size bounded', ()=>{
    const bytes = chunk('RIFF', ascii('DMSG'),
        chunk('segh', new Uint8Array(56)),
        chunk('LIST', ascii('UNFO'), chunk('UNAM', wide('Name'))));
    const root = chunkOf(readChunks(bytes), 'RIFF');
    assert.equal(root?.form, 'DMSG');
    assert.equal(chunkOf(root?.children ?? [], 'segh')?.data.length, 56);
    const unfo = listOf(root?.children ?? [], 'UNFO');
    assert.equal(wideString(chunkOf(unfo?.children ?? [], 'UNAM')), 'Name');
});

test('a segment reads its header and its wave items', ()=>{
    const bytes = dmsgSegment([
        { file: 'Icpw1.wav', time: 0, duration: 0, volume: -600 },
        { file: 'Icpw2.wav', time: 3072, startOffset: 1_000_000,
            duration: 6144, flags: 1 },
    ], { repeats: 0xffffffff, length: 12288, refLength: 1_750_0000 });
    const parsed = parseSegment(bytes);
    assert.equal(parsed.header.repeats, 0xffffffff);
    assert.equal(parsed.header.length, 12288);
    assert.equal(parsed.header.refLength, 1_750_0000);
    assert.equal(parsed.trackCount, 1);
    assert.equal(parsed.waves.length, 2);
    assert.deepEqual(parsed.waves[0],
        { volume: -600, pitch: 0, start: 0, startOffset: 0, duration: 0, flags: 0,
            file: 'Icpw1.wav' });
    assert.equal(parsed.waves[1].start, 3072);
    assert.equal(parsed.waves[1].startOffset, 1_000_000);
    assert.equal(parsed.waves[1].duration, 6144);
    assert.equal(parsed.waves[1].file, 'Icpw2.wav');
});

test('a tempo track is read, and music time becomes milliseconds through it', ()=>{
    const tempos = parseTempo(concat([tempoItem(0, 100), tempoItem(768, 200)]));
    assert.deepEqual(tempos, [{ time: 0, tempo: 100 }, { time: 768, tempo: 200 }]);
    // 768 ticks at 100 bpm is a beat of 600 ms; the next beat runs twice as
    // fast, so 1536 ticks is 600 + 300.
    assert.equal(Math.round(musicToMs(tempos, 768)), 600);
    assert.equal(Math.round(musicToMs(tempos, 1536)), 900);
});

test('music time without a tempo track runs at the default 120 bpm', ()=>{
    assert.equal(Math.round(musicToMs([], 768)), 500);
    assert.equal(Math.round(musicToMs([], 0)), 0);
});

test('a short segment header is read without walking past its chunk', ()=>{
    // The DirectX 7 header stops before the reference-time fields; the fields
    // before it are the same and the absent ones are zero.
    const short = new Uint8Array(48);
    new DataView(short.buffer).setUint32(0, 3, true);
    new DataView(short.buffer).setInt32(4, 768, true);
    const bytes = chunk('RIFF', ascii('DMSG'), chunk('segh', short));
    const parsed = parseSegment(bytes);
    assert.equal(parsed.header.repeats, 3);
    assert.equal(parsed.header.length, 768);
    assert.equal(parsed.header.refLength, 0);
    assert.deepEqual(parsed.waves, []);
});

test('a WAVE reads its format and its samples', ()=>{
    const samples = new Int16Array([1, -2, 3, -4]);
    const parsed = parseWave(wavFile(samples, { sampleRate: 48000, channels: 2 }));
    assert.equal(parsed?.format, 'pcm');
    assert.equal(parsed?.formatTag, 1);
    assert.equal(parsed?.channels, 2);
    assert.equal(parsed?.sampleRate, 48000);
    assert.equal(parsed?.bitsPerSample, 16);
    assert.deepEqual([.../** @type {any} */ (parsed).data],
        [...new Uint8Array(samples.buffer)]);
});

test('a wave that is not a WAVE form is refused', ()=>{
    assert.equal(parseWave(chunk('RIFF', ascii('DMSG'))), null);
});

test('a wave item carries the file name the reference wrote', ()=>{
    const bytes = dmsgSegment([{ file: 'BinC17.wav', time: 0 }]);
    assert.equal(parseSegment(bytes).waves[0].file, 'BinC17.wav');
});
