/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePe } from './pe.js';
import { findResource, listResources, loadString, RT_STRING, UI_LANGUAGE } from './resources.js';

/**
 * Where the resource section is mapped, and where its bytes are in the file.
 *
 * The two deliberately differ. An RVA and a directory-relative offset are then
 * different numbers for the same resource, which is the whole point: a reader
 * that confuses them lands somewhere else, and with the two equal it would land
 * in the right place by accident and prove nothing.
 */
const RSRC_RVA = 0x1000;
const RSRC_FILE = 0x200;

/**
 * Lays out a resource directory from a description of it.
 *
 * Hand-writing six of these would be six hundred lines of magic offsets that
 * nobody could check against the assertions; this is the smaller half of that
 * trade, and the assertions below name what it laid out rather than where.
 *
 * @param {{ type: number | string,
 *           names: { name: number | string,
 *                    langs: { lang: number, data: number[] }[] }[] }[]} types
 */
function buildResources(types){
    let at = 16 + types.length * 8;

    const typeNodes = types.map(type=>{
        const node = at;
        at += 16 + type.names.length * 8;
        return node;
    });
    const nameNodes = types.map(type=>type.names.map(name=>{
        const node = at;
        at += 16 + name.langs.length * 8;
        return node;
    }));
    const leaves = types.map(type=>type.names.map(name=>name.langs.map(()=>{
        const node = at;
        at += 16;
        return node;
    })));

    /** @type {Map<string, number>} */
    const strings = new Map();
    const intern = (/** @type {number | string} */ key)=>{
        if (typeof key !== 'string' || strings.has(key))
        {
            return;
        }
        strings.set(key, at);
        at += 2 + key.length * 2;
    };
    for (const type of types)
    {
        intern(type.type);
        for (const name of type.names)
        {
            intern(name.name);
        }
    }

    at = at + 3 & ~3;
    const payloads = types.map(type=>type.names.map(name=>name.langs.map(lang=>{
        const node = at;
        at += lang.data.length + 3 & ~3;
        return node;
    })));

    const bytes = new Uint8Array(at);
    const view = new DataView(bytes.buffer);

    /** @param {number} node @param {any[]} entries */
    const writeDirectory = (node, entries)=>{
        const named = entries.filter(entry=>typeof entry.key === 'string');
        const ids = entries.filter(entry=>typeof entry.key === 'number');
        view.setUint16(node + 12, named.length, true);
        view.setUint16(node + 14, ids.length, true);
        [...named, ...ids].forEach((entry, index)=>{
            const at_ = node + 16 + index * 8;
            view.setUint32(at_, typeof entry.key === 'string'
                ? /** @type {number} */ (strings.get(entry.key)) | 0x80000000
                : entry.key, true);
            view.setUint32(at_ + 4,
                entry.directory ? entry.offset | 0x80000000 : entry.offset, true);
        });
    };

    writeDirectory(0, types.map((type, index)=>(
        { key: type.type, directory: true, offset: typeNodes[index] })));

    types.forEach((type, ti)=>{
        writeDirectory(typeNodes[ti], type.names.map((name, ni)=>(
            { key: name.name, directory: true, offset: nameNodes[ti][ni] })));

        type.names.forEach((name, ni)=>{
            writeDirectory(nameNodes[ti][ni], name.langs.map((lang, li)=>(
                { key: lang.lang, directory: false, offset: leaves[ti][ni][li] })));

            name.langs.forEach((lang, li)=>{
                // OffsetToData is an RVA. Every other offset here is measured
                // from the directory's own start.
                view.setUint32(leaves[ti][ni][li], RSRC_RVA + payloads[ti][ni][li], true);
                view.setUint32(leaves[ti][ni][li] + 4, lang.data.length, true);
                view.setUint32(leaves[ti][ni][li] + 8, 1252, true);
                bytes.set(lang.data, payloads[ti][ni][li]);
            });
        });
    });

    for (const [text, offset] of strings)
    {
        view.setUint16(offset, text.length, true);
        for (let unit = 0; unit < text.length; unit++)
        {
            view.setUint16(offset + 2 + unit * 2, text.charCodeAt(unit), true);
        }
    }

    return bytes;
}

