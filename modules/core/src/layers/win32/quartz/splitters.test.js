/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioSubtype, parseAvi, parseWave, videoSubtype } from './splitters.js';
import {
    FORMAT_VIDEO_INFO, FORMAT_WAVE_FORMAT_EX, MEDIATYPE_AUDIO, MEDIATYPE_VIDEO,
} from './filter.js';

/** @param {string} id @param {Uint8Array} body */
const chunk = (id, body)=>{
    const padded = new Uint8Array(8 + body.length + (body.length & 1));
    padded.set([...id].map(ch=>ch.charCodeAt(0)), 0);
    new DataView(padded.buffer).setUint32(4, body.length, true);
    padded.set(body, 8);
    return padded;
};
/** @param {string} type @param {Uint8Array[]} parts */
const list = (type, parts)=>chunk('LIST', concat([text(type), ...parts]));
/** @param {string} value */
const text = value=>new Uint8Array([...value].map(ch=>ch.charCodeAt(0)));
/** @param {Uint8Array[]} parts */
const concat = parts=>{
    const whole = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
    let at = 0;
    for (const part of parts)
    {
        whole.set(part, at);
        at += part.length;
    }
    return whole;
};
/** @param {(view: DataView) => void} fill @param {number} length */
const bytes = (length, fill)=>{
    const out = new Uint8Array(length);
    fill(new DataView(out.buffer));
    return out;
};
/** A file as a reader over its bytes. @param {Uint8Array} file */
const reader = file=>async(/** @type {number} */ offset, /** @type {number} */ length)=>
    file.slice(offset, offset + length);

/** WAVEFORMATEX for 16-bit stereo PCM at 8000 Hz. */
const pcm = bytes(16, view=>{
    view.setUint16(0, 1, true);
    view.setUint16(2, 2, true);
    view.setUint32(4, 8000, true);
    view.setUint32(8, 32000, true);
    view.setUint16(12, 4, true);
    view.setUint16(14, 16, true);
});

test('a WAVE file is one stream of quarter-second packets of whole blocks, timed by its rate',
    async()=>{
        const data = new Uint8Array(32000 + 400);
        const file = concat([text('RIFF'), new Uint8Array(4), text('WAVE'),
            chunk('fmt ', pcm), chunk('data', data)]);
        const parsed = await parseWave(reader(file), file.length);
        assert.ok(parsed);
        assert.equal(parsed.streams.length, 1);
        assert.equal(parsed.streams[0].name, 'output');
        const type = parsed.streams[0].type;
        assert.equal(type.major, MEDIATYPE_AUDIO);
        assert.equal(type.sub, audioSubtype(1));
        assert.equal(type.formatType, FORMAT_WAVE_FORMAT_EX);
        assert.equal(type.format.length, 18, 'a WAVEFORMATEX whole, cbSize zero');
        assert.equal(type.sampleSize, 4, 'a sample is a block');
        assert.equal(parsed.packets.length, 5);
        assert.deepEqual(parsed.packets.map(packet=>packet.length), [8000, 8000, 8000, 8000, 400]);
        assert.equal(parsed.packets[1].start, 2_500_000, 'a quarter of a second in');
        assert.equal(parsed.packets[4].stop, Math.round(32400 * 10_000_000 / 32000));
        assert.equal(parsed.duration, parsed.packets[4].stop);
        assert.equal(parsed.packets[0].offset, file.length - data.length,
            'its bytes are the data chunk\'s');
    });

test('a file that is not a WAVE file is no file to the WAVE Parser', async()=>{
    const file = concat([text('RIFF'), new Uint8Array(4), text('AVI '), chunk('fmt ', pcm)]);
    assert.equal(await parseWave(reader(file), file.length), null);
});

/** An AVI stream header: kind, scale, rate, suggested buffer, sample size. */
/**
 * @param {string} kind @param {number} scale @param {number} rate
 * @param {number} suggested @param {number} [sampleSize]
 */
function strh(kind, scale, rate, suggested, sampleSize = 0){
    const body = bytes(56, view=>{
        view.setUint32(20, scale, true);
        view.setUint32(24, rate, true);
        view.setUint32(36, suggested, true);
        view.setUint32(44, sampleSize, true);
    });
    body.set(text(kind), 0);
    return chunk('strh', body);
};

