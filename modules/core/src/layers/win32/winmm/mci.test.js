/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMci, mciWords, MCI_ALL_DEVICE_ID } from './mci.js';
import { createMciWave, mciInteger } from './mci-wave.js';

/** @param {number} v */
const le32 = v=>[v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, v >>> 24 & 0xff];
/** @param {string} s */
const text = s=>[...s].map(c=>c.charCodeAt(0));

/** Two seconds of 8 kHz mono 8-bit silence: 16000 bytes. */
const twoSeconds = ()=>{
    const fmt = [1, 0, 1, 0, ...le32(8000), ...le32(8000), 1, 0, 8, 0];
    const body = [...text('WAVE'), ...text('fmt '), ...le32(16), ...fmt,
        ...text('data'), ...le32(16000), ...new Array(16000).fill(0x80)];
    return new Uint8Array([...text('RIFF'), ...le32(body.length), ...body]);
};

function machine(){
    let now = 0;
    /** @type {number[][]} */
    const posted = [];
    /** @type {any[]} */
    const tracks = [];
    const wave = createMciWave({
        now: ()=>now,
        readFile: path=>(path === 'C:\\sound.wav' ? twoSeconds() : null),
        output: ()=>({
            /** @param {any} format */
            open: format=>{
                const track = { format, written: 0, closed: false,
                    /** @param {Uint8Array} bytes */
                    write(bytes){
                        this.written += bytes.length;
                        return bytes.length;
                    },
                    close(){
                        this.closed = true;
                    } };
                tracks.push(track);
                return track;
            },
        }),
    });
    const mci = createMci({ drivers: { waveaudio: wave, video: null },
        post: (hwnd, message, wParam, lParam)=>posted.push([hwnd, message, wParam, lParam]) });
    /** @param {string} command @param {number} [hwnd] */
    const send = (command, hwnd = 0)=>/** @type {any} */ (mci.send(mciWords(command), hwnd));
    return { mci, send, posted, tracks, advance: (/** @type {number} */ ms)=>{
        now += ms;
        mci.tick();
    } };
}

test('a wave file opened under an alias is played from and to a position on the clock', async()=>{
    // mci.c test_playWAVE: lengths and positions in milliseconds, play ranges
    // refused past the end or backwards, a play's notification at its end.
    const m = machine();
    assert.deepEqual(m.send('open C:\\sound.wav alias s notify', 0x55),
        { error: 0, text: '1' });
    assert.deepEqual(m.posted.at(-1), [0x55, 0x3b9, 1, 1], 'MM_MCINOTIFY, successful, device 1');
    assert.equal(m.mci.deviceId('S'), 1, 'by its alias, in any case');
    assert.equal(m.mci.deviceId('waveaudio'), 0, 'a type is not looked up');
    assert.deepEqual(m.send('status s length'), { error: 0, text: '2000' });
    assert.deepEqual(m.send('status s mode'), { error: 0, text: 'stopped' });
    assert.equal(m.send('play s from 250 to 0').error, 282, 'MCIERR_OUTOFRANGE');
    assert.equal(m.send('play s to 3000').error, 282);
    assert.equal(m.send('play s from 500 to 220:5 notify', 0x66).error, 0, '220:5 is 1500');
    assert.equal(m.tracks.at(-1).written, 8000, 'the second between 500 and 1500 ms');
    m.advance(400);
    assert.deepEqual(m.send('status s position'), { error: 0, text: '900' });
    assert.deepEqual(m.send('status s mode'), { error: 0, text: 'playing' });
    m.advance(700);
    assert.deepEqual(m.send('status s mode'), { error: 0, text: 'stopped' });
    assert.deepEqual(m.send('status s position'), { error: 0, text: '1500' });
    assert.deepEqual(m.posted.at(-1), [0x66, 0x3b9, 1, 1], 'the play\'s notification at its end');
    assert.equal(m.send('play s to 1000').error, 282, 'not to before where it is');
    assert.equal(m.send('set s time format bytes').error, 0);
    assert.deepEqual(m.send('status s position'), { error: 0, text: '12000' });

    const waiting = m.send('play s wait');
    assert.ok(waiting instanceof Promise, 'play wait lasts the sound');
    m.advance(500);
    assert.deepEqual(await waiting, { error: 0 });
    assert.deepEqual(m.send('close s'), { error: 0 });
    assert.ok(m.tracks.every(track=>track.closed));
    assert.equal(m.send('close s').error, 263, 'MCIERR_INVALID_DEVICE_NAME');
});

test('a device is named by type, by type!element, by its file, and new needs an alias', ()=>{
    // mci.c test_openCloseWAVE.
    const m = machine();
    assert.equal(m.send('open new type waveaudio').error, 299, 'MCIERR_NEW_REQUIRES_ALIAS');
    assert.equal(m.send('open new type waveaudio alias r shareable').error, 274);
    assert.equal(m.send('open no-such-file.wav alias y').error, 275, 'MCIERR_FILE_NOT_FOUND');
    assert.equal(m.send('open nosuchdevice!x.wav alias n').error, 275,
        'a name before ! that is no type is part of the file name');
    assert.equal(m.send('open ! alias no').error, 263);
    assert.equal(m.send('open cdaudio').error, 266, 'no CD drive: the driver does not load');
    assert.equal(m.send('open x.xyz').error, 281, 'MCIERR_EXTENSION_NOT_FOUND');
    assert.deepEqual(m.send('open waveaudio'), { error: 0, text: '1' });
    assert.equal(m.send('open C:\\sound.wav alias waveaudio').error, 289,
        'a device opened by its type is aliased by it');
    assert.deepEqual(m.send('open waveaudio!C:\\sound.wav alias two'), { error: 0, text: '2' });
    assert.deepEqual(m.send('sysinfo all quantity open'), { error: 0, text: '2', mustFit: true });
    assert.deepEqual(m.send('sysinfo all name 2 open'), { error: 0, text: 'two', mustFit: true });
    assert.equal(m.send('sysinfo two quantity').error, 287, 'MCIERR_DEVICE_TYPE_REQUIRED');
    assert.equal(m.send('status all mode').error, 279, 'MCIERR_CANNOT_USE_ALL');
    assert.equal(m.send('cue output').error, 261, 'a device verb on no device is unknown');
    assert.deepEqual(m.send('close all'), { error: 0 });
    assert.equal(m.mci.deviceId('all'), MCI_ALL_DEVICE_ID);
});

