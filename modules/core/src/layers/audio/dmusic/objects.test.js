/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComObject } from '../../win32/ole32/objects.js';
import { parseGuid } from '../../win32/ole32/guid.js';
import { createDirectMusic } from './objects.js';
import { dmsgSegment, wavFile } from './test-fixtures.js';
import * as ids from './ids.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;

/** A guest address space with a bump allocator, for the descriptors a call writes. */
function arena(){
    const ram = new Uint8Array(1 << 20);
    let next = 0x10000;
    return {
        ram,
        /** @param {number} bytes @returns {number} */
        alloc(bytes){
            next = (next + 15) & ~15;
            const at = next;
            next += bytes;
            return at;
        },
        /** @param {number} address @returns {number} */
        readU32(address){
            return new DataView(ram.buffer).getUint32(address, true);
        },
        /** @param {number} address @param {number} value */
        writeU32(address, value){
            new DataView(ram.buffer).setUint32(address, value >>> 0, true);
        },
        /** @param {number} address @param {Uint8Array} bytes */
        writeBytes(address, bytes){
            ram.set(bytes, address);
        },
        /** @param {number} address @param {string} text */
        writeWide(address, text){
            for (let at = 0; at < text.length; at++)
            {
                new DataView(ram.buffer).setUint16(address + at * 2, text.charCodeAt(at), true);
            }
            new DataView(ram.buffer).setUint16(address + text.length * 2, 0, true);
        },
        /** @param {number} address @param {string} guid */
        writeGuid(address, guid){
            const bytes = parseGuid(guid);
            assert.ok(bytes);
            ram.set(/** @type {Uint8Array} */ (bytes), address);
        },
    };
}

/** A mixer that remembers every track it opened. */
function mixer(){
    /** @type {any[]} */
    const tracks = [];
    return {
        tracks,
        open(/** @type {any} */ format){
            const track = { format, gain: 1, closed: false, bytes: 0,
                /** @param {Uint8Array} data */
                write(data){ track.bytes += data.length; },
                close(){ track.closed = true; } };
            tracks.push(track);
            return track;
        },
    };
}

/** A test rig with a guest memory, a mixer and the files the loader reads. */
function rig(){
    const space = arena();
    const out = mixer();
    const time = { at: 1000 };
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    let pointer = 0x20000000;
    const dm = createDirectMusic({
        registry: /** @type {any} */ ({}),
        memory: {
            readBytes: (/** @type {number} */ a, /** @type {number} */ l)=>
                space.ram.subarray(a, a + l),
            writeBytes: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
                space.writeBytes(a, b),
        },
        publishInterface: ()=>pointer++,
        output: ()=>out,
        now: ()=>time.at,
        readFile: async path=>files.get(path) ?? files.get(path.toLowerCase()) ?? null,
        divergence: ()=>{},
    });
    return { space, out, time, files, dm };
}

/**
 * @param {any} object @param {string} iid @param {string} name @param {number[]} args
 */
function call(object, iid, name, args){
    const record = object.interfaceFor(iid);
    assert.ok(record, `${iid} is not on this object`);
    const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
    assert.ok(method, `${name} is not in this interface`);
    return method.invoke(object, args);
}

/** A segment's bytes with one wave, and the wave itself, ready for the loader. */
function segmentWithWave(){
    const samples = new Int16Array(2000);
    const wave = wavFile(samples, { sampleRate: 1000, channels: 1 });
    const segment = dmsgSegment([{ file: 'a.wav', time: 0 }],
        { length: 768, tempo: { time: 0, tempo: 120 } });
    return { segment, wave };
}

test('InitAudio makes a performance, a default path and a DirectMusic object', async()=>{
    const { space, dm } = rig();
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const musicOut = space.alloc(4);
    const soundOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'InitAudio',
        [musicOut, soundOut, 0, 5, 128, 0xffffffff, 0]), S_OK);
    assert.notEqual(space.readU32(musicOut), 0, 'a DirectMusic object was handed back');
    assert.equal(space.readU32(soundOut), 0, 'DirectSound is another layer to make');

    const pathOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'CreateStandardAudioPath', [5, 128, 1, pathOut]), S_OK);
    assert.notEqual(space.readU32(pathOut), 0);

    const defaultOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8,
        'GetDefaultAudioPath', [defaultOut]), S_OK);
    assert.notEqual(space.readU32(defaultOut), 0);
});

