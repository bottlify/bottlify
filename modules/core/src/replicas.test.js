/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplicas } from './replicas.js';

/**
 * A process as the replicas see one: its written files and its hive.
 *
 * @param {Record<string, string>} files
 */
function process(files){
    /** @type {Map<string, Uint8Array>} */
    const held = new Map(Object.entries(files).map(([path, text])=>
        [path, new TextEncoder().encode(text)]));
    /** @type {any} */
    let hive = { roots: [{ id: 0x80000002, key: { name: '', values: [], keys: [] } }] };
    return {
        held,
        session: {
            export: ()=>[...held].map(([path, bytes])=>({ path, bytes })),
            /** @param {{ path: string, bytes?: Uint8Array, delete?: boolean }[]} batch */
            apply: batch=>batch.forEach(file=>(file.delete
                ? held.delete(file.path)
                : held.set(file.path, /** @type {Uint8Array} */ (file.bytes)))),
        },
        registry: ()=>({
            toJSON: ()=>structuredClone(hive),
            /** @param {any} next */
            fromJSON: next=>{
                hive = structuredClone(next);
            },
        }),
        /** @param {string} name @param {number} value */
        setValue(name, value){
            hive.roots[0].key.keys = [{ name: 'Software', keys: [],
                values: [{ name, type: 4, data: [value, 0, 0, 0] }] }];
        },
        text: (/** @type {string} */ path)=>new TextDecoder().decode(held.get(path)),
    };
}

test('what one process wrote reaches the other, and is not carried back over newer work',
    ()=>{
        const replicas = createReplicas();
        const client = process({ 'C:\\setup.ini': 'v1' });
        const server = process({ 'C:\\setup.ini': 'v1' });
        replicas.track(client);
        replicas.track(server);

        server.held.set('C:\\App\\game.exe', new TextEncoder().encode('MZ'));
        server.setValue('Installed', 1);
        replicas.publish(server);
        assert.equal(client.text('C:\\App\\game.exe'), 'MZ');
        assert.deepEqual(client.registry().toJSON().roots[0].key.keys[0].values[0].data,
            [1, 0, 0, 0]);

        server.held.set('C:\\App\\game.exe', new TextEncoder().encode('MZ2'));
        replicas.publish(client);
        replicas.publish(server);
        assert.equal(client.text('C:\\App\\game.exe'), 'MZ2',
            'the client never wrote it, so it is not the client\'s to carry back');

        server.held.delete('C:\\setup.ini');
        replicas.publish(server);
        assert.equal(client.held.has('C:\\setup.ini'), false, 'a deletion travels too');
    });
