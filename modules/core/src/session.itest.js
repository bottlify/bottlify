/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Phase 4 acceptance, in the part that can be checked without a browser: a
 * program writes a file, the machine is thrown away, and a new one built from
 * the session it left behind finds the file there.
 *
 * The Master Plan words this as "reopened on another machine under the same
 * account". Everything between the two runs here is what would travel: the
 * session goes out through the same interface a cloud would upload, and comes
 * back in through the one it would restore from. What is not covered is the
 * transport itself, and it is named as such rather than pretended.
 *
 * The fixture reports what it read rather than being asked about it, so the
 * assertion is on the program's own behaviour: a first run prints nothing and
 * leaves a file, a second prints what the first wrote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { packSession, unpackSession } from './storage.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/session.exe', import.meta.url);

/** What the fixture writes; it must come back out of the second run verbatim. */
const PAYLOAD = 'SAVED-01';

/**
 * Runs the fixture once against a given session, and reports what it printed
 * and what it left behind.
 *
 * @param {{ path: string, bytes: Uint8Array }[]} incoming
 */
async function runOnce(incoming){
    const [wasm, exe] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(FIXTURE),
    ]);

    /** @type {{ path: string, bytes: Uint8Array }[]} */
    let saved = [];
    /** @type {any[]} */
    const announced = [];

    const app = await createApp({
        executable: new Uint8Array(exe),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
        storage: {
            load: async()=>incoming,
            /** @param {any[]} files @param {any[]} changes */
            save: (files, changes)=>{
                saved = files;
                announced.push(...changes);
            },
        },
    });

    let printed = '';
    app.on('output', (/** @type {any} */ payload)=>{
        printed += payload.text;
    });

    const exitCode = await app.run({ maxTurns: 20000 });
    // The save is announced on a microtask so a burst of writes becomes one
    // notification; let that settle before looking at what it produced.
    await new Promise(resolve=>setTimeout(resolve, 0));

    const session = app.session.export();
    await app.dispose();
    return { printed, exitCode, saved, announced, session };
}

test('a program finds, on its second run, what it wrote on its first', async()=>{
    const first = await runOnce([]);

    assert.equal(first.exitCode, 0);
    assert.equal(first.printed, '', 'nothing to read the first time round');
    assert.deepEqual(first.session.map((/** @type {any} */ file)=>file.path), ['C:\\save.dat'],
        'and it left exactly one file behind');

    // Everything between the runs is what a cloud would carry: out through the
    // interface an upload uses, back in through the one a restore uses.
    const travelled = await unpackSession(await packSession(first.session));
    const second = await runOnce(travelled);

    assert.equal(second.exitCode, 0);
    assert.equal(second.printed, PAYLOAD,
        'the second run read what the first wrote, through a packed session');
});

test('a run announces what changed, once per file', async()=>{
    const { announced, saved } = await runOnce([]);

    // The program writes its save in more than one call; what comes out is the
    // fact that the file is different now, not a log of every write.
    assert.deepEqual(announced.map((/** @type {any} */ change)=>change.path), ['C:\\save.dat']);
    assert.equal(announced[0].kind, 'written');
    assert.equal(saved.length, 1, 'and the save was handed the whole session, not a delta');
});

test('a session arriving from outside is there before the first instruction', async()=>{
    // Not a detail of ordering: a save that appears after the program has
    // looked for it is a save that was not there.
    const seeded = [{
        path: 'C:\\save.dat',
        bytes: new Uint8Array([...'RESTORED'].map(character=>character.charCodeAt(0))),
    }];

    const { printed } = await runOnce(seeded);
    assert.equal(printed, 'RESTORED');
});
