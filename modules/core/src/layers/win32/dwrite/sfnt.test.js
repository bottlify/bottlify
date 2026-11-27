/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FACE_TYPE, FILE_TYPE, FontFormatError, analyzeFile, characterMapOf, glyphsOf,
    metricsOf, nameTable, namesOf, openTypeTag, pack, styleOf, tablesOf, tagText,
    writeSfnt } from './sfnt.js';
import { SYSTEM_FAMILIES, createSystemFace } from './system.js';

const NO_ENGINE = { metrics: ()=>null, textWidth: ()=>null, glyph: ()=>null };
const arial = SYSTEM_FAMILIES.find(family=>family.name === 'Arial');

test('a written file reads back: its kind, its tables, their tags', ()=>{
    const bytes = writeSfnt(new Map([['head', new Uint8Array(54)], ['OS/2', new Uint8Array(4)]]));
    const kind = analyzeFile(bytes);
    assert.equal(kind.fileType, FILE_TYPE.TRUETYPE);
    assert.equal(kind.faceType, FACE_TYPE.TRUETYPE);
    assert.equal(kind.faces.length, 1);
    const tables = tablesOf(bytes, kind.faces[0]);
    assert.deepEqual([...tables.keys()].sort(), ['OS/2', 'head']);
    assert.equal(tables.get('head')?.length, 54);
    assert.equal(tagText(openTypeTag('cmap')), 'cmap', 'a tag as DirectWrite passes it');
    assert.deepEqual(analyzeFile(new Uint8Array(16)).faces, [], 'no font');
    assert.throws(()=>tablesOf(new Uint8Array(8), 0), FontFormatError);
});

test('names and packed fields read back', ()=>{
    const names = namesOf(nameTable([[1, 'Family'], [2, 'Bold']]));
    assert.deepEqual(names.filter(record=>record.platform === 3).map(record=>[record.id,
        record.text]), [[1, 'Family'], [2, 'Bold']]);
    assert.deepEqual([...pack([['u16', 0x102], ['i16', -1], ['u32', 7]])],
        [1, 2, 0xff, 0xff, 0, 0, 0, 7]);
});

test('a system face is a TrueType file the readers agree with', ()=>{
    const font = /** @type {any} */ (arial).fonts[1];
    const face = createSystemFace(font, NO_ENGINE);
    const bytes = face.bytes();
    const kind = analyzeFile(bytes);
    const tables = tablesOf(bytes, kind.faces[0]);
    const metrics = metricsOf(tables);
    assert.equal(metrics.designUnitsPerEm, 2048);
    assert.ok(metrics.ascent > 0 && metrics.descent > 0);
    assert.equal(metrics.lineGap, 0, 'no engine: no external leading measured');
    assert.ok(metrics.underlinePosition < 0 && metrics.strikethroughPosition > 0);
    const cmap = characterMapOf(tables.get('cmap'));
    assert.equal(cmap.lookup(0x41), 0x41, 'a glyph is its character\'s number');
    assert.equal(cmap.lookup(0xd800), 0, 'a surrogate is no glyph');
    assert.equal(cmap.lookup(0x1f600), 0, 'past the Basic Multilingual Plane');
    assert.equal(cmap.symbol, false);
    const glyphs = glyphsOf(tables);
    assert.equal(glyphs.count, 0xffff);
    assert.equal(glyphs.advance(0x41), face.advance(0x41), 'hmtx holds the measured advance');
    assert.deepEqual(styleOf(tables), { weight: 700, stretch: 5, style: 0 });
    assert.equal(face.box(0x20), null, 'a space has no ink');
    assert.ok((face.box(0x41)?.yMax ?? 0) > 0);
});

test('a system face takes the engine\'s measurements where there is one', ()=>{
    const font = /** @type {any} */ (arial).fonts[0];
    /** @type {any[]} */
    const asked = [];
    const face = createSystemFace(font, {
        metrics: request=>(asked.push(request), { ascent: 116, descent: 27, externalLeading: 4,
            aveCharWidth: 50, maxCharWidth: 120 }),
        textWidth: (_, text)=>(text === 'A' ? 85 : 64),
        glyph: ()=>({ advance: 85, left: 1, top: 30, width: 80, height: 86,
            coverage: new Uint8Array(80 * 86) }),
    });
    assert.equal(asked[0].height, -128, 'measured at the probe size');
    assert.equal(face.advance(0x41), 85 * 16);
    const metrics = metricsOf(tablesOf(face.bytes(), analyzeFile(face.bytes()).faces[0]));
    assert.equal(metrics.ascent, 116 * 16);
    assert.equal(metrics.descent, 27 * 16);
    assert.deepEqual(face.box(0x41), { xMin: 16, xMax: 81 * 16, yMax: 86 * 16, yMin: 0 });
});

test('the system families are gdi32\'s outline faces, with the faces Windows ships', ()=>{
    const names = SYSTEM_FAMILIES.map(family=>family.name);
    assert.ok(names.includes('Tahoma') && names.includes('Courier New'));
    assert.ok(!names.includes('MS Sans Serif'), 'a bitmap face is GDI\'s alone');
    assert.equal(SYSTEM_FAMILIES.find(family=>family.name === 'Tahoma')?.fonts.length, 2);
    assert.equal(arial?.fonts.length, 4);
    assert.equal(arial?.fonts[3].path, 'C:\\WINDOWS\\Fonts\\arialbi.ttf');
});
