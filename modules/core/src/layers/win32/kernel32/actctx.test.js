/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivationContexts, hashKey } from './actctx.js';

const HEAD = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">';
const MANIFEST1 = `${HEAD}<assemblyIdentity version="1.0.0.0" name="Wine.Test" type="win32">`
    + '</assemblyIdentity></assembly>';
const MANIFEST2 = `${HEAD}<assemblyIdentity version="1.2.3.4" name="Wine.Test" type="win32">`
    + '</assemblyIdentity><dependency><dependentAssembly><assemblyIdentity type="win32" '
    + 'name="testdep" version="6.5.4.3" processorArchitecture="x86"></assemblyIdentity>'
    + '</dependentAssembly></dependency></assembly>';
const TESTDEP3 = `${HEAD}<assemblyIdentity type="win32" name="testdep" version="6.5.4.3" `
    + 'processorArchitecture="x86"/><file name="testlib.dll"/><file name="testlib2.dll">'
    + '<windowClass>wndClass</windowClass><windowClass>wndClass2</windowClass></file></assembly>';

const TEB = 0x7000;
const SCRATCH = 0x100;

/** @param {Record<string, string>} [volume]  path -> file text */
function setup(volume = {}){
    const bytes = new Uint8Array(0x40000);
    const view = new DataView(bytes.buffer);
    let next = 0x10000;
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const said = [];
    const files = new Map(Object.entries(volume).map(([path, text])=>[path.toLowerCase(),
        new TextEncoder().encode(text)]));
    const spelled = Object.keys(volume);
    const { functions, loaderApi } = createActivationContexts({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: address=>{
            let text = '';
            for (let at = address; bytes[at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[at]);
            }
            return text;
        },
        readWideString: address=>{
            let text = '';
            for (let at = address; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        setLastError: code=>{
            errors.push(code);
        },
        allocate: size=>{
            const at = next;
            next += (size + 15) & ~15;
            bytes.fill(0, at, at + size);
            return at;
        },
        teb: ()=>TEB,
        readFile: path=>files.get(path.toLowerCase()) ?? null,
        stat: path=>{
            const key = path.toLowerCase().replace(/\\$/, '');
            if (files.has(key))
            {
                return { exists: true, isDirectory: false };
            }
            return [...files.keys()].some(file=>file.startsWith(`${key}\\`))
                ? { exists: true, isDirectory: true } : null;
        },
        list: (path, pattern)=>{
            const prefix = `${path.toLowerCase()}\\`;
            const ending = pattern.replace(/^\*/, '').toLowerCase();
            const names = new Set(spelled.filter(file=>file.toLowerCase().startsWith(prefix))
                .map(file=>file.slice(prefix.length).split('\\')[0]));
            return [...names].filter(name=>ending === '' || name.toLowerCase().endsWith(ending))
                .map(name=>({ name, isDirectory: !files.has(`${prefix}${name.toLowerCase()}`) }));
        },
        fullPath: path=>(/^[A-Za-z]:/.test(path) ? path : `C:\\app\\${path}`),
        imagePath: ()=>'C:\\app\\test.exe',
        answers: name=>/^(msvcr80|msvcp80|comctl32)\.dll$/i.test(name),
        encodeAnsi: text=>new TextEncoder().encode(text),
        decodeAnsi: data=>new TextDecoder().decode(data),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        [...`${text}\0`].forEach((unit, index)=>view.setUint16(at + index * 2, unit.charCodeAt(0),
            true));
        return at;
    };
    /** @param {number} at @param {number} length */
    const wideAt = (at, length)=>String.fromCharCode(...Array.from({ length },
        (_, index)=>view.getUint16(at + index * 2, true)));
    /** @param {string} path */
    const create = async path=>{
        bytes.fill(0, SCRATCH, SCRATCH + 32);
        view.setUint32(SCRATCH, 32, true);
        view.setUint32(SCRATCH + 8, putWide(0x200, path), true);
        return await functions.CreateActCtxW.handler([SCRATCH]);
    };
    const dword = (/** @type {number} */ at)=>view.getUint32(at, true);
    const natives = /** @type {any} */ (functions.CreateActCtxA).natives;
    /**
     * A fastcall entry's trap, as the export binding registers it.
     *
     * @param {string} name
     * @returns {(args: number[]) => number}
     */
    const fast = name=>{
        /** @type {any} */
        let trap = null;
        natives[name].guest({ register: (/** @type {string} */ _, /** @type {any} */ fn)=>{
            trap = fn;
            return 0x30000;
        } });
        return trap.handler;
    };
    return { functions, loaderApi, bytes, view, errors, said, putWide, wideAt, create, dword,
        natives, fast };
}

test('a context from a manifest file and its dependency answers for both', async()=>{
    const t = setup({ 'C:\\app\\test2.manifest': MANIFEST2,
        'C:\\app\\testdep.manifest': TESTDEP3 });
    const handle = await t.create('test2.manifest');
    assert.notEqual(handle, 0xffffffff);
    assert.ok(handle !== 0);

    // Basic: the handle itself, and no flags.
    assert.equal(t.functions.QueryActCtxW.handler([0x80000000, handle, 0, 1, 0x300, 8, 0x310]), 1);
    assert.equal(t.dword(0x300), handle);
    assert.equal(t.dword(0x310), 8);

    // Detailed: format 1, two assemblies, the root manifest's path and the application's.
    assert.equal(t.functions.QueryActCtxW.handler([0, handle, 0, 2, 0x400, 48, 0x310]), 0);
    assert.equal(t.errors.at(-1), 122, 'ERROR_INSUFFICIENT_BUFFER');
    const needed = t.dword(0x310);
    assert.equal(needed, 48 + ('C:\\app\\test2.manifest'.length + 1) * 2
        + ('C:\\app\\'.length + 1) * 2);
    assert.equal(t.functions.QueryActCtxW.handler([0, handle, 0, 2, 0x400, needed, 0x310]), 1);
    assert.deepEqual([4, 8, 12, 16, 20, 28, 32].map(at=>t.dword(0x400 + at)),
        [1, 2, 2, 'C:\\app\\test2.manifest'.length, 1, 2, 'C:\\app\\'.length],
        'a file for the root manifest and the application, none for a configuration');
    assert.equal(t.wideAt(t.dword(0x400 + 36), 21), 'C:\\app\\test2.manifest');
    assert.equal(t.wideAt(t.dword(0x400 + 44), 7), 'C:\\app\\');

    // The dependency's detail: its encoded identity, its manifest, a directory.
    t.view.setUint32(0x320, 2, true);
    assert.equal(t.functions.QueryActCtxW.handler([0, handle, 0x320, 3, 0x500, 88, 0x310]), 0);
    const size = t.dword(0x310);
    assert.equal(t.functions.QueryActCtxW.handler([0, handle, 0x320, 3, 0x500, size, 0x310]), 1);
    const encoded = 'testdep,processorArchitecture="x86",type="win32",version="6.5.4.3"';
    assert.equal(t.dword(0x500 + 4), encoded.length * 2);
    assert.equal(t.wideAt(t.dword(0x500 + 64), encoded.length), encoded);
    assert.equal(t.wideAt(t.dword(0x500 + 68), 23), 'C:\\app\\testdep.manifest');
    assert.equal(t.dword(0x500 + 44), 1, 'manifest version 1.0');
    assert.ok(t.dword(0x500 + 60) > 0 && t.dword(0x500 + 76) !== 0, 'a directory');
    assert.equal(t.dword(0x500 + 80), 2, 'two files');

    // A file of the dependency, by its 0-based assembly and file index.
    t.view.setUint32(0x330, 1, true);
    t.view.setUint32(0x334, 1, true);
    assert.equal(t.functions.QueryActCtxW.handler([0, handle, 0x330, 4, 0x600, 0x40, 0x310]), 1);
    assert.equal(t.dword(0x310), 0, 'nothing said written, as Windows answers');
    assert.deepEqual([0, 4, 8, 16].map(at=>t.dword(0x600 + at)), [2, 24, 0, 0]);
    assert.equal(t.wideAt(t.dword(0x600 + 12), 12), 'testlib2.dll');
});

test('activation puts a frame on the TEB\'s stack, and lookups find what it redirects', async()=>{
    const t = setup({ 'C:\\app\\test.manifest': TESTDEP3 });
    const handle = await t.create('test.manifest');
    assert.equal(t.functions.GetCurrentActCtx.handler([0x310]), 1);
    assert.equal(t.dword(0x310), 0, 'none before');
    assert.equal(t.functions.ActivateActCtx.handler([handle, 0x314]), 1);
    const cookie = t.dword(0x314);
    const frame = t.dword(t.dword(TEB + 0x1a8));
    assert.equal(frame, cookie);
    assert.deepEqual([0, 4].map(at=>t.dword(frame + at)), [0, handle]);
    assert.equal(t.dword(frame + 8) & 8, 8, 'heap allocated');
    assert.equal(t.functions.GetCurrentActCtx.handler([0x310]), 1);
    assert.equal(t.dword(0x310), handle);

    // DLL redirection: keyed data as Windows lays it out.
    const data = 0x700;
    t.bytes.fill(0xfe, data, data + 64);
    t.view.setUint32(data, 64, true);
    t.putWide(0x800, 'TESTLIB.dll');
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 2, 0x800, data]), 1);
    assert.deepEqual([4, 12, 16, 20, 32, 36].map(at=>t.dword(data + at)), [1, 20, 0, 0, 0, 1]);
    const lpData = t.dword(data + 8);
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>t.dword(lpData + at)), [20, 2, 0, 0, 0]);
    const base = t.dword(data + 24);
    assert.equal(t.dword(base), 0x64487353, "'SsHd'");
    assert.equal(t.dword(base + 20), 2, 'two DLLs');
    assert.ok(t.dword(data + 28) > 0);
    const first = t.dword(base + 24);
    assert.ok(t.dword(base + first) <= t.dword(base + first + 24), 'ordered by hash');
    assert.ok([hashKey('testlib.dll'), hashKey('testlib2.dll')].includes(t.dword(base + first)));

    // With RETURN_HACTCTX, the handle comes back, referenced.
    t.view.setUint32(data, 64, true);
    assert.equal(t.functions.FindActCtxSectionStringW.handler([1, 0, 2, 0x800, data]), 1);
    assert.equal(t.dword(data + 32), handle);
    t.functions.ReleaseActCtx.handler([handle]);

    // A window class: versioned by the assembly's version, the module's name after it.
    t.putWide(0x800, 'wndClass2');
    t.view.setUint32(data, 64, true);
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 3, 0x800, data]), 1);
    const wnd = t.dword(data + 8);
    const name = '6.5.4.3!wndClass2';
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>t.dword(wnd + at)),
        [24, 0, name.length * 2, 24, 'testlib2.dll'.length * 2]);
    assert.equal(t.wideAt(wnd + 24, name.length), name);
    assert.equal(t.dword(data + 12), 24 + name.length * 2 + 24 + 4);
    assert.equal(t.dword(data + 24) + t.dword(wnd + 20), wnd + 24 + name.length * 2 + 2);

    // What is not there, and what is asked wrongly.
    t.putWide(0x800, 'testlib3.dll');
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 2, 0x800, data]), 0);
    assert.equal(t.errors.at(-1), 14007, 'ERROR_SXS_KEY_NOT_FOUND');
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 100, 0x800, data]), 0);
    assert.equal(t.errors.at(-1), 14000, 'ERROR_SXS_SECTION_NOT_FOUND');
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 2, 0x800, 0]), 0);
    assert.equal(t.errors.at(-1), 87);
    t.view.setUint32(data, 35, true);
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 2, 0x800, data]), 0);
    assert.equal(t.errors.at(-1), 87, 'a cbSize short of the roster index');

    // ntdll's lookup takes no data block.
    t.view.setUint32(0x900, (18 << 16) | 16, true);
    t.view.setUint32(0x904, t.putWide(0x910, 'wndClass'), true);
    assert.equal(t.natives.RtlFindActivationContextSectionString.handler([0, 0, 3, 0x900, 0]), 0);

    assert.equal(t.functions.DeactivateActCtx.handler([0, cookie]), 1);
    assert.equal(t.dword(t.dword(TEB + 0x1a8)), 0);
    assert.equal(t.functions.DeactivateActCtx.handler([0, cookie]), 0);
    assert.equal(t.errors.at(-1), 14085, 'ERROR_SXS_INVALID_DEACTIVATION');
    t.putWide(0x800, 'testlib.dll');
    t.view.setUint32(data, 64, true);
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 2, 0x800, data]), 0,
        'nothing active, no process default');
    assert.equal(t.errors.at(-1), 14000);
});

