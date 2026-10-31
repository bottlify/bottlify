/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * tools/redist.mjs: which shared depots an install takes, what a Steam install
 * script asks for, and a redistributable's packages applied to a bottle -- a
 * real installer database and cabinets, built here, inside a program, as a
 * bootstrapper carries them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapper, cabinet, gameSetup } from '../modules/core/src/steam/redist.fixture.js';
import {
    applyPackage, compareVersions, depotOwners, imageMachine, installRedistributables,
    parseInstallScript, registryValue, sharedDepots, unpackRedistributable, wantedDepot,
    writeRegistry,
} from './redist.mjs';
import * as redist from '../modules/core/src/steam/redist.js';

const HKLM = 0x80000002;
const HKCU = 0x80000001;

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, c=>c.charCodeAt(0));

test('an install takes the depots of other apps the app names, at their owners\' manifests',
    ()=>{
        const shared = (/** @type {any} */ config)=>({ config, depotfromapp: '228980' });
        const info = { depots: {
            228986: { ...shared({ oslist: 'windows' }), sharedinstall: '1' },
            228990: shared({ oslist: 'windows' }),
            228999: shared({ oslist: 'macos' }),
            228998: shared({ oslist: 'windows', language: 'german' }),
            228997: shared(undefined),
            361422: { config: { oslist: 'windows' }, manifests: { public: { gid: '5' } } },
            branches: { public: { buildid: '1' } },
        } };
        const gid = (/** @type {string} */ value)=>({ manifests: { public: { gid: value } } });
        const owner = { depots: { 228986: gid('8782296191957114623'),
            228990: gid('1829726630299308803'), 228999: gid('3'), 228998: gid('4') } };
        assert.deepEqual(depotOwners(info), [228980]);
        assert.deepEqual(sharedDepots(info, new Map([[228980, owner]])), [
            { id: 228986, app: 228980, gid: 8782296191957114623n },
            { id: 228990, app: 228980, gid: 1829726630299308803n },
        ], 'Windows\' and the language\'s; one the owner has no manifest for is not');
        assert.deepEqual(sharedDepots(info, new Map()), [], 'no owner\'s info, none');
        assert.equal(wantedDepot({ config: { oslist: 'windows' }, dlcappid: '9' }, 'english'),
            false);
        assert.equal(wantedDepot({}, 'english'), true);
    });

test('an install script: its registry values and the programs it runs', ()=>{
    const script = parseInstallScript(String.raw`"Installscript"
{
    "Registry"
    {
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor\\Game"
        {
            "string" { "InstDir" "%INSTALLDIR%" }
            "dword" { "Installed" "1" }
        }
        "HKEY_CURRENT_USER\\Software\\Vendor" { "string" { "Language" "1033" } }
    }
    "Run Process"
    {
        "VCRedist"
        {
            "process 1" "%INSTALLDIR%\\redist\\vc_redist.x86.exe"
            "Command 1" "/q"
            "Process 2" "%INSTALLDIR%\\redist\\vc_redist.x64.exe"
            "Requirement_OS" { "Is64BitWindows" "1" }
        }
    }
}
"kvsignatures" { "Installscript" "00" }`);
    assert.deepEqual(script.registry.map(({ root, key, name, type })=>({ root, key, name, type })),
        [
            { root: HKLM, key: 'SOFTWARE\\Vendor\\Game', name: 'InstDir', type: 1 },
            { root: HKLM, key: 'SOFTWARE\\Vendor\\Game', name: 'Installed', type: 4 },
            { root: HKCU, key: 'Software\\Vendor', name: 'Language', type: 1 },
        ]);
    assert.deepEqual(script.registry[0].data, latin1('C:\\App\0'), '%INSTALLDIR% is the bottle\'s');
    assert.deepEqual([...script.registry[1].data], [1, 0, 0, 0]);
    assert.deepEqual(script.runs, [{ name: 'VCRedist', requires64: true, programs: [
        { path: 'C:\\App\\redist\\vc_redist.x86.exe', arguments: '/q' },
        { path: 'C:\\App\\redist\\vc_redist.x64.exe', arguments: '' },
    ] }]);
});

