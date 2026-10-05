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
import { volumeHandlers } from './volume-link.js';

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
