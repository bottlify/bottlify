/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    TKIND_ALIAS, TKIND_COCLASS, TKIND_DISPATCH, TKIND_ENUM, TKIND_INTERFACE, VAR_CONST,
    VT_BSTR, VT_PTR, VT_USERDEFINED, isImport, parseTypeLib, resolveReference,
} from './typelib.js';

/** A library written by a real IDL compiler, kept as an opaque fixture. */
const FIXTURE = new URL('./msft-typelib.bin', import.meta.url);
const library = parseTypeLib(new Uint8Array(readFileSync(FIXTURE)));

test('the header: name, GUID, version, locale, flags and documentation', ()=>{
    assert.equal(library.name, 'ProEngine');
    assert.equal(library.guid, '{94636247-BC39-4B8B-A728-2D1FBEBFA76A}');
    assert.equal(library.lcid, 1033);
    assert.equal(library.sysKind, 1, 'SYS_WIN32');
    assert.deepEqual([library.majorVersion, library.minorVersion], [1, 0]);
    assert.equal(library.flags, 0);
    assert.equal(library.helpString, 'InstallShield Professional Setup Kernel 7.0');
    assert.equal(library.helpFile, null);
    assert.equal(library.typeInfos.length, 162);
});

test('every kind of type the library holds is read, and counted by kind', ()=>{
    const counts = new Map();
    for (const type of library.typeInfos)
    {
        counts.set(type.kind, (counts.get(type.kind) ?? 0) + 1);
    }
    assert.deepEqual([...counts].sort(), [
        [TKIND_ENUM, 28], [TKIND_INTERFACE, 47], [TKIND_DISPATCH, 41],
        [TKIND_COCLASS, 35], [TKIND_ALIAS, 11],
    ].sort());
    assert.deepEqual(library.typeInfos.slice(0, 3).map(type=>[type.name, type.kind]), [
        ['LOGDB_CODES', TKIND_ENUM], ['OPSEQUENCE_CODES', TKIND_ENUM],
        ['OPTYPE_FILE_FIELDS', TKIND_ENUM],
    ]);
});

test('an interface: GUID, flags, vtable size, base, and a function with its parameters', ()=>{
    const type = library.typeInfos[10];
    assert.equal(type.name, 'ISetupBasicFeature');
    assert.equal(type.kind, TKIND_INTERFACE);
    assert.equal(type.guid, '{CC096170-E2CB-11D2-80C8-00104B1F6CEA}');
    assert.equal(type.flags, 0x1190, 'dual, dispatchable, oleautomation, nonextensible');
    assert.equal(type.vtableSize, 140, '7 inherited and 28 own slots');
    assert.equal(type.functions.length, 28);
    assert.equal(type.helpString, 'ISetupBasicFeature Interface');
    assert.deepEqual(type.implementedTypes, [{ hreftype: 13, flags: 0 }]);

    const name = type.functions[0];
    assert.equal(name.name, 'Name');
    assert.equal(name.memberId, 1);
    assert.equal(name.invokeKind, 2, 'INVOKE_PROPERTYGET');
    assert.equal(name.funcKind, 1, 'FUNC_PUREVIRTUAL');
    assert.equal(name.callingConvention, 4, 'CC_STDCALL');
    assert.equal(name.vtableOffset, 28, 'the first slot after IDispatch');
    assert.equal(name.returns.vt, 25, 'VT_HRESULT');
    assert.equal(name.parameters.length, 1);
    assert.equal(name.parameters[0].name, 'pVal');
    assert.equal(name.parameters[0].flags, 0xa, 'out, retval');
    assert.equal(name.parameters[0].type.vt, VT_PTR);
    assert.equal(name.parameters[0].type.element?.vt, VT_BSTR);

    // A pointer to a pointer to a user-defined type, resolved through the
    // type table twice and then to a type of this library.
    const log = type.functions[10];
    assert.equal(log.name, 'Log');
    const target = log.parameters[0].type.element?.element;
    assert.equal(target?.vt, VT_USERDEFINED);
    const referenced = resolveReference(library, target?.hreftype ?? -1);
    assert.ok(referenced && !isImport(referenced));
    assert.equal(referenced.name, 'ISetupFeatureLog');

    // A property put's value is unnamed and passed in.
    const put = type.functions[2];
    assert.equal(put.name, 'DisplayName');
    assert.equal(put.invokeKind, 4, 'INVOKE_PROPERTYPUT');
    assert.deepEqual(put.parameters.map(p=>[p.name, p.type.vt, p.flags]), [[null, VT_BSTR, 1]]);
});