test('a Registry table\'s values are typed by their prefixes; versions compare by field', ()=>{
    assert.deepEqual(registryValue('#14'), { type: 4, data: Uint8Array.of(14, 0, 0, 0) });
    assert.deepEqual(registryValue('#x0aff'), { type: 3, data: Uint8Array.of(10, 255) });
    assert.equal(registryValue('#%%SystemRoot%').type, 2);
    assert.deepEqual(registryValue('##1'), { type: 1, data: latin1('#1\0') });
    assert.deepEqual(registryValue('a[~]b'), { type: 7, data: latin1('a\0b\0\0') });
    assert.equal(registryValue('v14.0').type, 1);
    assert.ok(compareVersions('14.24.28127.4', '14.0.24215.1') > 0);
    assert.equal(compareVersions('9.0', '9.0.0'), 0);
});

test('registry writes go into a hive\'s JSON, a later value of a name over an earlier', ()=>{
    const hive = writeRegistry(null, [
        { root: HKLM, key: 'SOFTWARE\\A\\B', name: 'X', type: 4, data: Uint8Array.of(1, 0, 0, 0) },
        { root: HKLM, key: 'software\\a\\b', name: 'x', type: 4, data: Uint8Array.of(2, 0, 0, 0) },
    ]);
    const leaf = { name: 'B', keys: [], values: [{ name: 'x', type: 4, data: [2, 0, 0, 0] }] };
    assert.deepEqual(hive, { roots: [{ id: HKLM, key: { name: '', values: [], keys: [
        { name: 'SOFTWARE', values: [], keys: [{ name: 'A', values: [], keys: [leaf] }] }] } }] });
});

test('a PE image says its machine', ()=>{
    const image = new Uint8Array(0x100);
    const view = new DataView(image.buffer);
    view.setUint32(0x3c, 0x80, true);
    view.setUint16(0x84, 0x8664, true);
    assert.equal(imageMachine(image), 'amd64');
    view.setUint16(0x84, 0x14c, true);
    assert.equal(imageMachine(image), 'x86');
});

test('a bootstrapper\'s package is applied by its tables on the machine it is for', async()=>{
    const program = await bootstrapper({ wide: true, version: '14.0.1', size: 40, fill: 0x64 });
    const { packages, files } = await unpackRedistributable(program);
    assert.equal(packages.length, 1, 'the package inside the container inside the program');

    const wide = applyPackage(packages[0], files, 'amd64');
    assert.deepEqual(wide.files.map(file=>[file.path, file.bytes.length, file.bytes[0]]),
        [['C:\\WINDOWS\\system32\\vcruntime140.dll', 40, 0x64]],
        'its folder set by the custom action; the false condition\'s file left out');
    assert.deepEqual(wide.registry.map(({ key, name, data })=>[key, name, [...data]]), [
        ['SOFTWARE\\VC\\Runtimes\\x64', 'Installed', [1, 0, 0, 0]],
        ['SOFTWARE\\VC\\Runtimes\\x64', 'Version', [...latin1('14.0.1\0')]],
    ], 'the detection component\'s rows, the property read');
    assert.deepEqual(wide.skipped, ['tool.exe: its directory is not a Windows folder']);

    assert.deepEqual(applyPackage(packages[0], files, 'x86').files, [],
        'a 64-bit component is no 32-bit machine\'s');
    const narrow = await unpackRedistributable(
        await bootstrapper({ wide: false, version: '14.0.1', size: 30 }));
    assert.deepEqual(applyPackage(narrow.packages[0], narrow.files, 'amd64').files
        .map(file=>file.path), ['C:\\WINDOWS\\SysWOW64\\vcruntime140.dll'],
    'a 32-bit runtime on a 64-bit machine is in SysWOW64');
    assert.deepEqual(applyPackage(narrow.packages[0], narrow.files, 'x86').files
        .map(file=>file.path), ['C:\\WINDOWS\\system32\\vcruntime140.dll']);
});

