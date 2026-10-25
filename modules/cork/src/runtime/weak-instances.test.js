/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createWeakInstances } from './weak-instances.js';

setFlagsFromString('--expose-gc');
const gc = /** @type {() => void} */ (runInNewContext('gc'));
const turn = ()=>new Promise(resolve=>setTimeout(resolve, 0));

test('what nothing else holds is let go, key and all; what is held stays', async()=>{
    /** @type {ReturnType<typeof createWeakInstances<{ name: string }>>} */
    const map = createWeakInstances();
    const kept = { name: 'running' };
    map.set('kept', kept);
    (()=>{
        for (let index = 0; index < 50; index++)
        {
            map.set(`dropped ${index}`, { name: 'relinked away' });
        }
    })();
    // A collection in a turn of its own, as a weak reference read in a turn
    // holds its object to the end of it.
    for (let round = 0; round < 5 && map.size() > 1; round++)
    {
        await turn();
        gc();
        await turn();
    }
    assert.equal(map.live(), 1);
    assert.equal(map.size(), 1, 'the collected keys swept');
    assert.equal(map.get('kept'), kept);
    assert.equal(map.has('dropped 0'), false);
    assert.equal(map.get('dropped 0'), undefined);
});

test('one forgotten while held is not found, and its key names the next set under it',
    async()=>{
        /** @type {ReturnType<typeof createWeakInstances<{ name: string }>>} */
        const map = createWeakInstances();
        const first = { name: 'evicted' };
        map.set('module', first);
        map.delete('module');
        assert.equal(map.get('module'), undefined, 'while something else still holds it');
        const second = { name: 'brought back' };
        map.set('module', second);
        await turn();
        gc();
        await turn();
        assert.equal(map.get('module'), second);
        assert.equal(first.name, 'evicted');
    });
