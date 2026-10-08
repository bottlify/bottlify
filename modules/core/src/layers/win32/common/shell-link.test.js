/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BLOCK_SIGNATURES, LINK_FLAGS, SW_SHOWMAXIMIZED, SW_SHOWNORMAL,
    decodeShellLink, encodeShellLink, idListForPath, pathOfIdList, writeShellLink,
} from './shell-link.js';

/** CLSID_ShellLink as the header stores it: the first three fields little-endian. */
const LINK_CLSID_BYTES = [
    0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];
/** CLSID_MyComputer, {20D04FE0-3AEA-1069-A2D8-08002B30309D}, as an item stores it. */
const MY_COMPUTER_BYTES = [
    0xe0, 0x4f, 0xd0, 0x20, 0xea, 0x3a, 0x69, 0x10,
    0xa2, 0xd8, 0x08, 0x00, 0x2b, 0x30, 0x30, 0x9d,
];

/** @param {Uint8Array} bytes */
const view = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

/** @param {string} text */
const ascii = text=>[...text].map(c=>c.charCodeAt(0));
/** @param {string} text */
const asciiZ = text=>[...ascii(text), 0];
/** @param {string} text */
const wideZ = text=>[...text, '\0'].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >>> 8]);
/** @param {number} n */
const le16 = n=>[n & 0xff, (n >>> 8) & 0xff];
/** @param {number} n */
const le32 = n=>[n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/**
 * A header as a writer other than ours lays it out, from the specification's
 * offsets.
 *
 * @param {number} flags @param {{ showCommand?: number }} [extra]
 */
function header(flags, { showCommand = SW_SHOWNORMAL } = {}){
    const bytes = new Uint8Array(0x4c);
    const v = view(bytes);
    v.setUint32(0, 0x4c, true);
    bytes.set(LINK_CLSID_BYTES, 4);
    v.setUint32(0x14, flags, true);
    v.setUint32(0x3c, showCommand, true);
    return [...bytes];
}

/** A volume of named byte arrays, as the file surface sees one. */
function memoryVolume(){
    /** @type {Map<string, { bytes: Uint8Array, isDirectory: boolean, modified: number }>} */
    const names = new Map();
    return {
        names,
        /** @param {string} path @param {number} [size] @param {number} [modified] */
        addFile(path, size = 0, modified = Date.UTC(2004, 5, 15, 12, 30, 0)){
            names.set(path, { bytes: new Uint8Array(size), isDirectory: false, modified });
        },
        /** @param {string} path */
        addDirectory(path){
            names.set(path, { bytes: new Uint8Array(0), isDirectory: true,
                modified: Date.UTC(2004, 5, 15, 12, 0, 0) });
        },
        /** @param {string} path */
        stat(path){
            const entry = names.get(path);
            return entry ? { exists: true, isDirectory: entry.isDirectory,
                size: entry.bytes.length, modified: entry.modified } : null;
        },
        /** @param {string} path */
        open(path){
            const parent = path.slice(0, path.lastIndexOf('\\'));
            if (!names.get(parent)?.isDirectory)
            {
                return null;
            }
            names.set(path, { bytes: new Uint8Array(0), isDirectory: false, modified: 0 });
            return { path };
        },
        /** @param {{ path: string }} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            const entry = /** @type {any} */ (names.get(node.path));
            const grown = new Uint8Array(Math.max(entry.bytes.length, offset + bytes.length));
            grown.set(entry.bytes);
            grown.set(bytes, offset);
            entry.bytes = grown;
            return bytes.length;
        },
        close: ()=>{},
    };
}

test('a link nobody set anything on is a header and the terminal block', ()=>{
    const bytes = encodeShellLink({});
    assert.equal(bytes.length, 0x4c + 4);
    assert.equal(view(bytes).getUint32(0, true), 0x4c, 'HeaderSize');
    assert.deepEqual([...bytes.subarray(4, 20)], LINK_CLSID_BYTES, 'LinkCLSID');
    assert.equal(view(bytes).getUint32(0x14, true), LINK_FLAGS.IS_UNICODE);
    assert.equal(view(bytes).getUint32(0x3c, true), SW_SHOWNORMAL, 'ShowCommand');
    assert.equal(view(bytes).getUint32(0x4c, true), 0, 'TerminalBlock');

    const link = decodeShellLink(bytes);
    assert.ok(link);
    assert.equal(link.target, '');
    assert.equal(link.description, '');
    assert.equal(link.arguments, '');
    assert.equal(link.idList, null);
    assert.equal(link.linkInfo, null);
});

