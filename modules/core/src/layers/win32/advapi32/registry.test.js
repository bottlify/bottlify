/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createHive,
    HKEY_CLASSES_ROOT,
    HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE,
    REG_BINARY,
    REG_DWORD,
    REG_MULTI_SZ,
    REG_SZ,
    profileDirectories,
    shellFolders,
} from './registry.js';
import { WINDOWS_VERSIONS } from '../kernel32/versions.js';

/** A root id no hive hosts, used to prove a save cannot invent one. */
const HKEY_UNKNOWN_ROOT = 0x80000050;

/** @param {string} text */
const latin1 = text=>Uint8Array.from([...text].map(character=>character.charCodeAt(0)));

/** @param {ReturnType<typeof createHive>} hive @param {string} path */
const machine = (hive, path)=>hive.create(
    /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), path).key;

test('the hive announces a burst of changes once, and a restore not at all', async()=>{
    // Whoever keeps the hive between runs is told when it is worth keeping
    // again. A program writes its settings one value at a time; that is one
    // save, not one per value, and putting a saved hive back is not a change.
    const hive = createHive();
    let announced = 0;
    hive.onChanged(()=>announced++);
    const user = /** @type {any} */ (hive.root(HKEY_CURRENT_USER));
    const { key } = hive.create(user, 'Software\\Test');
    hive.setValue(key, 'Name', REG_SZ, Uint8Array.of(65, 0));
    hive.setValue(key, 'Width', REG_DWORD, Uint8Array.of(0, 4, 0, 0));
    assert.equal(announced, 0, 'not from inside the call that makes the change');
    await Promise.resolve();
    assert.equal(announced, 1, 'one burst, one announcement');

    hive.fromJSON(hive.toJSON());
    await Promise.resolve();
    assert.equal(announced, 1, 'a restore is not a change');

    hive.deleteValue(key, 'Missing');
    await Promise.resolve();
    assert.equal(announced, 1, 'and neither is deleting what was not there');
});

test('the predefined roots exist and nothing else does', ()=>{
    const hive = createHive();

    assert.ok(hive.root(HKEY_CLASSES_ROOT));
    assert.ok(hive.root(HKEY_CURRENT_USER));
    assert.ok(hive.root(HKEY_LOCAL_MACHINE));
    assert.equal(hive.root(0x80000004), null, 'HKEY_PERFORMANCE_DATA is not one of ours');
    assert.equal(hive.root(4), null, 'an ordinary handle value is not a root');
});