test('a caller\'s own frame goes on the stack as it is; the stack can be freed whole', async()=>{
    const t = setup({ 'C:\\app\\test1.manifest': MANIFEST1 });
    const handle = await t.create('test1.manifest');
    const extended = 0x1000;
    t.view.setUint32(extended, 0, true);
    t.view.setUint32(extended + 4, 0xdeadbeef, true);
    const activateFast = t.fast('RtlActivateActivationContextUnsafeFast');
    const deactivateFast = t.fast('RtlDeactivateActivationContextUnsafeFast');
    const frame = activateFast([extended, handle]);
    assert.equal(frame, extended + 8);
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>t.dword(extended + at)),
        [0, 0xdeadbeef, 0, handle, 0], 'Size and Format untouched, not heap allocated');
    const second = 0x1100;
    activateFast([second, handle]);
    assert.equal(t.dword(second + 8), extended + 8, 'linked to the one below');
    deactivateFast([second]);
    assert.equal(t.dword(t.dword(TEB + 0x1a8)), extended + 8);
    assert.equal(t.natives.RtlActivateActivationContext.handler([0, handle, 0x310]), 0);
    t.natives.RtlFreeThreadActivationContextStack.handler([]);
    assert.equal(t.dword(t.dword(TEB + 0x1a8)), 0, 'every frame gone');

    assert.equal(t.functions.ActivateActCtx.handler([handle, 0x314]), 1);
    assert.equal(t.natives.RtlQueryInformationActiveActivationContext.handler([1, 0x320, 8, 0x310]),
        0);
    assert.equal(t.dword(0x320), handle);
    assert.equal(t.functions.QueryActCtxW.handler([4, handle, 0, 1, 0x320, 8, 0x310]), 0,
        'the active one and a handle too');
    assert.equal(t.dword(0x310), 0);
    assert.equal(t.errors.at(-1), 87);
});

