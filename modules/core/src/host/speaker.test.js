/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSpeaker } from './speaker.js';

/** A target of events, as far as the speaker listens to one. */
function target(){
    /** @type {Map<string, Set<(event?: any) => void>>} */
    const handlers = new Map();
    return {
        /** @param {string} type @param {(event?: any) => void} handler */
        addEventListener(type, handler){
            handlers.set(type, (handlers.get(type) ?? new Set()).add(handler));
        },
        /** @param {string} type @param {(event?: any) => void} handler */
        removeEventListener(type, handler){
            handlers.get(type)?.delete(handler);
        },
        /** @param {string} type */
        fire(type){
            for (const handler of [...handlers.get(type) ?? []])
            {
                handler({ type });
            }
        },
        count: ()=>[...handlers.values()].reduce((total, set)=>total + set.size, 0),
    };
}

/**
 * A page with a phone's audio: a context that starts only when `resume` is
 * called inside a gesture (`gesture` true), as WebKit on a phone does.
 *
 * @param {{ isolated?: boolean, module?: Promise<void> }} [options]
 */
function phone({ isolated = true, module = Promise.resolve() } = {}){
    const page = target();
    /** @type {any[]} */
    const contexts = [];
    /** @type {any[]} */
    const nodes = [];
    const world = { gesture: true, session: { type: 'auto' }, page, contexts, nodes };
    class FakeContext {
        /** @param {any} options */
        constructor(options){
            Object.assign(this, target());
            this.options = options;
            this.state = 'suspended';
            this.sampleRate = 48000;
            this.resumes = 0;
            this.started = /** @type {number[]} */ ([]);
            this.destination = { name: 'destination' };
            this.audioWorklet = { added: /** @type {string[]} */ ([]),
                addModule: (/** @type {string} */ url)=>{
                    this.audioWorklet.added.push(url);
                    return module;
                } };
            contexts.push(this);
        }

        /** @param {string} state */
        become(state){
            this.state = state;
            /** @type {any} */ (this).fire('statechange');
        }

        resume(){
            this.resumes++;
            if (world.gesture && this.state !== 'closed')
            {
                this.become('running');
            }
            return new Promise(()=>{});
        }

        suspend(){
            this.become('suspended');
            return Promise.resolve();
        }

        close(){
            this.become('closed');
            return Promise.resolve();
        }

        createBuffer(){
            return {};
        }

        createBufferSource(){
            return { connect(){}, start: (/** @type {number} */ at)=>this.started.push(at) };
        }

        createGain(){
            /** @type {any} */ (this).gainNode = { gain: { value: 1 }, connect(){} };
            return /** @type {any} */ (this).gainNode;
        }
    }
    class FakeNode {
        /** @param {any} context @param {string} name @param {any} options */
        constructor(context, name, options){
            Object.assign(this, { context, name, options, posted: /** @type {any[]} */ ([]),
                connected: 0, disconnected: 0 });
            const self = /** @type {any} */ (this);
            self.port = { postMessage: (/** @type {any} */ message)=>self.posted.push(message) };
            nodes.push(this);
        }

        connect(){
            /** @type {any} */ (this).connected++;
        }

        disconnect(){
            /** @type {any} */ (this).disconnected++;
        }
    }
    const scope = {
        AudioContext: FakeContext,
        AudioWorkletNode: FakeNode,
        MessageChannel: class {
            port1 = { name: 'port1' };
            port2 = { name: 'port2' };
        },
        navigator: { audioSession: world.session },
        document: page,
        crossOriginIsolated: isolated,
        setTimeout: (/** @type {() => void} */ callback, /** @type {number} */ ms)=>
            setTimeout(callback, ms),
        clearTimeout: (/** @type {any} */ timer)=>clearTimeout(timer),
    };
    return { world, scope };
}

test('opened in the gesture, the speaker runs, plays as a game, unlocks with silence', async()=>{
    const { world, scope } = phone();
    const speaker = openSpeaker({ worklet: '/engine/worklet.js', scope: /** @type {any} */ (scope) });
    const [context] = world.contexts;
    assert.equal(context.state, 'running', 'resumed before anything was awaited');
    assert.equal(world.session.type, 'playback', 'so the ring switch does not mute it');
    assert.deepEqual(context.started, [0]);
    assert.deepEqual(await speaker.ready(50), { running: true });
    assert.deepEqual(context.audioWorklet.added, ['/engine/worklet.js']);
    await speaker.close();
});