test('the loader reads a segment from memory and its wave plays through the mixer', async()=>{
    const { space, out, files, dm } = rig();
    const { segment, wave } = segmentWithWave();
    files.set('a.wav', wave);
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());

    const block = space.alloc(segment.length);
    space.writeBytes(block, segment);
    const desc = space.alloc(ids.DMUS_OBJECTDESC.SIZE);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwSize, ids.DMUS_OBJECTDESC.SIZE);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.dwValidData,
        ids.DMUS_OBJ.CLASS | ids.DMUS_OBJ.MEMORY);
    space.writeGuid(desc + ids.DMUS_OBJECTDESC.guidClass, ids.CLSID_DIRECTMUSIC_SEGMENT);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.llMemLength, segment.length);
    space.writeU32(desc + ids.DMUS_OBJECTDESC.pbMemData, block);

    const segmentOut = space.alloc(4);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'GetObject',
        [desc, 0, segmentOut]), S_OK);
    const segmentPointer = space.readU32(segmentOut);
    assert.notEqual(segmentPointer, 0);

    const stateOut = space.alloc(4);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [segmentPointer, 0, 0, 0, 0, 0, stateOut, 0, 0]), S_OK);
    assert.notEqual(space.readU32(stateOut), 0, 'a play state was handed back');
    assert.equal(out.tracks.length, 1, 'the wave became one mixer track');
    assert.equal(out.tracks[0].format.sampleRate, 1000);
    assert.equal(out.tracks[0].bytes, 4000, 'the PCM samples crossed to the mixer');
    assert.equal(dm.diagnostics().playing, 1);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'IsPlaying',
        [segmentPointer, 0]), S_OK);

    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'StopEx',
        [segmentPointer, 0, 0, 0]), S_OK);
    assert.equal(out.tracks[0].closed, true);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'IsPlaying',
        [segmentPointer, 0]), S_FALSE);
});

test('LoadObjectFromFile reads a named file and hands back a segment', async()=>{
    const { space, files, dm } = rig();
    const { segment } = segmentWithWave();
    const name = 'C:\\music\\track.sgt';
    files.set(name, segment);
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const path = space.alloc(600);
    space.writeWide(path, name);
    const out = space.alloc(4);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'LoadObjectFromFile',
        [0, 0, path, out]), S_OK);
    assert.notEqual(space.readU32(out), 0);
});

test('SetSearchDirectory tells a not-yet-named path from one already set', async()=>{
    const { space, dm } = rig();
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const path = space.alloc(600);
    space.writeWide(path, 'C:\\music');
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'SetSearchDirectory',
        [0, path]), S_OK);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'SetSearchDirectory',
        [0, path]), S_FALSE);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'SetSearchDirectory',
        [0, 0]), E_POINTER);
});

test('a segment that is not a DMSG is refused and nothing is played', async()=>{
    const { space, files, dm } = rig();
    files.set('C:\\bad.sgt', new Uint8Array([1, 2, 3, 4]));
    const loader = createComObject(ids.CLSID_DIRECTMUSIC_LOADER, dm.loader());
    const path = space.alloc(600);
    space.writeWide(path, 'C:\\bad.sgt');
    const out = space.alloc(4);
    assert.equal(await call(loader, ids.IID_DIRECTMUSIC_LOADER8, 'LoadObjectFromFile',
        [0, 0, path, out]), S_OK);
    // An unparseable file still produces an object; what it plays is nothing,
    // which is the same answer an empty segment gives, not a crash.
    const performance = createComObject(ids.CLSID_DIRECTMUSIC_PERFORMANCE, dm.performance());
    const stateOut = space.alloc(4);
    const segmentPointer = space.readU32(out);
    assert.equal(await call(performance, ids.IID_DIRECTMUSIC_PERFORMANCE8, 'PlaySegmentEx',
        [segmentPointer, 0, 0, 0, 0, 0, stateOut, 0, 0]), S_OK);
    assert.equal(dm.diagnostics().playing, 1);
});
