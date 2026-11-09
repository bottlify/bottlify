/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tree and its stores agree, whatever a program does: every name the
 * tree holds as written is in the writable store under the node's key, and
 * nothing is in the store that the tree does not hold there. Neither store
 * folds case, so a store spelling a directory one way and the tree another
 * hands a program a file it cannot read and a session it cannot write out.
 *
 * Seeded random programs, run by two processes standing on one volume, over a
 * bundle and a writable layer that spell the same directories in different
 * cases, asking for every path in a case of their own; after every step the
 * drive's `disagreements` must be none, and every file `export` hands out must
 * read back the same through an open. And what the tree promises, the stores
 * keep: a file it lists takes a write, a directory it lists takes a new file
 * -- a store that refuses one is a store keyed otherwise than the tree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilesystemModule } from '../module.js';
import { ErrorCode } from './errors.js';
import { createMemoryStore } from './memory-store.js';

const DIRECTORIES = ['Windows', 'Temp', 'System32', 'Game', 'Data'];
const FILES = ['cpuz.sys', 'Save.DAT', 'a.txt'];
const CODES = new Set(Object.values(ErrorCode));

/** @param {number} seed */
function random(seed){
    // Scrambled and run in: xorshift from a small seed starts near zero.
    let state = (Math.imul(seed, 0x9e3779b1) ^ 0x5bd1e995) >>> 0 || 1;
    const next = ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
    for (let warm = 0; warm < 8; warm++)
    {
        next();
    }
    /** @template T @param {T[]} items @returns {T} */
    const pick = items=>items[Math.floor(next() * items.length)];
    /** @param {string} name */
    const spell = name=>[...name].map(character=>(next() < 0.5
        ? character.toLowerCase() : character.toUpperCase())).join('');
    const directory = ()=>Array.from({ length: 1 + Math.floor(next() * 2) },
        ()=>spell(pick(DIRECTORIES)));
    return { next, pick, spell, directory,
        file: ()=>[...directory(), spell(pick(FILES))],
        bytes: ()=>Uint8Array.from({ length: Math.floor(next() * 12) },
            ()=>Math.floor(next() * 256)) };
}

/**
 * A step that the volume refuses is a program's ordinary failure; anything
 * else is the layer's.
 *
 * @param {() => void} step
 */
const tolerate = step=>{
    try
    {
        step();
    }
    catch (e){
        if (!CODES.has(/** @type {any} */ (e)?.code))
        {
            throw e;
        }
    }
};

/**
 * Every file and directory a process sees on C:, as full paths.
 *
 * @param {any} fs
 */
const everything = fs=>{
    /** @type {string[]} */
    const files = [];
    const directories = ['C:\\'];
    for (let at = 0; at < directories.length; at++)
    {
        for (const entry of fs.list(directories[at]))
        {
            (entry.directory ? directories : files).push(entry.path);
        }
    }
    return { files, directories };
};

/** @param {string[]} components */
const onC = components=>`C:\\${components.join('\\')}`;