test('CreateActCtx refuses what Windows refuses, each with its error', async()=>{
    const t = setup({ 'C:\\app\\test2.manifest': MANIFEST2,
        'C:\\app\\bad.manifest': '<assembly manifestVersion="1.0"></assembly>',
        'C:\\app\\wrong\\test2.manifest': MANIFEST2,
        'C:\\app\\wrong\\testdep.manifest': TESTDEP3.replace('6.5.4.3', '6.5.4.4') });
    assert.equal(await t.create('nothing.manifest'), 0xffffffff);
    assert.equal(t.errors.at(-1), 2);
    assert.equal(await t.create('C:\\nowhere\\x.manifest'), 0xffffffff);
    assert.equal(t.errors.at(-1), 3);
    assert.equal(await t.create('bad.manifest'), 0xffffffff);
    assert.equal(t.errors.at(-1), 14001, 'ERROR_SXS_CANT_GEN_ACTCTX');
    assert.equal(await t.create('test2.manifest'), 0xffffffff, 'its dependency missing');
    assert.equal(t.errors.at(-1), 14001);
    assert.equal(await t.create('C:\\app\\wrong\\test2.manifest'), 0xffffffff,
        'a private assembly at another version');

    // cbSize has to reach lpSource, and each field a flag says is there.
    t.view.setUint32(SCRATCH, 8, true);
    assert.equal(t.functions.CreateActCtxW.handler([SCRATCH]), 0xffffffff);
    assert.equal(t.errors.at(-1), 87);
    t.view.setUint32(SCRATCH, 16, true);
    t.view.setUint32(SCRATCH + 4, 4, true);
    assert.equal(t.functions.CreateActCtxW.handler([SCRATCH]), 0xffffffff);
    assert.equal(t.errors.at(-1), 87, 'ASSEMBLY_DIRECTORY_VALID past cbSize');
    assert.equal(t.functions.CreateActCtxW.handler([0]), 0xffffffff);
});

