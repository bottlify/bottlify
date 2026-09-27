/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIso } from '@bottlify/core/iso';
import { buildIso } from '../../core/src/layers/filesystem/internal/iso/iso.fixture.js';
import {
    autorunText, discEntry, discOptions, isDiscImage, isDiscMedia, readAutorun, splitCommand,
} from './disc.js';
import { collectFrom } from './index.js';

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff);

/** A program the disc starts, recognisable by its bytes. */
const PROGRAM = latin1('MZ the autorun menu');
const SETUP = latin1('MZ the setup program');

/** @param {Record<string, Uint8Array | string | null>} files */
const disc = files=>({ name: 'DEMO.iso', disc: new Blob([buildIso({ label: 'DEMO', files })]) });

/** @param {Record<string, Uint8Array | string | null>} files @param {string | null} autorun */
const entryOf = async(files, autorun)=>{
    const image = buildIso({ files });
    return discEntry(await openIso((offset, length)=>image.subarray(offset, offset + length)),
        autorun === null ? null : latin1(autorun));
};

test('the [autorun] section is read without regard to case, first line of each key', ()=>{
    const found = readAutorun([
        '; a comment',
        '[Other]',
        'open=elsewhere.exe',
        '[AutoRun]',
        'Icon=autorun.ico',
        'OPEN = AutoRun.exe /menu',
        'open=second.exe',
        'shellexecute=readme.htm',
    ].join('\r\n'));
    assert.deepEqual(found, { open: 'AutoRun.exe /menu', shellexecute: 'readme.htm' });
    assert.deepEqual(readAutorun('[autorun]\nlabel=Demo\n'), { open: null, shellexecute: null });
});

test('autorun.inf is read as UTF-16 behind its byte order mark, and ANSI otherwise', ()=>{
    const wide = new Uint8Array([0xff, 0xfe, ...[...'[autorun]'].flatMap(c=>[c.charCodeAt(0), 0])]);
    assert.equal(autorunText(wide), '[autorun]');
    assert.equal(autorunText(new Uint8Array([0x5b, 0xe9, 0x5d])), '[\u00e9]');
});

test('an unquoted command line is split where CreateProcess would split it', ()=>{
    const files = new Map([['setup files\\setup.exe', 'Setup Files\\Setup.exe'],
        ['autorun.exe', 'AutoRun.exe']]);
    /** @param {string} path */
    const exists = path=>files.get(path.toLowerCase()) ?? null;
    assert.deepEqual(splitCommand('Setup Files\\setup.exe -x', exists),
        { path: 'Setup Files\\Setup.exe', arguments: '-x' });
    // `.exe` is what a bare name is looked for with.
    assert.deepEqual(splitCommand('autorun /menu now', exists),
        { path: 'AutoRun.exe', arguments: '/menu now' });
    assert.deepEqual(splitCommand('"Setup Files\\setup.exe"  /s ', exists),
        { path: 'Setup Files\\Setup.exe', arguments: '/s' });
    // A drive, a leading separator and a leading .\ all mean the disc's root.
    assert.deepEqual(splitCommand('.\\AutoRun.exe', exists).path, 'AutoRun.exe');
    assert.deepEqual(splitCommand('D:\\autorun.exe', exists).path, 'AutoRun.exe');
    assert.deepEqual(splitCommand('\\autorun.exe', exists).path, 'AutoRun.exe');
    assert.deepEqual(splitCommand('missing.exe -q', exists),
        { path: 'missing.exe', arguments: '-q' });
});

test('the disc starts what autorun.inf opens, and setup.exe when it names nothing', async()=>{
    const files = { 'AutoRun.exe': PROGRAM, 'Setup.exe': SETUP, 'readme.htm': 'hi' };
    assert.deepEqual(await entryOf(files, '[autorun]\r\nopen=AutoRun.exe -menu\r\n'),
        { path: 'AutoRun.exe', arguments: '-menu', from: 'autorun' });
    // A document is not a program to install with; open wins over it anyway.
    assert.deepEqual(await entryOf(files, '[autorun]\r\nshellexecute=readme.htm\r\n'),
        { path: 'Setup.exe', arguments: '', from: 'setup' });
    assert.deepEqual(await entryOf(files, '[autorun]\r\nshellexecute=AutoRun.exe\r\n'),
        { path: 'AutoRun.exe', arguments: '', from: 'autorun' });
    // A line naming something the disc does not have falls back too.
    assert.deepEqual(await entryOf(files, '[autorun]\r\nopen=gone.exe\r\n'),
        { path: 'Setup.exe', arguments: '', from: 'setup' });
    assert.deepEqual(await entryOf(files, null),
        { path: 'Setup.exe', arguments: '', from: 'setup' });
    assert.equal(await entryOf({ 'readme.htm': 'hi' }, null), null);
});

