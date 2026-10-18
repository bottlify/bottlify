/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { registerQuartzClasses } from '../quartz/graph.js';
import {
    createMciVideo, MCIERR_DUPLICATE_ALIAS, MCIERR_FILE_NOT_FOUND, MCIERR_UNSUPPORTED_FUNCTION,
} from './mci-video.js';

/**
 * A silent clip of `frameCount` frames, as an intro film of this era is: one
 * picture after another and then the end.
 *
 * @param {{ frameCount?: number, fps?: number, width?: number, height?: number }} [shape]
 */
function silentClip({ frameCount = 4, fps = 10, width = 640, height = 100 } = {}){
    let given = 0;
    return {
        width, height, fps, frameCount, hasVideo: true, hasAudio: false,
        sampleRate: 0, channels: 0,
        closed: false,
        decode(){
            if (given >= frameCount)
            {
                return /** @type {const} */ ('end');
            }
            given++;
            return /** @type {const} */ ('frame');
        },
        frame: ()=>Uint8Array.of(given, 0, 0, 0xff),
        close(){
            this.closed = true;
        },
    };
}

/**
 * The video driver over quartz's own film, with a file system of one film and
 * a keyboard whose keys the test holds.
 *
 * @param {{ files?: Record<string, ReturnType<typeof silentClip>> }} [options]
 */
function driver({ files = { 'media\\intro.avi': silentClip() } } = {}){
    /** @type {string[]} */
    const opened = [];
    const quartz = registerQuartzClasses(createComRegistry(), {
        writeMemory: ()=>{},
        post: ()=>{},
        video: {
            open: async name=>{
                opened.push(name);
                return files[name] ?? null;
            },
        },
    });
    /** @type {Set<number>} */
    const held = new Set();
    /** @type {string[]} */
    const divergences = [];
    const video = createMciVideo({
        film: ()=>quartz.film(),
        keyDown: key=>held.has(key),
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
    });
    /** @param {string} command */
    const send = async command=>{
        const words = command.trim().split(/\s+/);
        const answer = video.command(words);
        return answer === null ? null : await answer;
    };
    let now = 0;
    /** Ticks the films as the machine does between turns, `ms` of host time later. */
    const tick = (ms = 100)=>{
        now += ms;
        return quartz.tick(now, null);
    };
    return { video, send, tick, held, opened, divergences, files };
}

test('a film opened by MCI plays in the window it names and its wait ends with the film', async()=>{
    const { send, tick, opened } = driver();
    assert.deepEqual(
        await send('open media\\intro.avi type AVIVideo alias intro parent 4660 style child wait'),
        { error: 0 });
    assert.deepEqual(opened, ['media\\intro.avi']);
    assert.deepEqual(await send('window intro handle 4661 state restore wait'), { error: 0 });
    assert.deepEqual(await send('put intro destination at 0 190 640 100 wait'), { error: 0 });
    assert.deepEqual(await send('seek intro to start wait'), { error: 0 });
    assert.deepEqual(await send('break intro on 27 wait'), { error: 0 });

    let ended = false;
    const playing = send('play intro wait').then(answer=>{
        ended = true;
        return answer;
    });
    await Promise.resolve();
    // The film's clock starts at the tick after play; the next one is its first frame.
    tick();
    const first = tick();
    assert.ok(first, 'a frame is shown once the clock moved');
    assert.equal(first.hwnd, 4661, 'in the window `window ... handle` named');
    assert.deepEqual(first.window, { left: 0, top: 190, width: 640, height: 100,
        visible: true, fullScreen: false }, 'where `put ... destination` put it');
    assert.equal(ended, false, 'the wait lasts the film');
    for (let at = 0; at < 10; at++)
    {
        tick();
        await Promise.resolve();
    }
    assert.deepEqual(await playing, { error: 0 });
    assert.deepEqual(await send('stop intro wait'), { error: 0 });
    assert.deepEqual(await send('close intro wait'), { error: 0 });
    assert.equal(await send('close intro wait'), null, 'the alias is gone once closed');
});

test('the break key ends a wait before the film does', async()=>{
    const files = { 'media\\intro.avi': silentClip({ frameCount: 1000 }) };
    const { send, tick, held } = driver({ files });
    await send('open media\\intro.avi type avivideo alias intro parent 4660');
    await send('break intro on 27');
    const playing = send('play intro wait');
    tick();
    held.add(27);
    tick();
    assert.deepEqual(await playing, { error: 0 });
    assert.equal(tick(), null, 'nothing is shown once the break stopped it');
});

test('without wait the call returns at once and the film plays on', async()=>{
    const { send, tick } = driver();
    await send('open media\\intro.avi alias intro parent 1');
    assert.deepEqual(await send('play intro'), { error: 0 });
    assert.deepEqual(await send('status intro mode'), { error: 0, text: 'playing' });
    for (let at = 0; at < 10; at++)
    {
        tick();
    }
    assert.deepEqual(await send('status intro mode'), { error: 0, text: 'stopped' });
    assert.deepEqual(await send('status intro length'), { error: 0, text: '4' });
});

test('a film played to its end answers a second play at once rather than never', async()=>{
    const { send, tick } = driver();
    await send('open media\\intro.avi type AVIVideo alias intro parent 1');
    const first = send('play intro wait');
    for (let at = 0; at < 10; at++)
    {
        tick();
        await Promise.resolve();
    }
    assert.deepEqual(await first, { error: 0 });
    assert.deepEqual(await send('play intro wait'), { error: 0 });
});

test('closing a film ends a wait for it', async()=>{
    const files = { 'media\\intro.avi': silentClip({ frameCount: 1000 }) };
    const { send, tick } = driver({ files });
    await send('open media\\intro.avi type AVIVideo alias intro parent 1');
    const playing = send('play intro wait');
    tick();
    assert.deepEqual(await send('close intro'), { error: 0 });
    assert.deepEqual(await playing, { error: 0 });
});

test('the driver takes only films and its own aliases', async()=>{
    const { send, video } = driver();
    assert.equal(await send('open cdaudio alias cd wait'), null, 'not a film: another driver');
    assert.equal(await send('open music.mid type sequencer alias tune'), null);
    assert.equal(await send('play nothing wait'), null, 'an alias nobody opened');
    assert.deepEqual(await send('open media\\missing.avi type avivideo alias gone'),
        { error: MCIERR_FILE_NOT_FOUND });
    assert.equal(video.deviceId('gone'), 0, 'a film that did not open has no device');
    await send('open media\\intro.avi type avivideo alias intro');
    assert.notEqual(video.deviceId('INTRO'), 0, 'an alias is a device id, in any case');
    assert.deepEqual(await send('open media\\intro.avi type avivideo alias intro'),
        { error: MCIERR_DUPLICATE_ALIAS });
    assert.deepEqual(await send('record intro'), { error: MCIERR_UNSUPPORTED_FUNCTION });
});

test('a build with no decoder leaves every film to the answer of a machine without one', async()=>{
    const video = createMciVideo({ film: ()=>null, keyDown: ()=>false });
    assert.equal(video.command(['open', 'intro.avi', 'type', 'avivideo', 'alias', 'intro']), null);
});
