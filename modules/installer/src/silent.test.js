/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DESTINATION, detectFamily, dialogCalled, packagedEntries, readImage, responseFile,
    silentOptions,
} from './silent.js';
import { MEDIA_DIRECTORY } from './prefix.js';

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff);

/** @param {Uint8Array} bytes */
const text = bytes=>new TextDecoder('latin1').decode(bytes);

/**
 * A PE with the sections named, each holding the text given, and a payload
 * appended after the last of them -- the shape every stub in the corpus has.
 *
 * @param {{ name: string, text?: string }[]} sections
 * @param {Uint8Array} [overlay]
 */
function pe(sections, overlay = new Uint8Array(0)){
    const headers = 0x200;
    const align = 0x200;
    const bytes = new Uint8Array(headers + sections.length * align + overlay.length);
    const view = new DataView(bytes.buffer);
    bytes.set(latin1('MZ'), 0);
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80, 0x4550, true);
    view.setUint16(0x80 + 6, sections.length, true);
    view.setUint16(0x80 + 20, 0xe0, true);
    const table = 0x80 + 24 + 0xe0;
    sections.forEach((section, index)=>{
        const at = table + index * 40;
        bytes.set(latin1(section.name).subarray(0, 8), at);
        const raw = headers + index * align;
        view.setUint32(at + 16, align, true);
        view.setUint32(at + 20, raw, true);
        if (section.text)
        {
            bytes.set(latin1(section.text), raw);
        }
    });
    bytes.set(overlay, headers + sections.length * align);
    return bytes;
}

/**
 * The directory the InstallShield player appends: name, disc path, version,
 * decimal size, each NUL-ended, then the bytes.
 *
 * @param {{ name: string, bytes: Uint8Array }[]} files
 */
