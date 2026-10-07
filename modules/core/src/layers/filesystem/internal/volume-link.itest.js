/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of what a process across a link keeps of the run's volume
 * (`volume-link.js`): seeded programs of opens, reads, writes, seeks, ends,
 * closes, listings, creations and removals, by three processes standing on
 * the volume from afar and one standing on it here, run twice -- once with
 * every operation asked of the system, once with what is read kept until the
 * drive's word moves and every open settled in the run's shared sharing --
 * and everything a program can observe compared: every
 * answer, every refusal, the bytes of every read, and the volume as it ends.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilesystemModule } from '../module.js';
import { decodeValue, encodeValue } from '../../../system/codec.js';
import { createMemoryStore } from './memory-store.js';
import { createSharingMemory, openSharedSharing } from './shared-sharing.js';
import { CHUNK, remoteVolume, volumeHandlers } from './volume-link.js';

/** @param {number} seed */
const random = seed=>{
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
};

/** @param {() => number} next @param {number} length */
const bytesOf = (next, length)=>Uint8Array.from({ length }, ()=>Math.floor(next() * 256));

const DIRECTORIES = ['C:\\Data', 'C:\\Data\\Maps', 'C:\\Save'];
const FILES = ['C:\\Data\\pak0.pk4', 'C:\\Data\\pak1.pk4', 'C:\\Data\\Maps\\one.map',
    'C:\\Save\\game.sav', 'C:\\Save\\log.txt', 'C:\\readme.txt', 'C:\\data\\PAK0.PK4'];
const LENGTHS = [0, 1, 17, 512, 4096, CHUNK - 1, CHUNK, CHUNK + 3, 3 * CHUNK + 5];

/**
 * A run's volume with a source of files reaching over several chunks, and the
 * processes that stand on it: the first here, the rest across a link that is
 * a call through the codec, as a link's is.
 *
 * @param {number} seed @param {boolean} kept
 */
async function world(seed, kept){
    const next = random(seed);
    const memory = { revisions: new Int32Array(new SharedArrayBuffer(26 * 4)),
        sharing: createSharingMemory() };
    const run = { drives: new Map(), volumes: new Map(), writables: new Map(),
        watchers: new Set(), revisions: memory.revisions,
        ...kept ? { sharing: openSharedSharing(memory.sharing) } : {} };
    /** @type {Record<string, Uint8Array | null>} */
    const seeded = { 'Data': null, 'Data\\Maps': null, 'Save': null };
    seeded['Data\\pak0.pk4'] = bytesOf(next, 2 * CHUNK + 777);
    seeded['Data\\pak1.pk4'] = bytesOf(next, CHUNK);
    seeded['Data\\Maps\\one.map'] = bytesOf(next, 3000);
    seeded['readme.txt'] = bytesOf(next, 40);
    let clock = 0;
    const here = await createFilesystemModule().create({ volume: run, now: ()=>clock,
        drives: { C: { source: createMemoryStore(seeded) } } });
    const handlers = volumeHandlers(run).volume;
    /** @param {any} value */
    const across = value=>decodeValue(encodeValue(value));
    /** @param {string} method @param {any[]} args */
    const ask = (method, args)=>{
        let answer;
        try
        {
            answer = /** @type {any} */ (handlers)[method](...across(args));
        }
        catch (e){
            throw Object.assign(new Error(/** @type {Error} */ (e).message),
                { code: /** @type {any} */ (e).code });
        }
        return across(answer);
    };
    /** @param {string} method @param {any[]} args */
    const tell = (method, args)=>{
        ask(method, args);
    };
    const processes = [here];
    /** @type {ReturnType<typeof createFilesystemModule>[]} */
    const layers = [];
    for (let count = 0; count < 3; count++)
    {
        const layer = createFilesystemModule();
        layers.push(layer);
        processes.push(await layer.create({
            volume: remoteVolume(ask, kept ? memory : null, kept ? tell : null) }));
    }
    return { processes, tick: ()=>clock++,
        /** What the processes across kept: how often a read was answered here. */
        hits: ()=>layers.reduce((sum, layer)=>
            sum + (layer.diagnostics().metrics?.volumes['C:']?.hits ?? 0), 0) };
}

/**
 * One step of a program, the same on both arms: what it did, as values.
 *
 * @param {any} fs @param {any[]} handles @param {() => number} next @param {boolean} here
 */