test('two files of one key in a bootstrapper: the package takes the one of its size', async()=>{
    const x86 = cabinet({ 'vcruntime140.dll': new Uint8Array(30).fill(0x32) });
    const program = await bootstrapper({ wide: true, version: '14.0.1', size: 40, fill: 0x64 });
    const both = new Uint8Array(2 + x86.length + program.length);
    both.set(latin1('MZ'), 0);
    both.set(x86, 2);
    both.set(program, 2 + x86.length);
    const { packages, files } = await unpackRedistributable(both);
    assert.equal(files.get('vcruntime140.dll')?.length, 2);
    assert.equal(applyPackage(packages[0], files, 'amd64').files[0].bytes[0], 0x64);
});

test('an app\'s install scripts and the runtimes it carries are installed into its bottle',
    async()=>{
        const app = await mkdtemp(join(tmpdir(), 'redist-'));
        try
        {
            const vc = join(app, '_CommonRedist', 'vc');
            await mkdir(vc, { recursive: true });
            await mkdir(join(app, 'Engine', 'Prereq'), { recursive: true });
            await writeFile(join(vc, 'vc_redist.x64.exe'),
                await bootstrapper({ wide: true, version: '14.0.1', size: 40, fill: 1 }));
            await writeFile(join(vc, 'install x64.cmd'),
                '@ECHO OFF\r\nstart /w "" "%~dp0\\vc_redist.x64" /q /norestart\r\n');
            await writeFile(join(vc, 'installscript.vdf'), String.raw`"InstallScript"
{ "Run Process" {
  "x64" { "process 1" "%INSTALLDIR%\\_CommonRedist\\vc\\install x64.cmd" }
  "missing" { "process 1" "%INSTALLDIR%\\_CommonRedist\\vc\\gone.exe" }
} }`);
            await writeFile(join(app, 'game.vdf'), String.raw`"InstallScript"
{ "Registry" { "HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor" { "string" { "Dir" "%INSTALLDIR%" } } } }`);
            // The app's own prerequisite installer: a newer runtime, applied over the older.
            await writeFile(join(app, 'Engine', 'Prereq', 'Prereq.exe'), await bootstrapper(
                { wide: true, version: '14.24.2', size: 44, fill: 2, tool: false }));
            await writeFile(join(app, 'Setup.exe'), await gameSetup());

            const said = await installRedistributables(app,
                ['_CommonRedist\\vc\\installscript.vdf', 'game.vdf'], 'amd64');
            assert.deepEqual(said, [
                '_CommonRedist\\vc\\installscript.vdf: missing: '
                    + 'C:\\App\\_CommonRedist\\vc\\gone.exe is not in the app',
                '_CommonRedist\\vc\\vc_redist.x64.exe: 1 package(s), 1 file(s)',
                'Engine\\Prereq\\Prereq.exe: 1 package(s), 1 file(s), the app\'s own',
                'redistributables: 1 file(s), 5 registry value(s)',
            ], 'the batch file\'s program run; a setup installing elsewhere not');
            const runtime = await readFile(
                join(app, '.bottlify', 'drive_c', 'WINDOWS', 'system32', 'vcruntime140.dll'));
            assert.deepEqual([runtime.length, runtime[0]], [44, 2], 'the newer runtime\'s file');
            const hive = JSON.parse(
                await readFile(join(app, '.bottlify', 'registry.json'), 'utf8'));
            /** @param {string} path @param {string} name */
            const value = (path, name)=>path.split('\\').reduce((key, part)=>key.keys
                .find((/** @type {any} */ one)=>one.name === part), hive.roots
                .find((/** @type {any} */ root)=>root.id === HKLM).key)
                .values.find((/** @type {any} */ one)=>one.name === name).data;
            assert.deepEqual(value('SOFTWARE\\VC\\Runtimes\\x64', 'Version'),
                [...latin1('14.24.2\0')], 'and its registry values');
            assert.deepEqual(value('SOFTWARE\\Vendor', 'Dir'), [...latin1('C:\\App\0')]);
            assert.equal(existsSync(join(app, '.bottlify', 'drive_c', 'Program Files')), false);

            // A 32-bit machine has no 64-bit runtime: the scripts' registry alone.
            await rm(join(app, '.bottlify'), { recursive: true });
            const narrow = await installRedistributables(app, ['game.vdf'], 'x86');
            assert.equal(narrow.at(-1), 'redistributables: 0 file(s), 1 registry value(s)');
        }
        finally
        {
            await rm(app, { recursive: true, force: true });
        }
    });

