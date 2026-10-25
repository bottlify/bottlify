/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellFunctions } from './functions.js';
import { programIcon } from './icons.js';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { buildImage, buildResources } from '../../loader/internal/resources.test.js';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const ENGLISH = 0x0409;
const GERMAN = 0x0407;

/**
 * An icon image as a resource or an icon file holds one: a 32-bit DIB whose
 * height counts both masks, every pixel one colour, the AND mask clear.
 *
 * @param {number} side @param {number[]} bgr
 * @returns {Uint8Array}
 */
function iconImage(side, [b, g, r]){
    const maskStride = ((side + 31) >>> 5) * 4;
    const bytes = new Uint8Array(40 + side * side * 4 + maskStride * side);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 40, true);
    view.setInt32(4, side, true);
    view.setInt32(8, side * 2, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, 32, true);
    for (let at = 40; at < 40 + side * side * 4; at += 4)
    {
        bytes.set([b, g, r, 0], at);
    }
    return bytes;
}

/**
 * An icon group's directory: for each image its size, its depth, its length
 * and the RT_ICON id it is kept under.
 *
 * @param {{ side: number, id: number, length: number }[]} images
 * @returns {number[]}
 */
function groupDirectory(images){
    const bytes = new Uint8Array(6 + images.length * 14);
    const view = new DataView(bytes.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, images.length, true);
    images.forEach(({ side, id, length }, index)=>{
        const at = 6 + index * 14;
        bytes[at] = side & 0xff;
        bytes[at + 1] = side & 0xff;
        view.setUint16(at + 4, 1, true);
        view.setUint16(at + 6, 32, true);
        view.setUint32(at + 8, length, true);
        view.setUint16(at + 12, id, true);
    });
    return [...bytes];
}

const RED = [0, 0, 0xff];
const GREEN = [0, 0xff, 0];
const BLUE = [0xff, 0, 0];

/**
 * A library with two icon groups: one named, in two languages, offering a
 * small red image and a standard-sized green one; and one numbered 7, whose
 * only image is blue.
 */
function libraryWithIcons(){
    const small = iconImage(16, RED);
    const large = iconImage(32, GREEN);
    const other = iconImage(32, BLUE);
    const main = groupDirectory([
        { side: 16, id: 1, length: small.length }, { side: 32, id: 2, length: large.length },
    ]);
    return buildImage(buildResources([
        { type: RT_ICON, names: [
            { name: 1, langs: [{ lang: ENGLISH, data: [...small] }] },
            { name: 2, langs: [{ lang: ENGLISH, data: [...large] }] },
            { name: 3, langs: [{ lang: ENGLISH, data: [...other] }] },
        ] },
        { type: RT_GROUP_ICON, names: [
            { name: 'MAINICON',
                langs: [{ lang: ENGLISH, data: main }, { lang: GERMAN, data: main }] },
            { name: 7, langs: [{ lang: ENGLISH, data: groupDirectory(
                [{ side: 32, id: 3, length: other.length }]) }] },
        ] },
    ])).bytes;
}

/**
 * An icon file: its directory, then its images where the entries say.
 *
 * @param {{ side: number, bgr: number[] }[]} images
 */
function iconFile(images){
    const bits = images.map(({ side, bgr })=>iconImage(side, bgr));
    let at = 6 + images.length * 16;
    const bytes = new Uint8Array(at + bits.reduce((total, one)=>total + one.length, 0));
    const view = new DataView(bytes.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, images.length, true);
    images.forEach(({ side }, index)=>{
        const entry = 6 + index * 16;
        bytes[entry] = side & 0xff;
        bytes[entry + 1] = side & 0xff;
        view.setUint16(entry + 4, 1, true);
        view.setUint16(entry + 6, 32, true);
        view.setUint32(entry + 8, bits[index].length, true);
        view.setUint32(entry + 12, at, true);
        bytes.set(bits[index], at);
        at += bits[index].length;
    });
    return bytes;
}

/**
 * A shell over a real volume holding the files given, with the system
 * directory a bare name is also looked for in, and an icon maker that keeps
 * what it was handed.
 *
 * @param {Record<string, Uint8Array>} files
 * @param {Record<string, any>} [extra]  More of the host, laid over the rest.
 */