test('a device named by its file is opened for the command and closed when it is done', ()=>{
    // mci.c test_AutoOpenWAVE.
    const m = machine();
    assert.equal(m.send('play C:\\sound.wav notify', 0x55).error, 300,
        'MCIERR_NOTIFY_ON_AUTO_OPEN');
    assert.equal(m.send('play C:\\sound.wav').error, 0);
    assert.deepEqual(m.send('sysinfo waveaudio quantity open').text, '1', 'open while it plays');
    m.advance(2000);
    assert.deepEqual(m.send('sysinfo waveaudio quantity open').text, '0', 'and closed at its end');
    assert.deepEqual(m.send('status C:\\sound.wav length'), { error: 0, text: '2000' });
    assert.deepEqual(m.send('sysinfo waveaudio quantity open').text, '0',
        'a status closes its device at once');
});

test('the command form is the string form, its answers in the parameter block', ()=>{
    // mci.c test_mciParser and test_recordWAVE through mciSendCommand.
    const m = machine();
    const memory = new DataView(new ArrayBuffer(0x1000));
    /** @type {Map<number, string>} */
    const strings = new Map([[0x800, 'waveaudio'], [0x840, ''], [0x880, 'x']]);
    /** @param {number} address */
    const block = address=>({
        address,
        u32: (/** @type {number} */ offset)=>memory.getUint32(address + offset, true),
        setU32: (/** @type {number} */ offset, /** @type {number} */ value)=>
            memory.setUint32(address + offset, value, true),
        putU32: (/** @type {number} */ at, /** @type {number} */ value)=>
            memory.setUint32(at, value, true),
        text: (/** @type {number} */ at)=>strings.get(at) ?? '',
        write: (/** @type {number} */ at, /** @type {number} */ room, /** @type {string} */ s)=>
            strings.set(at, s.slice(0, room - 1)),
    });
    memory.setUint32(0x100, 0x55, true);
    memory.setUint32(0x108, 0x800, true);
    memory.setUint32(0x10c, 0x840, true);
    memory.setUint32(0x110, 0x880, true);
    // MCI_OPEN with MCI_OPEN_ELEMENT | MCI_OPEN_TYPE | MCI_OPEN_ALIAS | MCI_NOTIFY.
    assert.equal(m.mci.command(0, 0x803, 0x200 | 0x2000 | 0x400 | 1, block(0x100)), 0);
    assert.equal(memory.getUint32(0x104, true), 1, 'wDeviceID');
    assert.deepEqual(m.posted.at(-1), [0x55, 0x3b9, 1, 1]);
    // MCI_STATUS MCI_STATUS_MODE: MCI_MODE_STOP.
    memory.setUint32(0x208, 4, true);
    assert.equal(m.mci.command(1, 0x814, 0x100, block(0x200)), 0);
    assert.equal(memory.getUint32(0x204, true), 525);
    memory.setUint32(0x208, 6, true);
    assert.equal(m.mci.command(1, 0x814, 0x100, block(0x200)), 0);
    assert.equal(memory.getUint32(0x204, true), 0, 'MCI_FORMAT_MILLISECONDS');
    // MCI_GETDEVCAPS MCI_GETDEVCAPS_DEVICE_TYPE: MCI_DEVTYPE_WAVEFORM_AUDIO.
    memory.setUint32(0x308, 4, true);
    assert.equal(m.mci.command(1, 0x80b, 0x100, block(0x300)), 0);
    assert.equal(memory.getUint32(0x304, true), 0x20a);
    // MCI_SYSINFO quantity into a DWORD, refused into three bytes.
    memory.setUint32(0x404, 0x500, true);
    memory.setUint32(0x408, 4, true);
    assert.equal(m.mci.command(MCI_ALL_DEVICE_ID, 0x810, 0x100 | 0x200, block(0x400)), 0);
    assert.equal(memory.getUint32(0x500, true), 1);
    memory.setUint32(0x408, 3, true);
    assert.equal(m.mci.command(MCI_ALL_DEVICE_ID, 0x810, 0x100, block(0x400)), 268);
    assert.equal(m.mci.command(7, 0x814, 0x100, block(0x200)), 257, 'MCIERR_INVALID_DEVICE_ID');
    assert.equal(m.mci.command(1, 0x804, 0, block(0)), 0, 'MCI_CLOSE');
});

test('an MCI integer is decimal or colon-separated bytes, never hexadecimal', ()=>{
    assert.equal(mciInteger('250'), 250);
    assert.equal(mciInteger(':1'), 256);
    assert.equal(mciInteger('250::'), 250);
    assert.equal(mciInteger('220:5:0'), 1500);
    assert.equal(mciInteger('0xfa'), null);
    assert.equal(mciInteger('0:0:0:0:0'), null);
    assert.equal(mciInteger('256:0:0:0'), null);
    assert.equal(mciInteger(undefined), null);
});