test('the header fields sit at the offsets the specification gives', ()=>{
    const volume = memoryVolume();
    volume.addDirectory('C:\\Games');
    volume.addFile('C:\\Games\\game.exe', 123456, Date.UTC(2004, 5, 15, 12, 30, 0));
    const bytes = encodeShellLink({
        target: 'C:\\Games\\game.exe', iconIndex: -101, showCommand: SW_SHOWMAXIMIZED,
        hotkey: 0x0646,
    }, path=>volume.stat(path));
    const v = view(bytes);
    assert.equal(v.getUint32(0x18, true), 0x20, 'FileAttributes: an ordinary archived file');
    // 2004-06-15 12:30:00 UTC in 100-nanosecond intervals since 1601.
    const time = 127317762000000000n;
    assert.equal(v.getBigUint64(0x1c, true), time, 'CreationTime');
    assert.equal(v.getBigUint64(0x24, true), time, 'AccessTime');
    assert.equal(v.getBigUint64(0x2c, true), time, 'WriteTime');
    assert.equal(v.getUint32(0x34, true), 123456, 'FileSize');
    assert.equal(v.getInt32(0x38, true), -101, 'IconIndex, a resource id');
    assert.equal(v.getUint32(0x3c, true), SW_SHOWMAXIMIZED, 'ShowCommand');
    assert.equal(v.getUint16(0x40, true), 0x0646, 'HotKey');
    assert.deepEqual([...bytes.subarray(0x42, 0x4c)], new Array(10).fill(0), 'Reserved1..3');
});

test('a link to a file round-trips every field an installer sets', ()=>{
    const volume = memoryVolume();
    volume.addDirectory('C:\\Program Files');
    volume.addDirectory('C:\\Program Files\\Demo');
    volume.addFile('C:\\Program Files\\Demo\\demo.exe', 4096);
    const fields = {
        target: 'C:\\Program Files\\Demo\\demo.exe',
        description: 'Play the demo',
        workingDirectory: 'C:\\Program Files\\Demo',
        arguments: '/window "spaced arg"',
        iconLocation: 'C:\\Program Files\\Demo\\demo.ico',
        iconIndex: 2,
        showCommand: SW_SHOWMAXIMIZED,
        hotkey: 0x0644,
        relativePath: '.\\demo.exe',
    };
    const bytes = encodeShellLink(fields, path=>volume.stat(path));
    const flags = view(bytes).getUint32(0x14, true);
    for (const flag of [
        LINK_FLAGS.HAS_LINK_TARGET_ID_LIST, LINK_FLAGS.HAS_LINK_INFO, LINK_FLAGS.HAS_NAME,
        LINK_FLAGS.HAS_RELATIVE_PATH, LINK_FLAGS.HAS_WORKING_DIR, LINK_FLAGS.HAS_ARGUMENTS,
        LINK_FLAGS.HAS_ICON_LOCATION, LINK_FLAGS.IS_UNICODE,
    ])
    {
        assert.notEqual(flags & flag, 0, `flag ${flag.toString(16)}`);
    }
    assert.equal(flags & LINK_FLAGS.HAS_EXP_STRING, 0, 'no variables, no environment block');

    const link = decodeShellLink(bytes);
    assert.ok(link);
    assert.equal(link.target, fields.target);
    assert.equal(link.idListPath, fields.target, 'the id list names the target');
    assert.equal(link.linkInfo?.path, fields.target, 'and so does the LinkInfo');
    assert.equal(link.linkInfo?.localBasePath, fields.target);
    assert.equal(link.linkInfo?.commonPathSuffix, '');
    assert.deepEqual(link.linkInfo?.volume, { driveType: 3, serialNumber: 0, label: '' });
    assert.equal(link.description, fields.description);
    assert.equal(link.workingDirectory, fields.workingDirectory);
    assert.equal(link.arguments, fields.arguments);
    assert.equal(link.iconLocation, fields.iconLocation);
    assert.equal(link.relativePath, fields.relativePath);
    assert.equal(link.iconIndex, 2);
    assert.equal(link.showCommand, SW_SHOWMAXIMIZED);
    assert.equal(link.hotkey, 0x0644);
    assert.equal(link.fileSize, 4096);
    assert.deepEqual(link.blocks, []);
});

