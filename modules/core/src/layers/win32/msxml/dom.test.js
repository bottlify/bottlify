/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The DOM through its COM interfaces, as a setup engine drives it: a
 * document made by its class, loadXML, the document element and its
 * attributes, selectNodes and getElementsByTagName lists, and the parse
 * error of a document that is not one. Each pointer is answered as the
 * interface its method declares - a program calls an element's methods by
 * slot through what get_documentElement hands back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { DOCUMENT_CLASSES, IID, registerMsxmlClasses } from './dom.js';

const DOCUMENT30 = '{F5078F32-C551-11D3-89B9-0000F81FE221}';
const VT_BSTR = 8;
const VT_NULL = 1;

function harness(){
    const bytes = new Uint8Array(1 << 20);
    const view = new DataView(bytes.buffer);
    let next = 0x1000;
    const allocate = (/** @type {number} */ size)=>{
        const at = next;
        next += (size + 15) & ~15;
        return at;
    };
    /** Each pointer published: its object and the interface it was asked as. */
    /** @type {Map<number, { object: any, iid: string }>} */
    const pointers = new Map();
    /** @type {Map<any, number>} */
    const published = new Map();
    const registry = createComRegistry();
    registerMsxmlClasses({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        readWideString: at=>{
            let text = '';
            for (let i = at; view.getUint16(i, true) !== 0; i += 2)
            {
                text += String.fromCharCode(view.getUint16(i, true));
            }
            return text;
        },
        heap: { allocate, free: ()=>0 },
        registry,
        vtables: {
            publish: (object, iid)=>{
                const record = object.interfaceFor(iid);
                const known = published.get(record);
                if (known)
                {
                    return known;
                }
                const pointer = allocate(16);
                published.set(record, pointer);
                pointers.set(pointer, { object, iid });
                return pointer;
            },
        },
        readFile: async()=>null,
    });
    /** @param {string} text */
    const bstr = text=>{
        const at = allocate(text.length * 2 + 6) + 4;
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
        return at;
    };
    /** @param {number} at */
    const readBstr = at=>{
        let text = '';
        for (let i = at; view.getUint16(i, true) !== 0; i += 2)
        {
            text += String.fromCharCode(view.getUint16(i, true));
        }
        return text;
    };
    /**
     * A method of the interface a pointer was handed out as, by name.
     *
     * @param {number} pointer @param {string} name @param {number[]} args
     */
    const call = (pointer, name, ...args)=>{
        const held = pointers.get(pointer);
        assert.ok(held, `0x${pointer.toString(16)} is a pointer handed out`);
        const method = held.object.interfaceFor(held.iid).methods.find(
            (/** @type {any} */ one)=>one.name === name);
        assert.ok(method, `${name} on ${held.iid}`);
        return method.invoke(held.object, args);
    };
    const out = ()=>allocate(16);
    const document = registry.create(DOCUMENT30);
    assert.ok(document);
    // The document as CoCreateInstance hands it out, asked for IXMLDOMDocument2.
    const documentPointer = allocate(16);
    pointers.set(documentPointer, { object: document, iid: IID.DOCUMENT2 });
    return { bytes, view, bstr, readBstr, call, out, document: documentPointer, pointers,
        u32: (/** @type {number} */ at)=>view.getUint32(at, true) };
}

const XML = '<?xml version="1.0" encoding="utf-16"?>\r\n'
    + '<Setup xmlns="http://schemas.microsoft.com/Setup/2008/01/im" SetupVersion="1.0">'
    + '<LocalizedData><Language LCID="1033"><Text ID="one" LocalizedText="One"/>'
    + '<Text ID="two" LocalizedText="Two"/></Language></LocalizedData>'
    + '<Configuration><BlockIf ID="a"/><BlockIf ID="b"/><Other/></Configuration></Setup>';

test('every DOMDocument class makes a document', ()=>{
    const registry = createComRegistry();
    registerMsxmlClasses(/** @type {any} */ ({ registry, vtables: { publish: ()=>1 } }));
    for (const { clsid } of DOCUMENT_CLASSES)
    {
        assert.ok(registry.create(clsid), clsid);
    }
});

test('a document loads, its element is an IXMLDOMElement whose attributes it reads', ()=>{
    const h = harness();
    const ok = h.out();
    assert.equal(h.call(h.document, 'loadXML', h.bstr(XML), ok), 0);
    assert.equal(h.view.getInt16(ok, true), -1, 'VARIANT_TRUE');
    const element = h.out();
    assert.equal(h.call(h.document, 'get_documentElement', element), 0);
    assert.equal(h.pointers.get(h.u32(element))?.iid, IID.ELEMENT, 'as the method declares');
    const value = h.out();
    assert.equal(h.call(h.u32(element), 'getAttribute', h.bstr('SetupVersion'), value), 0);
    assert.equal(h.view.getUint16(value, true), VT_BSTR);
    assert.equal(h.readBstr(h.u32(value + 8)), '1.0');
    assert.equal(h.call(h.u32(element), 'getAttribute', h.bstr('Nothing'), value), 1, 'S_FALSE');
    assert.equal(h.view.getUint16(value, true), VT_NULL);
});