function step(fs, handles, next, here){
    const pick = (/** @type {any[]} */ from)=>from[Math.floor(next() * from.length)];
    const file = pick(FILES);
    const roll = next();
    const handle = handles.length > 0 ? pick(handles) : null;
    const share = { shareRead: next() < 0.8, shareWrite: next() < 0.5 };
    if (roll < 0.14)
    {
        const write = next() < 0.4;
        const opened = fs.open(file, { read: true, write, ...share,
            disposition: write ? pick([fs.Disposition.OPEN_ALWAYS, fs.Disposition.CREATE_ALWAYS,
                fs.Disposition.OPEN_EXISTING]) : fs.Disposition.OPEN_EXISTING });
        handles.push(opened);
        return ['open', file];
    }
    if (roll < 0.45 && handle)
    {
        return ['read', [...fs.read(handle, pick(LENGTHS))]];
    }
    if (roll < 0.55 && handle)
    {
        return ['write', fs.write(handle, bytesOf(next, pick(LENGTHS)))];
    }
    if (roll < 0.68 && handle)
    {
        return ['seek', fs.seek(handle, Math.floor(next() * 3 * CHUNK) - (next() < 0.3 ? CHUNK : 0),
            pick(['begin', 'current', 'end']))];
    }
    if (roll < 0.7 && handle)
    {
        fs.setEndOfFile(handle);
        return ['end', fs.size(handle)];
    }
    if (roll < 0.76 && handle)
    {
        handles.splice(handles.indexOf(handle), 1);
        fs.close(handle);
        return ['close'];
    }
    if (roll < 0.84)
    {
        const entry = fs.stat(next() < 0.8 ? file : pick(DIRECTORIES));
        return ['stat', entry && [entry.name, entry.size, entry.directory, entry.modified]];
    }
    if (roll < 0.9)
    {
        return ['list', fs.list(pick(DIRECTORIES)).map((/** @type {any} */ entry)=>
            [entry.name, entry.size, entry.directory])
            .sort((/** @type {any} */ a, /** @type {any} */ b)=>(a[0] < b[0] ? -1 : 1))];
    }
    if (roll < 0.93)
    {
        fs.deleteFile(file);
        return ['delete', file];
    }
    if (roll < 0.96)
    {
        const directory = pick(DIRECTORIES);
        return ['directory', fs.createDirectory(`${directory}\\Sub`),
            next() < 0.5 ? fs.removeDirectory(`${directory}\\Sub`) : null];
    }
    if (here)
    {
        // What the page puts on the volume from outside, behind every
        // process's back.
        return ['apply', fs.apply([{ path: file, bytes: bytesOf(next, pick(LENGTHS)) }])];
    }
    return ['size', handle ? fs.size(handle) : null];
}

/** @param {() => any} run */
const outcome = run=>{
    try
    {
        return run();
    }
    catch (e){
        return ['refused', /** @type {any} */ (e).code ?? String(e)];
    }
};

for (const seed of [1, 2, 3, 4, 5, 6])
{
    test(`seed ${seed}: processes that keep what they read of the volume observe what processes`
        + ' that ask for every read observe', async()=>{
        const asked = await world(seed, false);
        const kept = await world(seed, true);
        const programs = random(seed * 7919);
        /** @type {{ asked: any[][], kept: any[][] }} */
        const handles = { asked: [[], [], [], []], kept: [[], [], [], []] };
        for (let index = 0; index < 3000; index++)
        {
            const which = Math.floor(programs() * 4);
            const draw = Math.floor(programs() * 0x7fffffff);
            const one = outcome(()=>step(asked.processes[which], handles.asked[which],
                random(draw), which === 0));
            const two = outcome(()=>step(kept.processes[which], handles.kept[which],
                random(draw), which === 0));
            asked.tick();
            kept.tick();
            assert.deepEqual(two, one, `step ${index}, process ${which}`);
        }
        for (const file of FILES)
        {
            const read = (/** @type {any} */ fs)=>outcome(()=>{
                const opened = fs.open(file, { read: true, shareRead: true, shareWrite: true,
                    disposition: fs.Disposition.OPEN_EXISTING });
                const bytes = [...fs.read(opened, 4 * CHUNK)];
                fs.close(opened);
                return bytes;
            });
            assert.deepEqual(read(kept.processes[0]), read(asked.processes[0]), file);
        }
        assert.ok(kept.hits() > 100, `what was kept answered ${kept.hits()} reads`);
        assert.equal(asked.hits(), 0);
    });
}
