/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    compareVersions, encodeIdentity, identityMatches, parseManifest, parseXml,
} from './manifest.js';

const utf8 = (/** @type {string} */ text)=>new TextEncoder().encode(text);
const HEAD = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">';
const ID = '<assemblyIdentity version="1.0.0.0"  name="Wine.Test" type="win32"></assemblyIdentity>';

/** @param {string} text */
const read = text=>{
    const parsed = parseManifest(utf8(text));
    if ('refused' in parsed)
    {
        throw new Error(parsed.refused);
    }
    return parsed.manifest;
};

test('a manifest gives its identity, files, window classes and dependencies', ()=>{
    const manifest = read(`${HEAD}<assemblyIdentity version="1.2.3.4" name="Wine.Test" type="win32"
        publicKeyToken="6595b6414666f1df" /><description />
        <file name="testlib.dll"><windowClass>wndClass</windowClass>
        <windowClass versioned="no">plain</windowClass></file>
        <file name="other.dll" loadFrom="%SystemRoot%\\x.dll"/>
        <dependency><dependentAssembly><assemblyIdentity type="win32" name="testdep"
        version="6.5.4.3" processorArchitecture="x86"/></dependentAssembly></dependency>
        </assembly>`);
    assert.deepEqual(manifest.identity, { name: 'Wine.Test', type: 'win32', version: [1, 2, 3, 4],
        processorArchitecture: null, publicKeyToken: '6595b6414666f1df', language: null });
    assert.deepEqual(manifest.files.map(file=>file.name), ['testlib.dll', 'other.dll']);
    assert.deepEqual(manifest.files[0].windowClasses,
        [{ name: 'wndClass', versioned: true }, { name: 'plain', versioned: false }]);
    assert.equal(manifest.files[1].loadFrom, '%SystemRoot%\\x.dll');
    assert.equal(manifest.dependencies.length, 1);
    assert.equal(manifest.dependencies[0].identity.name, 'testdep');
    assert.equal(encodeIdentity(/** @type {any} */ (manifest.identity)),
        'Wine.Test,publicKeyToken="6595b6414666f1df",type="win32",version="1.2.3.4"');
});

test('spaces around an attribute\'s equals sign, a BOM, and UTF-16 with its BOM are read', ()=>{
    const spaced = '<assembly xmlns = "urn:schemas-microsoft-com:asm.v1" manifestVersion = "1.0">'
        + '<assemblyIdentity version = "1.0.0.0" name = "Wine.Test" type = "win32">'
        + '</assemblyIdentity></assembly>';
    assert.equal(read(spaced).identity?.name, 'Wine.Test');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(`${HEAD}${ID}</assembly>`)]);
    assert.ok('manifest' in parseManifest(bom));
    const text = `${HEAD}${ID}</assembly>`;
    const wide = new Uint8Array(2 + text.length * 2);
    wide.set([0xff, 0xfe]);
    [...text].forEach((c, i)=>{
        wide[2 + i * 2] = c.charCodeAt(0);
    });
    assert.ok('manifest' in parseManifest(wide));
    assert.ok('refused' in parseManifest(wide.subarray(2)), 'without its BOM');
    const padded = new Uint8Array([...utf8(`${HEAD}${ID}</assembly>`), 0, 0, 0]);
    assert.ok('manifest' in parseManifest(padded), 'a resource padded with NULs');
});

test('what Windows refuses is refused', ()=>{
    const refused = (/** @type {string} */ text)=>'refused' in parseManifest(utf8(text));
    assert.ok(refused(`<assembly manifestVersion="1.0">${ID}</assembly>`), 'no namespace');
    assert.ok(refused(`<assembly xmlns="urn:schemas-microsoft-com:asm.v1">${ID}</assembly>`),
        'no manifest version');
    assert.ok(refused(`${HEAD}${ID}</assembly><test></test>`), 'something after the root');
    assert.ok(refused(`<assembly xmlns="urn:schemas-microsoft-com:asm.v5" manifestVersion="1.0">`
        + `${ID}</assembly>`), 'another namespace');
    assert.ok(refused(`${HEAD}${ID}<file></file></assembly>`), 'a file without a name');
    assert.ok(refused(`${HEAD}${ID}<trustInfo xmlns="urn:schemas-microsoft-com:asm.v2"><security>`
        + '<requestedPrivileges><requestedExecutionLevel level="requireAdministrator"/>'
        + '<requestedExecutionLevel uiAccess="true"/></requestedPrivileges></security>'
        + '</trustInfo></assembly>'), 'a run level twice');
    assert.ok(refused(`${HEAD}${ID}<file name="a.dll"><activatableClass name="C" `
        + 'threadingModel="both" /></file></assembly>'), 'WinRT outside its namespace');
    assert.ok(refused(`${HEAD}<assemblyIdentity name="x" version="1.0"/></assembly>`),
        'a version of two parts');
    assert.ok(!refused(`${HEAD}${ID}<test></test></assembly>`),
        'an element nothing reads is passed over');
    assert.ok(!refused('<assembly xmlns="urn:schemas-microsoft-com:asm.v3" manifestVersion="1.0">'
        + '<dependency/></assembly>'), 'asm.v3, no identity, an empty dependency');
});

