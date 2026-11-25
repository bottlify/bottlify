/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsdmoFunctions, listDmos } from './functions.js';
import { formatGuid, parseGuid } from '../../../system/guid.js';

const DMO = '{77777777-0000-0000-0000-000000000000}';
const OTHER = '{88888888-0000-0000-0000-000000000000}';
const AUDIO_DECODER = '{57F2DB8B-E6BB-4513-9D43-DCD2A6593125}';
const VIDEO_DECODER = '{4A69B442-28BE-4991-969C-B500ADF5D8A8}';
const AUDIO = '{73647561-0000-0010-8000-00AA00389B71}';
const PCM = '{00000001-0000-0010-8000-00AA00389B71}';
const VIDEO = '{73646976-0000-0010-8000-00AA00389B71}';
const NULL = '{00000000-0000-0000-0000-000000000000}';

/** A flat memory, a registry kept as paths, and objects called by method name. */
function machine(){
    const memory = new Uint8Array(1 << 16);
    let next = 0x1000;
    /** @type {Map<string, Map<string, Uint8Array>>} */
    const keys = new Map();
    /** @param {string} path */
    const fold = path=>path.toUpperCase();
    /** @type {any[]} */
    const objects = [];
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>memory.slice(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>memory.set(bytes, at),
        readWideString: (/** @type {number} */ at)=>{
            let text = '';
            for (let i = at; memory[i] | memory[i + 1]; i += 2)
            {
                text += String.fromCharCode(memory[i] | memory[i + 1] << 8);
            }
            return text;
        },
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes + 15 & ~15;
            return at;
        },
        free: ()=>{},
        publish: (/** @type {any} */ object)=>{
            objects.push(object);
            return objects.length;
        },
        registry: {
            exists: (/** @type {string} */ path)=>keys.has(fold(path)),
            subkeys: (/** @type {string} */ path)=>{
                const prefix = `${fold(path)}\\`;
                return [...new Set([...keys.keys()].filter(key=>key.startsWith(prefix))
                    .map(key=>key.slice(prefix.length).split('\\')[0]))];
            },
            get: (/** @type {string} */ path, /** @type {string} */ name)=>
                keys.get(fold(path))?.get(name) ?? null,
            set: (/** @type {string} */ path, /** @type {string} */ name, /** @type {Uint8Array} */ data)=>{
                keys.get(fold(path))?.set(name, data);
            },
            create: (/** @type {string} */ path)=>{
                const parts = path.split('\\');
                for (let i = 1; i <= parts.length; i++)
                {
                    const key = fold(parts.slice(0, i).join('\\'));
                    if (!keys.has(key))
                    {
                        keys.set(key, new Map());
                    }
                }
            },
            remove: (/** @type {string} */ path)=>{
                for (const key of [...keys.keys()])
                {
                    if (key === fold(path) || key.startsWith(`${fold(path)}\\`))
                    {
                        keys.delete(key);
                    }
                }
            },
        },
    };
    const functions = createMsdmoFunctions(host);
    /** @param {string} text */
    const guid = text=>{
        const at = host.allocate(16);
        memory.set(/** @type {Uint8Array} */ (parseGuid(text)), at);
        return at;
    };
    /** @param {string} text */
    const wide = text=>{
        const at = host.allocate(text.length * 2 + 2);
        [...text].forEach((ch, i)=>{
            memory[at + i * 2] = ch.charCodeAt(0);
        });
        return at;
    };
    /** @param {[string, string][]} list */
    const pairs = list=>{
        const at = host.allocate(list.length * 32);
        list.forEach(([type, subtype], i)=>{
            memory.set(/** @type {Uint8Array} */ (parseGuid(type)), at + i * 32);
            memory.set(/** @type {Uint8Array} */ (parseGuid(subtype)), at + i * 32 + 16);
        });
        return at;
    };
    const u32 = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    /** @param {number} pointer @param {string} method @param {number[]} args */
    const invoke = (pointer, method, args)=>objects[pointer - 1].interfaceFor(
        '{2C3CD98A-2BFA-4A53-9C27-5249BA64BA0F}').methods.find((/** @type {any} */ m)=>
        m.name === method).invoke(objects[pointer - 1], args);
    return { host, functions, guid, wide, pairs, u32, invoke, memory };
}