/**
 * A PE32 image whose only section is the resource blob.
 *
 * @param {Uint8Array} rsrc
 */
function buildImage(rsrc){
    const SECTION_TABLE = 0x178;
    const bytes = new Uint8Array(RSRC_FILE + rsrc.length);
    const view = new DataView(bytes.buffer);

    view.setUint16(0, 0x5a4d, true); //         "MZ"
    view.setUint32(0x3c, 0x80, true); //        e_lfanew
    view.setUint32(0x80, 0x00004550, true); //  "PE\0\0"
    view.setUint16(0x84, 0x014c, true); //      i386
    view.setUint16(0x86, 1, true); //           one section
    view.setUint16(0x94, 224, true); //         optional header size
    view.setUint16(0x98, 0x010b, true); //      PE32
    view.setUint32(0x98 + 28, 0x00400000, true); // ImageBase
    view.setUint32(0x98 + 32, 0x1000, true); //     SectionAlignment
    view.setUint32(0x98 + 56, 0x2000, true); //     SizeOfImage
    view.setUint32(0x98 + 60, RSRC_FILE, true); //  SizeOfHeaders
    view.setUint32(0x98 + 92, 16, true); //         NumberOfRvaAndSizes
    view.setUint32(0x98 + 96 + 2 * 8, RSRC_RVA, true); //     directory[2].rva
    view.setUint32(0x98 + 96 + 2 * 8 + 4, rsrc.length, true); // directory[2].size

    bytes.set(new TextEncoder().encode('.rsrc'), SECTION_TABLE);
    view.setUint32(SECTION_TABLE + 8, rsrc.length, true); //  VirtualSize
    view.setUint32(SECTION_TABLE + 12, RSRC_RVA, true); //    VirtualAddress
    view.setUint32(SECTION_TABLE + 16, rsrc.length, true); // SizeOfRawData
    view.setUint32(SECTION_TABLE + 20, RSRC_FILE, true); //   PointerToRawData

    bytes.set(rsrc, RSRC_FILE);
    return { bytes, image: parsePe(bytes) };
}

/**
 * A string bundle: sixteen slots, each a code-unit count then that many units.
 *
 * @param {string[]} strings
 */
function bundle(strings){
    /** @type {number[]} */
    const out = [];
    for (let slot = 0; slot < 16; slot++)
    {
        const text = strings[slot] ?? '';
        out.push(text.length & 0xff, text.length >> 8 & 0xff);
        for (const unit of text)
        {
            out.push(unit.charCodeAt(0) & 0xff, unit.charCodeAt(0) >> 8 & 0xff);
        }
    }
    return out;
}

const bytesOf = (/** @type {string} */ text)=>[...text].map(one=>one.charCodeAt(0));

test('a resource is found by type and name, both by id', ()=>{
    const { bytes, image } = buildImage(buildResources([
        { type: 2, names: [{ name: 101, langs: [{ lang: 0x409, data: [1, 2, 3, 4] }] }] },
    ]));

    const found = findResource(bytes, image, 2, 101);
    assert.ok(found, 'the bitmap is there');
    assert.equal(found.size, 4);
    assert.equal(found.language, 0x409, 'and it reports the language it was tagged with');
});

test('the leaf offset is an RVA, unlike every other offset in the tree', ()=>{
    // The one asymmetry in this format. Read as directory-relative it lands
    // inside the directory and hands back a piece of the tree as the resource,
    // which is why the section here is mapped somewhere other than its file
    // offset -- with the two equal, a reader could confuse them and still be
    // right by accident.
    const payload = bytesOf('PAYLOAD!');
    const { bytes, image } = buildImage(buildResources([
        { type: 10, names: [{ name: 1, langs: [{ lang: 0, data: payload }] }] },
    ]));

    const found = findResource(bytes, image, 10, 1);
    assert.ok(found);
    assert.ok(found.rva >= RSRC_RVA, 'the address is relative to the image, not the directory');

    // Follow it the way a caller would, through the section mapping.
    const at = RSRC_FILE + (found.rva - RSRC_RVA);
    assert.equal(new TextDecoder().decode(bytes.subarray(at, at + found.size)), 'PAYLOAD!');
});

