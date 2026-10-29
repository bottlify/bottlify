/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReference } from './typelib.js';
import { STDOLE2, STDOLE_GUID, isStdole } from './stdole.js';

/** @param {string} name */
const typeNamed = name=>STDOLE2.typeInfos.find(type=>type.name === name);

test('stdole2 is OLE Automation 2.0, its types in the order the compiler lays them out', ()=>{
    assert.deepEqual([STDOLE2.name, STDOLE2.guid, STDOLE2.majorVersion, STDOLE2.minorVersion,
        STDOLE2.helpString], ['stdole', STDOLE_GUID, 2, 0, 'OLE Automation']);
    assert.deepEqual(STDOLE2.typeInfos.slice(0, 6).map(type=>type.name),
        ['GUID', 'DISPPARAMS', 'EXCEPINFO', 'IUnknown', 'IDispatch', 'IEnumVARIANT']);
    STDOLE2.typeInfos.forEach((type, index)=>{
        assert.equal(type.index, index);
        assert.equal(resolveReference(STDOLE2, type.hreftype), type, `${type.name} resolves`);
    });
});

test('every type stdole2 refers to is one of its own', ()=>{
    /** @param {import('./typelib.js').TypeDescription | null} described */
    const check = described=>{
        if (!described)
        {
            return;
        }
        if (described.vt === 29)
        {
            assert.ok(resolveReference(STDOLE2, described.hreftype));
        }
        check(described.element);
        check(described.array?.element ?? null);
    };
    for (const type of STDOLE2.typeInfos)
    {
        type.implementedTypes.forEach(implemented=>
            assert.ok(resolveReference(STDOLE2, implemented.hreftype), type.name));
        check(type.alias);
        type.functions.forEach(fn=>{
            check(fn.returns);
            fn.parameters.forEach(parameter=>check(parameter.type));
        });
        type.variables.forEach(variable=>check(variable.type));
    }
});

test('IFont numbers its methods after IUnknown, a property\'s get and put sharing one id', ()=>{
    const font = /** @type {import('./typelib.js').TypeInfoDescription} */ (typeNamed('IFont'));
    assert.equal(font.guid, '{BEF6E002-A874-101A-8BBA-00AA00300CAB}');
    const [getName, putName, getSize] = font.functions;
    assert.deepEqual([getName.memberId, putName.memberId, getSize.memberId],
        [0x60010000, 0x60010000, 0x60010001]);
    assert.deepEqual([getName.invokeKind, putName.invokeKind], [2, 4]);
    assert.equal(getName.vtableOffset, 12);
    assert.equal(font.vtableSize, 12 + font.functions.length * 4);
    const dispatch = /** @type {any} */ (typeNamed('Font'));
    assert.deepEqual(dispatch.variables.map((/** @type {any} */ v)=>[v.name, v.memberId]),
        [['Name', 0], ['Size', 2], ['Bold', 3], ['Italic', 4], ['Underline', 5],
            ['Strikethrough', 6], ['Weight', 7], ['Charset', 8]], 'olectl.h\'s DISPID_FONT_*');
    const coclass = /** @type {any} */ (typeNamed('StdFont'));
    assert.equal(coclass.guid, '{0BE35203-8F91-11CE-9DE3-00AA004BB851}');
    assert.equal(resolveReference(STDOLE2, coclass.implementedTypes[0].hreftype), dispatch);
});

test('stdole2.tlb is known by its file name, with or without a directory', ()=>{
    assert.ok(isStdole('stdole2.tlb'));
    assert.ok(isStdole('C:\\Windows\\System32\\STDOLE2.TLB'));
    assert.ok(!isStdole('mystdole2.tlb'));
    assert.ok(!isStdole('stdole32.tlb'));
});
