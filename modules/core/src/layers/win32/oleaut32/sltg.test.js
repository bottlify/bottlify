/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGuid } from '../ole32/guid.js';
import { parseTypeLibrary } from './sltg.js';

const LIBRARY_GUID = '{91814EB1-B5F0-11D2-80B9-00104B1F6CEA}';
const TYPE_GUID = '{91814EB2-B5F0-11D2-80B9-00104B1F6CEA}';

/** Little-endian bytes, appended in order. */
function writer(){
    /** @type {number[]} */
    const bytes = [];
    const self = {
        bytes,
        /** @param {number} value */
        u8(value){
            bytes.push(value & 0xff);
            return self;
        },
        /** @param {number} value */
        u16(value){
            return self.u8(value).u8(value >> 8);
        },
        /** @param {number} value */
        u32(value){
            return self.u16(value).u16(value >>> 16);
        },
        /** @param {string} text */
        ascii(text){
            for (const character of text)
            {
                self.u8(character.charCodeAt(0));
            }
            return self;
        },
        /** @param {string} guid */
        guid(guid){
            bytes.push(.../** @type {Uint8Array} */ (parseGuid(guid)));
            return self;
        },
        /** @param {number} count @param {number} value */
        fill(count, value){
            for (let index = 0; index < count; index++)
            {
                self.u8(value);
            }
            return self;
        },
    };
    return self;
}

/**
 * The smallest SLTG library of one interface with one method,
 * `HRESULT Frob([in] long value)`, laid out as the tools write it.
 */
function oneInterface(){
    // A parameter's name is at an even offset: its low bit is a flag.
    const names = 'Things\0IThing\0Frob\0\0value\0';
    const nameOf = (/** @type {string} */ name)=>names.indexOf(`${name}\0`);

    // The type block: its header, the member header, one function and its
    // one parameter, then the tail.
    const members = writer()
        .u8(0x4c).u8(0x12).u16(0xffff).u16(nameOf('Frob')).u32(0x60020000)
        .u16(0xfffe).u16(0xffff).u16(22).u8((1 << 3) | 4).u8(0x80).u16(25).u16(12)
        .u16(nameOf('value') | 1).u16(3);
    const tail = writer().u16(1).u16(0).u16(0).u16(0).u16(0).u16(0xffff).u16(0xffff)
        .u16(members.bytes.length).u16(0).u16(0).u16(0).u16(0xffff).u16(0).u16(0).u16(0).u16(0)
        .u16(4).u16(4).u16(0).u16(0).u16(16).u16(0xffff).u16(0xffff).u16(0xffff).u16(0xffff)
        .u16(0).u16(0);
    const block = writer().u16(0x0501).u32(0xffffffff).u32(0xffffffff).u32(0x22).u32(0xffffffff)
        .u16(1).u16(0).u32(0xfffe0000).u8(0x02).u8(0).u8(0x02).u8(3).u32(0)
        .u16(1).u16(0xffff).u8(1).u32(members.bytes.length);
    block.bytes.push(...members.bytes, ...tail.bytes);

    // The library block, its type records, and the name table past the fixed jump.
    const library = writer().u16(0x51cc).u16(3).u16(nameOf('Things')).u16(0xffff).u16(0xffff)
        .u16(0xffff).u32(0).u16(1).u16(0x409).u32(0).u16(0).u16(2).u16(1).guid(LIBRARY_GUID)
        .fill(0x40, 0xff).u16(1)
        .u16(10).ascii('AAAAAAAAAA').u16(0xffff).u16(0xffff).u16(nameOf('IThing')).u16(0)
        .u16(0xffff).u32(0).u16(0xffff).guid(TYPE_GUID).u16(3);
    const tableAt = library.bytes.length + 4;
    library.u32(tableAt).u16(0xffff).fill(0x214, 0).u16(0).ascii(names);

    const file = writer().ascii('SLTG').u16(3).u16(9).u16(0).u16(1)
        .u32(0x000204ff).u32(0).u32(0xc0).u32(0x46000000).u32(0x44).u32(0xffff0000)
        .u32(block.bytes.length).u16(0).u16(2)
        .u32(library.bytes.length).u16(0).u16(0)
        .u8(1).ascii('CompObj\0dir\0').ascii('AAAAAAAAAA\0').fill(9, 0);
    file.bytes.push(...block.bytes, ...library.bytes);
    return Uint8Array.from(file.bytes);
}

test('an SLTG library reads into the description an MSFT one does', ()=>{
    const library = parseTypeLibrary(oneInterface());
    assert.equal(library.name, 'Things');
    assert.equal(library.guid, LIBRARY_GUID);
    assert.deepEqual([library.majorVersion, library.minorVersion, library.sysKind], [2, 1, 1]);
    assert.equal(library.typeInfos.length, 1);

    const [type] = library.typeInfos;
    assert.equal(type.name, 'IThing');
    assert.equal(type.guid, TYPE_GUID);
    assert.equal(type.kind, 3, 'TKIND_INTERFACE');
    assert.equal(type.hreftype, 0, 'numbered as the MSFT reader numbers a type');
    assert.equal(type.vtableSize, 16);

    const [frob] = type.functions;
    assert.equal(frob.name, 'Frob');
    assert.equal(frob.memberId, 0x60020000);
    assert.equal(frob.vtableOffset, 12);
    assert.equal(frob.callingConvention, 4, 'CC_STDCALL');
    assert.equal(frob.returns.vt, 25, 'HRESULT');
    const parameters = frob.parameters.map(parameter=>
        [parameter.name, parameter.type.vt, parameter.flags]);
    assert.deepEqual(parameters, [['value', 3, 1]], 'a long, [in]');
});

test('bytes of neither format are refused', ()=>{
    assert.throws(()=>parseTypeLibrary(new Uint8Array(64)), /not an MSFT type library/);
});