test('a context the browser keeps stopped says so, and starts at the next gesture', async()=>{
    const { world, scope } = phone();
    world.gesture = false;
    const speaker = openSpeaker({ scope: /** @type {any} */ (scope) });
    const [context] = world.contexts;
    assert.deepEqual(await speaker.ready(20),
        { running: false, reason: 'the audio context stayed suspended' });
    assert.notEqual(context.state, 'closed', 'kept, not closed');

    world.gesture = true;
    world.page.fire('touchend');
    assert.equal(context.state, 'running');
    await speaker.close();
});

test('an interruption nobody asked for is resumed; a suspension asked for is not', async()=>{
    const { world, scope } = phone();
    const speaker = openSpeaker({ scope: /** @type {any} */ (scope) });
    const [context] = world.contexts;

    world.gesture = false;
    context.become('interrupted');
    assert.equal(context.state, 'interrupted', 'a phone lets it start again only in a gesture');
    world.gesture = true;
    world.page.fire('pointerup');
    assert.equal(context.state, 'running');

    speaker.suspend();
    world.page.fire('click');
    assert.equal(context.state, 'suspended', 'a paused run stays quiet');
    speaker.resume();
    assert.equal(context.state, 'running');
    await speaker.close();
});

test('a worklet that does not load is the reason there is no sound', async()=>{
    const { scope } = phone({ module: Promise.reject(new Error('404')) });
    const speaker = openSpeaker({ scope: /** @type {any} */ (scope) });
    assert.deepEqual(await speaker.ready(20),
        { running: false, reason: 'the audio worklet did not load: 404' });
    await speaker.close();
});

test('shared, the worklet reads the track tables; unshared, the engine posts its mix', async()=>{
    const app = {
        audio: { format: ()=>({ channels: 2 }), memory: ()=>({ table: 'table' }) },
        /** @type {Map<string, (event: any) => void>} */
        handlers: new Map(),
        /** @param {string} name @param {(event: any) => void} handler */
        on(name, handler){
            app.handlers.set(name, handler);
            return ()=>app.handlers.delete(name);
        },
    };
    const shared = phone();
    const speaker = openSpeaker({ scope: /** @type {any} */ (shared.scope) });
    assert.deepEqual(speaker.audioOptions(), { drained: true, sampleRate: 48000 });
    speaker.connect(app);
    const [node] = shared.world.nodes;
    assert.deepEqual(node.options, { outputChannelCount: [2],
        processorOptions: { table: 'table', channels: 2 } });
    app.handlers.get('sound-table')?.({ id: 7, table: 'seven' });
    assert.deepEqual(node.posted, [{ type: 'table', id: 7, table: 'seven' }]);
    await speaker.close();
    assert.equal(app.handlers.size, 0, 'nothing left listening');
    assert.equal(node.disconnected, 1);
    assert.equal(shared.world.page.count(), 0, 'nor on the page');

    const apart = phone({ isolated: false });
    const posted = openSpeaker({ scope: /** @type {any} */ (apart.scope) });
    assert.deepEqual(posted.audioOptions(), { drained: true, sampleRate: 48000,
        port: { name: 'port2' } });
    posted.connect(app);
    assert.deepEqual(apart.world.nodes[0].options.processorOptions, { channels: 2 });
    assert.deepEqual(apart.world.nodes[0].posted, [{ type: 'feed', port: { name: 'port1' } }]);
    await posted.close();
});

test('the volume is the output\'s, before and after it plays', async()=>{
    const { scope } = phone();
    const speaker = openSpeaker({ scope: /** @type {any} */ (scope) });
    speaker.volume(0);
    speaker.connect({ audio: { format: ()=>({ channels: 2 }), memory: ()=>({ table: null }) },
        on: ()=>()=>{} });
    assert.equal(speaker.context.gainNode.gain.value, 0, 'silent from the first sample');
    speaker.volume(0.5);
    assert.equal(speaker.context.gainNode.gain.value, 0.5);
    await speaker.close();
});