async function shellOver(files, extra = {}){
    const fs = await filesystemModule.create({});
    const volume = /** @type {any} */ (createVolume(fs));
    for (const directory of ['C:\\WINDOWS', 'C:\\WINDOWS\\system32', 'C:\\work'])
    {
        volume.mkdir(directory);
    }
    volume.setCurrentDirectory('C:\\work');
    for (const [path, bytes] of Object.entries(files))
    {
        const node = volume.open(path, { write: true, create: true, truncate: true });
        volume.write(node, 0, bytes);
        volume.close(node);
    }
    const memory = new Uint8Array(0x1000);
    /** @type {import('../user32/cursors.js').CursorPicture[]} */
    const made = [];
    /** @type {string[]} */
    const diverged = [];
    const shell = /** @type {any} */ (createShellFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readCString: (address, limit)=>{
            let end = address;
            while (end < address + limit && memory[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(memory.subarray(address, end));
        },
        volume: { ...volume, drives: ()=>['C'] },
        folders: { System: 'C:\\WINDOWS\\system32', Windows: 'C:\\WINDOWS' },
        icon: picture=>{
            made.push(picture);
            return 0x4000 + made.length;
        },
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
        ...extra,
    }));
    let next = 0x100;
    /** A string in guest memory. @param {string} text @param {boolean} wide */
    const put = (text, wide)=>{
        const at = next;
        for (const [index, unit] of [...text, '\0'].entries())
        {
            if (wide)
            {
                memory[at + index * 2] = unit.charCodeAt(0) & 0xff;
                memory[at + index * 2 + 1] = unit.charCodeAt(0) >>> 8;
            }
            else
            {
                memory[at + index] = unit.charCodeAt(0);
            }
        }
        next += (text.length + 1) * 2 + 15 & ~15;
        return at;
    };
    return { shell, put, made, diverged, memory };
}

test('ExtractIcon counts a library\'s icon groups and hands out the one at an index', async()=>{
    const m = await shellOver({ 'C:\\work\\icons.dll': libraryWithIcons() });
    const name = m.put('C:\\work\\icons.dll', true);

    assert.equal(m.shell.ExtractIconW.handler([0, name, 0xffffffff]), 2,
        'a group in two languages is one group');
    assert.equal(m.made.length, 0, 'counting makes no icon');

    assert.equal(m.shell.ExtractIconW.handler([0, name, 0]), 0x4001);
    assert.equal(m.made[0].width, 32, 'the standard size, not the first image');
    assert.deepEqual([...m.made[0].bgra.subarray(0, 4)], [0, 0xff, 0, 0xff]);
    assert.deepEqual(m.made[0].hotSpot, { x: 16, y: 16 });

    assert.equal(m.shell.ExtractIconW.handler([0, name, 1]), 0x4002);
    assert.deepEqual([...m.made[1].bgra.subarray(0, 4)], [0xff, 0, 0, 0xff]);
    assert.deepEqual([m.shell.ExtractIconA.argBytes, m.shell.ExtractIconW.argBytes], [12, 12]);
});

test('an index below -1 is a resource id, and an index past the last is no icon', async()=>{
    const m = await shellOver({ 'C:\\work\\icons.dll': libraryWithIcons() });
    const name = m.put('C:\\work\\icons.dll', false);

    assert.equal(m.shell.ExtractIconA.handler([0, name, -7 >>> 0]), 0x4001);
    assert.deepEqual([...m.made[0].bgra.subarray(0, 4)], [0xff, 0, 0, 0xff]);
    assert.equal(m.shell.ExtractIconA.handler([0, name, -8 >>> 0]), 0, 'no group 8');
    assert.equal(m.shell.ExtractIconA.handler([0, name, 2]), 0);
    assert.equal(m.shell.ExtractIconA.handler([0, name, 3000]), 0);
    assert.equal(m.made.length, 1);
});

test('a file that is no image, or is not there, has no icons at any index', async()=>{
    // Wine's ExtractIcon test, on an empty text file: NULL for 0, -1 and 1,
    // where the documentation would have 1 for a file that is not an image.
    const m = await shellOver({ 'C:\\work\\readme.txt': new Uint8Array(0),
        'C:\\work\\notes.txt': new TextEncoder().encode('MZ is how this starts') });
    for (const file of ['C:\\work\\readme.txt', 'C:\\work\\notes.txt', 'C:\\work\\gone.dll'])
    {
        const name = m.put(file, true);
        for (const index of [0, 0xffffffff, 1])
        {
            assert.equal(m.shell.ExtractIconW.handler([0, name, index]), 0, `${file} ${index}`);
        }
    }
    assert.equal(m.shell.ExtractIconW.handler([0, 0, 0]), 0, 'no file named');
    assert.equal(m.made.length, 0);
});