/** A PE image of a machine, as much of one as says which. @param {number} machine */
function peImage(machine){
    const bytes = new Uint8Array(0x100);
    const view = new DataView(bytes.buffer);
    view.setUint32(0x3c, 0x80, true);
    view.setUint16(0x84, machine, true);
    return bytes;
}

/**
 * DirectX's cabinets as the June 2010 runtime lays them out: a 32-bit one whose
 * Windows NT INF installs into system32 or, on a 64-bit machine, SysWOW64,
 * beside its 9x INF; a 64-bit one with its own section and a COM server.
 */
function directxCabinets(){
    const x86 = cabinet({
        'X3DAudio1_7.dll': peImage(0x14c),
        'X3DAudio1_7_x86.inf': latin1([
            '[Version]', 'Signature = "$Windows NT$"', '',
            '[DestinationDirs]', 'DefaultDestDir = 11', 'DirectX_SysWOW64 = 10,SysWOW64', '',
            '[x86_Install]', 'CopyFiles = DirectX_System', '[x64_Install]',
            'CopyFiles = DirectX_SysWOW64', '[DirectX_System]', 'X3DAudio1_7.dll',
            '[DirectX_SysWOW64]', 'X3DAudio1_7.dll ; the same file'].join('\r\n')),
        'X3DAudio1_7_w9x.inf': latin1(['[Version]', 'Signature = "$CHICAGO$"',
            '[DestinationDirs]', 'DefaultDestDir = 11', '[DefaultInstall]',
            'CopyFiles = Files', '[Files]', 'X3DAudio1_7.dll'].join('\n')),
    });
    const x64 = cabinet({
        'XAudio2_7.dll': peImage(0x8664),
        'XAudio2_7_x64.inf': latin1(['[Version]', 'Signature = "$Windows NT$"',
            '[DestinationDirs]', 'DirectX_System = 11', '[DefaultInstall]',
            'CopyFiles = DirectX_System', '[DirectX_System]', 'XAudio2_7.dll',
            '[DllRegisterServer]', '%11%\\XAudio2_7.dll'].join('\n')),
    });
    return [x86, x64];
}

test('an INF is its sections, comments and blank lines dropped', ()=>{
    const inf = redist.parseInf(
        '; head\r\n[Version]\r\nSignature = "$Windows NT$" ; why\r\n\r\n[A]\r\nb\r\n');
    assert.deepEqual([...inf], [['version', ['Signature = "$Windows NT$"']], ['a', ['b']]]);
});

test('DirectX\'s cabinets are installed by their Windows NT INFs for the machine', ()=>{
    const narrow = redist.directxFiles(directxCabinets(), 'x86');
    assert.deepEqual(narrow.files.map(file=>file.path),
        ['C:\\WINDOWS\\system32\\X3DAudio1_7.dll'],
        'a 32-bit machine takes the 32-bit section, and no 64-bit image');
    assert.deepEqual(narrow.unregistered, []);
    const wide = redist.directxFiles(directxCabinets(), 'amd64');
    assert.deepEqual(wide.files.map(file=>file.path).sort(), [
        'C:\\WINDOWS\\SysWOW64\\X3DAudio1_7.dll', 'C:\\WINDOWS\\system32\\XAudio2_7.dll']);
    assert.deepEqual(wide.unregistered, ['XAudio2_7.dll'], 'a COM server named, not registered');
    assert.deepEqual(redist.directxFiles([latin1('not a cabinet')], 'x86').files, []);
});