test('an enum: constants with their inline values', ()=>{
    const type = library.typeInfos[1];
    assert.equal(type.name, 'OPSEQUENCE_CODES');
    assert.equal(type.functions.length, 0);
    assert.equal(type.variables.length, 4);
    const first = type.variables[0];
    assert.equal(first.name, 'END_OF_SEQUENCE');
    assert.equal(first.memberId, 0x40000000);
    assert.equal(first.varKind, VAR_CONST);
    assert.equal(first.type.vt, 22, 'VT_INT');
    assert.deepEqual(first.constant, { vt: 3, value: 769 });
    assert.equal(type.variables[3].constant?.value, 772);
});

test('a coclass lists what it implements, in order, with the default marked', ()=>{
    const type = library.typeInfos[27];
    assert.equal(type.name, 'SetupKernel');
    assert.equal(type.kind, TKIND_COCLASS);
    assert.deepEqual(type.implementedTypes.map(entry=>[
        /** @type {any} */ (resolveReference(library, entry.hreftype)).name, entry.flags,
    ]), [['ISetupMedia', 1], ['ISetupMedia2', 0], ['ISetupMedia3', 0],
        ['ISetupServiceProvider', 0]]);
});

test('an alias stands for another type', ()=>{
    const type = library.typeInfos[20];
    assert.equal(type.name, 'SizeFlags');
    assert.equal(type.kind, TKIND_ALIAS);
    assert.equal(type.alias?.vt, VT_USERDEFINED);
    const target = resolveReference(library, type.alias?.hreftype ?? -1);
    assert.equal(/** @type {any} */ (target).name, '__MIDL_ISetupBasicFeature_0001');
});

test('imports name the standard library, by GUID or by index', ()=>{
    assert.equal(library.imports.length, 8);
    const dispatch = resolveReference(library, 13);
    assert.ok(dispatch && isImport(dispatch));
    assert.equal(dispatch.guid, '{00020400-0000-0000-C000-000000000046}');
    assert.equal(dispatch.kind, TKIND_INTERFACE);
    assert.equal(dispatch.library.name, 'stdole2.tlb');
    assert.equal(dispatch.library.guid, '{00020430-0000-0000-C000-000000000046}');
    assert.deepEqual([dispatch.library.majorVersion, dispatch.library.minorVersion], [2, 0]);
    const unknown = resolveReference(library, 1);
    assert.equal(/** @type {any} */ (unknown).guid, '{00000000-0000-0000-C000-000000000046}');
    const byIndex = library.imports[2];
    assert.equal(byIndex.guid, null);
    assert.equal(byIndex.typeIndex, 0);
});

test('a reference that names nothing resolves to nothing', ()=>{
    assert.equal(resolveReference(library, 7), null, 'not a whole type record');
    assert.equal(resolveReference(library, 162 * 0x64), null, 'past the last type');
    assert.equal(resolveReference(library, 0x1001), null, 'no such import');
});

test('a dispinterface stores its own methods with their real vtable slots', ()=>{
    const type = library.typeInfos[33];
    assert.equal(type.name, 'ISetupObjects');
    assert.equal(type.kind, TKIND_DISPATCH);
    assert.deepEqual(type.functions.map(f=>[f.name, f.memberId, f.vtableOffset]), [
        ['Count', 1, 28], ['Item', 0, 32], ['_NewEnum', -4, 36], ['Add', 20, 40],
    ]);
});

test('bytes that are not a library are refused, not misread', ()=>{
    assert.throws(()=>parseTypeLib(new Uint8Array(16)), /not an MSFT type library/);
    assert.throws(()=>parseTypeLib(Uint8Array.from([0x4d, 0x53, 0x46, 0x54, 1, 2, 3])),
        /not an MSFT type library/);
    const truncated = new Uint8Array(readFileSync(FIXTURE)).subarray(0, 0x400);
    assert.throws(()=>parseTypeLib(truncated));
});