test('an icon file is one icon, its standard-sized image', async()=>{
    const m = await shellOver({ 'C:\\work\\app.ico': iconFile([
        { side: 16, bgr: RED }, { side: 32, bgr: GREEN }, { side: 48, bgr: BLUE },
    ]) });
    const name = m.put('app.ico', true);

    assert.equal(m.shell.ExtractIconW.handler([0, name, 0xffffffff]), 1,
        'one icon, at three sizes');
    assert.equal(m.shell.ExtractIconW.handler([0, name, 0]), 0x4001);
    assert.equal(m.made[0].width, 32);
    assert.deepEqual([...m.made[0].bgra.subarray(0, 4)], [0, 0xff, 0, 0xff]);
    assert.equal(m.shell.ExtractIconW.handler([0, name, 1]), 0);
});

test('a bare name is found in the system directory, as the shell\'s own libraries are', async()=>{
    const m = await shellOver({ 'C:\\WINDOWS\\system32\\icons.dll': libraryWithIcons() });
    assert.equal(m.shell.ExtractIconW.handler([0, m.put('icons.dll', true), 0xffffffff]), 2);
    assert.equal(m.shell.ExtractIconA.handler([0, m.put('icons.dll', false), 0]), 0x4001);
});

test('a file whose bytes are still arriving is answered when they have', async()=>{
    const fs = await filesystemModule.create({});
    const base = /** @type {any} */ (createVolume(fs));
    const late = { ...base,
        /** @param {any} node @param {number} offset @param {number} length */
        read: (node, offset, length)=>Promise.resolve(base.read(node, offset, length)) };
    const m = await shellOver({}, { volume: { ...late, drives: ()=>['C'] } });
    base.mkdir('C:\\work');
    const node = base.open('C:\\work\\icons.dll', { write: true, create: true, truncate: true });
    base.write(node, 0, libraryWithIcons());
    base.close(node);
    const name = m.put('C:\\work\\icons.dll', true);

    const counted = m.shell.ExtractIconW.handler([0, name, 0xffffffff]);
    assert.ok(counted instanceof Promise, 'the guest call waits on the reads');
    assert.equal(await counted, 2);
    assert.equal(await m.shell.ExtractIconW.handler([0, name, 1]), 0x4001);
    assert.deepEqual([...m.made[0].bgra.subarray(0, 4)], [0xff, 0, 0, 0xff]);
});

test('without an icon maker the icons are counted, none handed out, and that is said', async()=>{
    const m = await shellOver({ 'C:\\work\\icons.dll': libraryWithIcons() }, { icon: undefined });
    const name = m.put('C:\\work\\icons.dll', true);
    assert.equal(m.shell.ExtractIconW.handler([0, name, 0xffffffff]), 2);
    assert.equal(m.shell.ExtractIconW.handler([0, name, 0]), 0);
    assert.deepEqual(m.diverged.map(line=>line.split(':')[0]), ['ExtractIcon']);
});

test('a 16-bit image is reported as one whose icons are not read', async()=>{
    const image = new Uint8Array(0x100);
    image.set([0x4d, 0x5a]);
    image[0x3c] = 0x80;
    image.set([0x4e, 0x45], 0x80);
    const m = await shellOver({ 'C:\\work\\old.exe': image });
    assert.equal(m.shell.ExtractIconW.handler([0, m.put('old.exe', true), 0xffffffff]), 0);
    assert.equal(m.diverged.length, 1);
    assert.match(m.diverged[0], /16-bit/);
});