/** Steam's DirectX script, as the redistributables' depot carries it. */
const DIRECTX_SCRIPT = String.raw`"installscript"
{ "Run Process" { "dxsetup" {
  "process 1" "%INSTALLDIR%\\_CommonRedist\\DirectX\\Jun2010\\DXSETUP.exe"
  "command 1" "/silent" } } }`;

test('Steam\'s DirectX step installs what its setup\'s cabinets hold, in a directory', async()=>{
    const app = await mkdtemp(join(tmpdir(), 'redist-'));
    try
    {
        const dx = join(app, '_CommonRedist', 'DirectX', 'Jun2010');
        await mkdir(dx, { recursive: true });
        await writeFile(join(dx, 'DXSETUP.exe'), peImage(0x14c));
        const [x86, x64] = directxCabinets();
        await writeFile(join(dx, 'Feb2010_X3DAudio_x86.cab'), x86);
        await writeFile(join(dx, 'Jun2010_XAudio_x64.cab'), x64);
        await writeFile(join(dx, 'installscript.vdf'), DIRECTX_SCRIPT);
        const said = await installRedistributables(app,
            ['_CommonRedist\\DirectX\\Jun2010\\installscript.vdf'], 'x86');
        assert.deepEqual(said, [
            '_CommonRedist\\DirectX\\Jun2010\\DXSETUP.exe: 1 file(s) by its cabinets\' INFs',
            'redistributables: 1 file(s), 0 registry value(s)',
        ]);
        assert.ok(existsSync(join(app, '.bottlify', 'drive_c', 'WINDOWS', 'system32',
            'X3DAudio1_7.dll')));
    }
    finally
    {
        await rm(app, { recursive: true, force: true });
    }
});

test('the DirectX step runs over a bottle a browser writes in place: the tree alone', async()=>{
    const [x86, x64] = directxCabinets();
    /** @type {Map<string, Uint8Array>} */
    const files = new Map([
        ['_CommonRedist\\DirectX\\Jun2010\\DXSETUP.exe', peImage(0x14c)],
        ['_CommonRedist\\DirectX\\Jun2010\\Feb2010_X3DAudio_x86.cab', x86],
        ['_CommonRedist\\DirectX\\Jun2010\\Jun2010_XAudio_x64.cab', x64],
        ['_CommonRedist\\DirectX\\Jun2010\\installscript.vdf', latin1(DIRECTX_SCRIPT)],
        // A cabinet elsewhere is not the setup's.
        ['Other\\Feb2010_X3DAudio_x86.cab', x86],
    ]);
    const tree = {
        list: async()=>[...files.keys()],
        read: async(/** @type {string} */ path)=>/** @type {Uint8Array} */ (files.get(path)),
        write: async(/** @type {string} */ path, /** @type {Uint8Array} */ bytes)=>{
            files.set(path, bytes);
        },
    };
    const said = await redist.installRedistributables(tree,
        ['_CommonRedist\\DirectX\\Jun2010\\installscript.vdf'], 'amd64');
    assert.equal(said[0], '_CommonRedist\\DirectX\\Jun2010\\DXSETUP.exe: 2 file(s) by its '
        + 'cabinets\' INFs, not registered: XAudio2_7.dll');
    assert.deepEqual([...files.keys()].filter(path=>path.startsWith('.bottlify')).sort(), [
        '.bottlify\\drive_c\\WINDOWS\\SysWOW64\\X3DAudio1_7.dll',
        '.bottlify\\drive_c\\WINDOWS\\system32\\XAudio2_7.dll',
    ]);
});
