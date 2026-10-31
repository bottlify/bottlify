/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * steam-install.mjs's --keys on stdin: read and checked before Steam is asked
 * anything, a refusal one line that shows no key or code. And the install
 * itself, over depots made up here: what it leaves in a directory, packed, is
 * the bundle a browser's install of the same depots writes in place
 * (@bottlify/core/steam's installBundle) -- the gate between the two.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync,
} from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installToDirectory } from './steam-install.mjs';
import { openBundle, writeBundle } from './btl.mjs';
import { installBundle } from '../modules/core/src/steam/install.js';
import { contentServer, fakeDepot, noise } from '../modules/core/src/steam/depot.fixture.js';
import { bootstrapper, gameSetup } from '../modules/core/src/steam/redist.fixture.js';

const TOOL = fileURLToPath(new URL('./steam-install.mjs', import.meta.url));
const KEY = '5a'.repeat(32);
const CODE = '9876543210987654321';
const ENTRY = { depot: 1, gid: '2', key: KEY, code: CODE };

/** @param {string[]} args @param {string} input */
const run = (args, input)=>spawnSync(process.execPath, [TOOL, ...args],
    { input, encoding: 'utf8' });

test('keys that are not a depot access list fail the run at once, naming no key or code', ()=>{
    const inputs = [`[${JSON.stringify(ENTRY)}`, '[]',
        JSON.stringify([{ ...ENTRY, key: KEY.slice(1) }]), JSON.stringify([ENTRY, ENTRY])];
    for (const input of inputs)
    {
        const result = run(['--keys', '-', '--app', '70', '--out', 'unused'], input);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /^failed: [^\n]*\n$/, 'one line');
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${KEY.slice(1)}|${CODE}`));
    }
});

test('a run takes a session or keys, not both and not neither', ()=>{
    const both = ['--session', '-', '--keys', '-'];
    for (const args of [[], both])
    {
        const result = run([...args, '--app', '70', '--out', 'x'], '');
        assert.equal(result.status, 1);
        assert.match(result.stderr, /^failed: usage: .*--session <file> \| --keys <file>/);
    }
});

/** A program's first bytes: a PE image for x86-64. */
function program64(){
    const image = new Uint8Array(4096);
    image.set([0x4d, 0x5a]);
    new DataView(image.buffer).setUint32(0x3c, 0x80, true);
    new DataView(image.buffer).setUint32(0x80, 0x4550, true);
    new DataView(image.buffer).setUint16(0x84, 0x8664, true);
    return image;
}

/** @param {string} text */
const bytesOf = text=>new TextEncoder().encode(text);

/** A bundle's every file -- path, size, digest, bytes -- and its empty folders. @param {string} path */
async function bundleFiles(path){
    const bundle = await openBundle(path);
    try
    {
        const files = [];
        for (const file of bundle.list())
        {
            files.push({ path: file.path, size: file.size, sha256: file.sha256,
                bytes: new Uint8Array(await bundle.read(file.path)) });
        }
        return { files, directories: [...bundle.directories()].sort() };
    }
    finally
    {
        await bundle.close();
    }
}

test('an install into a directory, packed, is the bundle a browser\'s install writes in place',
    async t=>{
        const vc = await bootstrapper({ wide: true, version: '14.29.1', size: 48, fill: 7 });
        const prereq = await bootstrapper({ wide: true, version: '14.30.2', size: 52, fill: 9,
            tool: false });
        const depots = [
            fakeDepot({ depot: 101, gid: 1n, chunkSize: 30_000, files: [
                { name: 'Binaries\\Game.exe',
                    bytes: Uint8Array.from([...program64(), ...noise(70_000, 3)]) },
                { name: 'Content\\Paks\\base.pak', bytes: noise(250_000, 4) },
                { name: 'Content\\Saved', directory: true },
                { name: 'Content\\empty.txt', bytes: new Uint8Array(0) },
                { name: 'Engine\\Prereq\\Prereq.exe', bytes: prereq },
                { name: 'Setup.exe', bytes: await gameSetup() },
                { name: 'install.vdf', bytes: bytesOf(String.raw`"InstallScript"
{ "Registry" { "HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor" { "string" { "Dir" "%INSTALLDIR%" } } } }`) },
            ] }),
            fakeDepot({ depot: 102, gid: 2n, files: [
                { name: 'CONTENT\\Paks\\BASE.pak', bytes: noise(90_000, 5) },
                { name: 'content\\Paks\\extra.pak', bytes: noise(10_000, 6) },
            ] }),
            fakeDepot({ depot: 228989, gid: 3n, shared: true, files: [
                { name: '_CommonRedist\\vcredist\\2019\\VC_redist.x64.exe', bytes: vc },
                { name: '_CommonRedist\\vcredist\\2019\\installscript.vdf',
                    bytes: bytesOf(String.raw`"InstallScript"
{ "Run Process" { "VC" { "process 1"
  "%INSTALLDIR%\\_CommonRedist\\vcredist\\2019\\VC_redist.x64.exe"
  "command 1" "/q" "Requirement_OS" { "Is64BitWindows" "1" } } } }`) },
            ] }),
        ];
        t.mock.method(globalThis, 'fetch', contentServer(depots).fetch);
        const servers = ['a.example', 'b.example'].map(host=>({ host, vhost: host, type: 'CDN' }));
        const how = { depots, servers, installscript: 'install.vdf',
            executable: 'Binaries\\Game.exe' };
        const work = await mkdtemp(join(tmpdir(), 'steam-install-'));
        try
        {
            const out = join(work, 'app');
            /** @type {string[]} */
            const toolSaid = [];
            await installToDirectory({ ...how, out, log: line=>toolSaid.push(line) });
            await writeBundle({ root: out, output: join(work, 'tool.btl') });

            const fd = openSync(join(work, 'browser.btl'), 'w+');
            // Every chunk finds its save due, and a save takes a while: chunks
            // landing from several downloads at once must not save over one
            // another (a browser refuses a second handle on install.json).
            let clock = 0;
            t.mock.method(Date, 'now', ()=>(clock += 3000));
            let open = 0;
            let most = 0;
            let saves = 0;
            const onSave = async()=>{
                most = Math.max(most, ++open);
                saves++;
                await new Promise(done=>setTimeout(done, 5));
                open--;
            };
            try
            {
                const { entry, said } = await installBundle({ ...how, onSave, handle: {
                    read: (buffer, { at })=>readSync(fd, buffer, 0, buffer.length, at),
                    write: (buffer, { at })=>writeSync(fd, buffer, 0, buffer.length, at),
                    truncate: size=>ftruncateSync(fd, size),
                    flush: ()=>fsyncSync(fd),
                    getSize: ()=>fstatSync(fd).size,
                } });
                assert.deepEqual(entry,
                    new Uint8Array(await readFile(join(out, 'Binaries', 'Game.exe'))));
                assert.deepEqual(said, toolSaid.filter(line=>!line.startsWith('depot ')));
                assert.deepEqual(said, [
                    '_CommonRedist\\vcredist\\2019\\VC_redist.x64.exe: 1 package(s), 1 file(s)',
                    'Engine\\Prereq\\Prereq.exe: 1 package(s), 1 file(s), the app\'s own',
                    'redistributables: 1 file(s), 5 registry value(s)',
                ], 'the shared depot\'s script and the app\'s own prerequisite, in both');
                assert.ok(saves > 1, 'saved along the way');
                assert.equal(most, 1, 'one save at a time');
            }
            finally
            {
                closeSync(fd);
            }

            const tool = await bundleFiles(join(work, 'tool.btl'));
            const browser = await bundleFiles(join(work, 'browser.btl'));
            /** @param {{ bytes: Uint8Array }} file */
            const described = ({ bytes, ...file })=>({ ...file, bytes: bytes.length });
            assert.deepEqual(browser.files.map(described), tool.files.map(described),
                'the same files, in the same order');
            assert.deepEqual(browser.files.map(file=>file.bytes), tool.files.map(file=>file.bytes));
            assert.deepEqual(browser.directories, tool.directories);
            // What makes the comparison worth something: each part of the install is in both.
            assert.deepEqual(tool.files.map(file=>file.path).filter(path=>/bottlify|Paks/.test(path)), [
                '.bottlify\\drive_c\\WINDOWS\\system32\\vcruntime140.dll',
                '.bottlify\\registry.json',
                'Content\\Paks\\base.pak', 'Content\\Paks\\extra.pak',
            ]);
            assert.deepEqual(tool.files.find(file=>file.path.endsWith('vcruntime140.dll'))?.bytes,
                new Uint8Array(52).fill(9), 'the app\'s newer runtime over the shared depot\'s');
            assert.deepEqual(tool.directories, ['Content\\Saved']);
        }
        finally
        {
            await rm(work, { recursive: true, force: true });
        }
    });