/** @param {number} seed */
async function run(seed){
    const r = random(seed);
    /** @type {Record<string, string>} */
    const source = {};
    for (let count = Math.floor(r.next() * 8); count > 0; count--)
    {
        source[r.file().join('\\')] = 'bundle';
    }
    const volume = { drives: new Map(), volumes: new Map(), writables: new Map(),
        watchers: new Set() };
    const layers = [createFilesystemModule(), createFilesystemModule()];
    const first = await layers[0].create({ volume });
    // The machine's own directories and files, made before the bundle is
    // mounted over them, in a spelling of their own.
    for (let count = 1 + Math.floor(r.next() * 4); count > 0; count--)
    {
        const at = r.file();
        for (let depth = 1; depth < at.length; depth++)
        {
            tolerate(()=>first.createDirectory(onC(at.slice(0, depth))));
        }
        tolerate(()=>first.apply([{ path: onC(at), bytes: r.bytes() }]));
    }
    first.mount('C', { source: createMemoryStore(source) });
    const processes = [first, await layers[1].create({ volume })];
    /** @type {{ fs: any, handle: any }[]} */
    const held = [];
    /** @type {string[]} */
    const log = [];

    const steps = {
        mkdir: (/** @type {any} */ fs)=>fs.createDirectory(onC(r.directory())),
        create: (/** @type {any} */ fs)=>{
            const handle = fs.open(onC(r.file()), { write: true, disposition: r.pick([
                fs.Disposition.CREATE_NEW, fs.Disposition.CREATE_ALWAYS,
                fs.Disposition.OPEN_ALWAYS, fs.Disposition.TRUNCATE_EXISTING]) });
            fs.write(handle, r.bytes());
            if (r.next() < 0.3)
            {
                fs.seek(handle, Math.floor(r.next() * 8));
                fs.setEndOfFile(handle);
            }
            if (r.next() < 0.3)
            {
                held.push({ fs, handle });
            }
            else
            {
                fs.close(handle);
            }
        },
        write: (/** @type {any} */ fs)=>{
            const handle = fs.open(onC(r.file()), { write: true });
            fs.seek(handle, Math.floor(r.next() * 8));
            fs.write(handle, r.bytes());
            fs.close(handle);
        },
        close: ()=>{
            const open = held.splice(Math.floor(r.next() * held.length), 1)[0];
            open?.fs.close(open.handle);
        },
        remove: (/** @type {any} */ fs)=>fs.deleteFile(onC(r.file())),
        rmdir: (/** @type {any} */ fs)=>fs.removeDirectory(onC(r.directory())),
        rename: (/** @type {any} */ fs)=>(r.next() < 0.5
            ? fs.rename(onC(r.file()), onC(r.file()))
            : fs.rename(onC(r.directory()), onC(r.directory()))),
        // A further name for a file: its bytes stay under the name that owns
        // them, which a later rename or delete may move.
        link: (/** @type {any} */ fs)=>fs.link(onC(r.file()), onC(r.file())),
        apply: (/** @type {any} */ fs)=>fs.apply(r.next() < 0.3
            ? [{ path: onC(r.file()), delete: true }]
            : [{ path: onC(r.file()), bytes: r.bytes() }]),
        // What the tree lists must take what it promises, refused only by
        // another open's terms: a copy-up of a bundle's file, a file made in
        // a directory the machine made before the bundle came.
        listed: (/** @type {any} */ fs)=>{
            const { files, directories } = everything(fs);
            if (files.length > 0 && r.next() < 0.5)
            {
                const path = r.pick(files);
                promised(()=>{
                    const handle = fs.open(path, { write: true, shareWrite: true });
                    fs.write(handle, r.bytes());
                    fs.close(handle);
                }, `a write to ${path}`);
                return;
            }
            const path = `${r.pick(directories).replace(/\\$/, '')}\\made${log.length}.tmp`;
            promised(()=>fs.close(fs.open(path,
                { write: true, disposition: fs.Disposition.CREATE_NEW })), `creating ${path}`);
        },
    };
    /** @param {() => void} step @param {string} what */
    const promised = (step, what)=>{
        try
        {
            step();
        }
        catch (e){
            assert.equal(/** @type {any} */ (e)?.code, ErrorCode.SHARING_VIOLATION,
                `${what} was refused, seed ${seed}, after ${log.join(' ')}: ${e}`);
        }
    };
    const names = /** @type {(keyof typeof steps)[]} */ (Object.keys(steps));

    for (let step = 0; step < 60; step++)
    {
        const which = r.next() < 0.5 ? 0 : 1;
        const name = r.pick(names);
        log.push(`${which}:${name}`);
        tolerate(()=>steps[name](processes[which]));

        const where = `seed ${seed}, after ${log.join(' ')}`;
        const report = /** @type {any} */ (layers[which].diagnostics());
        assert.equal(report.metrics.volumes['C:'].disagreements, 0, where);
        for (const entry of processes[which].export(undefined, { everyName: true }))
        {
            const reading = processes[1 - which].open(entry.path,
                { read: true, shareWrite: true });
            const read = processes[1 - which].read(reading, 1 << 16);
            processes[1 - which].close(reading);
            assert.deepEqual([...read], [...entry.bytes], `${entry.path}, ${where}`);
        }
    }
    for (const open of held)
    {
        open.fs.close(open.handle);
    }
    await Promise.all(layers.map(layer=>layer.dispose()));
}

test('the tree and its stores agree after every step, whatever a program spells how', async()=>{
    for (let seed = 1; seed <= 300; seed++)
    {
        await run(seed);
    }
});
