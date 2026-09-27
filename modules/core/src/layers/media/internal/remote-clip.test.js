/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AHEAD, serveClips } from './clip-worker.js';
import { createRemoteClips } from './remote-clip.js';

/**
 * A decoder whose clip yields a scripted sequence, as `createDecoder`'s does.
 *
 * @param {string[]} script  'frame' | 'audio' | 'end'
 */
function scriptedDecoder(script){
    const calls = { decode: 0 };
    return {
        calls,
        /** @param {Uint8Array} bytes */
        open(bytes){
            assert.equal(bytes.length, 3);
            let at = 0;
            let frames = 0;
            return {
                width: 2, height: 1, fps: 25, frameCount: 3, hasVideo: true, hasAudio: true,
                sampleRate: 22050, channels: 1,
                decode(){
                    calls.decode++;
                    return script[at++] ?? 'end';
                },
                frame: ()=>Uint8Array.of(++frames, 0, 0, 255, frames, 0, 0, 255),
                readAudio: ()=>(script[at - 1] === 'audio' ? Int16Array.of(at, -at) : null),
                close(){},
            };
        },
    };
}

/** Two ends of a channel, each message delivered on a later turn as a worker's is. */
function ports(){
    /** @type {(message: any) => void} */
    let toEngine = ()=>{};
    /** @type {(message: any) => void} */
    let toWorker = ()=>{};
    const clone = (/** @type {any} */ message)=>structuredClone(message);
    return {
        engine: {
            post: (/** @type {any} */ message)=>setImmediate(()=>toWorker(clone(message))),
            listen: (/** @type {(message: any) => void} */ handler)=>{
                toEngine = handler;
            },
        },
        worker: {
            post: (/** @type {any} */ message)=>setImmediate(()=>toEngine(clone(message))),
            /** @param {(message: any) => void} handler */
            serve: handler=>{
                toWorker = handler;
            },
        },
    };
}

const settle = ()=>new Promise(resolve=>setTimeout(resolve, 20));

test('a film decoded on another thread arrives in the order the decoder made it', async()=>{
    const { engine, worker } = ports();
    const decoder = scriptedDecoder(['frame', 'audio', 'frame', 'frame', 'end']);
    worker.serve(serveClips(worker, Promise.resolve(decoder)));
    const clips = createRemoteClips(engine);

    const clip = await clips.open(Uint8Array.of(1, 2, 3));
    assert.equal(clip.width, 2);
    assert.equal(clip.sampleRate, 22050);
    assert.equal(clip.decode(), 'pending', 'nothing has arrived on the first turn');

    await settle();
    assert.equal(clip.decode(), 'frame');
    assert.deepEqual([...clip.frame()], [1, 0, 0, 255, 1, 0, 0, 255]);
    assert.equal(clip.decode(), 'audio');
    assert.deepEqual([...clip.readAudio()], [2, -2]);
    assert.equal(clip.decode(), 'frame');
    assert.equal(clip.frame()[0], 2);
    assert.equal(clip.decode(), 'frame');
    assert.equal(clip.decode(), 'end');
    clip.close();
});

test('the decoding thread works ahead by a bounded number of frames and no further',
    async()=>{
        const { engine, worker } = ports();
        const decoder = scriptedDecoder(Array(40).fill('frame'));
        worker.serve(serveClips(worker, Promise.resolve(decoder)));
        const clips = createRemoteClips(engine);
        const clip = await clips.open(Uint8Array.of(1, 2, 3));

        await settle();
        assert.equal(decoder.calls.decode, AHEAD, 'it stopped once that many were waiting');

        assert.equal(clip.decode(), 'frame');
        assert.equal(clip.decode(), 'frame');
        await settle();
        assert.equal(decoder.calls.decode, AHEAD + 2, 'and each frame taken bought one more');
        clip.close();
    });

test('a clip the thread cannot open is refused with the decoder\'s reason', async()=>{
    const { engine, worker } = ports();
    worker.serve(serveClips(worker, Promise.resolve({ open(){
        throw new Error('no codec');
    } })));
    const clips = createRemoteClips(engine);
    await assert.rejects(clips.open(Uint8Array.of(1, 2, 3)), /no codec/);
});