test('the keys every machine carries are there before any program writes', ()=>{
    // An installer opens SharedDLLs, Uninstall and the shell folders without
    // creating them, and takes a missing one for a broken machine: measured
    // as a program that installed the same file for ever after the open
    // failed.
    const hive = createHive();
    const local = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
    const shared = hive.open(local, 'Software\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs');
    assert.ok(shared, 'found whatever the case');
    const version = hive.open(local, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion');
    const files = version && hive.getValue(version, 'ProgramFilesDir');
    assert.equal(files && String.fromCharCode(...files.data.subarray(0, files.data.length - 1)),
        'C:\\Program Files');
    // DirectX's own setup library reads the version here and tells an
    // installer whether to offer its redistributable.
    const directX = hive.open(local, 'software\\microsoft\\directx');
    const dxVersion = directX && hive.getValue(directX, 'Version');
    assert.equal(dxVersion && String.fromCharCode(...dxVersion.data.subarray(0, 12)),
        '4.09.00.0904');
    const installed = directX && hive.getValue(directX, 'InstalledVersion');
    assert.equal(installed?.type, REG_BINARY, 'the older setup library reads the binary pair');
    assert.deepEqual(installed && [...installed.data], [0, 0, 0, 9, 0, 0, 9, 4]);
    // A program reads the processor's speed here to scale its own clock
    // readings, and one that finds nothing calls this a 0 MHz machine.
    const processor = hive.open(local, 'HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0');
    const mhz = processor && hive.getValue(processor, '~MHz');
    assert.equal(mhz?.type, REG_DWORD, 'as a DWORD, which is how the kernel writes it');
    assert.deepEqual(mhz && [...mhz.data], [0xe8, 0x03, 0, 0],
        '1000 MHz, the rate rdtsc advances at');
    assert.ok(processor && hive.getValue(processor, 'VendorIdentifier'));
    // A COM server registering itself opens the class root's CLSID without
    // creating it, and gives up when it is not there.
    const classes = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
    for (const name of ['CLSID', 'Interface', 'TypeLib', 'AppID'])
    {
        assert.ok(hive.open(classes, name), name);
    }

    // A restore keeps what a program wrote and puts back what it deleted.
    hive.remove(local, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs');
    const { key } = hive.create(local, 'SOFTWARE\\Vendor');
    hive.setValue(key, 'Path', REG_SZ, Uint8Array.of(67, 0));
    hive.fromJSON(hive.toJSON());
    const restored = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
    assert.ok(hive.open(restored, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs'));
    assert.ok(hive.open(restored, 'SOFTWARE\\Vendor'));
});

test('the processor key reports the engine\'s speed, and a restored hive takes it over', ()=>{
    const mhzOf = (/** @type {any} */ hive)=>{
        const local = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
        const processor = hive.open(local, 'HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0');
        return new DataView(hive.getValue(processor, '~MHz').data.buffer).getUint32(0, true);
    };
    const slow = createHive();
    const fast = createHive({ processorMhz: 3000 });
    assert.equal(mhzOf(slow), 1000);
    assert.equal(mhzOf(fast), 3000);
    // HARDWARE is the kernel's, written at every boot: a hive saved by a run on
    // the slower engine does not keep its speed on the faster one.
    fast.fromJSON(slow.toJSON());
    assert.equal(mhzOf(fast), 3000);
});

/**
 * A value as a program reads it: text without its terminator, a DWORD as a
 * number, and null when there is none.
 *
 * @param {ReturnType<typeof createHive>} hive @param {number} rootId
 * @param {string} path @param {string} name
 */
const valueOf = (hive, rootId, path, name)=>{
    const key = hive.open(/** @type {any} */ (hive.root(rootId)), path);
    const value = key && hive.getValue(key, name);
    if (!value)
    {
        return null;
    }
    return value.type === REG_DWORD
        ? new DataView(value.data.buffer, value.data.byteOffset).getUint32(0, true)
        : String.fromCharCode(...value.data.subarray(0, value.data.length - 1));
};

const NT_VERSION = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
const USER_FOLDERS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders';
const COMMON_FOLDERS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders';

test('the Windows NT version key describes the Windows the hive was made for', ()=>{
    /** @param {import('../kernel32/versions.js').WindowsVersion} version */
    const describe = version=>{
        const hive = createHive({ windows: version });
        return ['CurrentVersion', 'CurrentBuildNumber', 'CurrentBuild', 'CSDVersion',
            'ProductName', 'CurrentMajorVersionNumber', 'CurrentMinorVersionNumber']
            .map(name=>valueOf(hive, HKEY_LOCAL_MACHINE, NT_VERSION, name));
    };
    // XP and 2000 keep an obsolete placeholder in CurrentBuild; 10 keeps
    // CurrentVersion at 6.3 for the programs that parse it, and says 10.0 in
    // two DWORDs of its own.
    const obsolete = '1.511.1 () (Obsolete data - do not use)';
    assert.deepEqual(describe(WINDOWS_VERSIONS.win2000), ['5.0', '2195', obsolete,
        'Service Pack 4', 'Microsoft Windows 2000', null, null]);
    assert.deepEqual(describe(WINDOWS_VERSIONS.winxp), ['5.1', '2600', obsolete,
        'Service Pack 3', 'Microsoft Windows XP', null, null]);
    assert.deepEqual(describe(WINDOWS_VERSIONS.win7), ['6.1', '7601', '7601',
        'Service Pack 1', 'Windows 7 Professional', null, null]);
    assert.deepEqual(describe(WINDOWS_VERSIONS.win10), ['6.3', '19045', '19045',
        null, 'Windows 10 Pro', 10, 0]);
    assert.equal(valueOf(createHive(), HKEY_LOCAL_MACHINE, NT_VERSION, 'CSDVersion'),
        'Service Pack 3', 'a hive made without a version is XP\'s');
});

test('Windows 10 names its release and its update revision, and nothing older does', ()=>{
    // 19045 is 22H2, the release whose ReleaseId stayed at 2009 when the
    // name moved to DisplayVersion; UBR is the revision after the build.
    /** @param {import('../kernel32/versions.js').WindowsVersion} version */
    const release = version=>{
        const hive = createHive({ windows: version });
        return ['DisplayVersion', 'ReleaseId', 'UBR']
            .map(name=>valueOf(hive, HKEY_LOCAL_MACHINE, NT_VERSION, name));
    };
    const [displayVersion, releaseId, ubr] = release(WINDOWS_VERSIONS.win10);
    assert.equal(displayVersion, '22H2');
    assert.equal(releaseId, '2009');
    assert.equal(typeof ubr, 'number', 'UBR is a DWORD');
    assert.equal(ubr, WINDOWS_VERSIONS.win10.release?.ubr);
    for (const name of /** @type {const} */ (['win2000', 'winxp', 'win7']))
    {
        assert.deepEqual(release(WINDOWS_VERSIONS[name]), [null, null, null], name);
    }
});

test('the shell folders are Documents and Settings to XP and Users from 7 on', ()=>{
    const xp = shellFolders(WINDOWS_VERSIONS.winxp);
    assert.equal(xp.Profile, 'C:\\Documents and Settings\\User');
    assert.equal(xp.AppData, 'C:\\Documents and Settings\\User\\Application Data');
    assert.equal(xp['Local AppData'],
        'C:\\Documents and Settings\\User\\Local Settings\\Application Data');
    assert.equal(xp.Personal, 'C:\\Documents and Settings\\User\\My Documents');
    assert.equal(xp['Common AppData'], 'C:\\Documents and Settings\\All Users\\Application Data');
    assert.equal(xp['Common Documents'], 'C:\\Documents and Settings\\All Users\\Documents');
    assert.deepEqual(shellFolders(WINDOWS_VERSIONS.win2000), xp);

    const seven = shellFolders(WINDOWS_VERSIONS.win7);
    assert.equal(seven.Profile, 'C:\\Users\\User');
    assert.equal(seven.AppData, 'C:\\Users\\User\\AppData\\Roaming');
    assert.equal(seven['Local AppData'], 'C:\\Users\\User\\AppData\\Local');
    assert.equal(seven.Personal, 'C:\\Users\\User\\Documents');
    assert.equal(seven.Desktop, 'C:\\Users\\User\\Desktop');
    assert.equal(seven.Programs,
        'C:\\Users\\User\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs');
    assert.equal(seven['Common AppData'], 'C:\\ProgramData');
    assert.equal(seven['Common Programs'],
        'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs');
    assert.equal(seven['Common Documents'], 'C:\\Users\\Public\\Documents');
    assert.equal(seven['Common Desktop'], 'C:\\Users\\Public\\Desktop');
    assert.deepEqual(shellFolders(WINDOWS_VERSIONS.win10), seven);

    for (const folders of [xp, seven])
    {
        assert.equal(folders.Windows, 'C:\\WINDOWS');
        assert.equal(folders.ProgramFiles, 'C:\\Program Files', 'a 32-bit system has one');
    }

    // The registry and the shell read one table: what a program reads from
    // one it finds in the other.
    const hive = createHive({ windows: WINDOWS_VERSIONS.win7 });
    assert.equal(valueOf(hive, HKEY_CURRENT_USER, USER_FOLDERS, 'AppData'), seven.AppData);
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, COMMON_FOLDERS, 'Common Documents'),
        seven['Common Documents']);
});

test('a hive restored under another Windows describes that one, and keeps the rest', ()=>{
    // A bottle's registry is kept between runs, and its version is a setting
    // that can change: the values that describe the machine are the
    // machine's, rewritten at every start, while a program's own survive.
    const saved = createHive({ windows: WINDOWS_VERSIONS.win10 });
    const { key } = saved.create(/** @type {any} */ (saved.root(HKEY_CURRENT_USER)),
        'Software\\Vendor');
    saved.setValue(key, 'Path', REG_SZ, latin1('C:\\Games\0'));

    const hive = createHive({ windows: WINDOWS_VERSIONS.winxp });
    hive.fromJSON(saved.toJSON());

    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, NT_VERSION, 'CurrentVersion'), '5.1');
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, NT_VERSION, 'CSDVersion'), 'Service Pack 3');
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, NT_VERSION, 'CurrentMajorVersionNumber'),
        null, 'what only 10 has is gone');
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, NT_VERSION, 'UBR'), null);
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, NT_VERSION, 'DisplayVersion'), null);
    assert.equal(valueOf(hive, HKEY_CURRENT_USER, USER_FOLDERS, 'AppData'),
        shellFolders(WINDOWS_VERSIONS.winxp).AppData);
    assert.equal(valueOf(hive, HKEY_CURRENT_USER, 'Software\\Vendor', 'Path'), 'C:\\Games');
});