test('the id list has the shapes the shell writes for a path on a drive', ()=>{
    const volume = memoryVolume();
    volume.addDirectory('C:\\Games');
    volume.addFile('C:\\Games\\game.exe', 0x1234, Date.UTC(2004, 5, 15, 12, 30, 0));
    const list = /** @type {Uint8Array} */ (idListForPath('c:\\Games\\game.exe',
        path=>volume.stat(path.replace(/^c:/, 'C:'))));
    assert.ok(list);
    // The computer: a root folder item by class, sorted where the computer sorts.
    assert.deepEqual([...list.subarray(0, 4)], [0x14, 0x00, 0x1f, 0x50]);
    assert.deepEqual([...list.subarray(4, 20)], MY_COMPUTER_BYTES);
    // The drive: 25 bytes, the volume type, the root's name.
    assert.deepEqual([...list.subarray(20, 27)], [0x19, 0x00, 0x2f, ...ascii('C:\\'), 0]);
    assert.deepEqual([...list.subarray(27, 45)], new Array(18).fill(0), 'the rest of it zero');
    // A directory, then the file with its size, DOS stamp and attributes.
    let at = 45;
    const directory = list.subarray(at, at + view(list).getUint16(at, true));
    assert.equal(directory[2], 0x31, 'a directory entry');
    assert.deepEqual([...directory.subarray(14, 20)], asciiZ('Games'));
    at += directory.length;
    const file = list.subarray(at, at + view(list).getUint16(at, true));
    assert.equal(file[2], 0x32, 'a file entry');
    assert.equal(view(file).getUint32(4, true), 0x1234, 'its size');
    // 2004-06-15 is ((2004 - 1980) << 9) | (6 << 5) | 15; 12:30:00 is (12 << 11) | (30 << 5).
    assert.equal(view(file).getUint16(8, true), (24 << 9) | (6 << 5) | 15, 'DOS date');
    assert.equal(view(file).getUint16(10, true), (12 << 11) | (30 << 5), 'DOS time');
    assert.equal(view(file).getUint16(12, true), 0x20, 'attributes');
    assert.deepEqual([...file.subarray(14, 23)], asciiZ('game.exe'));
    assert.equal(file.length % 2, 0, 'items keep an even length');
    at += file.length;
    assert.deepEqual([...list.subarray(at)], [0, 0], 'the terminal id');

    assert.equal(pathOfIdList(list), 'C:\\Games\\game.exe');
    assert.equal(idListForPath('\\\\server\\share\\a.exe'), null, 'a share has no such shape');
    assert.equal(idListForPath('game.exe'), null, 'nor does a relative name');
});

test('a drive root and a directory target', ()=>{
    const root = decodeShellLink(encodeShellLink({ target: 'D:\\' }));
    assert.equal(root?.target, 'D:\\');
    assert.equal(root?.idListPath, 'D:\\');

    const volume = memoryVolume();
    volume.addDirectory('C:\\Data');
    const directory = encodeShellLink({ target: 'C:\\Data\\' }, path=>volume.stat(path));
    const link = decodeShellLink(directory);
    assert.equal(link?.target, 'C:\\Data', 'the trailing separator is not part of the name');
    assert.equal(link?.fileAttributes, 0x10, 'FILE_ATTRIBUTE_DIRECTORY');
    assert.equal(link?.fileSize, 0);
    const list = /** @type {Uint8Array} */ (link?.idList);
    assert.equal(list[45 + 2], 0x31, 'the last item is a directory entry');
});