test('a disc image is told apart by its contents, not its name', async()=>{
    const media = disc({ 'Setup.exe': SETUP });
    assert.equal(await isDiscImage(media.disc), true);
    assert.equal(await isDiscImage(new Blob([new Uint8Array(40000)])), false);
    assert.equal(isDiscMedia(media), true);
    assert.equal(isDiscMedia({ name: 'Setup.exe', bytes: SETUP }), false);
});

test('installing from a disc starts its program from its own drive, the image mounted', async()=>{
    const media = disc({
        'AUTORUN.INF': '[AutoRun]\r\nopen=AutoRun.exe -autorun\r\n',
        'AutoRun.exe': PROGRAM,
        'Setup.exe': SETUP,
        'Data/big.cab': new Uint8Array(100000),
    });
    const options = await discOptions(media, { windows: 'win7' });
    assert.deepEqual(options.executable, PROGRAM);
    assert.equal(options.imagePath, 'D:\\AutoRun.exe');
    assert.equal(options.commandLine, '"D:\\AutoRun.exe" -autorun');
    assert.deepEqual(options.discs, [{ image: media.disc, letter: 'D' }]);
    assert.deepEqual(await options.storage.load(), []);
    assert.deepEqual(options.seeded, []);
    assert.equal(options.label, 'DEMO');
    assert.equal(options.windows, 'win7');
    assert.equal(options.unattended, null, 'the wizard runs unless silent is asked for');

    const chosen = await discOptions(media, { entry: 'setup.exe' });
    assert.deepEqual(chosen.executable, SETUP);
    assert.equal(chosen.commandLine, '"D:\\Setup.exe"');
    await assert.rejects(discOptions(media, { entry: 'nothing.exe' }), /has no nothing\.exe/);
    await assert.rejects(discOptions(disc({ 'readme.txt': 'x' })), /names no program to start/);
});

test('silent mode is read off the program the disc starts and the files beside it', async()=>{
    // An InstallShield player on a disc: its cabinets and settings beside it.
    const player = new Uint8Array(0x400);
    player.set(latin1('MZ'), 0);
    new DataView(player.buffer).setUint32(0x3c, 0x40, true);
    player.set(latin1('PE\0\0'), 0x40);
    new DataView(player.buffer).setUint16(0x46, 1, true);
    new DataView(player.buffer).setUint16(0x54, 0xe0, true);
    player.set(latin1('.text'), 0x40 + 24 + 0xe0);
    new DataView(player.buffer).setUint32(0x40 + 24 + 0xe0 + 16, 0x100, true);
    new DataView(player.buffer).setUint32(0x40 + 24 + 0xe0 + 20, 0x200, true);
    player.set(latin1('InstallShield'), 0x200);
    const media = disc({
        'Setup.exe': player,
        'data1.cab': 'cab',
        'engine32.cab': 'engine',
        'setup.ini': '[Startup]\r\nProductGUID={0A1B2C3D-0000-1111-2222-333344445555}\r\n',
    });
    const options = await discOptions(media, { silent: true });
    assert.equal(options.unattended?.family, 'installshield');
    assert.match(options.unattended?.commandLine ?? '', /^"D:\\Setup\.exe" \/s \/f1/);
    assert.match(new TextDecoder().decode(options.unattended?.seeded[0].bytes),
        /\{0A1B2C3D-0000-1111-2222-333344445555\}-DlgOrder/);
});

test('what a disc install produced is collected whole: nothing of the disc was seeded', ()=>{
    const app = {
        session: { export: ()=>[
            { path: 'C:\\Program Files\\Demo\\game.exe', bytes: latin1('MZ game') },
            { path: 'C:\\Program Files\\Demo\\setup.log', bytes: latin1('log') },
        ] },
        registry: ()=>({ toJSON: ()=>({}) }),
    };
    const prefix = collectFrom(app, disc({ 'Setup.exe': SETUP }));
    assert.equal(prefix.root, 'C:\\Program Files\\Demo');
    assert.equal(prefix.entry, 'game.exe');
});
