/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../../vendor/cellar/cellar.js';
import { openRunCache, relayedJoin } from './run-cache.js';

/** A reader over what `join` handed a thread, told what the keeper says after. */
const joinedReader = (/** @type {{ join: (post: (message: any) => void) => any }} */ run)=>{
    /** @type {any} */
    let reader = null;
    const joined = run.join(message=>reader?.adopt(message));
    reader = createReader({ shared: joined.shared, segments: joined.segments,
        keeper: { reserve: ()=>null, raise: ()=>false, raiseLater: ()=>{}, drop: ()=>{} } });
    return reader;
};

/** Enough names that the keeper's index makes its table larger. */
const NAMES = 3000;

test('a thread joined after the index grew finds every name, the ones put before and after',
    async()=>{
        const run = await openRunCache({ budget: 64 << 20 });
        try
        {
            for (let n = 0; n < NAMES; n++)
            {
                assert.ok(run.reader.put(`n/${n}`, new Uint8Array([n & 0xff])));
            }
            const late = joinedReader(run);
            run.reader.put('n/after', new Uint8Array([7]));
            for (const n of [0, NAMES >> 1, NAMES - 1])
            {
                assert.equal(late.with(`n/${n}`, (/** @type {Uint8Array} */ body)=>body[0]), n & 0xff,
                    `name ${n}`);
            }
            assert.equal(late.with('n/after', (/** @type {Uint8Array} */ body)=>body[0]), 7);

            // The same through a thread that passes the run's cache on (a process in a
            // worker of its own, to its executors): it was joined before the growth.
            const relay = relayedJoin(run.join(message=>relay.adopt(message)));
            for (let n = 0; n < NAMES; n++)
            {
                run.reader.put(`m/${n}`, new Uint8Array([n & 0xff]));
            }
            const relayed = joinedReader(relay);
            assert.equal(relayed.with(`m/${NAMES - 1}`, (/** @type {Uint8Array} */ body)=>body[0]),
                (NAMES - 1) & 0xff);
        }
        finally
        {
            run.close();
        }
    });