test('a target the volume does not have is still written, with no facts', ()=>{
    const bytes = encodeShellLink({ target: 'C:\\nonexistent\\path' });
    const v = view(bytes);
    assert.equal(v.getUint32(0x18, true), 0, 'FileAttributes');
    assert.equal(v.getBigUint64(0x2c, true), 0n, 'WriteTime');
    assert.equal(decodeShellLink(bytes)?.target, 'C:\\nonexistent\\path');
});

test('ANSI strings: the link reads back in the ANSI page', ()=>{
    // 0xe9 is e-acute and 0x80 the euro sign in Windows-1252.
    const fields = {
        target: 'C:\\Spiele\\caf\u00e9.exe', description: 'Price \u20ac5', arguments: '-x',
        unicode: false,
    };
    const bytes = encodeShellLink(fields);
    const link = decodeShellLink(bytes);
    assert.ok(link);
    assert.equal(link.flags & LINK_FLAGS.IS_UNICODE, 0);
    assert.equal(link.description, fields.description);
    assert.equal(link.arguments, '-x');
    assert.equal(link.target, fields.target);
    // NAME_STRING is a count and that many bytes, with no terminator.
    const at = bytes.indexOf(0x80) - 'Price '.length - 2;
    assert.deepEqual([...bytes.subarray(at, at + 2 + 8)],
        [8, 0, ...ascii('Price '), 0x80, 0x35]);
});

test('a target the ANSI page cannot hold goes into the Unicode halves', ()=>{
    const target = 'C:\\\u6e38\u620f\\\u0438\u0433\u0440\u0430.exe';
    const bytes = encodeShellLink({ target, description: '\u6e38\u620f' });
    const link = decodeShellLink(bytes);
    assert.ok(link);
    assert.equal(link.target, target);
    assert.equal(link.idListPath, target, 'file entries flagged as UTF-16');
    assert.equal(link.linkInfo?.localBasePath, target, 'LocalBasePathUnicode');
    assert.equal(link.description, '\u6e38\u620f');
    const linkInfoAt = 0x4c + 2 + view(bytes).getUint16(0x4c, true);
    assert.equal(view(bytes).getUint32(linkInfoAt + 4, true), 0x24,
        'a LinkInfo header with the Unicode offsets');
});

test('a target with variables is kept in the environment block as it is', ()=>{
    const target = '%ProgramFiles%\\Demo\\demo.exe';
    const plain = decodeShellLink(encodeShellLink({ target }));
    assert.ok(plain);
    assert.notEqual(plain.flags & LINK_FLAGS.HAS_EXP_STRING, 0);
    assert.equal(plain.flags & (LINK_FLAGS.HAS_LINK_TARGET_ID_LIST | LINK_FLAGS.HAS_LINK_INFO), 0,
        'nothing to expand it with, so no path is claimed');
    assert.equal(plain.environmentTarget, target);
    assert.equal(plain.target, target);
    assert.equal(plain.blocks[0].signature, BLOCK_SIGNATURES.ENVIRONMENT);
    assert.equal(plain.blocks[0].bytes.length, 0x314);

    /** @param {string} text */
    const expand = text=>text.replace('%ProgramFiles%', 'C:\\Program Files');
    const expanded = decodeShellLink(encodeShellLink({ target, expand }));
    assert.ok(expanded);
    assert.equal(expanded.target, target, 'the raw form answers for the target');
    assert.equal(expanded.linkInfo?.path, 'C:\\Program Files\\Demo\\demo.exe');
    assert.equal(expanded.idListPath, 'C:\\Program Files\\Demo\\demo.exe');
});

test('an icon with variables gets its own environment block', ()=>{
    const iconLocation = '%SystemRoot%\\system32\\shell32.dll';
    const link = decodeShellLink(encodeShellLink({ iconLocation, iconIndex: 3 }));
    assert.ok(link);
    assert.notEqual(link.flags & LINK_FLAGS.HAS_EXP_ICON, 0);
    assert.equal(link.environmentIcon, iconLocation);
    assert.equal(link.iconLocation, iconLocation);
});

