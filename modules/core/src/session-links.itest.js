/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate for hard links across a session: a volume a program changed --
 * files made, written, truncated, linked, renamed and deleted, in seeded
 * random order -- and the volume a later run builds from the session saved
 * of it must be the same to everything a program can ask. Every name's bytes,
 * size, number of links, which names are one file, and every directory's
 * listing; through the packed session (the local one is that, as base64)
 * and the origin file system's folder alike.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from './layers/filesystem/module.js';
import { opfsSession, packSession, unpackSession } from './storage.js';

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    };
}

/** A directory handle's interface, as much of it as a session folder uses. */
function fakeDirectory(){
    /** @returns {any} */
    const folder = ()=>{
        /** @type {Map<string, any>} */
        const here = new Map();
        /** @type {Map<string, any>} */
        const below = new Map();
        return {
            /** @param {string} name @param {{ create?: boolean }} [options] */
            async getFileHandle(name, options){
                if (!here.has(name))
                {
                    if (!options?.create)
                    {
                        throw new Error('NotFoundError');
                    }
                    here.set(name, new Uint8Array(0));
                }
                return {
                    getFile: async()=>new Blob([here.get(name)]),
                    createWritable: async()=>{
                        let written = new Uint8Array(0);
                        return {
                            write: async(/** @type {Uint8Array} */ chunk)=>{
                                written = chunk.slice();
                            },
                            close: async()=>{
                                here.set(name, written);
                            },
                        };
                    },
                };
            },
            /** @param {string} name @param {{ create?: boolean }} [options] */
            async getDirectoryHandle(name, options){
                if (!below.has(name))
                {
                    if (!options?.create)
                    {
                        throw new Error('NotFoundError');
                    }
                    below.set(name, folder());
                }
                return below.get(name);
            },
            /** @param {string} name */
            async removeEntry(name){
                if (!here.delete(name) && !below.delete(name))
                {
                    throw new Error('NotFoundError');
                }
            },
            async* entries(){
                for (const name of [...here.keys()])
                {
                    yield [name, await this.getFileHandle(name)];
                }
            },
        };
    };
    return folder();
}

/**
 * Everything a program can ask of the volume, as one value: each directory's
 * listing, each file's bytes and links, and which names are one file.
 *
 * @param {any} fs
 */
function observe(fs){
    /** @type {Record<string, any>} */
    const seen = {};
    /** @type {Map<string, string[]>} */
    const identities = new Map();
    /** @param {string} directory */
    const walk = directory=>{
        const entries = fs.list(`${directory}\\*`)
            .sort((/** @type {any} */ a, /** @type {any} */ b)=>a.name.localeCompare(b.name));
        seen[directory] = entries.map((/** @type {any} */ entry)=>`${entry.name}`
            + `${entry.directory ? '\\' : `:${entry.size}:${entry.links}`}`);
        for (const entry of entries)
        {
            const path = `${directory}\\${entry.name}`;
            if (entry.directory)
            {
                walk(path);
                continue;
            }
            const handle = fs.open(path, { read: true });
            seen[path] = [...fs.read(handle, entry.size)].join(',');
            fs.close(handle);
            const identity = fs.stat(path).identity;
            identities.set(identity, [...identities.get(identity) ?? [], path.toUpperCase()]);
        }
    };
    walk('C:');
    seen.oneFile = [...identities.values()].map(names=>names.sort().join('=')).sort();
    return seen;
}

/**
 * A program's run, in `steps` random changes: names are few, so changes land
 * on each other -- a write through a link, a delete of a file's first name,
 * a rename of a name whose file has others.
 *
 * @param {any} fs @param {() => number} next @param {number} steps
 */
function play(fs, next, steps){
    const names = ['A', 'B', 'C', 'D', 'E'].flatMap(name=>[`C:\\${name}.DAT`,
        `C:\\SUB\\${name}.DAT`]);
    const pick = ()=>names[Math.floor(next() * names.length)];
    fs.createDirectory('C:\\SUB');
    for (let step = 0; step < steps; step++)
    {
        const choice = next();
        const name = pick();
        const exists = fs.stat(name) !== null;
        try
        {
            if (!exists || choice < 0.15)
            {
                const handle = fs.open(name, { write: true, disposition: 'OPEN_ALWAYS' });
                const length = Math.floor(next() * 6);
                fs.seek(handle, Math.floor(next() * 4));
                fs.write(handle, Uint8Array.from({ length }, ()=>Math.floor(next() * 256)));
                fs.close(handle);
            }
            else if (choice < 0.4)
            {
                fs.link(pick(), name);
            }
            else if (choice < 0.55)
            {
                fs.rename(name, pick());
            }
            else if (choice < 0.7)
            {
                fs.deleteFile(name);
            }
            else if (choice < 0.8)
            {
                const handle = fs.open(name, { write: true });
                fs.seek(handle, Math.floor(next() * 5));
                fs.setEndOfFile(handle);
                fs.close(handle);
            }
            else
            {
                const handle = fs.open(name, { write: true });
                fs.seek(handle, Math.floor(next() * 5));
                fs.write(handle, Uint8Array.of(Math.floor(next() * 256)));
                fs.close(handle);
            }
        }
        catch (e){
            // A name taken, a file not there: refused as Windows refuses it,
            // and the same refusal on both sides of the comparison.
            if (!(/** @type {any} */ (e)?.code))
            {
                throw e;
            }
        }
    }
}

/** @param {any} session */
async function restored(session){
    const fs = await filesystemModule.create({});
    fs.apply(session.files);
    if (session.links)
    {
        fs.applyLinks(session.links);
    }
    return fs;
}

test('a volume rebuilt from its saved session is the volume that was saved', async()=>{
    let linked = 0;
    for (let seed = 1; seed <= 60; seed++)
    {
        const fs = await filesystemModule.create({});
        play(fs, random(seed), 80);
        const session = { files: fs.export(), registry: null, links: fs.exportLinks() };
        linked += session.links.length;
        const before = observe(fs);

        // What a reader that keeps no links takes: every name, as a file of its own.
        const every = fs.export(undefined, { everyName: true });
        assert.equal(every.length, session.files.length
            + session.links.reduce((/** @type {number} */ count, /** @type {any} */ record)=>
                count + record.names.length, 0));
        for (const file of every)
        {
            assert.equal([...file.bytes].join(','), before[file.path],
                `seed ${seed}, ${file.path}`);
        }

        const packed = await unpackSession(await packSession(session));
        assert.deepEqual(observe(await restored(packed)), before, `seed ${seed}, packed`);

        const folder = fakeDirectory();
        const kept = opfsSession('gate', async()=>folder);
        await kept.save(session);
        assert.deepEqual(observe(await restored(await kept.load())), before,
            `seed ${seed}, the origin file system's folder`);
    }
    assert.ok(linked > 20, `the sequences made links to compare (${linked})`);
});

test('a session with no links is saved as it always was', async()=>{
    const fs = await filesystemModule.create({});
    play(fs, random(7), 0);
    const handle = fs.open('C:\\SAVE.DAT', { write: true, disposition: 'OPEN_ALWAYS' });
    fs.write(handle, Uint8Array.of(1, 2, 3));
    fs.close(handle);
    const today = { files: fs.export(), registry: { k: 1 } };
    const withNone = { ...today, links: fs.exportLinks() };
    assert.deepEqual(withNone.links, []);
    assert.deepEqual(await packSession(withNone), await packSession(today),
        'no links entry, byte for byte');
    assert.deepEqual(Object.keys(await unpackSession(await packSession(today))),
        ['files', 'registry'], 'and read back in the shape it always had');
});
