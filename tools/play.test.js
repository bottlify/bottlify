/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBundle } from './btl.mjs';
import { ensureEntry, servePlayer } from './play.mjs';

const MAKE_BTL = fileURLToPath(new URL('./make-btl.mjs', import.meta.url));

/** A bottle `demo` of two files in a directory of bottles, the program in a subdirectory. */
async function bottles(){
    const dir = mkdtempSync(join(tmpdir(), 'play-'));
    const game = join(dir, 'game');
    mkdirSync(join(game, 'Bin'), { recursive: true });
    const image = Uint8Array.from({ length: 70_000 }, (_, i)=>i * 7 & 0xff);
    writeFileSync(join(game, 'Bin', 'Demo.exe'), image);
    writeFileSync(join(game, 'data.txt'), 'data');
    const bottle = join(dir, 'bundles', 'demo');
    mkdirSync(bottle, { recursive: true });
    await writeBundle({ root: game, output: join(bottle, 'bundle.btl'), blockSize: 1 << 15 });
    writeFileSync(join(bottle, 'manifest.json'), JSON.stringify({ id: 'demo',
        entry: 'Bin\\Demo.exe' }));
    return { dir, bundles: join(dir, 'bundles'), bottle, image };
}

test('the program\'s image comes out of the bundle beside it, once', async()=>{
    const { dir, bottle, image } = await bottles();
    try
    {
        const out = await ensureEntry(bottle);
        assert.deepEqual(new Uint8Array(readFileSync(out)), image);
        writeFileSync(out, 'kept');
        await ensureEntry(bottle);
        assert.equal(readFileSync(out, 'utf8'), 'kept', 'an entry already there is not rewritten');
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('make-btl extract writes the entry, or a named file, out of a bottle', async()=>{
    const { dir, bottle, image } = await bottles();
    try
    {
        const run = (/** @type {string[]} */ args)=>spawnSync(process.execPath,
            [MAKE_BTL, ...args], { cwd: dir, encoding: 'utf8' });
        const entry = run(['extract', 'demo']);
        assert.equal(entry.status, 0, entry.stderr);
        assert.deepEqual(new Uint8Array(readFileSync(join(bottle, 'entry'))), image);
        const named = run(['extract', 'demo', 'data.txt', `--out=${join(dir, 'out.txt')}`]);
        assert.equal(named.status, 0, named.stderr);
        assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'data');
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('make-btl pack guesses the entry, or records the one and the root it is given', ()=>{
    const dir = mkdtempSync(join(tmpdir(), 'play-'));
    try
    {
        const game = join(dir, 'game');
        mkdirSync(join(game, 'Bin'), { recursive: true });
        writeFileSync(join(game, 'Bin', 'Game.exe'), new Uint8Array(4096));
        writeFileSync(join(game, 'Setup.exe'), new Uint8Array(8192));
        writeFileSync(join(game, 'Tool.exe'), new Uint8Array(1024));
        const run = (/** @type {string[]} */ args)=>spawnSync(process.execPath,
            [MAKE_BTL, ...args], { cwd: dir, encoding: 'utf8' });
        const manifest = ()=>JSON.parse(readFileSync(join(dir, 'bundles', 'g', 'manifest.json'),
            'utf8'));
        assert.equal(run(['pack', game, 'g']).status, 0);
        assert.equal(manifest().entry, 'Bin\\Game.exe', 'the largest that is not a setup');
        assert.equal(manifest().root, undefined);
        const named = run(['pack', game, 'g', '--entry=Tool.exe',
            '--root=C:\\Program Files\\Vendor\\Game']);
        assert.equal(named.status, 0, named.stderr);
        assert.equal(manifest().entry, 'Tool.exe');
        assert.equal(manifest().root, 'C:\\Program Files\\Vendor\\Game');
        assert.equal(run(['extract', 'g']).status, 0);
        assert.match(run(['pack', game, 'g', '--entry=Missing.exe']).stdout, /not in the bundle/);
        assert.throws(()=>readFileSync(join(dir, 'bundles', 'g', 'entry')),
            'a repack drops the image extracted from the bundle before');
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the player serves its page and a bottle a range at a time, isolated', async()=>{
    const { dir, bundles, bottle } = await bottles();
    const server = await servePlayer({ bundles });
    try
    {
        await ensureEntry(bottle);
        const base = `http://127.0.0.1:${server.port}`;
        const page = await fetch(`${base}/?bottle=demo`);
        assert.equal(page.status, 200);
        assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
        assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
        assert.match(await page.text(), /from '\/bottlify\/core\.js'/);
        const range = await fetch(`${base}/bundles/demo/bundle.btl`,
            { headers: { Range: 'bytes=0-3' } });
        assert.equal(range.status, 206);
        assert.equal(await range.text(), 'BTL1');
        const entry = await fetch(`${base}/bundles/demo/entry`);
        assert.equal(entry.status, 200);
        assert.equal((await entry.arrayBuffer()).byteLength, 70_000);
    }
    finally
    {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