test('ExtractIconEx hands out each icon at both sizes, and counts what it handed out', async()=>{
    const m = await shellOver({ 'C:\\work\\icons.dll': libraryWithIcons() });
    const view = new DataView(m.memory.buffer);
    for (const wide of [false, true])
    {
        const call = m.shell[`ExtractIconEx${wide ? 'W' : 'A'}`];
        const name = m.put('C:\\work\\icons.dll', wide);
        assert.equal(await call.handler([name, -1 >>> 0, 0, 0, 0]), 2, 'how many');
        m.made.length = 0;
        m.memory.fill(0xaa, 0x800, 0x840);
        assert.equal(await call.handler([name, 0, 0x800, 0x820, 4]), 2,
            'two icons, a pair of sizes counting once');
        assert.deepEqual([0x800, 0x804, 0x820, 0x824].map(at=>view.getUint32(at, true)),
            [0x4001, 0x4003, 0x4002, 0x4004]);
        assert.deepEqual(m.made.map(picture=>picture.width), [32, 16, 32, 32],
            'the small size where the group has one, its only image where not');
        assert.equal(view.getUint32(0x808, true), 0, 'past the last, a null');
        m.made.length = 0;
        assert.equal(await call.handler([name, 1, 0, 0x820, 1]), 1, 'the small one alone');
        assert.equal(m.made.length, 1);
        assert.equal(await call.handler([name, -7 >>> 0, 0x800, 0, 3]), 1,
            'a resource id names one icon');
        assert.equal(await call.handler([m.put('C:\\work\\gone.dll', wide), 0, 0x800, 0, 1]),
            0);
        assert.equal(call.argBytes, 20);
    }
    assert.equal(m.shell.ExtractIconEx, m.shell.ExtractIconExA, 'the bare name is the ANSI one');
});

test('ExtractAssociatedIconEx gives the file\'s own icon and its id, or NULL', async()=>{
    const m = await shellOver({ 'C:\\work\\icons.dll': libraryWithIcons(),
        'C:\\work\\readme.txt': new Uint8Array(0) });
    const view = new DataView(m.memory.buffer);
    view.setUint16(0x900, 1, true);
    view.setUint16(0x902, 0xcaca, true);
    const name = m.put('C:\\work\\icons.dll', true);
    assert.equal(await m.shell.ExtractAssociatedIconExW.handler([0, name, 0x900, 0x902]), 0x4001);
    assert.equal(view.getUint16(0x902, true), 7, 'the group\'s resource id');
    assert.deepEqual([...m.made[0].bgra.subarray(0, 4)], [0xff, 0, 0, 0xff]);
    view.setUint16(0x900, 0, true);
    assert.equal(await m.shell.ExtractAssociatedIconExA.handler([0,
        m.put('C:\\work\\readme.txt', false), 0x900, 0x902]), 0, 'no icon of its own');
    assert.equal(m.diverged.length, 1);
    assert.equal(m.shell.ExtractAssociatedIconExW.argBytes, 16);
});

test('a program\'s icon for a page is its first group\'s largest image, in RGBA', ()=>{
    const icon = programIcon(libraryWithIcons());
    assert.equal(icon?.width, 32);
    assert.equal(icon?.height, 32);
    assert.deepEqual([...icon?.rgba?.subarray(0, 4) ?? []], [0, 0xff, 0, 0xff],
        'the green standard-sized image of MAINICON, not the red one or group 7\'s blue');
});

test('a PNG image in the group is handed over as the file it is', ()=>{
    // 256 by 256, the size a group stores as a PNG since Vista; only the
    // signature and the header's size fields matter here.
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, 1, 0, 0, 0, 1, 0]);
    const small = iconImage(32, RED);
    const bytes = buildImage(buildResources([
        { type: RT_ICON, names: [
            { name: 1, langs: [{ lang: ENGLISH, data: [...small] }] },
            { name: 2, langs: [{ lang: ENGLISH, data: [...png] }] },
        ] },
        { type: RT_GROUP_ICON, names: [{ name: 1, langs: [{ lang: ENGLISH, data: groupDirectory([
            { side: 32, id: 1, length: small.length }, { side: 0, id: 2, length: png.length },
        ]) }] }] },
    ])).bytes;
    const icon = programIcon(bytes);
    assert.deepEqual({ width: icon?.width, height: icon?.height, png: [...icon?.png ?? []] },
        { width: 256, height: 256, png: [...png] });
});

test('bytes that are no image, or an image with no icon, give no program icon', ()=>{
    assert.equal(programIcon(new Uint8Array([1, 2, 3])), null);
    assert.equal(programIcon(buildImage(buildResources([])).bytes), null);
});