test('an AVI file\'s streams are its strl lists, its packets its index, each timed by its stream',
    async()=>{
        // A 4x2 RGB24 video at 10 frames a second, and the PCM audio above.
        const bitmap = bytes(40, view=>{
            view.setUint32(0, 40, true);
            view.setInt32(4, 4, true);
            view.setInt32(8, 2, true);
            view.setUint16(12, 1, true);
            view.setUint16(14, 24, true);
            view.setUint32(20, 24, true);
        });
        const hdrl = list('hdrl', [chunk('avih', new Uint8Array(56)),
            list('strl', [strh('vids', 1, 10, 24), chunk('strf', bitmap)]),
            list('strl', [strh('auds', 1, 8000, 3200, 4), chunk('strf', pcm)])]);
        const frame = new Uint8Array(24);
        const sound = new Uint8Array(3200);
        const movi = list('movi', [chunk('00db', frame), chunk('01wb', sound),
            chunk('00db', frame)]);
        const head = concat([text('RIFF'), new Uint8Array(4), text('AVI '), hdrl]);
        const moviStart = head.length + 8;
        // Offsets from the 'movi' tag, as the format has them.
        const index = bytes(48, view=>{
            const entries = [['00db', 0x10, 4, 24], ['01wb', 0, 4 + 32, 3200],
                ['00db', 0, 4 + 32 + 3208, 24]];
            entries.forEach(([id, flags, offset, size], at)=>{
                [.../** @type {string} */ (id)].forEach((ch, n)=>view.setUint8(at * 16 + n, ch.charCodeAt(0)));
                view.setUint32(at * 16 + 4, /** @type {number} */ (flags), true);
                view.setUint32(at * 16 + 8, /** @type {number} */ (offset), true);
                view.setUint32(at * 16 + 12, /** @type {number} */ (size), true);
            });
        });
        const file = concat([head, movi, chunk('idx1', index)]);
        const parsed = await parseAvi(reader(file), file.length);
        assert.ok(parsed);
        assert.deepEqual(parsed.streams.map(stream=>stream.name), ['Stream 00', 'Stream 01']);
        const video = parsed.streams[0].type;
        assert.equal(video.major, MEDIATYPE_VIDEO);
        assert.equal(video.sub, videoSubtype(0, 24));
        assert.equal(video.formatType, FORMAT_VIDEO_INFO);
        assert.equal(new DataView(video.format.buffer).getUint32(0x28, true), 1_000_000,
            'a VIDEOINFOHEADER whose frame time is the stream\'s rate');
        assert.equal(video.temporal, false);
        assert.equal(parsed.streams[1].type.major, MEDIATYPE_AUDIO);
        assert.deepEqual(parsed.packets.map(packet=>[packet.stream, packet.start, packet.stop]),
            [[0, 0, 1_000_000], [1, 0, 1_000_000], [0, 1_000_000, 2_000_000]]);
        assert.equal(parsed.packets[0].offset, moviStart + 4 + 8, 'past the chunk\'s own header');
        assert.equal(parsed.packets[0].sync, true, 'a key frame');
        assert.equal(parsed.duration, 2_000_000);
    });

test('an AVI file with no index is walked through its movi list', async()=>{
    const bitmap = bytes(40, view=>{
        view.setUint32(0, 40, true);
        view.setUint16(14, 32, true);
    });
    const hdrl = list('hdrl', [list('strl', [strh('vids', 1, 25, 0), chunk('strf', bitmap)])]);
    const movi = list('movi', [chunk('00dc', new Uint8Array(5)), chunk('00dc', new Uint8Array(7))]);
    const file = concat([text('RIFF'), new Uint8Array(4), text('AVI '), hdrl, movi]);
    const parsed = await parseAvi(reader(file), file.length);
    assert.ok(parsed);
    assert.deepEqual(parsed.packets.map(packet=>packet.length), [5, 7]);
    assert.equal(parsed.streams[0].largest, 7, 'the allocator is asked for the largest packet');
});

test('the subtypes are the format tag and the FOURCC in the base GUID, RGB by depth', ()=>{
    assert.equal(audioSubtype(0x55), '{00000055-0000-0010-8000-00AA00389B71}');
    assert.equal(videoSubtype(0x30323449, 12), '{30323449-0000-0010-8000-00AA00389B71}');
    assert.equal(videoSubtype(0, 24), '{E436EB7D-524F-11CE-9F53-0020AF0BA770}');
});
