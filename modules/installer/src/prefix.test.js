/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MEDIA_DIRECTORY, REGISTRY_PATH, SYSTEM_PATH, chooseRoot, collect, guessEntry,
    installLocations, prefixOptions,
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
    assert.deepEqual(prefix.files.map(file=>file.path), ['title.exe']);
});

test('the empty directories under the root are carried, relative to it', ()=>{
    const prefix = collect({
        files: tree(['C:\\Games\\Title\\title.exe']),
        directories: ['C:\\Games\\Title\\Settings\\Profiles', 'C:\\Temp\\scratch'],
    });

    assert.equal(prefix.root, 'C:\\Games\\Title');
    assert.deepEqual(prefix.directories, ['Settings\\Profiles']);
});

test('what was seeded is not part of what the installer produced', ()=>{
    const media = prefixOptions({ name: 'Setup.exe', bytes: bytes('MZ') });
    const prefix = collect({
        files: tree([media.imagePath, 'C:\\Games\\Title\\title.exe']),
        seeded: media.seeded,
    });

    assert.deepEqual(prefix.files.map(file=>file.path), ['title.exe']);
    assert.equal(prefix.root, 'C:\\Games\\Title');
});

test('the root is the shallowest directory holding an executable', ()=>{
    assert.equal(chooseRoot(tree([
        'C:\\Program Files\\Title\\title.exe',
        'C:\\Program Files\\Title\\tools\\editor.exe',
        'C:\\Program Files\\Title\\data\\art.mpq',
    ])), 'C:\\Program Files\\Title');
});

test('the system\'s own tree is never mistaken for the installation', ()=>{
    // An installer that drops a runtime in the system directory has still
    // installed the game somewhere else, and the shallowest rule alone would
    // pick the system directory every time.
    assert.equal(chooseRoot(tree([
        'C:\\Windows\\System32\\helper.exe',
        'C:\\Games\\Title\\title.exe',
    ])), 'C:\\Games\\Title');
});

test('the setup InstallShield keeps for maintenance is not the installation', ()=>{
    // As deep as the program, one executable each, and sorted ahead of it.
    assert.equal(chooseRoot(tree([
        'C:\\Program Files\\InstallShield Installation Information\\{91B323B5}\\Setup.exe',
        'C:\\Program Files\\Publisher\\Title\\title.exe',
    ])), 'C:\\Program Files\\Publisher\\Title');
});

test('what an installer unpacks beside itself is the distribution, not the installation', ()=>{
    // A self-extractor unpacks its setup next to itself, a level shallower
    // than any Program Files directory the setup then installs into.
    assert.equal(chooseRoot(tree([
        `${MEDIA_DIRECTORY}\\Title_Install\\setup.exe`,
        `${MEDIA_DIRECTORY}\\Title_Install\\autorun.exe`,
        'C:\\Program Files\\Publisher\\Title\\title.exe',
    ])), 'C:\\Program Files\\Publisher\\Title');
    // An archive that unpacks the game itself put it nowhere else.
    assert.equal(chooseRoot(tree([`${MEDIA_DIRECTORY}\\Title\\title.exe`])),
        `${MEDIA_DIRECTORY}\\Title`);
});

/**
 * A hive as `toJSON` gives it, with one Uninstall entry per location, each
 * InstallLocation a REG_SZ in the ANSI page as the registry keeps it.
 *
 * @param {string[]} locations @param {number} [root]  HKEY_LOCAL_MACHINE by default.
 */
const uninstallHive = (locations, root = 0x80000002)=>{
    /** @param {string} name @param {any[]} keys @param {any[]} [values] */
    const key = (name, keys, values = [])=>({ name, values, keys });
    const entries = locations.map((location, index)=>key(`{entry-${index}}`, [], [
        { name: 'DisplayName', type: 1, data: [...bytes(`Title ${index}\0`)] },
        { name: 'InstallLocation', type: 1, data: [...bytes(`${location}\0`)] },
    ]));
    return { roots: [{ id: root, key: key('ROOT', [key('SOFTWARE', [key('Microsoft', [
        key('Windows', [key('CurrentVersion', [key('Uninstall', entries)])])])])]) }] };
};