function packaged(files){
    const parts = files.flatMap(file=>[
        latin1(`${file.name}\x00Disk1\\${file.name}\x000.0.0.0\x00${file.bytes.length}\x00`),
        file.bytes,
    ]);
    const total = parts.reduce((sum, part)=>sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts)
    {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

const SETUP_INI = '[Startup]\r\nAppName=Some Title\r\n'
    + 'ProductGUID=A98E5E03-E407-408E-A8D8-B9F088F21000\r\n'
    + '[Languages]\r\nDefault=0x0009\r\n';

const WISE_STUB = pe(
    [{ name: '.text' },
        { name: '.rdata', text: 'DisplayGraphics\0WiseMain\0Could not extract Wise0132.dll to' }],
    latin1('\0 ,\x03\x04payload'));

const INSTALLSHIELD_STUB = pe(
    [{ name: '.text' }, { name: '.rdata', text: 'InstallShield Silent\0setupexe.log' }],
    packaged([
        { name: 'data1.cab', bytes: latin1('ISc(') },
        { name: 'engine32.cab', bytes: latin1('MSCF') },
        { name: 'setup.ini', bytes: latin1(SETUP_INI) },
    ]));

const WINZIP_STUB = pe([{ name: '.text' }, { name: '_winzip_', text: 'PK' }]);

const WINRAR_STUB = pe([{ name: 'UPX0' }, { name: 'UPX1' }], latin1('Rar!\x1a\x07\x00\xcf\x90s'));

test('a PE is read for its sections and where its payload begins', ()=>{
    const image = readImage(WINRAR_STUB);
    assert.deepEqual(image?.sections, ['UPX0', 'UPX1']);
    const overlay = image?.overlay ?? 0;
    assert.equal(text(WINRAR_STUB.subarray(overlay, overlay + 4)), 'Rar!');
    assert.equal(readImage(latin1('not a program')), null);
    assert.equal(readImage(latin1('MZ' + '\0'.repeat(0x3e))), null, 'no PE signature');
});

test('the InstallShield directory is walked by size, whatever the payload holds', ()=>{
    const image = readImage(INSTALLSHIELD_STUB);
    const entries = packagedEntries(INSTALLSHIELD_STUB, image?.overlay ?? 0);
    assert.deepEqual(entries.map(entry=>[entry.name, entry.size]),
        [['data1.cab', 4], ['engine32.cab', 4], ['setup.ini', SETUP_INI.length]]);
    const ini = entries[2];
    assert.equal(text(INSTALLSHIELD_STUB.subarray(ini.at, ini.at + ini.size)), SETUP_INI);
    assert.deepEqual(packagedEntries(WISE_STUB, readImage(WISE_STUB)?.overlay ?? 0), [],
        'a payload of another shape is no directory');
});

test('a family is read off the engine in the bytes, not the name', ()=>{
    assert.equal(detectFamily(WISE_STUB), 'wise');
    assert.equal(detectFamily(INSTALLSHIELD_STUB), 'installshield');
    assert.equal(detectFamily(WINZIP_STUB), 'winzip-sfx');
    assert.equal(detectFamily(WINRAR_STUB), 'winrar-sfx');
    assert.equal(detectFamily(latin1('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + '\0'.repeat(64))), 'msi');
    assert.equal(detectFamily(pe([{ name: '.text', text: 'a program of its own' }])), null);
    assert.equal(detectFamily(latin1('PK\x03\x04')), null, 'not even a program');
});

test('an InstallShield disc is the player beside the engine files; the marker is not enough', ()=>{
    const player = pe([{ name: '.text', text: 'InstallShield Setup Player 2K2' }]);
    assert.equal(detectFamily(player, ['data1.cab', 'engine32.cab', 'setup.ini', 'setup.inx']),
        'installshield');
    assert.equal(detectFamily(player, ['readme.txt']), null,
        'a program that merely mentions the engine is not built with it');
    assert.equal(detectFamily(player, ['DATA1.CAB', 'Engine32.cab', 'Setup.ini']), 'installshield',
        'names are matched the way the file system matches them');
});

test('a marker in the payload does not count: only the stub is read', ()=>{
    const carrier = pe([{ name: '.text', text: 'a self-extractor of another make' }],
        latin1('WiseMain Wise0132.dll InstallShield data1.cab\0'));
    assert.equal(detectFamily(carrier), null);
});

test('the silent command lines, per family', ()=>{
    const image = `${MEDIA_DIRECTORY}\\Setup.exe`;
    /** @type {[Uint8Array, string, string | null][]} */
    const table = [
        [WISE_STUB, `"${image}" /S /M=${MEDIA_DIRECTORY}\\bottlify-wise.txt`, DESTINATION],
        [INSTALLSHIELD_STUB,
            `"${image}" /s /f1"${MEDIA_DIRECTORY}\\bottlify.iss" /f2"${MEDIA_DIRECTORY}\\bottlify.log"`,
            DESTINATION],
        [WINZIP_STUB, `"${image}" /auto ${DESTINATION}`, DESTINATION],
        [WINRAR_STUB, `"${image}" -s`, null],
    ];
    for (const [bytes, commandLine, destination] of table)
    {
        const options = silentOptions({ name: 'Setup.exe', bytes });
        assert.equal(options?.commandLine, commandLine);
        assert.equal(options?.destination, destination);
    }
    assert.equal(silentOptions({ name: 'Setup.exe', bytes: pe([{ name: '.text' }]) }), null,
        'no family, no silent mode');
    assert.equal(silentOptions({
        name: 'product.msi',
        bytes: latin1('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + '\0'.repeat(64)),
    }), null, 'nothing in the guest runs an .msi');
});

test('Wise is answered from a values file naming the destination relative to Program Files', ()=>{
    const options = silentOptions({ name: 'Doom.exe', bytes: WISE_STUB });
    assert.equal(options?.family, 'wise');
    assert.deepEqual(options?.seeded.map(file=>[file.path, text(file.bytes)]),
        [[`${MEDIA_DIRECTORY}\\bottlify-wise.txt`, 'MAINDIR=..\\App\r\n']]);
    assert.match(options?.commandLine ?? '', /^"[^"]+" \/S /, 'the stub reads only the first switch');
});

test('InstallShield is answered from a response file keyed by the product GUID', ()=>{
    const options = silentOptions({ name: 'Setup.exe', bytes: INSTALLSHIELD_STUB });
    assert.equal(options?.family, 'installshield');
    assert.equal(options?.seeded[0].path, `${MEDIA_DIRECTORY}\\bottlify.iss`);
    const response = text(options?.seeded[0].bytes ?? new Uint8Array(0));
    assert.match(response, /^\[InstallShield Silent\]\r\nVersion=v7\.00\r\nFile=Response File\r\n/);
    const guid = '\\{A98E5E03-E407-408E-A8D8-B9F088F21000\\}';
    assert.match(response, new RegExp(`\\[${guid}-SdWelcome-0\\]\\r\\nResult=1\\r\\n`));
    assert.match(response,
        new RegExp(`\\[${guid}-SdAskDestPath-0\\]\\r\\nResult=1\\r\\nszDir=C:\\\\App\\r\\n`));
    assert.match(response, new RegExp(`-DlgOrder\\]\\r\\nDlg0=${guid}-SdWelcome-0\\r\\n`));

    const disc = silentOptions({
        name: 'setup.exe',
        bytes: pe([{ name: '.text', text: 'InstallShield' }]),
        files: [
            { name: 'data1.cab', bytes: latin1('ISc(') },
            { name: 'engine32.cab', bytes: latin1('MSCF') },
            { name: 'setup.ini', bytes: latin1('[Startup]\r\nProductGUID={0123-4567}\r\n') },
        ],
    });
    assert.match(text(disc?.seeded[0].bytes ?? new Uint8Array(0)), /\[\{0123-4567\}-DlgOrder\]/,
        'the GUID is read off the disc, braces or not');

    const noIni = silentOptions({
        name: 'setup.exe',
        bytes: pe([{ name: '.text', text: 'InstallShield' }]),
        files: [
            { name: 'data1.cab', bytes: latin1('ISc(') },
            { name: 'engine32.cab', bytes: latin1('MSCF') },
            { name: 'setup.ini', bytes: latin1('[Startup]\r\nAppName=x\r\n') },
        ],
    });
    assert.equal(noIni, null, 'without the GUID there is no way to key the answers');

    const msi = silentOptions({
        name: 'setup.exe',
        bytes: pe([{ name: '.text', text: 'InstallShield' }]),
        files: [
            { name: 'data1.cab', bytes: latin1('') },
            { name: 'engine32.cab', bytes: latin1('') },
            { name: 'setup.ini', bytes: latin1(SETUP_INI) },
            { name: 'Product.msi', bytes: latin1('') },
        ],
    });
    assert.equal(msi?.commandLine,
        `"${MEDIA_DIRECTORY}\\setup.exe" /s /v"/qn INSTALLDIR=C:\\App"`);
    assert.deepEqual(msi?.seeded, []);
});

test('the response file answers every standard dialog by name', ()=>{
    const response = responseFile('0000', 'D:\\Games');
    for (const dialog of ['SdWelcome', 'SdLicense', 'SdAskDestPath', 'SdSetupType', 'SdStartCopy',
        'SdFinish'])
    {
        assert.match(response, new RegExp(`\\[\\{0000\\}-${dialog}-0\\]\\r\\n`));
    }
    assert.match(response, /szDir=D:\\Games\r\n/);
    assert.match(response, /Count=\d+\r\n/);
});

test('an InstallShield 5 disc carries its engine as _inst32i.ex_ and has no product GUID', ()=>{
    const player = pe([{ name: '.text', text: 'InstallShield' }]);
    const files = ['data1.cab', '_inst32i.ex_', 'setup.ini']
        .map(name=>({ name,
            bytes: latin1(name === 'setup.ini' ? '[Startup]\r\nAppName=x\r\n' : '') }));
    assert.equal(detectFamily(player, files.map(file=>file.name)), 'installshield');
    assert.equal(detectFamily(player, ['data1.cab', 'setup.ini']), null, 'no engine, no player');

    const options = silentOptions({ name: 'Setup.exe', bytes: player, files },
        { dialogs: ['SdWelcome', 'SdLicense', 'SdAskDestPath'] });
    assert.equal(options?.commandLine, `"${MEDIA_DIRECTORY}\\Setup.exe" -s `
        + `-f1${MEDIA_DIRECTORY}\\bottlify.iss -f2${MEDIA_DIRECTORY}\\bottlify.log`);
    const response = text(options?.seeded[0].bytes ?? new Uint8Array(0));
    assert.match(response, /^\[InstallShield Silent\]\r\nVersion=v5\.00\.000\r\n/);
    assert.match(response, /\[DlgOrder\]\r\nDlg0=SdWelcome-0\r\nDlg1=SdLicense-0\r\n/);
    assert.match(response, /Count=3\r\n/);
    assert.match(response, /\[SdAskDestPath-0\]\r\nResult=1\r\nszDir=C:\\App\r\n/);
    assert.match(text(silentOptions({ name: 'Setup.exe', bytes: player, files })?.seeded[0].bytes
        ?? new Uint8Array(0)), /Dlg0=SdWelcome-0\r\nCount=1\r\n/, 'unlearned, the welcome');
});

test('the dialog an InstallShield 5 engine reaches is read off the call naming its section', ()=>{
    assert.equal(dialogCalled({ name: 'USER32.dll!wsprintfA',
        strings: [null, '%s-%ld', 'SdLicense', null] }), 'SdLicense');
    assert.equal(dialogCalled({ name: 'USER32.dll!wsprintfA', strings: [null, '%d', 'x'] }), null);
    assert.equal(dialogCalled({ name: 'KERNEL32.dll!lstrcpyA', strings: [null, '%s-%ld'] }), null);
});
