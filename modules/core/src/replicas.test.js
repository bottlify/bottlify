/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplicas } from './replicas.js';

/**
 * A process as the replicas see one: its written files, counted by
 * generation as the volume counts them, and its hive with its revision.
 *
 * @param {Record<string, string>} files
 */
function process(files){
    /** @type {Map<string, Uint8Array>} */
    const held = new Map(Object.entries(files).map(([path, text])=>
        [path, new TextEncoder().encode(text)]));
    /** @type {Map<string, number>} */
    const touched = new Map();
    let generation = 0;
    let revision = 0;
    const reads = { files: 0, hive: 0 };
    /** @param {string} path */
    const touch = path=>touched.set(path, ++generation);
    /** @type {any} */
    let hive = { roots: [{ id: 0x80000002, key: { name: '', values: [], keys: [] } }] };
    return {
        held,
        reads,
        /** @param {string} path @param {string} text */
        write(path, text){
            held.set(path, new TextEncoder().encode(text));
            touch(path);
        },
        /** @param {string} path */
        remove(path){
            held.delete(path);
            touch(path);
        },
        session: {
            generation: ()=>generation,
            /** @param {number} mark */
            changesSince: mark=>[...touched].filter(([, at])=>at > mark).map(([path])=>{
                reads.files++;
                const bytes = held.get(path);
                return bytes ? { path, bytes } : { path, delete: true };
            }),
            /**
             * @param {{ path: string, bytes?: Uint8Array, delete?: boolean }[]} batch
             * @param {{ quiet?: boolean }} [options]
             */
            apply: (batch, options)=>batch.forEach(file=>{
                if (file.delete)
                {
                    held.delete(file.path);
                }
                else
                {
                    held.set(file.path, /** @type {Uint8Array} */ (file.bytes));
                }
                if (!options?.quiet)
                {
                    touch(file.path);
                }
            }),
        },
        registry: ()=>({
            revision: ()=>revision,
            toJSON: ()=>{
                reads.hive++;
                return structuredClone(hive);
            },
            /** @param {any} next */
            fromJSON: next=>{
                hive = structuredClone(next);
            },
        }),
        /** @param {string} name @param {number} value */
        setValue(name, value){
            hive.roots[0].key.keys = [{ name: 'Software', keys: [],
                values: [{ name, type: 4, data: [value, 0, 0, 0] }] }];
            revision++;
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

        server.write('C:\\App\\game.exe', 'MZ');
        server.setValue('Installed', 1);
        replicas.publish(server);
        assert.equal(client.text('C:\\App\\game.exe'), 'MZ');
        assert.deepEqual(client.registry().toJSON().roots[0].key.keys[0].values[0].data,
            [1, 0, 0, 0]);

        server.write('C:\\App\\game.exe', 'MZ2');
        replicas.publish(client);
        replicas.publish(server);
        assert.equal(client.text('C:\\App\\game.exe'), 'MZ2',
            'the client never wrote it, so it is not the client\'s to carry back');

        server.remove('C:\\setup.ini');
        replicas.publish(server);
        assert.equal(client.held.has('C:\\setup.ini'), false, 'a deletion travels too');
    });

test('a process that changed nothing since it was last brought up to date is not read',
    ()=>{
        const replicas = createReplicas();
        const client = process({});
        const server = process({});
        replicas.track(client);
        replicas.track(server);
        server.write('C:\\App\\data.cab', 'payload');
        replicas.publish(server);
        const before = { ...server.reads };

        // A call across and back, a thousand times: nothing written, nothing read.
        for (let call = 0; call < 1000; call++)
        {
            replicas.publish(server);
            replicas.publish(client);
        }
        assert.deepEqual(server.reads, before, 'the server was not read again');
        assert.equal(client.reads.files, 0, 'nor was the client, which only received');

        // One more file: only it is read, not the one already carried.
        server.write('C:\\App\\game.exe', 'MZ');
        replicas.publish(server);
        assert.equal(server.reads.files, before.files + 1);
        assert.equal(server.reads.hive, before.hive, 'and the registry, unchanged, is not');
        assert.equal(client.text('C:\\App\\game.exe'), 'MZ');
    });