test('a DMO registered is found by its category and types, named, and gone once unregistered', ()=>{
    const m = machine();
    const f = m.functions;
    const types = m.pairs([[AUDIO, PCM]]);
    assert.equal(f.DMORegister.handler([m.wide('dmo test'), m.guid(DMO), m.guid(AUDIO_DECODER),
        0, 1, types, 1, types]), 0);
    assert.equal(f.DMORegister.handler([m.wide('video'), m.guid(OTHER), m.guid(VIDEO_DECODER),
        0, 0, 0, 0, 0]), 0);
    assert.equal(f.DMORegister.handler([m.wide('nowhere'), m.guid(OTHER), m.guid(NULL),
        0, 0, 0, 0, 0]), 0x80070057 | 0, 'GUID_NULL names no category to be in');

    /** @param {string} category @param {[string, string][]} wanted */
    const enumerate = (category, wanted)=>{
        const out = m.host.allocate(4);
        assert.equal(f.DMOEnum.handler([m.guid(category), 0, wanted.length,
            wanted.length ? m.pairs(wanted) : 0, 0, 0, out]), 0);
        const clsids = m.host.allocate(16 * 4);
        const fetched = m.host.allocate(4);
        m.invoke(m.u32(out), 'Next', [4, clsids, 0, fetched]);
        return Array.from({ length: m.u32(fetched) },
            (_, i)=>formatGuid(m.memory.slice(clsids + i * 16, clsids + i * 16 + 16)));
    };
    assert.deepEqual(enumerate(AUDIO_DECODER, []), [DMO]);
    assert.deepEqual(enumerate(NULL, []).sort(), [DMO, OTHER].sort(),
        'GUID_NULL is every category');
    assert.deepEqual(enumerate(NULL, [[AUDIO, NULL]]), [DMO], 'a wildcard subtype matches');
    assert.deepEqual(enumerate(NULL, [[VIDEO, NULL]]), []);

    const name = m.host.allocate(160);
    assert.equal(f.DMOGetName.handler([m.guid(DMO), name]), 0);
    assert.equal(m.host.readWideString(name), 'dmo test');

    const inGiven = m.host.allocate(4);
    const outGiven = m.host.allocate(4);
    const inTypes = m.host.allocate(64);
    assert.equal(f.DMOGetTypes.handler([m.guid(DMO), 2, inGiven, inTypes, 0, outGiven, 0]), 0);
    assert.equal(m.u32(inGiven), 1);
    assert.equal(m.u32(outGiven), 0, 'none asked, none written');
    assert.equal(formatGuid(m.memory.slice(inTypes + 16, inTypes + 32)), PCM);

    assert.equal(listDmos(m.host.registry).find(dmo=>dmo.clsid === DMO)?.category, AUDIO_DECODER);

    assert.equal(f.DMOUnregister.handler([m.guid(DMO), m.guid(AUDIO_DECODER)]), 0);
    assert.equal(f.DMOUnregister.handler([m.guid(DMO), m.guid(AUDIO_DECODER)]), 1,
        'S_FALSE: it was not there');
    assert.deepEqual(enumerate(NULL, []), [OTHER]);
    assert.equal(m.host.registry.exists(`DirectShow\\MediaObjects\\${DMO}`), false,
        'out of its last category, its own key goes');
});

test('the media type helpers keep a format block in task memory beside the type', ()=>{
    const m = machine();
    const f = m.functions;
    const out = m.host.allocate(4);
    assert.equal(f.MoCreateMediaType.handler([out, 20]), 0);
    const type = m.u32(out);
    assert.equal(m.u32(type + 0x40), 20);
    const format = m.u32(type + 0x44);
    assert.notEqual(format, 0);
    m.memory[format] = 0x5a;
    const copy = m.host.allocate(4);
    assert.equal(f.MoDuplicateMediaType.handler([copy, type]), 0);
    const duplicate = m.u32(copy);
    assert.notEqual(m.u32(duplicate + 0x44), format, 'the copy has a block of its own');
    assert.equal(m.memory[m.u32(duplicate + 0x44)], 0x5a);
    assert.equal(f.MoFreeMediaType.handler([duplicate]), 0);
    assert.equal(m.u32(duplicate + 0x44), 0, 'the format pointer is cleared with its block');
    assert.equal(f.MoInitMediaType.handler([0, 0]), 0x80004003 | 0);
});