test('a link with LinkInfo only, ANSI strings, as an older writer saves it', ()=>{
    const flags = LINK_FLAGS.HAS_LINK_INFO | LINK_FLAGS.HAS_NAME | LINK_FLAGS.HAS_WORKING_DIR;
    const volumeId = [...le32(0x10 + 5), ...le32(3), ...le32(0x1234abcd), ...le32(0x10),
        ...asciiZ('DISK')];
    const base = asciiZ('C:\\WINDOWS');
    const suffix = asciiZ('NOTEPAD.EXE');
    const head = 0x1c;
    const info = [
        ...le32(head + volumeId.length + base.length + suffix.length), ...le32(head),
        ...le32(1), ...le32(head), ...le32(head + volumeId.length), ...le32(0),
        ...le32(head + volumeId.length + base.length),
        ...volumeId, ...base, ...suffix,
    ];
    const bytes = new Uint8Array([
        ...header(flags), ...info,
        ...le16(7), ...ascii('Notepad'),
        ...le16(10), ...ascii('C:\\WINDOWS'),
        ...le32(0),
    ]);
    const link = decodeShellLink(bytes);
    assert.ok(link);
    assert.equal(link.target, 'C:\\WINDOWS\\NOTEPAD.EXE', 'base and suffix joined');
    assert.deepEqual(link.linkInfo?.volume, { driveType: 3, serialNumber: 0x1234abcd,
        label: 'DISK' });
    assert.equal(link.description, 'Notepad');
    assert.equal(link.workingDirectory, 'C:\\WINDOWS');
    assert.equal(link.idList, null);
});

/**
 * A file entry item as the shell writes one: the 8.3 name as the primary
 * one, then the extension block of the given version with the long name at
 * the place that version keeps it, and the word that ends the item pointing
 * back at the block.
 *
 * @param {number} type @param {string} short @param {string} long @param {number} version
 */
function fileEntry(type, short, long, version){
    const primary = asciiZ(short);
    if ((14 + primary.length) % 2 !== 0)
    {
        primary.push(0);
    }
    const extensionAt = 14 + primary.length;
    // XP (3) names straight after the identifier; Vista (7) after a file
    // reference and a size; Windows 7 (8) four bytes later; Windows 8 (9) four
    // more, which are not zero in what it writes.
    const nameAt = { 3: 18, 7: 38, 8: 42, 9: 46 }[version] ?? 18;
    const filler = new Array(nameAt - 18).fill(0);
    if (version >= 9)
    {
        filler.splice(-4, 4, 0xf7, 0x67, 0x76, 0x00);
    }
    const extension = [...le16(0), ...le16(version), ...le32(0xbeef0004), ...le32(0), ...le32(0),
        ...le16(0x14), ...filler, ...wideZ(long), ...le16(extensionAt)];
    extension.splice(0, 2, ...le16(extension.length));
    const body = [type, 0, ...le32(0), ...le16(0), ...le16(0), ...le16(0x10),
        ...primary, ...extension];
    return [...le16(body.length + 2), ...body];
}

test('a link with an id list only, whose file entries carry their long names', ()=>{
    for (const version of [3, 7, 8, 9])
    {
        const list = [
            ...le16(0x14), 0x1f, 0x50, ...MY_COMPUTER_BYTES,
            ...le16(0x19), 0x2f, ...asciiZ('C:\\'), ...new Array(0x19 - 7).fill(0),
            ...fileEntry(0x31, 'PROGRA~1', 'Program Files', version),
            ...fileEntry(0x32, 'LONGNA~1.EXE', 'Long Name Game.exe', version),
            0, 0,
        ];
        const bytes = new Uint8Array([
            ...header(LINK_FLAGS.HAS_LINK_TARGET_ID_LIST | LINK_FLAGS.IS_UNICODE),
            ...le16(list.length), ...list, ...le32(0),
        ]);
        const link = decodeShellLink(bytes);
        assert.ok(link, `version ${version}`);
        assert.equal(link.linkInfo, null);
        assert.equal(link.target, 'C:\\Program Files\\Long Name Game.exe', `version ${version}`);
        assert.deepEqual([...(link.idList ?? [])], list);
    }
});

