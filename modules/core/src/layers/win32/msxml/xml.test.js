/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDocument, NODE, parseXml, serializeXml, textOf, XmlError } from './xml.js';
import { selectNodes, XPathError } from './xpath.js';

const SETUP = `<?xml version="1.0" encoding="utf-8"?>
<!-- configuration -->
<Setup xmlns="http://schemas.microsoft.com/Setup/2008/01/im" SetupVersion="1.0">
  <UI Dll="SetupUi.dll" Name="Microsoft Visual C++ 2010  x86 Redistributable Setup"/>
  <Configuration>
    <BlockIf ID="a"><Exists><RegKey Location="HKLM\\x"/></Exists></BlockIf>
    <BlockIf ID="b"/>
    <ExpressionAlias Id="One"><Not/></ExpressionAlias>
  </Configuration>
  <LocalizedData>
    <Language LCID="1033"><Text ID="#(loc.x)" LocalizedText="A &amp; B &lt;c&gt; &#65;&#x42;"/></Language>
    <Language LCID="1031"/>
  </LocalizedData>
  <Note><![CDATA[raw <text>]]> and more </Note>
</Setup>`;

test('a document is read into its nodes, the declaration a processing instruction', ()=>{
    const document = parseXml(SETUP);
    assert.equal(document.type, NODE.DOCUMENT);
    assert.deepEqual(document.children.map(node=>[node.type, node.name]),
        [[NODE.PROCESSING_INSTRUCTION, 'xml'], [NODE.COMMENT, '#comment'],
            [NODE.ELEMENT, 'Setup']]);
    assert.equal(document.children[0].value, 'version="1.0" encoding="utf-8"');
    const setup = document.children[2];
    assert.deepEqual(setup.children.map(node=>node.name),
        ['UI', 'Configuration', 'LocalizedData', 'Note'], 'whitespace between elements dropped');
    assert.equal(setup.attributes[0].name, 'xmlns');
    const text = setup.children[2].children[0].children[0];
    assert.equal(text.attributes[1].value, 'A & B <c> AB', 'entities and references');
    const note = setup.children[3];
    assert.deepEqual(note.children.map(node=>node.type), [NODE.CDATA, NODE.TEXT]);
    assert.equal(textOf(note), 'raw <text> and more');
});

test('whitespace is kept when asked, and an error says where', ()=>{
    const kept = parseXml('<a> <b/> </a>', { preserveWhiteSpace: true });
    assert.deepEqual(kept.children[0].children.map(node=>node.type),
        [NODE.TEXT, NODE.ELEMENT, NODE.TEXT]);
    assert.throws(()=>parseXml('<a>\n<b></a>'), e=>e instanceof XmlError && e.line === 2);
    assert.throws(()=>parseXml('<a x="1" x="2"/>'), XmlError);
    assert.throws(()=>parseXml('<a/><b/>'), XmlError);
    assert.throws(()=>parseXml('just text'), XmlError);
    assert.throws(()=>parseXml('<a>&nope;</a>'), XmlError);
});

test('a node is written back as MSXML writes it', ()=>{
    const document = parseXml('<?xml version="1.0"?><a x="1 &amp; &quot;2&quot;"><b/>t&lt;</a>');
    assert.equal(serializeXml(document.children[1]), '<a x="1 &amp; &quot;2&quot;"><b/>t&lt;</a>');
    assert.equal(serializeXml(document), '<?xml version="1.0"?>\r\n<a x="1 &amp; &quot;2&quot;">'
        + '<b/>t&lt;</a>\r\n');
});

test('bytes are decoded by their mark, their zeros or their declaration', ()=>{
    const wide = new Uint8Array([0xff, 0xfe, 0x3c, 0, 0x61, 0, 0x2f, 0, 0x3e, 0]);
    assert.equal(decodeDocument(wide), '<a/>');
    assert.equal(decodeDocument(new TextEncoder().encode('<a>é</a>')), '<a>é</a>');
    const encode = (/** @type {string} */ text)=>new TextEncoder().encode(text);
    assert.equal(decodeDocument(Uint8Array.of(...encode('<?xml encoding="windows-1252"?><a>'),
        0xe9, ...encode('</a>'))), '<?xml encoding="windows-1252"?><a>é</a>');
});

test('the paths a setup engine selects with', ()=>{
    const document = parseXml(SETUP);
    const names = (/** @type {import('./xml.js').XmlNode} */ from, /** @type {string} */ path)=>
        selectNodes(from, path).map(node=>node.attributes[0]?.value ?? node.name);
    assert.deepEqual(names(document, '//Setup/LocalizedData/Language'), ['1033', '1031']);
    assert.deepEqual(names(document, '//*[@Id=\'One\']'), ['One']);
    assert.deepEqual(names(document, '//BlockIf[@ID]'), ['a', 'b']);
    const setup = document.children[2];
    assert.deepEqual(names(setup, './/ExpressionAlias'), ['One']);
    assert.deepEqual(names(setup, 'Configuration/BlockIf[2]'), ['b']);
    assert.deepEqual(names(setup, 'Configuration/BlockIf[last()]'), ['b']);
    assert.deepEqual(names(setup, '//Language[@LCID="1031" or @LCID="9"]'), ['1031']);
    assert.deepEqual(names(setup, 'UI/@Dll'), ['UI/@Dll'].map(()=>'Dll'));
    assert.equal(selectNodes(setup, 'Note/text()').length, 2, 'a CDATA section is text too');
    assert.deepEqual(names(setup, '//BlockIf[not(@ID="a")] | //ExpressionAlias'), ['b', 'One']);
    assert.deepEqual(names(document.children[2].children[1].children[0], '..'), ['Configuration']);
    assert.deepEqual(names(setup, '/Setup/UI'), ['SetupUi.dll']);
    assert.equal(selectNodes(setup, '//Nothing').length, 0);
    assert.throws(()=>selectNodes(setup, 'a[@'), XPathError);
    assert.throws(()=>selectNodes(setup, 'count(//a)'), XPathError, 'not a node set');
});