test('the run level, compatibility and settings are read, an undeclared prefix included', ()=>{
    const manifest = read(`${HEAD}${ID}<asmv3:application><asmv3:windowsSettings
        xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings"><dpiAware>true</dpiAware>
        </asmv3:windowsSettings></asmv3:application>
        <trustInfo xmlns="urn:schemas-microsoft-com:asm.v2"><security><requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="TRUE"/>
        </requestedPrivileges></security></trustInfo>
        <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application>
        <supportedOS Id="{E2011457-1546-43c5-a5fe-008deee3d3f0}"/>
        <maxversiontested Id="10.0.18358"/></application></compatibility></assembly>`);
    assert.deepEqual(manifest.runLevel, { level: 3, uiAccess: true });
    assert.deepEqual(manifest.compatibility,
        { supportedOs: ['{e2011457-1546-43c5-a5fe-008deee3d3f0}'],
            maxVersionTested: ['10.0.18358'] });
    assert.deepEqual(manifest.settings.get('dpiAware'),
        { namespace: 'http://schemas.microsoft.com/SMI/2005/WindowsSettings', value: 'true' });
});

test('a publisher policy gives its binding redirects for the assembly it names', ()=>{
    const policy = read('<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">'
        + '<assemblyIdentity type="win32-policy" name="policy.8.0.Microsoft.VC80.CRT" '
        + 'version="8.0.50727.6195" processorArchitecture="x86" publicKeyToken="1fc8b3b9a1e18e3b"/>'
        + '<dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.VC80.CRT" '
        + 'processorArchitecture="x86" publicKeyToken="1fc8b3b9a1e18e3b"/>'
        + '<bindingRedirect oldVersion="8.0.41204.256-8.0.50608.0" newVersion="8.0.50727.6195"/>'
        + '</dependentAssembly></dependency></assembly>');
    assert.equal(policy.redirectsFor?.name, 'Microsoft.VC80.CRT');
    assert.deepEqual(policy.redirects, [{ oldVersion: [[8, 0, 41204, 256], [8, 0, 50608, 0]],
        newVersion: [8, 0, 50727, 6195] }]);
    assert.deepEqual(policy.dependencies, [], 'a redirect is no dependency');
});

test('a dependency is answered by the same assembly at exactly its version', ()=>{
    const wanted = { name: 'testdep', type: 'win32', version: [6, 5, 4, 3],
        processorArchitecture: 'x86', publicKeyToken: null, language: '*' };
    assert.ok(identityMatches(wanted, { ...wanted, name: 'TESTDEP', language: 'fr-FR' }));
    assert.ok(!identityMatches(wanted, { ...wanted, version: [6, 5, 4, 4] }));
    assert.ok(!identityMatches(wanted, { ...wanted, processorArchitecture: 'amd64' }));
    assert.equal(compareVersions([8, 0, 50727, 762], [8, 0, 50727, 6195]), -1);
});

test('XML: entities, comments, CDATA, and what is not XML', ()=>{
    const root = parseXml('<?xml version="1.0"?><!-- c --><a x="&lt;&#65;&#x42;"><b>t&amp;u</b>'
        + '<![CDATA[<raw>]]></a>');
    assert.ok(typeof root !== 'string');
    assert.equal(root.attributes.get('x'), '<AB');
    assert.equal(root.children[0].text, 't&u');
    assert.equal(root.text, '<raw>');
    assert.equal(typeof parseXml('<a><b></a>'), 'string');
    assert.equal(typeof parseXml('<a x="1" x="2"/>'), 'string');
    assert.equal(typeof parseXml('<a/><b/>'), 'string');
});