test('the id list answers for the target before the LinkInfo, as the shell reads it', ()=>{
    // A mapped drive: the id list names Z:, the LinkInfo the share behind it.
    const list = [
        ...le16(0x14), 0x1f, 0x50, ...MY_COMPUTER_BYTES,
        ...le16(0x19), 0x2f, ...asciiZ('Z:\\'), ...new Array(0x19 - 7).fill(0),
        ...fileEntry(0x32, 'REPORT~1.PDF', 'Report 2017.pdf', 9),
        0, 0,
    ];
    const netName = asciiZ('\\\\srv\\docs');
    const net = [...le32(0x14 + netName.length), ...le32(0), ...le32(0x14), ...le32(0),
        ...le32(0), ...netName];
    const suffix = asciiZ('Report 2017.pdf');
    const head = 0x1c;
    const info = [...le32(head + net.length + suffix.length), ...le32(head), ...le32(2),
        ...le32(0), ...le32(0), ...le32(head), ...le32(head + net.length), ...net, ...suffix];
    const link = decodeShellLink(new Uint8Array([
        ...header(LINK_FLAGS.HAS_LINK_TARGET_ID_LIST | LINK_FLAGS.HAS_LINK_INFO),
        ...le16(list.length), ...list, ...info, ...le32(0),
    ]));
    assert.equal(link?.target, 'Z:\\Report 2017.pdf');
    assert.equal(link?.linkInfo?.path, '\\\\srv\\docs\\Report 2017.pdf');
});

test('an id list rooted anywhere but the computer names no path', ()=>{
    // The control panel, a root folder item of another class.
    const list = new Uint8Array([
        ...le16(0x14), 0x1f, 0x70,
        0x20, 0x20, 0xec, 0x21, 0xea, 0x3a, 0x69, 0x10, 0xa2, 0xdd, 0x08, 0x00,
        0x2b, 0x30, 0x30, 0x9d,
        0, 0,
    ]);
    assert.equal(pathOfIdList(list), null);
    const bytes = new Uint8Array([
        ...header(LINK_FLAGS.HAS_LINK_TARGET_ID_LIST), ...le16(list.length), ...list, ...le32(0),
    ]);
    const link = decodeShellLink(bytes);
    assert.equal(link?.target, '');
    assert.deepEqual([...(link?.idList ?? [])], [...list], 'the list is kept as it is');
});

test('a link to a share: the network half of LinkInfo, both ways', ()=>{
    const target = '\\\\server\\games\\demo\\demo.exe';
    const link = decodeShellLink(encodeShellLink({ target }));
    assert.ok(link);
    assert.equal(link.target, target);
    assert.equal(link.idList, null);
    assert.equal(link.linkInfo?.network?.netName, '\\\\server\\games');
    assert.equal(link.linkInfo?.commonPathSuffix, 'demo\\demo.exe');
    assert.equal(link.linkInfo?.localBasePath, null);

    const wide = '\\\\server\\\u6e38\u620f\\a.exe';
    assert.equal(decodeShellLink(encodeShellLink({ target: wide }))?.target, wide);

    // As a writer that names a device and a provider lays it out.
    const netName = asciiZ('\\\\srv\\shared');
    const device = asciiZ('Z:');
    const net = [...le32(0x14 + netName.length + device.length), ...le32(3), ...le32(0x14),
        ...le32(0x14 + netName.length), ...le32(0x00020000), ...netName, ...device];
    const head = 0x1c;
    const suffix = asciiZ('setup.exe');
    const info = [...le32(head + net.length + suffix.length), ...le32(head), ...le32(2),
        ...le32(0), ...le32(0), ...le32(head), ...le32(head + net.length), ...net, ...suffix];
    const read = decodeShellLink(new Uint8Array([
        ...header(LINK_FLAGS.HAS_LINK_INFO), ...info, ...le32(0),
    ]));
    assert.equal(read?.target, '\\\\srv\\shared\\setup.exe');
    assert.equal(read?.linkInfo?.network?.deviceName, 'Z:');
    assert.equal(read?.linkInfo?.network?.providerType, 0x00020000);
});

