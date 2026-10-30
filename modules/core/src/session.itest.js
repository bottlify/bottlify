/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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

const FIXTURE = new URL('../test/fixtures/session.exe', import.meta.url);

/** What the fixture writes; it must come back out of the second run verbatim. */
const PAYLOAD = 'SAVED-01';

/**
 * Runs the fixture once against a given session, and reports what it printed
 * and what it left behind.
 *
 * The save is coalesced (`coalescedSaver`) and settles on its own timer, but
 * `dispose` flushes it immediately -- "what the program wrote last is saved
 * now rather than after it settles" -- so `saved`/`announced` are read only
 * after `dispose`, which is what actually delivers them, not a wait of our
 * own. Disposed on the error path too: the machine is one per process, and
 * the first test below runs this twice in the same test body, so the second
 * `createApp` needs the first machine gone before it runs.
 *
 * @param {{ path: string, bytes: Uint8Array }[]} incoming
 */
async function runOnce(incoming){
    const exe = await readFile(FIXTURE);

    /** @type {{ path: string, bytes: Uint8Array }[]} */
    let saved = [];
    /** @type {any[][]} what each save was told changed */
    const announced = [];

    const app = await createApp({
        executable: new Uint8Array(exe),
        storage: {
            load: async()=>incoming,
            /** @param {{ files: any[] }} session @param {any[]} changes */
            save: (session, changes)=>{
                saved = session.files;
                announced.push(changes);
            },
        },
    });
    try
    {
        let printed = '';
        app.on('output', (/** @type {any} */ payload)=>{
            printed += payload.text;
        });

        const exitCode = await app.run({ maxTurns: 20000, timeoutMs: 20000 });
        const session = app.session.export();
        await app.dispose();
        return { printed, exitCode, saved, announced, session };
    }
    catch (e){
        await app.dispose();
        throw e;
    }
}

test('a program finds, on its second run, what it wrote on its first',
    { timeout: 30000 }, async()=>{
        const first = await runOnce([]);

        assert.equal(first.exitCode, 0);
        assert.equal(first.printed, '', 'nothing to read the first time round');
        assert.deepEqual(first.session.map((/** @type {any} */ file)=>file.path), ['C:\\save.dat'],
            'and it left exactly one file behind');

        // Everything between the runs is what a cloud would carry: out through
        // the interface an upload uses, back in through the one a restore uses.
        const travelled = await unpackSession(await packSession(first.session));
        const second = await runOnce(travelled.files);

        assert.equal(second.exitCode, 0);
        assert.equal(second.printed, PAYLOAD,
            'the second run read what the first wrote, through a packed session');
    });

test('a run announces what changed, once per file', { timeout: 15000 }, async()=>{
    const { announced, saved } = await runOnce([]);

    // The program writes its save in more than one call; what comes out is the
    // fact that the file is different now, not a log of every write. Said of
    // each save: how many saves a run makes follows the saver's settle on the
    // host's timer, which a busy machine lets run out between two turns of the
    // program, and each of those saves is right to name the file.
    assert.ok(announced.length >= 1, 'the run was saved');
    for (const changes of announced)
    {
        assert.deepEqual(changes, [{ path: 'C:\\save.dat', kind: 'written' }],
            'each save names the file once');
    }
    assert.equal(saved.length, 1, 'and the save was handed the whole session, not a delta');
});

test('a session arriving from outside is there before the first instruction',
    { timeout: 15000 }, async()=>{
        // Not a detail of ordering: a save that appears after the program has
        // looked for it is a save that was not there.
        const seeded = [{
            path: 'C:\\save.dat',
            bytes: new Uint8Array([...'RESTORED'].map(character=>character.charCodeAt(0))),
        }];

        const { printed } = await runOnce(seeded);
        assert.equal(printed, 'RESTORED');
    });