test('a key path is created once and found again whatever its case', ()=>{
    const hive = createHive();
    const root = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));

    const first = hive.create(root, 'Software\\Vendor\\Product');
    assert.equal(first.created, true);

    const again = hive.create(root, 'SOFTWARE\\vendor\\PRODUCT');
    assert.equal(again.created, false, 'case does not make a second key');
    assert.equal(again.key, first.key);

    assert.equal(hive.open(root, 'software\\VENDOR'), hive.open(root, 'Software\\Vendor'));
    assert.equal(hive.open(root, 'Software\\Missing'), null);
});

test('an empty path names the key itself', ()=>{
    const hive = createHive();
    const root = /** @type {any} */ (hive.root(HKEY_CURRENT_USER));

    assert.equal(hive.open(root, ''), root);
    assert.equal(hive.open(root, null), root);
    assert.equal(hive.create(root, '').key, root);
    // Guest code concatenates these paths and leaves separators behind.
    assert.equal(hive.open(root, '\\'), root);
});

test('values are found without regard to case, and a missing one is null', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Vendor');

    hive.setValue(key, 'InstallPath', REG_SZ, latin1('C:\\Games'));

    // Both directions: folding only on the way in would still answer a
    // lower-case question and nothing else.
    assert.equal(
        /** @type {any} */ (hive.getValue(key, 'installpath')).name,
        'InstallPath',
        'the name comes back as it was written, not as it was asked for');
    assert.ok(hive.getValue(key, 'INSTALLPATH'));
    assert.ok(hive.getValue(key, 'InstallPath'));
    assert.equal(hive.getValue(key, 'Missing'), null);
});