test('blocks nothing here interprets come back out as they went in', ()=>{
    const tracker = new Uint8Array(0x60);
    view(tracker).setUint32(0, 0x60, true);
    view(tracker).setUint32(4, BLOCK_SIGNATURES.TRACKER, true);
    tracker.fill(0x5a, 8);
    const first = decodeShellLink(encodeShellLink({
        target: 'C:\\a.exe', blocks: [{ signature: BLOCK_SIGNATURES.TRACKER, bytes: tracker }],
    }));
    assert.ok(first);
    assert.equal(first.blocks.length, 1);
    assert.deepEqual([...first.blocks[0].bytes], [...tracker]);
    const again = decodeShellLink(encodeShellLink({ target: first.target, blocks: first.blocks }));
    assert.deepEqual([...(again?.blocks[0].bytes ?? [])], [...tracker]);
});

test('an installer descriptor block is read and flagged', ()=>{
    const darwin = new Uint8Array(0x314);
    view(darwin).setUint32(0, 0x314, true);
    view(darwin).setUint32(4, BLOCK_SIGNATURES.DARWIN, true);
    darwin.set(asciiZ('descriptor'), 8);
    const bytes = encodeShellLink({
        blocks: [{ signature: BLOCK_SIGNATURES.DARWIN, bytes: darwin }],
    });
    const link = decodeShellLink(bytes);
    assert.notEqual((link?.flags ?? 0) & LINK_FLAGS.HAS_DARWIN_ID, 0);
    assert.equal(link?.darwinId, 'descriptor');
});

test('what is not a link reads as none, and a missing terminal block is forgiven', ()=>{
    assert.equal(decodeShellLink(new Uint8Array(0)), null, 'an empty file');
    assert.equal(decodeShellLink(new Uint8Array(0x4c)), null, 'zeros');
    const wrongClass = new Uint8Array(header(0));
    wrongClass[4] = 0x02;
    assert.equal(decodeShellLink(wrongClass), null, 'another class');

    const full = encodeShellLink({ target: 'C:\\Games\\game.exe', description: 'Game' });
    assert.equal(decodeShellLink(full.subarray(0, full.length - 10)), null,
        'a string cut short');
    assert.equal(decodeShellLink(full.subarray(0, full.length - 4))?.description, 'Game',
        'the end of the bytes ends the extra data');
    const overrun = new Uint8Array([...full.subarray(0, full.length - 4),
        ...le32(0x400), ...le32(BLOCK_SIGNATURES.PROPERTY_STORE), ...new Array(16).fill(0)]);
    assert.equal(decodeShellLink(overrun)?.description, 'Game',
        'and so does a block claiming more bytes than are left');

    const odd = decodeShellLink(new Uint8Array([...header(0, { showCommand: 5 }), ...le32(0)]));
    assert.equal(odd?.showCommand, SW_SHOWNORMAL, 'a show command outside the three');
});

test('writeShellLink puts the link on the volume, with the target read off it', ()=>{
    const volume = memoryVolume();
    volume.addDirectory('C:\\Start Menu');
    volume.addDirectory('C:\\Games');
    volume.addFile('C:\\Games\\game.exe', 77);
    assert.equal(writeShellLink(volume, 'C:\\Start Menu\\Game.lnk',
        { target: 'C:\\Games\\game.exe', arguments: '-play' }), true);
    const saved = volume.names.get('C:\\Start Menu\\Game.lnk')?.bytes;
    assert.ok(saved);
    const link = decodeShellLink(saved);
    assert.equal(link?.target, 'C:\\Games\\game.exe');
    assert.equal(link?.arguments, '-play');
    assert.equal(link?.fileSize, 77);

    assert.equal(writeShellLink(volume, 'C:\\Missing\\Game.lnk', { target: 'C:\\x.exe' }), false,
        'a directory that is not there is the caller\'s to make');
});