test('a named entry is a counted string, not a terminated one', ()=>{
    // Read as a C string it runs into whatever was laid out next, which is
    // usually another name, and the lookup then matches nothing.
    const { bytes, image } = buildImage(buildResources([
        {
            type: 'CUSTOMTYPE',
            names: [{ name: 'THENAME', langs: [{ lang: 0, data: [7] }] }],
        },
        { type: 24, names: [{ name: 'OTHER', langs: [{ lang: 0, data: [8] }] }] },
    ]));

    const found = findResource(bytes, image, 'CUSTOMTYPE', 'THENAME');
    assert.ok(found, 'a named type and a named resource both resolve');
    assert.equal(found.size, 1);

    assert.ok(findResource(bytes, image, 'customtype', 'thename'),
        'and names match without regard to case, as the API promises');
});

test('a string is read out of the bundle of sixteen it shares', ()=>{
    // Bundle id is (id >> 4) + 1, and the slot is the low four bits. The +1 is
    // the part that is silently wrong: without it every lookup finds the bundle
    // below and returns a string sixteen identifiers away.
    const { bytes, image } = buildImage(buildResources([
        {
            type: RT_STRING,
            names: [
                { name: 1, langs: [{ lang: 0x409, data: bundle(['zero', 'one', 'two']) }] },
                { name: 3, langs: [{ lang: 0x409, data: bundle([]) }] },
            ],
        },
    ]));

    // Bundle 1 holds identifiers 0..15, so identifier 2 is its third slot.
    assert.equal(loadString(bytes, image, 2), 'two');
    assert.equal(loadString(bytes, image, 0), 'zero');
    assert.equal(loadString(bytes, image, 1), 'one');
});

test('a slot with no string is absent, not empty', ()=>{
    // How a gap in a range of identifiers is stored. The bundle exists, so a
    // reader that only checks for the bundle reports success and writes nothing.
    const { bytes, image } = buildImage(buildResources([
        {
            type: RT_STRING,
            names: [{ name: 1, langs: [{ lang: 0, data: bundle(['zero', '', 'two']) }] }],
        },
    ]));

    assert.equal(loadString(bytes, image, 0), 'zero');
    assert.equal(loadString(bytes, image, 1), null, 'the empty slot holds no string');
    assert.equal(loadString(bytes, image, 2), 'two', 'and the walk carries on past it');
});

test('a bundle that does not exist is not an error', ()=>{
    const { bytes, image } = buildImage(buildResources([
        { type: RT_STRING, names: [{ name: 1, langs: [{ lang: 0, data: bundle(['zero']) }] }] },
    ]));

    // Identifier 4096 wants bundle 257, which was never laid out.
    assert.equal(loadString(bytes, image, 4096), null);
});

test('a type the image does not carry is absent', ()=>{
    const { bytes, image } = buildImage(buildResources([
        { type: 2, names: [{ name: 1, langs: [{ lang: 0, data: [1] }] }] },
    ]));

    assert.equal(findResource(bytes, image, 3, 1), null, 'no icons here');
    assert.equal(findResource(bytes, image, 2, 999), null, 'and no bitmap by that name');
});

test('an image with no resource directory carries nothing', ()=>{
    const { bytes, image } = buildImage(buildResources([
        { type: 2, names: [{ name: 1, langs: [{ lang: 0, data: [1] }] }] },
    ]));
    const without = { ...image, directories: image.directories.map(()=>({ address: 0, size: 0 })) };

    assert.equal(findResource(bytes, without, 2, 1), null);
    assert.equal(loadString(bytes, without, 0), null);
    assert.deepEqual(listResources(bytes, without), []);
});

test('a specific language is honoured, and only that one', ()=>{
    // Wine's kernel32 resource tests, test_find_resource: FindResourceEx for a
    // language the resource is not in is ERROR_RESOURCE_LANG_NOT_FOUND, even
    // when the language is English.
    const { bytes, image } = buildImage(buildResources([
        {
            type: 10,
            names: [{
                name: 1,
                langs: [
                    { lang: 0x407, data: bytesOf('de') },
                    { lang: 0x409, data: bytesOf('en') },
                ],
            }],
        },
    ]));

    assert.equal(findResource(bytes, image, 10, 1, 0x409)?.language, 0x409);
    assert.equal(findResource(bytes, image, 10, 1, 0x407)?.language, 0x407);
    assert.equal(findResource(bytes, image, 10, 1, 0x419), null, 'and one absent is absent');
    const german = buildImage(buildResources([
        { type: 4, names: [{ name: 1, langs: [{ lang: 0x407, data: bytesOf('de') }] }] },
    ]));
    assert.equal(findResource(german.bytes, german.image, 4, 1, 0x409), null);
});