test('string data is stored with its terminator counted', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Test');

    // A guest that passes strlen as the byte count is the common case, and the
    // reader on the other side expects to find the NUL anyway.
    const sz = hive.setValue(key, 'Path', REG_SZ, latin1('ab'));
    assert.deepEqual([...sz.data], [0x61, 0x62, 0]);

    const already = hive.setValue(key, 'Done', REG_SZ, latin1('ab\0'));
    assert.deepEqual([...already.data], [0x61, 0x62, 0], 'a terminator is not doubled');

    // advapi32's registry tests set a REG_SZ of no bytes and read none back.
    const empty = hive.setValue(key, 'Empty', REG_SZ, new Uint8Array(0));
    assert.deepEqual([...empty.data], [], 'nothing stays nothing');

    // REG_MULTI_SZ ends the list with a second NUL, not a first.
    const multi = hive.setValue(key, 'List', REG_MULTI_SZ, latin1('a\0b\0'));
    assert.deepEqual([...multi.data], [0x61, 0, 0x62, 0, 0]);
});

test('binary and dword data are stored byte for byte', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Test');

    const dword = hive.setValue(key, 'Count', REG_DWORD, Uint8Array.from([7, 0, 0, 0]));
    assert.deepEqual([...dword.data], [7, 0, 0, 0], 'a trailing zero is data, not a terminator');

    const binary = hive.setValue(key, 'Blob', REG_BINARY, Uint8Array.from([1, 2, 3]));
    assert.deepEqual([...binary.data], [1, 2, 3]);
});

test('enumeration order is insertion order and survives an overwrite', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Test');

    hive.create(key, 'Beta');
    hive.create(key, 'Alpha');
    hive.setValue(key, 'second', REG_DWORD, Uint8Array.from([0, 0, 0, 0]));
    hive.setValue(key, 'first', REG_DWORD, Uint8Array.from([0, 0, 0, 0]));

    assert.deepEqual(hive.subkeys(key), ['Beta', 'Alpha']);
    assert.deepEqual(hive.values(key).map(value=>value.name), ['second', 'first']);

    hive.setValue(key, 'SECOND', REG_DWORD, Uint8Array.from([1, 0, 0, 0]));
    assert.deepEqual(hive.values(key).map(value=>value.name), ['SECOND', 'first'],
        'rewriting a value leaves it where an enumeration already found it');
});

