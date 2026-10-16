/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DRIVE_ROOT, MEDIA_DIRECTORY, REGISTRY_PATH, collect, guessEntry, prefixOptions,
} from './prefix.js';

/** @param {string} text */
const bytes = text=>new TextEncoder().encode(text);

/** @param {string[]} paths */
const tree = paths=>paths.map(path=>({ path, bytes: bytes(path) }));

test('the distribution is seeded where the guest can open it, and named as the image', async()=>{
    const options = prefixOptions({ name: 'Setup.exe', bytes: bytes('MZ') });

    assert.equal(options.imagePath, `${MEDIA_DIRECTORY}\\Setup.exe`);
    assert.deepEqual(options.seeded, [options.imagePath]);
    // A distribution reads its own file, so it has to be on the volume before
    // the first instruction rather than handed to the loader alone.
    assert.deepEqual((await options.storage.load()).map(file=>file.path), [options.imagePath]);
});

test('an install runs under the Windows the bottle will run under', ()=>{
    // An installer acts on the Windows it finds -- a path it records, a
    // component it picks -- so it is run under the bottle's own.
    const media = { name: 'Setup.exe', bytes: bytes('MZ') };
    assert.equal(prefixOptions(media, { windows: 'win7' }).windows, 'win7');
    assert.equal('windows' in prefixOptions(media), false, 'absent is the engine\'s default');
    assert.throws(()=>prefixOptions(media, { windows: /** @type {any} */ ('win98') }),
        /the choices are win2000, winxp, win7, win10/);
});

test('the rest of the media is seeded beside the entry, none of it counted as produced', async()=>{
    const options = prefixOptions({
        name: 'Setup.exe', bytes: bytes('MZ'),
        files: [
            { name: 'setup.exe', bytes: bytes('MZ') },
            { name: 'data.zip', bytes: bytes('PK') },
            { name: 'Support\\readme.txt', bytes: bytes('hi') },
        ],
    });

    // A disc's entry reads its archives from beside itself, so they are on the
    // volume before the first instruction, under the entry's own directory.
    assert.deepEqual((await options.storage.load()).map(file=>file.path), [
        `${MEDIA_DIRECTORY}\\Setup.exe`,
        `${MEDIA_DIRECTORY}\\data.zip`,
        `${MEDIA_DIRECTORY}\\Support\\readme.txt`,
    ]);
    const prefix = collect({
        files: tree([...options.seeded, 'C:\\Games\\Title\\title.exe']),
        seeded: options.seeded,
    });
    assert.deepEqual(prefix.files.map(file=>file.path), ['Games\\Title\\title.exe']);
});

test('a bottle is everything the install wrote on C:, by its path from the root', ()=>{
    // No directory is guessed to be the installation: a game installed to a
    // Bin directory left its Data beside it, a setup put its runtime in Common
    // Files, and a guess at one root left the rest behind.
    const prefix = collect({
        files: tree(['C:\\Program Files\\Maker\\Title\\Bin\\title.exe',
            'C:\\Program Files\\Maker\\Title\\Data\\level.pak',
            'C:\\Program Files\\Common Files\\Runtime\\run.dll',
            'C:\\WINDOWS\\Fonts\\title.ttf']),
    });
    assert.equal(prefix.root, DRIVE_ROOT);
    assert.deepEqual(prefix.files.map(file=>file.path), [
        'Program Files\\Maker\\Title\\Bin\\title.exe',
        'Program Files\\Maker\\Title\\Data\\level.pak',
        'Program Files\\Common Files\\Runtime\\run.dll',
        'WINDOWS\\Fonts\\title.ttf',
    ]);
    assert.equal(prefix.entry, 'Program Files\\Maker\\Title\\Bin\\title.exe');
    assert.deepEqual(prefix.outside, []);
});

test('the run\'s scratch and other drives stay out', ()=>{
    const prefix = collect({
        files: tree(['C:\\Games\\Title\\title.exe',
            'C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\setup.dll',
            'C:\\Temp\\unpacked.cab',
            'C:\\Documents and Settings\\User\\Local Settings\\Temp\\x.tmp',
            'C:\\Documents and Settings\\User\\Application Data\\Title\\config.ini',
            'D:\\Saves\\one.sav']),
        directories: ['C:\\Games\\Title\\Settings\\Profiles', 'C:\\Temp\\scratch'],
    });
    assert.deepEqual(prefix.files.map(file=>file.path), ['Games\\Title\\title.exe',
        'Documents and Settings\\User\\Application Data\\Title\\config.ini']);
    assert.deepEqual(prefix.outside, ['C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\setup.dll',
        'C:\\Temp\\unpacked.cab', 'C:\\Documents and Settings\\User\\Local Settings\\Temp\\x.tmp',
        'D:\\Saves\\one.sav']);
    assert.deepEqual(prefix.directories, ['Games\\Title\\Settings\\Profiles'],
        'empty directories too, scratch left out');
});