test('dependencies are found in the store, beside the program, then among the engine\'s', async()=>{
    const policy = `${HEAD}<assemblyIdentity type="win32-policy" name="policy.1.0.Shared" `
        + 'version="1.0.0.9" processorArchitecture="x86" publicKeyToken="00112233aabbccdd"/>'
        + '<dependency><dependentAssembly><assemblyIdentity type="win32" name="Shared" '
        + 'processorArchitecture="x86" publicKeyToken="00112233aabbccdd"/>'
        + '<bindingRedirect oldVersion="1.0.0.0-1.0.0.8" newVersion="1.0.0.9"/>'
        + '</dependentAssembly></dependency></assembly>';
    const shared = `${HEAD}<assemblyIdentity type="win32" name="Shared" version="1.0.0.9" `
        + 'processorArchitecture="x86" publicKeyToken="00112233aabbccdd"/>'
        + '<file name="shared.dll"/></assembly>';
    /** @param {string} name @param {string} version @param {string} token */
    const depending = (name, version, token)=>'<dependency><dependentAssembly>'
        + `<assemblyIdentity type="win32" name="${name}" version="${version}" `
        + `processorArchitecture="x86" publicKeyToken="${token}"/></dependentAssembly></dependency>`;
    const app = `${HEAD}${depending('Shared', '1.0.0.1', '00112233aabbccdd')}`
        + `${depending('Microsoft.VC80.CRT', '8.0.50608.0', '1fc8b3b9a1e18e3b')}`
        + `${depending('Microsoft.VC80.OpenMP', '8.0.50608.0', '1fc8b3b9a1e18e3b')}</assembly>`;
    const openmp = `${HEAD}<assemblyIdentity type="win32" name="Microsoft.VC80.OpenMP" `
        + 'version="8.0.50608.0" processorArchitecture="x86" publicKeyToken="1fc8b3b9a1e18e3b"/>'
        + '<file name="vcomp.dll"/></assembly>';
    const t = setup({
        'C:\\WINDOWS\\WinSxS\\Manifests\\x86_Shared_x.manifest': shared,
        'C:\\WINDOWS\\WinSxS\\x86_Shared_x\\shared.dll': 'MZ',
        'C:\\WINDOWS\\WinSxS\\Policies\\x86_policy.1.0.Shared_x\\1.0.0.9.policy': policy,
        'C:\\app\\test.exe.manifest': app,
        'C:\\app\\Microsoft.VC80.OpenMP\\Microsoft.VC80.OpenMP.manifest': openmp,
    });
    assert.equal(await t.loaderApi.processDefaultFrom(null, 'C:\\app\\test.exe'), null);
    assert.equal(t.loaderApi.redirect('SHARED.dll')?.path,
        'C:\\WINDOWS\\WinSxS\\x86_Shared_x\\shared.dll', 'the store, through its policy');
    assert.equal(t.loaderApi.redirect('vcomp.dll')?.path,
        'C:\\app\\Microsoft.VC80.OpenMP\\vcomp.dll', 'a private assembly in its folder');
    assert.match(String(t.loaderApi.redirect('msvcr80.dll')?.path),
        /^C:\\WINDOWS\\WinSxS\\x86_Microsoft\.VC80\.CRT_1fc8b3b9a1e18e3b_8\.0\.50727\.6195_x-ww_[0-9a-f]{8}\\msvcr80\.dll$/,
        'the engine\'s runtime');
    assert.equal(t.loaderApi.redirect('msvcr80.dll')?.source, null, 'the engine answers it');
    assert.equal(t.loaderApi.redirect('kernel32.dll'), null);

    // msvcr80's own check, as its DllMain makes it: the process default answers.
    const data = 0x700;
    t.view.setUint32(data, 64, true);
    t.putWide(0x800, 'msvcr80.dll');
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 2, 0x800, data]), 1);
    t.putWide(0x800, 'vcomp.dll');
    t.view.setUint32(data, 64, true);
    assert.equal(t.functions.FindActCtxSectionStringW.handler([0, 0, 2, 0x800, data]), 1);
    assert.equal(t.dword(data + 36), 4, 'the fourth assembly of the context');
});