test('a key with subkeys is refused rather than deleted', ()=>{
    const hive = createHive();
    const root = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
    hive.create(root, 'Software\\Vendor\\Product');

    assert.equal(hive.remove(root, 'Software\\Vendor'), 'has-subkeys');
    assert.equal(hive.remove(root, 'Software\\Vendor\\Product'), 'deleted');
    assert.equal(hive.remove(root, 'SOFTWARE\\VENDOR'), 'deleted', 'case is no obstacle');
    assert.equal(hive.remove(root, 'Software\\Vendor'), 'missing');
    assert.equal(hive.remove(root, ''), 'missing', 'a key cannot delete itself');
});

test('deleting a value reports whether there was one', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Test');
    hive.setValue(key, 'Gone', REG_SZ, latin1('x'));

    assert.equal(hive.deleteValue(key, 'GONE'), true);
    assert.equal(hive.deleteValue(key, 'Gone'), false);
    assert.equal(hive.getValue(key, 'Gone'), null);
});

test('a hive survives a round trip through JSON', ()=>{
    const hive = createHive();
    const key = machine(hive, 'Software\\Vendor\\Product');
    hive.setValue(key, 'InstallPath', REG_SZ, latin1('C:\\Games'));
    hive.setValue(key, 'Blob', REG_BINARY, Uint8Array.from([0, 1, 2, 0xff]));
    hive.setValue(key, '', REG_SZ, latin1('default'));
    hive.create(key, 'Second');
    hive.create(key, 'First');
    hive.setValue(
        /** @type {any} */ (hive.root(HKEY_CURRENT_USER)), 'Top', REG_DWORD,
        Uint8Array.from([9, 0, 0, 0]));

    // Through an actual serialisation, since that is what a saved session is.
    const restored = createHive();
    restored.fromJSON(JSON.parse(JSON.stringify(hive.toJSON())));

    const back = /** @type {any} */ (restored.open(
        /** @type {any} */ (restored.root(HKEY_LOCAL_MACHINE)), 'software\\vendor\\product'));
    assert.ok(back, 'the tree comes back, and still ignores case');
    assert.deepEqual(restored.subkeys(back), ['Second', 'First'], 'order is part of the contract');
    assert.deepEqual(restored.values(back).map(value=>value.name), ['InstallPath', 'Blob', '']);
    assert.deepEqual(
        [...(/** @type {any} */ (restored.getValue(back, 'blob')).data)], [0, 1, 2, 0xff]);
    assert.equal(/** @type {any} */ (restored.getValue(back, 'InstallPath')).type, REG_SZ);
    assert.deepEqual(restored.toJSON(), hive.toJSON());
});

test('restoring a partial save leaves the other roots usable', ()=>{
    const hive = createHive();
    hive.fromJSON({ roots: [{ id: HKEY_UNKNOWN_ROOT, key: { name: 'x', values: [], keys: [] } }] });

    assert.ok(hive.root(HKEY_LOCAL_MACHINE), 'a root nobody saved is there, not absent');
    assert.deepEqual(hive.subkeys(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE))),
        ['SOFTWARE', 'SYSTEM', 'HARDWARE'], 'holding only what every machine holds');
    assert.equal(hive.root(HKEY_UNKNOWN_ROOT), null);
});

test('a restore discards what the hive was holding', ()=>{
    const hive = createHive();
    machine(hive, 'Software\\Stale');

    hive.fromJSON(createHive().toJSON());

    assert.equal(
        hive.open(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)), 'Software\\Stale'), null);
});