test('what a setup keeps of itself for repair or removal stays out, and so do shortcuts', ()=>{
    // InstallShield's copy of a demo's whole package was 88 MB of a 228 MB
    // bottle; only Add or Remove Programs reads any of it.
    const kept = [
        'C:\\WINDOWS\\Downloaded Installations\\{C0D3}\\Demo.msi',
        'C:\\WINDOWS\\Installer\\fee4f149.msi',
        'C:\\WINDOWS\\Installer\\{69EA}\\DemoShortCut.exe',
        'C:\\Program Files\\InstallShield Installation Information\\{69EA}\\setup.inx',
        'C:\\Program Files\\Common Files\\InstallShield\\Driver\\8\\Intel 32\\IDriver.exe',
        'C:\\WINDOWS\\system32\\dllcache\\quartz.dll',
        'C:\\WINDOWS\\RegisteredPackages\\{44BBA855}\\dxnt.cab',
        'C:\\Documents and Settings\\All Users\\Desktop\\Demo.lnk',
        'C:\\Documents and Settings\\All Users\\Start Menu\\Programs\\Demo\\Demo.lnk',
    ];
    const prefix = collect({ files: tree(['C:\\Games\\Title\\title.exe', ...kept]) });
    assert.deepEqual(prefix.files.map(file=>file.path), ['Games\\Title\\title.exe']);
    assert.deepEqual(prefix.outside, kept);
});

test('what was seeded is not part of what the installer produced', ()=>{
    const media = prefixOptions({ name: 'Setup.exe', bytes: bytes('MZ') });
    const prefix = collect({
        files: tree([media.imagePath, 'C:\\Games\\Title\\title.exe']),
        seeded: media.seeded,
    });

    assert.deepEqual(prefix.files.map(file=>file.path), ['Games\\Title\\title.exe']);
});

test('what an installer unpacks beside itself is the distribution, not the installation', ()=>{
    // A self-extractor unpacks its setup next to itself before the setup
    // installs the game elsewhere; that unpacked setup is scratch.
    const unpacked = collect({ files: tree([
        `${MEDIA_DIRECTORY}\\Title_Install\\setup.exe`,
        `${MEDIA_DIRECTORY}\\Title_Install\\data1.cab`,
        'C:\\Program Files\\Publisher\\Title\\title.exe',
    ]) });
    assert.deepEqual(unpacked.files.map(file=>file.path),
        ['Program Files\\Publisher\\Title\\title.exe']);
    assert.equal(unpacked.outside.length, 2);
    // An archive that unpacks the game itself put it nowhere else.
    const itself = collect({ files: tree([`${MEDIA_DIRECTORY}\\Title\\title.exe`]) });
    assert.deepEqual(itself.files.map(file=>file.path), ['Install\\Title\\title.exe']);
});

test('what the install put in system32 travels, Windows\' own libraries included', ()=>{
    // The engine answers its own libraries there whatever a bottle carries
    // (core's loader), so a DirectX setup's copies are carried as they are.
    const prefix = collect({
        files: tree([
            'C:\\Games\\Title\\title.exe',
            'C:\\WINDOWS\\system32\\d3d9.dll',
            'C:\\WINDOWS\\system32\\d3dx9_30.dll',
            'C:\\WINDOWS\\system32\\drivers\\title.sys',
        ]),
    });
    assert.deepEqual(prefix.files.map(file=>file.path), [
        'Games\\Title\\title.exe',
        'WINDOWS\\system32\\d3d9.dll',
        'WINDOWS\\system32\\d3dx9_30.dll',
        'WINDOWS\\system32\\drivers\\title.sys',
    ]);
    assert.equal(prefix.entry, 'Games\\Title\\title.exe');
});

test('the registry travels as a file inside the tree', ()=>{
    const prefix = collect({
        files: tree(['C:\\Games\\Title\\title.exe']),
        registry: { roots: [{ id: 0x80000002, key: { name: 'HKEY_LOCAL_MACHINE' } }] },
    });

    const carried = prefix.files.find(file=>file.path === REGISTRY_PATH);
    assert.ok(carried, 'an unpacked prefix has to describe its own registry');
    assert.equal(JSON.parse(new TextDecoder().decode(carried.bytes)).roots[0].id, 0x80000002);
});

test('the guessed entry is the largest executable that is not a setup program', ()=>{
    assert.equal(guessEntry([
        { path: 'Games\\Title\\unins000.exe', bytes: new Uint8Array(9000) },
        { path: 'WINDOWS\\IsUninst.exe', bytes: new Uint8Array(9000) },
        { path: 'WINDOWS\\system32\\helper.exe', bytes: new Uint8Array(8000) },
        { path: 'Games\\Title\\title.exe', bytes: new Uint8Array(400) },
        { path: 'Games\\Title\\config.exe', bytes: new Uint8Array(100) },
    ]), 'Games\\Title\\title.exe', 'never one of the Windows directory\'s');
});