test('a program without a manifest has no context; one naming nothing found fails', async()=>{
    const bare = setup({});
    assert.equal(await bare.loaderApi.processDefaultFrom(null, 'C:\\app\\test.exe'), null);
    assert.equal(bare.loaderApi.hasProcessDefault(), false);
    const missing = setup({ 'C:\\app\\test.exe.manifest': MANIFEST2 });
    assert.match(String(await missing.loaderApi.processDefaultFrom(null, 'C:\\app\\test.exe')),
        /testdep/);
    const embedded = setup({ 'C:\\app\\testdep.manifest': TESTDEP3 });
    assert.equal(await embedded.loaderApi.processDefaultFrom(new TextEncoder().encode(MANIFEST2),
        'C:\\app\\test.exe'), null, 'resource 1 of the image');
    assert.equal(embedded.loaderApi.redirect('testlib.dll')?.path, 'C:\\app\\testlib.dll');
});

test('a runtime the bottle keeps outside the store is seen at its store directory', async()=>{
    const app = `${HEAD}<dependency><dependentAssembly><assemblyIdentity type="win32" `
        + 'name="Microsoft.VC90.CRT" version="9.0.21022.8" processorArchitecture="x86" '
        + 'publicKeyToken="1fc8b3b9a1e18e3b"/></dependentAssembly></dependency></assembly>';
    const t = setup({ 'C:\\app\\test.exe.manifest': app,
        'C:\\WINDOWS\\system32\\msvcr90.dll': 'MZ' });
    assert.equal(await t.loaderApi.processDefaultFrom(null, 'C:\\app\\test.exe'), null);
    const found = t.loaderApi.redirect('msvcr90.dll');
    assert.match(String(found?.path), /^C:\\WINDOWS\\WinSxS\\x86_Microsoft\.VC90\.CRT_/);
    assert.equal(found?.source, 'C:\\WINDOWS\\system32\\msvcr90.dll');

    const none = setup({ 'C:\\app\\test.exe.manifest': app });
    assert.match(String(await none.loaderApi.processDefaultFrom(null, 'C:\\app\\test.exe')),
        /Microsoft\.VC90\.CRT/, 'a runtime the bottle has nowhere is no assembly');
});