test('the root is where the install told Windows it put the application', ()=>{
    // An installer's maintenance copy of itself sits shallower than the game,
    // and the shallowest-executable rule alone would bottle the setup.
    const files = tree([
        'C:\\Program Files\\Setup Information\\{1234}\\setup.exe',
        'C:\\Program Files\\Publisher\\Demo\\Title\\title.exe',
        'C:\\Program Files\\Publisher\\Demo\\Title\\Video\\intro.bik',
    ]);
    const prefix = collect({ files,
        registry: uninstallHive(['c:\\program files\\publisher\\demo\\title\\']) });
    assert.equal(prefix.root, 'C:\\Program Files\\Publisher\\Demo\\Title',
        'spelt as the volume spells it, without the trailing separator');
    assert.deepEqual(prefix.files.filter(file=>file.path !== REGISTRY_PATH)
        .map(file=>file.path), ['title.exe', 'Video\\intro.bik']);
    const perUser = uninstallHive(['C:\\Program Files\\Publisher\\Demo\\Title'], 0x80000001);
    assert.equal(collect({ files, registry: perUser }).root,
        'C:\\Program Files\\Publisher\\Demo\\Title', 'a per-user entry too');
});

test('a recorded location holding nothing the install wrote leaves the layout to decide', ()=>{
    // Another program's entry, or a location the program was moved from.
    const files = tree(['C:\\Games\\Title\\title.exe']);
    assert.equal(collect({ files, registry: uninstallHive(['C:\\Elsewhere']) }).root,
        'C:\\Games\\Title');
    assert.deepEqual(installLocations(uninstallHive(['C:\\Elsewhere', 'not a path'])),
        ['C:\\Elsewhere']);
    assert.deepEqual(installLocations(undefined), []);
});

test('among equally shallow candidates the one with more executables wins', ()=>{
    assert.equal(chooseRoot(tree([
        'C:\\Games\\Shortcut\\link.exe',
        'C:\\Games\\Title\\title.exe',
        'C:\\Games\\Title\\patch.exe',
    ])), 'C:\\Games\\Title');
});

test('files the root does not cover are reported rather than dropped silently', ()=>{
    const prefix = collect({
        files: tree(['C:\\Games\\Title\\title.exe', 'C:\\Windows\\Fonts\\title.ttf']),
    });

    assert.deepEqual(prefix.files.map(file=>file.path), ['title.exe']);
    assert.deepEqual(prefix.outside, ['C:\\Windows\\Fonts\\title.ttf']);
});

test('what the install added to system32 travels beside the registry', ()=>{
    // A setup installs the runtime its program links against there -- the D3DX
    // libraries a DirectX setup puts in -- and the program looks nowhere else.
    const prefix = collect({
        files: tree([
            'C:\\Games\\Title\\title.exe',
            'C:\\WINDOWS\\system32\\d3dx9_30.dll',
            'C:\\Windows\\System32\\xinput1_3.dll',
            'C:\\WINDOWS\\system32\\drivers\\title.sys',
        ]),
    });

    assert.deepEqual(prefix.files.map(file=>file.path), [
        'title.exe',
        `${SYSTEM_PATH}\\d3dx9_30.dll`,
        `${SYSTEM_PATH}\\xinput1_3.dll`,
        `${SYSTEM_PATH}\\drivers\\title.sys`,
    ]);
    assert.equal(new TextDecoder().decode(prefix.files[1].bytes),
        'C:\\WINDOWS\\system32\\d3dx9_30.dll', 'the bytes the install wrote');
    assert.deepEqual(prefix.outside, []);
    assert.equal(prefix.entry, 'title.exe', 'a file in system32 is never the program to start');
});

test('a library the engine synthesises is not carried out of system32', ()=>{
    // Mounted back, a copy of one of Windows' own libraries would be mapped in
    // place of the engine's; the redistributables are not in the list.
    const prefix = collect({
        files: tree([
            'C:\\Games\\Title\\title.exe',
            'C:\\WINDOWS\\system32\\d3d9.dll',
            'C:\\WINDOWS\\system32\\DSOUND.DLL',
            'C:\\WINDOWS\\system32\\d3dx9_30.dll',
        ]),
        synthesised: ['D3D9.dll', 'DSOUND.dll', 'KERNEL32.dll'],
    });

    assert.deepEqual(prefix.files.map(file=>file.path),
        ['title.exe', `${SYSTEM_PATH}\\d3dx9_30.dll`]);
    assert.deepEqual(prefix.answered,
        ['C:\\WINDOWS\\system32\\d3d9.dll', 'C:\\WINDOWS\\system32\\DSOUND.DLL']);
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
        { path: 'unins000.exe', bytes: new Uint8Array(9000) },
        { path: 'title.exe', bytes: new Uint8Array(400) },
        { path: 'config.exe', bytes: new Uint8Array(100) },
    ]), 'title.exe');
});

test('a tree with no executable keeps the volume root rather than inventing one', ()=>{
    assert.equal(chooseRoot(tree(['C:\\Data\\readme.txt'])), 'C:\\');
});
