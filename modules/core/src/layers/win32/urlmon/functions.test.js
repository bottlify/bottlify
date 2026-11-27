/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_AGENTS, createUrlmonFunctions, sniffMime, urlExtension } from './functions.js';

/** @param {string} windows */
function harness(windows){
    const ram = new Uint8Array(256);
    const view = new DataView(ram.buffer);
    const { ObtainUserAgentString } = createUrlmonFunctions({ windows,
        readU32: address=>view.getUint32(address, true),
        writeU32: (address, value)=>view.setUint32(address, value, true),
        writeMemory: (address, bytes)=>ram.set(bytes, address) });
    return { ram, view, call: ObtainUserAgentString };
}

test('ObtainUserAgentString writes the Windows\' Internet Explorer string and its terminator',
    ()=>{
        const h = harness('win7');
        assert.equal(h.call.argBytes, 12);
        h.view.setUint32(4, 200, true);
        assert.equal(h.call.handler([0, 16, 4]), 0);
        const agent = USER_AGENTS.win7;
        assert.equal(new TextDecoder().decode(h.ram.subarray(16, 16 + agent.length)), agent);
        assert.equal(h.ram[16 + agent.length], 0);
        assert.equal(h.view.getUint32(4, true), agent.length + 1, 'the size it took');
    });

test('a buffer too small is E_OUTOFMEMORY with the size needed; no buffer is E_INVALIDARG', ()=>{
    const h = harness('winxp');
    h.view.setUint32(4, 4, true);
    assert.equal(h.call.handler([0, 16, 4]), 0x8007000e);
    assert.equal(h.view.getUint32(4, true), USER_AGENTS.winxp.length + 1);
    assert.equal(h.ram[16], 0, 'and nothing written');
    assert.equal(h.call.handler([0, 0, 4]), 0x80070057);
    assert.equal(h.call.handler([0, 16, 0]), 0x80070057);
});

/** FindMimeFromData over a small memory, `.png` registered as the system registers it. */
function mime(){
    const ram = new Uint8Array(0x1000);
    const view = new DataView(ram.buffer);
    let next = 0x800;
    const { FindMimeFromData } = createUrlmonFunctions({ windows: 'win7',
        readU32: address=>view.getUint32(address, true),
        writeU32: (address, value)=>view.setUint32(address, value, true),
        writeMemory: (address, bytes)=>ram.set(bytes, address),
        readMemory: (address, length)=>ram.slice(address, address + length),
        readWideString: address=>{
            let text = '';
            for (let at = address; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        allocate: bytes=>{
            const at = next;
            next += bytes + 8;
            return at;
        },
        contentType: extension=>(extension === '.png' ? 'image/png' : null) });
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        [...text, '\0'].forEach((char, index)=>view.setUint16(at + index * 2, char.charCodeAt(0),
            true));
        return at;
    };
    /** @param {number} url @param {number[]} data @param {number} proposed */
    const call = (url, data, proposed)=>{
        ram.set(data, 0x400);
        return FindMimeFromData.handler([0, url, data.length ? 0x400 : 0, data.length, proposed, 0,
            0x10, 0]);
    };
    const answer = ()=>{
        const at = view.getUint32(0x10, true);
        let text = '';
        for (let p = at; view.getUint16(p, true) !== 0; p += 2)
        {
            text += String.fromCharCode(view.getUint16(p, true));
        }
        return text;
    };
    return { call, wide, answer, view };
}

test('FindMimeFromData: the data\'s signature, then the proposal, then the extension', ()=>{
    const m = mime();
    assert.equal(m.call(0, [0x89, 0x50, 0x4e, 0x47, 13, 10, 0x1a, 10], 0), 0);
    assert.equal(m.answer(), 'image/x-png', 'urlmon\'s own name for PNG data');
    assert.equal(m.call(0, [0x89, 0x50, 0x4e, 0x47, 13, 10, 0x1a, 10], m.wide(0x200, 'text/plain')),
        0);
    assert.equal(m.answer(), 'image/x-png', 'the data\'s signature over a proposal');
    assert.equal(m.call(0, [...'hello'].map(c=>c.charCodeAt(0)), m.wide(0x200, 'text/css')), 0);
    assert.equal(m.answer(), 'text/css', 'text no signature names takes the proposal');
    assert.equal(m.call(m.wide(0x100, 'pack://application:,,,/a/b.PNG?x=1'), [], 0), 0);
    assert.equal(m.answer(), 'image/png', 'the extension as registered');
    assert.equal(m.call(0, [1, 2, 3], 0), 0);
    assert.equal(m.answer(), 'application/octet-stream');
    assert.equal(m.call(m.wide(0x100, 'c:/x.unknownext'), [], 0) >>> 0, 0x80004005,
        'nothing to go by');
    assert.equal(m.view.getUint32(0x10, true), 0);
    assert.equal(m.call(0, [], 0) >>> 0, 0x80070057, 'neither URL nor data');
});

test('the signatures and the URL\'s extension', ()=>{
    /** @param {string} text */
    const bytes = text=>Uint8Array.from([...text].map(c=>c.charCodeAt(0)));
    assert.equal(sniffMime(bytes('<HTML><body>')), 'text/html');
    assert.equal(sniffMime(bytes('GIF89a')), 'image/gif');
    assert.equal(sniffMime(Uint8Array.of(0xff, 0xd8, 0xff)), 'image/pjpeg');
    assert.equal(sniffMime(bytes('MZ\x90')), 'application/x-msdownload');
    assert.equal(sniffMime(bytes('plain words')), null);
    assert.equal(urlExtension('http://h/p/file.tar.GZ#frag'), '.gz');
    assert.equal(urlExtension('http://h/p.d/file'), '');
});

test('CoInternetSetFeatureEnabled turns a feature on or off; IsFeatureEnabled answers S_OK or'
    + ' S_FALSE', ()=>{
    /** @type {string[]} */
    const said = [];
    const fns = createUrlmonFunctions({ windows: 'win7', readU32: ()=>0, writeU32: ()=>{},
        writeMemory: ()=>{}, divergence: (api, detail)=>said.push(detail) });
    const FEATURE_WEBOC_POPUPMANAGEMENT = 5;
    assert.equal(fns.CoInternetIsFeatureEnabled.handler([0, 2]), 0, 'object caching starts on');
    assert.equal(fns.CoInternetIsFeatureEnabled.handler([FEATURE_WEBOC_POPUPMANAGEMENT, 2]), 1);
    assert.equal(fns.CoInternetSetFeatureEnabled.handler([FEATURE_WEBOC_POPUPMANAGEMENT, 2, 1]), 0);
    assert.equal(fns.CoInternetIsFeatureEnabled.handler([FEATURE_WEBOC_POPUPMANAGEMENT, 2]), 0);
    assert.equal(fns.CoInternetSetFeatureEnabled.handler([28, 2, 1]) >>> 0, 0x80070057,
        'past the last feature');
    assert.equal(fns.CoInternetSetFeatureEnabled.handler([1, 0, 1]) >>> 0, 0x80070057, 'no flags');
    assert.equal(said.length, 0);
    fns.CoInternetSetFeatureEnabled.handler([1, 1, 1]);
    assert.match(said.join(), /thread/);
});
