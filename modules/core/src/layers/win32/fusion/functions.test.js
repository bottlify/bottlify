/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * fusion.dll as Wine's fusion tests say Windows answers: assembly names and
 * their display form (asmname.c), GetCachePath (fusion.c), the cache's
 * install, query and uninstall (asmcache.c), its enumeration (asmenum.c).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import { managedImage } from '../mscoree/metadata.fixture.js';
import { ASM_CACHE, createFusionFunctions } from './functions.js';

const S_OK = 0;
const S_FALSE = 1;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
const FUSION_E_INVALID_NAME = 0x80131047 | 0;
const FUSION_E_PRIVATE_ASM_DISALLOWED = 0x80131044 | 0;
const COR_E_ASSEMBLYEXPECTED = 0x80131018 | 0;
const ERROR_FILE_NOT_FOUND = 0x80070002 | 0;
const ERROR_INVALID_NAME = 0x8007007b | 0;
const PARSE = 1;
const DEFAULTS = 2;
const GAC = 'C:\\WINDOWS\\assembly\\GAC';

async function machine(){
    const bytes = new Uint8Array(1 << 20);
    const view = new DataView(bytes.buffer);
    let next = 0x1000;
    const allocate = (/** @type {number} */ size)=>{
        const at = next;
        next += (size + 15) & ~15;
        return at;
    };
    const fs = await filesystemModule.create({});
    const volume = /** @type {any} */ (createVolume(fs));
    /** @type {Map<number, { object: any, iid: string }>} */
    const pointers = new Map();
    /** @type {string[]} */
    const divergences = [];
    const fns = createFusionFunctions({
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
        pointerSize: 4,
        windowsDirectory: ()=>'C:\\WINDOWS',
        files: volume,
        publish: (object, iid)=>{
            const at = allocate(16);
            pointers.set(at, { object, iid });
            return at;
        },
        objectAt: pointer=>pointers.get(pointer)?.object ?? null,
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
    });
    /** @param {string} text */
    const wide = text=>{
        const at = allocate(text.length * 2 + 2);
        [...text, '\0'].forEach((unit, i)=>view.setUint16(at + i * 2, unit.charCodeAt(0), true));
        return at;
    };
    /** @param {number} at */
    const text = at=>{
        let out = '';
        for (let i = at; view.getUint16(i, true) !== 0; i += 2)
        {
            out += String.fromCharCode(view.getUint16(i, true));
        }
        return out;
    };
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    const setU32 = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setUint32(at, value >>> 0, true);
    /** A DWORD out-parameter holding `value`. @param {number} [value] */
    const dword = (value = 0)=>{
        const at = allocate(4);
        setU32(at, value);
        return at;
    };
    const buffer = ()=>allocate(1024);
    /** @param {string} name @param {...number} args */
    const fn = (name, ...args)=>/** @type {any} */ (fns)[name].handler(args);
    /** @param {number} pointer @param {string} name @param {...number} args */
    const call = (pointer, name, ...args)=>{
        const held = pointers.get(pointer);
        assert.ok(held, `0x${pointer.toString(16)} was handed out`);
        const method = held.object.interfaceFor(held.iid).methods.find(
            (/** @type {any} */ one)=>one.name === name);
        assert.ok(method, name);
        return method.invoke(held.object, args);
    };
    /** A name object made from text. @param {string} display @param {number} [flags] */
    const named = (display, flags = PARSE)=>{
        const out = dword(0xdeadbeef);
        assert.equal(fn('CreateAssemblyNameObject', out, wide(display), flags, 0), S_OK, display);
        return u32(out);
    };
    /** @param {number} name @param {number} [flags] */
    const display = (name, flags = 0)=>{
        const at = buffer();
        const size = dword(512);
        const hr = call(name, 'GetDisplayName', at, size, flags);
        return hr === S_OK ? text(at) : hr;
    };
    /** @param {string} path @param {Uint8Array} data */
    const file = (path, data)=>{
        const parts = path.split('\\');
        for (let depth = 2; depth < parts.length; depth++)
        {
            volume.mkdir(parts.slice(0, depth).join('\\'));
        }
        const node = volume.open(path, { write: true, create: true, truncate: true });
        volume.write(node, 0, data);
        volume.close(node);
    };
    return { bytes, view, fns, fn, call, wide, text, u32, setU32, dword, buffer, named, display,
        file, volume, divergences, allocate };
}