test('lists by path and by tag name keep their nodes once the name is freed', ()=>{
    const h = harness();
    h.call(h.document, 'loadXML', h.bstr(XML), h.out());
    const list = h.out();
    assert.equal(h.call(h.document, 'selectNodes', h.bstr('//BlockIf[@ID]'), list), 0);
    const length = h.out();
    h.call(h.u32(list), 'get_length', length);
    assert.equal(h.u32(length), 2);

    const language = h.out();
    h.call(h.document, 'selectSingleNode', h.bstr('//Setup/LocalizedData/Language'), language);
    const asElement = h.pointers.get(h.u32(language));
    assert.ok(asElement);
    const name = h.bstr('Text');
    const texts = h.out();
    const method = asElement.object.interfaceFor(IID.ELEMENT).methods
        .find((/** @type {any} */ one)=>one.name === 'getElementsByTagName');
    assert.equal(method.invoke(asElement.object, [name, texts]), 0);
    h.bytes.fill(0, name, name + 8);
    h.call(h.u32(texts), 'get_length', length);
    assert.equal(h.u32(length), 2, 'the name was read at the call');
    const item = h.out();
    assert.equal(h.call(h.u32(texts), 'get_item', 1, item), 0);
    const nodeName = h.out();
    h.call(h.u32(item), 'get_nodeName', nodeName);
    assert.equal(h.readBstr(h.u32(nodeName)), 'Text');
    assert.equal(h.call(h.u32(texts), 'get_item', 2, item), 1, 'past the end: S_FALSE');
});

test('a document that does not parse says why, where', ()=>{
    const h = harness();
    const ok = h.out();
    assert.equal(h.call(h.document, 'loadXML', h.bstr('<a>\n<b></a>'), ok), 1);
    assert.equal(h.view.getInt16(ok, true), 0, 'VARIANT_FALSE');
    const error = h.out();
    h.call(h.document, 'get_parseError', error);
    const code = h.out();
    assert.equal(h.call(h.u32(error), 'get_errorCode', code), 0);
    assert.notEqual(h.u32(code), 0);
    h.call(h.u32(error), 'get_line', code);
    assert.equal(h.u32(code), 2);
    const element = h.out();
    assert.equal(h.call(h.document, 'get_documentElement', element), 1, 'no element: S_FALSE');
});

test('load reads a document from a SAFEARRAY of bytes, as a setup engine hands its manifest',
    async()=>{
        const h = harness();
        const text = new TextEncoder().encode('﻿<BurnManifest><Payload Id="ux"/></BurnManifest>');
        const data = h.out() + 0x100;
        h.bytes.set(text, data);
        // SAFEARRAY: one dimension, one-byte elements, the data, its count.
        const array = h.out();
        h.view.setUint16(array, 1, true);
        h.view.setUint32(array + 4, 1, true);
        h.view.setUint32(array + 12, data, true);
        h.view.setUint32(array + 16, text.length, true);
        const ok = h.out();
        // VT_ARRAY | VT_UI1 by value: the type word, a reserved word, the array.
        assert.equal(await h.call(h.document, 'load', 0x2011, 0, array, 0, ok), 0);
        assert.equal(h.view.getInt16(ok, true), -1, 'VARIANT_TRUE');
        const element = h.out();
        h.call(h.document, 'get_documentElement', element);
        const name = h.out();
        assert.equal(h.call(h.u32(element), 'get_nodeName', name), 0);
        assert.equal(h.readBstr(h.u32(name)), 'BurnManifest');
    });

test('a node made by the document is answered as its kind and goes into the tree', ()=>{
    const h = harness();
    h.call(h.document, 'loadXML', h.bstr('<root/>'), h.out());
    const made = h.out();
    assert.equal(h.call(h.document, 'createElement', h.bstr('child'), made), 0);
    assert.equal(h.pointers.get(h.u32(made))?.iid, IID.ELEMENT);
    const root = h.out();
    h.call(h.document, 'get_documentElement', root);
    assert.equal(h.call(h.u32(root), 'appendChild', h.u32(made), 0), 0);
    const xml = h.out();
    h.call(h.u32(root), 'get_xml', xml);
    assert.equal(h.readBstr(h.u32(xml)), '<root><child/></root>');
});