test('the classes root is saved as the two roots it shows, and an older save folds in', ()=>{
    const hive = createHive();
    const classes = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
    const { key } = hive.create(classes, 'CLSID\\{00000000-0000-0000-0000-00000000C0DE}');
    hive.setValue(key, '', REG_SZ, latin1('Registered'));
    assert.ok(hive.open(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)),
        'Software\\Classes\\CLSID\\{00000000-0000-0000-0000-00000000C0DE}'));
    const saved = hive.toJSON();
    assert.equal(saved.roots.some(root=>root.id === HKEY_CLASSES_ROOT), false,
        'not a third copy of what the machine and the user already hold');

    // A save made while the classes root was a tree of its own still has its
    // classes found, and what the machine side says wins where both have it.
    const older = /** @type {any} */ (saved);
    older.roots.push({ id: HKEY_CLASSES_ROOT, key: { name: 'HKEY_CLASSES_ROOT', values: [], keys: [
        { name: '.xyz', values: [{ name: '', type: REG_SZ, data: [...latin1('xyzfile\0')] }],
            keys: [] },
        { name: 'CLSID', values: [], keys: [
            { name: '{00000000-0000-0000-0000-00000000C0DE}',
                values: [{ name: '', type: REG_SZ, data: [...latin1('Stale\0')] }], keys: [] },
        ] },
    ] } });
    const restored = createHive();
    restored.fromJSON(JSON.parse(JSON.stringify(older)));
    const root = /** @type {any} */ (restored.root(HKEY_CLASSES_ROOT));
    /** @param {any} at */
    const text = at=>String.fromCharCode(...restored.getValue(at, '')?.data ?? []);
    assert.equal(text(restored.open(root, '.XYZ')), 'xyzfile\0');
    assert.equal(text(restored.open(root, 'CLSID\\{00000000-0000-0000-0000-00000000C0DE}')),
        'Registered\0');
});

test('the profile\'s directories are every folder under it, each parent before its children', ()=>{
    for (const windows of Object.values(WINDOWS_VERSIONS))
    {
        const directories = profileDirectories(windows);
        const folders = shellFolders(windows);
        for (const name of ['Profile', 'Desktop', 'Startup', 'Personal', 'AppData',
            'Local AppData', 'Common Desktop', 'Common Startup', 'Common Documents',
            'Common AppData'])
        {
            assert.ok(directories.includes(folders[name]), `${windows.name}: ${name}`);
        }
        directories.forEach((path, index)=>{
            const parent = path.slice(0, path.lastIndexOf('\\'));
            assert.ok(parent === 'C:' || directories.indexOf(parent) < index,
                `${windows.name}: ${parent} before ${path}`);
        });
        assert.ok(!directories.some(path=>/^C:\\(WINDOWS|Program Files)/i.test(path)),
            'the system\'s own directories are not the profile\'s');
    }
    assert.ok(profileDirectories(WINDOWS_VERSIONS.win7).includes('C:\\Users\\Public'));
    assert.ok(profileDirectories(WINDOWS_VERSIONS.winxp)
        .includes('C:\\Documents and Settings\\User\\Local Settings'));
});

test('a saved tree fills in what the hive lacks and leaves what it has as it is', ()=>{
    // An installation's registry beneath a session's: the key a launcher
    // looks for to know the game is installed comes from the installation,
    // and a value the program has changed since stays changed.
    const installed = createHive();
    const game = machine(installed, 'SOFTWARE\\Monolith Productions\\TRON 2.0 Demo\\1.0');
    installed.setValue(game, 'InstallDir', REG_SZ, latin1('C:\\Games\\Tron\0'));
    installed.setValue(game, 'Language', REG_SZ, latin1('English\0'));
    installed.setValue(installed.create(/** @type {any} */ (installed.root(HKEY_CLASSES_ROOT)),
        '.rez').key, '', REG_SZ, latin1('TronData\0'));

    const hive = createHive();
    hive.setValue(machine(hive, 'SOFTWARE\\Monolith Productions\\Tron 2.0 Demo\\1.0'),
        'Language', REG_SZ, latin1('French\0'));
    hive.fillFromJSON(JSON.parse(JSON.stringify(installed.toJSON())));

    const at = 'SOFTWARE\\Monolith Productions\\Tron 2.0 Demo\\1.0';
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, at, 'InstallDir'), 'C:\\Games\\Tron',
        'filled in, under the name as the hive already spelled it');
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, at, 'Language'), 'French',
        'what the hive already had is kept');
    assert.equal(valueOf(hive, HKEY_CLASSES_ROOT, '.rez', ''), 'TronData',
        'and a class registration is found where classes are');
});