/** A strong name's token, by node's own SHA-1. @param {Uint8Array} key */
const tokenOf = key=>createHash('sha1').update(key).digest().subarray(-8).reverse()
    .toString('hex');

test('GetCachePath: each cache, the size with its terminator, nothing written short', async()=>{
    const m = await machine();
    const size = m.dword(0);
    assert.equal(m.fn('GetCachePath', ASM_CACHE.GAC, 0, size), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(m.u32(size), GAC.length + 1);
    assert.equal(m.fn('GetCachePath', ASM_CACHE.GAC, 0, 0), E_INVALIDARG);
    const out = m.wide('nochange');
    m.setU32(size, GAC.length);
    assert.equal(m.fn('GetCachePath', ASM_CACHE.GAC, out, size), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(m.text(out), 'nochange');
    m.setU32(size, 260);
    assert.equal(m.fn('GetCachePath', ASM_CACHE.GAC, out, size), S_OK);
    assert.equal(m.text(out), GAC);
    m.setU32(size, 260);
    assert.equal(m.fn('GetCachePath', ASM_CACHE.ROOT, out, size), S_OK);
    assert.equal(m.text(out), 'C:\\WINDOWS\\assembly');
    m.setU32(size, 260);
    assert.equal(m.fn('GetCachePath', ASM_CACHE.ZAP, out, size), S_OK);
    assert.equal(m.text(out), 'C:\\WINDOWS\\assembly\\NativeImages_v4.0.30319_32');
    const kept = m.wide('nochange');
    assert.equal(m.fn('GetCachePath', ASM_CACHE.GAC | ASM_CACHE.ROOT, kept, size), E_INVALIDARG);
    assert.equal(m.text(kept), 'nochange');
});

test('a display name read: the full form back, its parts as properties', async()=>{
    const m = await machine();
    const name = m.named('wine, Version=1.2.3.4, Culture=en, PublicKeyToken=1234567890ABCDEF');
    assert.equal(m.display(name),
        'wine, Version=1.2.3.4, Culture=en, PublicKeyToken=1234567890abcdef');
    assert.equal(m.display(name, 0x1 | 0x2), 'wine, Version=1.2.3.4, Culture=en');
    const hi = m.dword();
    const lo = m.dword();
    assert.equal(m.call(name, 'GetVersion', hi, lo), S_OK);
    assert.deepEqual([m.u32(hi), m.u32(lo)], [0x00010002, 0x00030004]);
    // A property: its size in bytes, and the size needed when it does not fit.
    const at = m.buffer();
    const size = m.dword(260);
    assert.equal(m.call(name, 'GetProperty', 3, at, size), S_OK);
    assert.equal(m.u32(size), 10);
    assert.equal(m.text(at), 'wine');
    m.setU32(size, 9);
    assert.equal(m.call(name, 'GetProperty', 3, at, size), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(m.u32(size), 10);
    m.setU32(size, 260);
    assert.equal(m.call(name, 'GetProperty', 4, at, size), S_OK);
    assert.deepEqual([m.u32(size), m.view.getUint16(at, true)], [2, 1]);
    m.setU32(size, 260);
    assert.equal(m.call(name, 'GetProperty', 1, at, size), S_OK);
    assert.deepEqual([...m.bytes.subarray(at, at + 8)],
        [0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef]);
    m.setU32(size, 260);
    assert.equal(m.call(name, 'GetProperty', 16, at, size), S_OK, 'a token is known');
    assert.equal(m.u32(size), 260, 'and the size is left alone');
    m.setU32(size, 260);
    assert.equal(m.call(name, 'GetProperty', 2, at, size), S_OK);
    assert.equal(m.u32(size), 0, 'a property never set has no bytes');
});

test('a name with only some parts: what is not set stays unset', async()=>{
    const m = await machine();
    const partial = m.named('wine, Version=1.5, Culture=neutral, Bogus=42');
    assert.equal(m.display(partial), 'wine, Version=1.5, Culture=neutral');
    const hi = m.dword(0xbeefcace);
    const lo = m.dword(0xcafebabe);
    assert.equal(m.call(partial, 'GetVersion', hi, lo), FUSION_E_INVALID_NAME);
    assert.deepEqual([m.u32(hi), m.u32(lo)], [0, 0]);
    const size = m.dword(260);
    const at = m.buffer();
    assert.equal(m.call(partial, 'GetProperty', 8, at, size), S_OK);
    assert.equal(m.u32(size), 2, 'neutral is an empty culture');
    m.setU32(size, 260);
    assert.equal(m.call(partial, 'GetProperty', 6, at, size), S_OK);
    assert.equal(m.u32(size), 0, 'no build number');
    m.setU32(size, 260);
    assert.equal(m.call(partial, 'GetProperty', 16, at, size), S_FALSE, 'no token');
    assert.equal(m.u32(size), 260);
    const quoted = m.named('wine,version="1.0.0.00000",culture="en"');
    assert.equal(m.display(quoted), 'wine, Version=1.0.0.0, Culture=en');
    const arch = m.named('wine, processorArchitecture=amd64');
    assert.equal(m.display(arch, 0x20), 'wine, processorArchitecture=AMD64');
});

test('a display name that is not one is refused, and nothing is written', async()=>{
    const m = await machine();
    for (const bad of ['wine, PublicKeyToken=567890abcdef', 'wine, PublicKeyToken=1234567890ghijkl',
        'wine PublicKeyToken=1234567890abcdef', 'wine, PublicKeyToken', 'wine, PublicKeyToken=',
        'wine, Version=1.x', 'wine, processorArchitecture=sparc'])
    {
        const out = m.dword(0xdeadbeef);
        assert.equal(m.fn('CreateAssemblyNameObject', out, m.wide(bad), PARSE, 0),
            FUSION_E_INVALID_NAME, bad);
        assert.equal(m.u32(out), 0xdeadbeef);
    }
    const out = m.dword(0xdeadbeef);
    assert.equal(m.fn('CreateAssemblyNameObject', out, 0, PARSE, 0), E_INVALIDARG);
    assert.equal(m.fn('CreateAssemblyNameObject', out, m.wide(''), PARSE, 0), E_INVALIDARG);
    assert.equal(m.u32(out), 0xdeadbeef);
    assert.equal(m.fn('CreateAssemblyNameObject', 0, m.wide('wine'), 0, 0), E_INVALIDARG);
});

test('without parsing: no name, an empty one, a simple one', async()=>{
    const m = await machine();
    const out = m.dword();
    assert.equal(m.fn('CreateAssemblyNameObject', out, 0, DEFAULTS, 0), S_OK);
    const none = m.u32(out);
    assert.equal(m.display(none), FUSION_E_INVALID_NAME);
    const size = m.dword(260);
    const at = m.wide('a');
    assert.equal(m.call(none, 'GetName', size, at), S_OK);
    assert.deepEqual([m.u32(size), m.text(at)], [0, 'a'], 'no name: nothing, size 0');
    const empty = m.named('', DEFAULTS);
    assert.equal(m.display(empty), FUSION_E_INVALID_NAME);
    m.setU32(size, 0);
    assert.equal(m.call(empty, 'GetName', size, at), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(m.u32(size), 1);
    const plain = m.named('wine', DEFAULTS);
    m.setU32(size, 3);
    assert.equal(m.call(plain, 'GetDisplayName', 0, size, 0), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(m.u32(size), 5);
    assert.equal(m.display(plain), 'wine');
});

test('IsEqual compares only what both names name; Clone copies', async()=>{
    const m = await machine();
    const wine = m.named('wine');
    assert.equal(m.call(wine, 'IsEqual', m.named('WINE, version=1.0.0.0, culture=neutral'), 0x7f),
        S_OK);
    assert.equal(m.call(m.named('wine,version=1.0.0.0,culture=en'),
        'IsEqual', m.named('wine,version=1.0.0.0,culture=neutral'), 0x7f), S_FALSE);
    assert.equal(m.call(m.named('wine, Version=1.0.0.1'), 'IsEqual',
        m.named('wine, Version=1.0.0.0'), 0x7f), S_FALSE);
    assert.equal(m.call(wine, 'IsEqual', 0, 0x7f), S_FALSE);
    const out = m.dword();
    assert.equal(m.call(m.named('wine, Culture=en'), 'Clone', out), S_OK);
    assert.equal(m.display(m.u32(out)), 'wine, Culture=en');
});

/** A strongly named assembly's file, and its token. */
const signed = (/** @type {import('../mscoree/metadata.fixture.js').ImageShape} */ shape)=>{
    const publicKey = Uint8Array.from({ length: 160 }, (_, i)=>(i * 31 + 5) & 0xff);
    return { image: managedImage({ publicKey, ...shape }), token: tokenOf(publicKey) };
};

test('InstallAssembly files a strongly named assembly by its name, kind and runtime', async()=>{
    const m = await machine();
    const out = m.dword();
    assert.equal(m.fn('CreateAssemblyCache', out, 42), S_OK);
    assert.ok(m.volume.stat('C:\\WINDOWS\\assembly')?.isDirectory, 'the cache root is made');
    const cache = m.u32(out);
    const install = (/** @type {string} */ path)=>m.call(cache, 'InstallAssembly', 0, m.wide(path), 0);
    assert.equal(await m.call(cache, 'InstallAssembly', 0, 0, 0), E_INVALIDARG);
    assert.equal(await install(''), E_INVALIDARG);
    assert.equal(await install('file'), ERROR_INVALID_NAME);
    assert.equal(await install('file.bad'), ERROR_INVALID_NAME);
    assert.equal(await install('C:\\file.dll'), ERROR_FILE_NOT_FOUND);
    m.file('C:\\empty.dll', new Uint8Array(100));
    assert.equal(await install('C:\\empty.dll'), COR_E_ASSEMBLYEXPECTED);
    m.file('C:\\weak.dll', managedImage({ name: 'weak' }));
    assert.equal(await install('C:\\weak.dll'), FUSION_E_PRIVATE_ASM_DISALLOWED);

    const legacy = signed({ name: 'wine', version: [1, 0, 0, 0], runtime: 'v2.0.50727' });
    m.file('C:\\setup\\wine.dll', legacy.image);
    m.volume.setCurrentDirectory('C:\\setup');
    assert.equal(await install('wine.dll'), S_OK, 'a relative path is the current directory\'s');
    assert.ok(m.volume.stat(`${GAC}_MSIL\\wine\\1.0.0.0__${legacy.token}\\wine.dll`));

    const v4 = signed({ name: 'Tool', version: [4, 0, 0, 0], culture: 'fr', flags: 0x3 });
    m.file('C:\\setup\\Tool.dll', v4.image);
    assert.equal(await install('C:\\setup\\Tool.dll'), S_OK);
    assert.ok(m.volume.stat('C:\\WINDOWS\\Microsoft.NET\\assembly\\GAC_32\\Tool\\'
        + `v4.0_4.0.0.0_fr_${v4.token}\\Tool.dll`), 'IL that needs 32 bits, runtime 4');

    const split = signed({ name: 'Split', files: ['part.netmodule'] });
    m.file('C:\\setup\\Split.dll', split.image);
    assert.equal(await install('C:\\setup\\Split.dll'), 0x80131042 | 0, 'a module missing');
    m.file('C:\\setup\\part.netmodule', new Uint8Array([1, 2, 3]));
    assert.equal(await install('C:\\setup\\Split.dll'), S_OK);
    assert.equal(m.volume.stat('C:\\WINDOWS\\Microsoft.NET\\assembly\\GAC_MSIL\\Split\\'
        + `v4.0_1.2.3.4__${split.token}\\part.netmodule`)?.size, 3);
});

test('QueryAssemblyInfo: found by any part of its name, the path and the size', async()=>{
    const m = await machine();
    const { image, token } = signed({ name: 'wine', version: [1, 0, 0, 0],
        runtime: 'v2.0.50727' });
    m.file('C:\\wine.dll', image);
    const out = m.dword();
    m.fn('CreateAssemblyCache', out, 0);
    const cache = m.u32(out);
    const path = `${GAC}_MSIL\\wine\\1.0.0.0__${token}\\wine.dll`;
    const info = m.allocate(24);
    const into = m.buffer();
    const reset = ()=>{
        m.bytes.fill(0, info, info + 24);
        m.setU32(info, 24);
        m.setU32(info + 16, into);
        m.setU32(info + 20, 260);
        m.view.setUint16(into, 0, true);
    };
    /** @param {number} flags @param {string} name */
    const query = (flags, name)=>m.call(cache, 'QueryAssemblyInfo', flags, m.wide(name), info);

    reset();
    assert.equal(query(0, 'wine'), ERROR_FILE_NOT_FOUND);
    assert.deepEqual([m.u32(info + 4), m.text(into), m.u32(info + 20)], [0, '', 260]);
    assert.equal(await m.call(cache, 'InstallAssembly', 0, m.wide('C:\\wine.dll'), 0), S_OK);

    reset();
    assert.equal(m.call(cache, 'QueryAssemblyInfo', 1, 0, info), E_INVALIDARG);
    assert.equal(query(1, ''), E_INVALIDARG);
    reset();
    assert.equal(query(0, 'wine'), S_OK);
    assert.deepEqual([m.u32(info + 4), m.u32(info + 8), m.text(into), m.u32(info + 20)],
        [1, 0, path, path.length + 1]);
    reset();
    assert.equal(query(2, `wine, Version=1.0.0.00000, Culture=neutral, PublicKeyToken=${token}`),
        S_OK);
    assert.equal(m.u32(info + 8), 4, 'GETSIZE: whole 4 KB clusters');
    for (const missing of ['wine.dll', 'wine, Version=1.0.0.1', 'wine, Culture=en',
        'wine, PublicKeyToken=aaaaaaaaaaaaaaaa'])
    {
        reset();
        assert.equal(query(2, missing), ERROR_FILE_NOT_FOUND, missing);
        assert.equal(m.u32(info + 4), 0, missing);
    }
    assert.equal(query(0, 'mscorlib.dll,publicKeyToken=nuLl'), FUSION_E_PRIVATE_ASM_DISALLOWED);
    reset();
    m.setU32(info, 1);
    assert.equal(query(1, 'wine'), E_INVALIDARG);
    assert.equal(m.u32(info + 4), 0, 'a structure of another size is left alone');
    reset();
    m.setU32(info, 0);
    assert.equal(query(1, 'wine'), S_OK);
    assert.equal(m.u32(info), 24, 'a size of 0 is filled in');
    reset();
    m.setU32(info + 20, path.length);
    assert.equal(query(2, 'wine'), E_NOT_SUFFICIENT_BUFFER);
    assert.deepEqual([m.u32(info + 4), m.u32(info + 20), m.text(into)],
        [1, path.length + 1, '']);
    assert.equal(m.call(cache, 'QueryAssemblyInfo', 1, m.wide('wine'), 0), S_OK);

    const disposition = m.dword(0xf00dbad);
    assert.equal(m.call(cache, 'UninstallAssembly', 0, m.wide('wine'), 0, disposition), S_OK);
    assert.equal(m.u32(disposition), 1);
    assert.equal(m.volume.stat(`${GAC}_MSIL\\wine`), null, 'the name folder goes with it');
    assert.equal(m.call(cache, 'UninstallAssembly', 0, m.wide('wine'), 0, disposition), S_FALSE);
    assert.equal(m.u32(disposition), 3);
});

test('the cache item is made and refuses streams, said', async()=>{
    const m = await machine();
    const out = m.dword();
    m.fn('CreateAssemblyCache', out, 0);
    const cache = m.u32(out);
    assert.equal(m.call(cache, 'CreateAssemblyCacheItem', 0, 0, 0, 0), E_INVALIDARG);
    const item = m.dword();
    assert.equal(m.call(cache, 'CreateAssemblyCacheItem', 1, 0xdeadbeef, item, m.wide('wine')),
        S_OK);
    assert.equal(m.call(m.u32(item), 'CreateStream', 0, 0, 0, 0, m.dword(), 0), 0x80004001 | 0);
    assert.ok(m.divergences.some(line=>line.startsWith('IAssemblyCacheItem::CreateStream')));
});

test('CreateAssemblyEnum: the cache\'s folders, sorted, named as the query spells it', async()=>{
    const m = await machine();
    const gac = `${GAC}\\Wine`;
    for (const folder of ['1.0.1.2__16a3fcd171e93a8d', '1.0.0.0__16a3fcd171e93a8d',
        '1.0.1.2__123456789abcdef0'])
    {
        m.file(`${gac}\\${folder}\\Wine.dll`, new Uint8Array(100));
    }
    m.volume.mkdir(`${gac}\\2.0.0.0__16a3fcd171e93a8d`);
    m.file('C:\\WINDOWS\\Microsoft.NET\\assembly\\GAC_MSIL\\Other\\'
        + 'v4.0_3.0.0.0_de_0123456789abcdef\\Other.exe', new Uint8Array(4));
    /** @param {number} name @param {number} [flags] */
    const listed = (name, flags = ASM_CACHE.GAC)=>{
        const out = m.dword();
        assert.equal(m.fn('CreateAssemblyEnum', out, 0, name, flags, 0), S_OK);
        /** @type {(string | number)[]} */
        const names = [];
        const next = m.dword(0xdeadbeef);
        while (m.call(m.u32(out), 'GetNextAssembly', 0, next, 0) === S_OK)
        {
            names.push(m.display(m.u32(next)));
        }
        assert.equal(m.u32(next) >>> 0, names.length === 0 ? 0xdeadbeef : m.u32(next) >>> 0);
        return names;
    };
    assert.deepEqual(listed(0), [
        'Wine, Version=1.0.0.0, Culture=neutral, PublicKeyToken=16a3fcd171e93a8d',
        'Wine, Version=1.0.1.2, Culture=neutral, PublicKeyToken=123456789abcdef0',
        'Wine, Version=1.0.1.2, Culture=neutral, PublicKeyToken=16a3fcd171e93a8d',
        'Other, Version=3.0.0.0, Culture=de, PublicKeyToken=0123456789abcdef',
    ], 'a version folder without its file is not an assembly');
    assert.deepEqual(listed(m.named('wine, Version=1.0.1.2')), [
        'wine, Version=1.0.1.2, Culture=neutral, PublicKeyToken=123456789abcdef0',
        'wine, Version=1.0.1.2, Culture=neutral, PublicKeyToken=16a3fcd171e93a8d',
    ]);
    assert.deepEqual(listed(m.named('WINE, PublicKeyToken=16a3fcd171e93a8d')).length, 2);
    assert.deepEqual(listed(0, ASM_CACHE.ZAP), [], 'no native images');
    const kept = m.dword(0xdeadbeef);
    assert.equal(m.fn('CreateAssemblyEnum', kept, 0, 0, ASM_CACHE.ROOT, 0), E_INVALIDARG);
    assert.equal(m.fn('CreateAssemblyEnum', kept, 0, 0, 0, 0), E_INVALIDARG);
    assert.equal(m.u32(kept), 0xdeadbeef);
});