/**
 * An RCDATA resource 1 in each of the languages given, in the ascending order
 * a resource compiler lays them out in.
 *
 * @param {number[]} languages
 */
const inLanguages = languages=>buildImage(buildResources([{
    type: 10,
    names: [{ name: 1, langs: [...languages].sort((a, b)=>a - b)
        .map(lang=>({ lang, data: [lang & 0xff, lang >> 8] })) }],
}]));

test('a lookup naming no language takes the user interface\'s, not the first there is', ()=>{
    // Fifteen languages side by side, as a multilingual installer carries its
    // dialogs, and Traditional Chinese (0x404) sorts before US English.
    const { bytes, image } = inLanguages([0x404, 0x405, 0x407, 0x409, 0x40c, 0x411, 0x804]);
    assert.equal(UI_LANGUAGE, 0x409);
    assert.equal(findResource(bytes, image, 10, 1)?.language, 0x409);
    // Wine's kernel32 resource tests: LANG_NEUTRAL with SUBLANG_NEUTRAL is the
    // same search, and a resource in one language alone is still found by it.
    const only = inLanguages([0x407]);
    assert.equal(findResource(only.bytes, only.image, 10, 1)?.language, 0x407);
});

test('with the user interface\'s language absent the neutral search goes on in order', ()=>{
    // Its primary language with no sublanguage, then LANG_NEUTRAL with
    // SUBLANG_NEUTRAL and with SUBLANG_DEFAULT, then English, and only
    // then the first entry.
    const GERMAN = 0x407;
    /** @param {number[]} languages */
    const chosen = languages=>{
        const { bytes, image } = inLanguages(languages);
        return findResource(bytes, image, 10, 1, null, GERMAN)?.language;
    };
    assert.equal(chosen([0x000, 0x007, 0x404, 0x407, 0x409]), 0x407, 'the language itself');
    assert.equal(chosen([0x000, 0x007, 0x404, 0x409, 0x807]), 0x007, 'its primary, neutral');
    assert.equal(chosen([0x000, 0x400, 0x404, 0x409, 0x807]), 0x000, 'LANG_NEUTRAL');
    assert.equal(chosen([0x400, 0x404, 0x409, 0x807]), 0x400, 'the user default');
    assert.equal(chosen([0x404, 0x409, 0x807]), 0x409, 'English');
    assert.equal(chosen([0x404, 0x807]), 0x404, 'and at last the first');
});

test('a string is read in the user interface\'s language when none is named', ()=>{
    const { bytes, image } = buildImage(buildResources([{
        type: RT_STRING,
        names: [{ name: 1, langs: [
            { lang: 0x404, data: bundle(['\u4e2d']) },
            { lang: 0x409, data: bundle(['English']) },
        ] }],
    }]));
    assert.equal(loadString(bytes, image, 0), 'English');
    assert.equal(loadString(bytes, image, 0, 0x404), '\u4e2d');
});

test('a listing says what an image actually carries', ()=>{
    const { bytes, image } = buildImage(buildResources([
        { type: 2, names: [{ name: 101, langs: [{ lang: 0x409, data: [1, 2] }] }] },
        {
            type: RT_STRING,
            names: [
                { name: 1, langs: [{ lang: 0x409, data: bundle(['a']) }] },
                { name: 2, langs: [{ lang: 0x409, data: bundle(['b']) }] },
            ],
        },
    ]));

    const listed = listResources(bytes, image);
    assert.equal(listed.length, 3);
    assert.deepEqual(listed.map(one=>one.typeName), ['BITMAP', 'STRING', 'STRING']);
    assert.deepEqual(listed.map(one=>one.name), [101, 1, 2]);
    assert.equal(listed[0].size, 2);
});
