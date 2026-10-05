/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createFilesystemModule } from '../module.js';
import { createLinkMemory, openLink } from '../../../system/link.js';
import { remoteVolume, volumeHandlers } from './volume-link.js';

const here = (/** @type {string} */ path)=>new URL(path, import.meta.url).href;

/** @param {string} text */
const bytes = text=>new TextEncoder().encode(text);

test('a process in another thread stands on the run\'s volume: it reads and writes what this'
    + ' one does, and the sharing both agreed to holds across them', { timeout: 30000 }, async()=>{
    const run = { drives: new Map(), volumes: new Map(), writables: new Map(),
        watchers: new Set() };
    const layer = createFilesystemModule();
    const here_ = await layer.create({ volume: run });
    here_.createDirectory('C:\\Save');
    const kept = here_.open('C:\\Save\\a.txt', { write: true, shareRead: false,
        disposition: here_.Disposition.CREATE_NEW });
    here_.write(kept, bytes('from A'));

    const { a, b } = createLinkMemory();
    const system = openLink(a, volumeHandlers(run));
    const serving = system.serve();
    const answer = await new Promise((resolve, reject)=>{
        const worker = new Worker(`
            const { workerData, parentPort } = require('node:worker_threads');
            (async()=>{
                const [{ openLink }, { createFilesystemModule }, { remoteVolume }] =
                    await Promise.all([import(workerData.link), import(workerData.module),
                        import(workerData.remote)]);
                const link = openLink(workerData.end, {});
                const fs = await createFilesystemModule().create({
                    volume: remoteVolume((method, args)=>
                        link.callWaiting('volume', method, args)) });
                const code = run=>{ try { run(); return null; } catch (e) { return e.code; } };
                const size = fs.stat('C:\\\\Save\\\\a.txt').size;
                const refused = code(()=>fs.open('C:\\\\Save\\\\A.TXT', { read: true }));
                const missing = code(()=>fs.open('C:\\\\Save\\\\none.txt', { read: true }));
                const mine = fs.open('C:\\\\Save\\\\b.txt', { write: true,
                    disposition: fs.Disposition.CREATE_NEW });
                fs.write(mine, new TextEncoder().encode('from B'));
                fs.close(mine);
                const names = fs.list('C:\\\\Save').map(entry=>entry.name).sort();
                parentPort.postMessage({ size, refused, missing, names });
            })().catch(e=>parentPort.postMessage({ error: String(e && e.stack || e) }));`,
        { eval: true, workerData: { end: b, link: here('../../../system/link.js'),
            module: here('../module.js'), remote: here('./volume-link.js') } });
        worker.once('message', message=>{
            worker.terminate();
            if (message.error)
            {
                reject(new Error(message.error));
            }
            else
            {
                resolve(message);
            }
        });
        worker.once('error', reject);
    });
    assert.deepEqual(answer, { size: 6, refused: 'SHARING_VIOLATION', missing: 'NOT_FOUND',
        names: ['a.txt', 'b.txt'] });
    const theirs = here_.open('C:\\Save\\b.txt', { read: true });
    assert.equal(new TextDecoder().decode(here_.read(theirs, 64)), 'from B',
        'what the other thread wrote is on the volume');
    here_.close(theirs);
    here_.close(kept);
    system.close();
    await serving;
    await layer.dispose();
});

test('a process on the run\'s volume from afar reports its drives as the run\'s, not by walking'
    + ' them', async()=>{
    /** @type {string[]} */
    const asked = [];
    const volume = remoteVolume((method, args)=>{
        asked.push(method === 'call' ? args[1] : method);
        return method === 'drives' ? [{ letter: 'C', readOnly: false, volume: null }] : null;
    });
    const layer = createFilesystemModule();
    await layer.create({ volume });
    asked.length = 0;
    const { metrics } = layer.diagnostics();
    assert.deepEqual(metrics?.volumes['C:'], { across: true });
    assert.deepEqual(asked, [], 'nothing is asked of the run for it');
    await layer.dispose();
});

test('what a process reads of a drive from afar it keeps until the drive changes, and reads'
    + ' again after', async()=>{
    const run = { drives: new Map(), volumes: new Map(), writables: new Map(),
        watchers: new Set(), revisions: new Int32Array(new SharedArrayBuffer(26 * 4)) };
    const here_ = await createFilesystemModule().create({ volume: run });
    const file = here_.open('C:\\data.bin', { write: true,
        disposition: here_.Disposition.CREATE_NEW });
    here_.write(file, new Uint8Array(3000).fill(1));
    here_.close(file);
    const handlers = volumeHandlers(run).volume;
    /** @type {string[]} */
    const asked = [];
    const there = await createFilesystemModule().create({
        volume: remoteVolume((method, args)=>{
            asked.push(method === 'call' ? args[1] : method);
            return /** @type {any} */ (handlers)[method](...args);
        }, { revisions: run.revisions }) });
    const read = ()=>{
        const opened = there.open('C:\\data.bin', { read: true, shareWrite: true });
        const got = [];
        for (let at = 0; at < 3000; at += 512)
        {
            got.push(...there.read(opened, 512));
        }
        there.close(opened);
        return got;
    };
    asked.length = 0;
    assert.deepEqual(read(), new Array(3000).fill(1));
    const first = asked.filter(name=>name === 'read').length;
    asked.length = 0;
    read();
    assert.deepEqual(asked.filter(name=>name === 'read' || name === 'size' || name === 'stat'),
        [], 'the second time nothing is read across');
    const writing = here_.open('C:\\data.bin', { write: true, shareRead: true });
    here_.write(writing, new Uint8Array(10).fill(2));
    here_.close(writing);
    asked.length = 0;
    assert.deepEqual(read().slice(0, 12), [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1],
        'a write here is read there');
    assert.equal(asked.filter(name=>name === 'read').length, first);
});
