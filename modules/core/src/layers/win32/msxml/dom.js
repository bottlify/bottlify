/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MSXML's DOM: the DOMDocument classes of every version a program names -
 * MSXML 2.0's (Microsoft.XMLDOM), 2.6, 3.0, 4.0 and 6.0, the version-
 * independent MSXML2 one and their free-threaded twins - and the nodes,
 * node lists, attribute maps and parse errors they hand out, through the
 * vtables of msxml.h and msxml2.h.
 *
 * A setup engine reads its configuration with it: loadXML or load, the
 * document element, selectNodes and selectSingleNode with simple paths
 * (`xpath.js`), attributes and text. What is read and written is XML 1.0
 * (`xml.js`). Every node of a document is one object while a program holds
 * it, so the same node handed out twice is the same pointer, and each answers
 * the interfaces of its kind. A document loads before load returns, async
 * or not, its readyState complete.
 *
 * IDispatch is there for the vtable's shape: no type information, and
 * Invoke refused, said once - a script that drives the DOM through it is
 * not served yet. Typed values (dataType), XSLT (transformNode), schemas and
 * namespaces collections are refused the same way.
 */

import { createComObject } from '../ole32/objects.js';
import {
    decodeDocument, makeNode, NODE, NODE_TYPE_STRINGS, parseXml, serializeXml, textOf, XmlError,
} from './xml.js';
import { selectNodes, XPathError } from './xpath.js';

/** @typedef {import('./xml.js').XmlNode} XmlNode */
/** @typedef {import('../ole32/objects.js').ComMethod} ComMethod */

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** A node of a kind that cannot take the child or the call. */
const E_UNEXPECTED = 0x8000ffff | 0;
/** What a document that did not parse answers in its parse error (XML_E_*). */
const XML_E_INVALID = 0xc00ce502 | 0;
const XML_E_MISSINGROOT = 0xc00ce558 | 0;
/** INET_E_RESOURCE_NOT_FOUND: a file load could not find. */
const RESOURCE_NOT_FOUND = 0x800c0005 | 0;

const VT_NULL = 1;
const VT_I2 = 2;
const VT_I4 = 3;
const VT_BSTR = 8;
const VT_DISPATCH = 9;
const VT_BOOL = 11;
const VT_VARIANT = 12;
const VT_UNKNOWN = 13;
const VT_UI1 = 17;
const VT_ARRAY = 0x2000;
const VT_BYREF = 0x4000;

/** How far a string of the DOM is read. */
const MAX_TEXT = 0x400000;

export const IID = Object.freeze({
    DISPATCH: '{00020400-0000-0000-C000-000000000046}',
    NODE: '{2933BF80-7B36-11D2-B20E-00C04F983E60}',
    DOCUMENT: '{2933BF81-7B36-11D2-B20E-00C04F983E60}',
    NODE_LIST: '{2933BF82-7B36-11D2-B20E-00C04F983E60}',
    NAMED_NODE_MAP: '{2933BF83-7B36-11D2-B20E-00C04F983E60}',
    CHARACTER_DATA: '{2933BF84-7B36-11D2-B20E-00C04F983E60}',
    ATTRIBUTE: '{2933BF85-7B36-11D2-B20E-00C04F983E60}',
    ELEMENT: '{2933BF86-7B36-11D2-B20E-00C04F983E60}',
    TEXT: '{2933BF87-7B36-11D2-B20E-00C04F983E60}',
    COMMENT: '{2933BF88-7B36-11D2-B20E-00C04F983E60}',
    PROCESSING_INSTRUCTION: '{2933BF89-7B36-11D2-B20E-00C04F983E60}',
    CDATA: '{2933BF8A-7B36-11D2-B20E-00C04F983E60}',
    DOCUMENT2: '{2933BF95-7B36-11D2-B20E-00C04F983E60}',
    FRAGMENT: '{3EFAA413-272F-11D2-836F-0000F87A7782}',
    PARSE_ERROR: '{3EFAA426-272F-11D2-836F-0000F87A7782}',
    SELECTION: '{AA634FC7-5888-44A7-A257-3A47150D3A0E}',
});

/** The interface of each kind of node, as the methods that hand one out declare it. */
const KIND_IIDS = /** @type {Record<number, string>} */ (Object.freeze({
    1: IID.ELEMENT, 2: IID.ATTRIBUTE, 3: IID.TEXT, 4: IID.CDATA, 7: IID.PROCESSING_INSTRUCTION,
    8: IID.COMMENT, 9: IID.DOCUMENT, 11: IID.FRAGMENT,
}));

/**
 * The DOMDocument classes, by CLSID, and the version each is: the
 * version-independent ones are 3.0's, as MSXML 3 serves them.
 */
export const DOCUMENT_CLASSES = Object.freeze([
    { clsid: '{2933BF90-7B36-11D2-B20E-00C04F983E60}', version: 2,
        progIds: ['Microsoft.XMLDOM', 'MSXML.DOMDocument', 'Microsoft.XMLDOM.1.0'] },
    { clsid: '{2933BF91-7B36-11D2-B20E-00C04F983E60}', version: 2,
        progIds: ['Microsoft.FreeThreadedXMLDOM', 'MSXML.FreeThreadedDOMDocument'] },
    { clsid: '{F6D90F11-9C73-11D3-B32E-00C04F990BB4}', version: 3,
        progIds: ['Msxml2.DOMDocument'] },
    { clsid: '{F6D90F12-9C73-11D3-B32E-00C04F990BB4}', version: 3,
        progIds: ['Msxml2.FreeThreadedDOMDocument'] },
    { clsid: '{F5078F1B-C551-11D3-89B9-0000F81FE221}', version: 2.6,
        progIds: ['Msxml2.DOMDocument.2.6'] },
    { clsid: '{F5078F1C-C551-11D3-89B9-0000F81FE221}', version: 2.6,
        progIds: ['Msxml2.FreeThreadedDOMDocument.2.6'] },
    { clsid: '{F5078F32-C551-11D3-89B9-0000F81FE221}', version: 3,
        progIds: ['Msxml2.DOMDocument.3.0'] },
    { clsid: '{F5078F33-C551-11D3-89B9-0000F81FE221}', version: 3,
        progIds: ['Msxml2.FreeThreadedDOMDocument.3.0'] },
    { clsid: '{88D969C0-F192-11D4-A65F-0040963251E5}', version: 4,
        progIds: ['Msxml2.DOMDocument.4.0'] },
    { clsid: '{88D969C1-F192-11D4-A65F-0040963251E5}', version: 4,
        progIds: ['Msxml2.FreeThreadedDOMDocument.4.0'] },
    { clsid: '{88D96A05-F192-11D4-A65F-0040963251E5}', version: 6,
        progIds: ['Msxml2.DOMDocument.6.0'] },
    { clsid: '{88D96A06-F192-11D4-A65F-0040963251E5}', version: 6,
        progIds: ['Msxml2.FreeThreadedDOMDocument.6.0'] },
]);

/**
 * @typedef {Object} MsxmlHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown }} heap
 *     the task heap BSTRs come from, as SysAllocString's
 * @property {import('../ole32/objects.js').ComRegistry} registry
 * @property {{ publish: (object: any, interfaceId: string) => number }} vtables
 * @property {(path: string) => Promise<Uint8Array | null>} readFile
 * @property {(path: string, bytes: Uint8Array) => Promise<boolean>} [writeFile]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} DocumentState
 * @property {XmlNode} root
 * @property {number} version
 * @property {boolean} async
 * @property {boolean} preserveWhiteSpace
 * @property {boolean} validateOnParse
 * @property {boolean} resolveExternals
 * @property {string} url
 * @property {{ code: number, reason: string, line: number, column: number, at: number,
 *     source: string, url: string }} error
 * @property {Map<string, string>} properties
 */

const NO_ERROR = Object.freeze({ code: 0, reason: '', line: 0, column: 0, at: 0, source: '',
    url: '' });

/**
 * Methods in vtable order, `words` the arguments each takes after `this`.
 *
 * @param {[string, number][]} slots
 * @param {Record<string, (args: number[], self: any) => number | Promise<number>>} handlers
 * @param {(name: string) => number} refuse
 * @returns {ComMethod[]}
 */
const methods = (slots, handlers, refuse)=>slots.map(([name, words])=>({
    name, argBytes: 4 + words * 4,
    invoke: (/** @type {any} */ object, /** @type {number[]} */ args)=>{
        // A document CoCreateInstance made is known by its node from its first call.
        object?.state?.adopt?.(object);
        const handler = handlers[name];
        return handler ? handler(args, object) : refuse(name);
    },
}));

const DISPATCH_SLOTS = /** @type {[string, number][]} */ ([['GetTypeInfoCount', 1],
    ['GetTypeInfo', 3], ['GetIDsOfNames', 5], ['Invoke', 8]]);
const NODE_SLOTS = /** @type {[string, number][]} */ ([['get_nodeName', 1], ['get_nodeValue', 1],
    ['put_nodeValue', 4], ['get_nodeType', 1], ['get_parentNode', 1], ['get_childNodes', 1],
    ['get_firstChild', 1], ['get_lastChild', 1], ['get_previousSibling', 1],
    ['get_nextSibling', 1], ['get_attributes', 1], ['insertBefore', 6], ['replaceChild', 3],
    ['removeChild', 2], ['appendChild', 2], ['hasChildNodes', 1], ['get_ownerDocument', 1],
    ['cloneNode', 2], ['get_nodeTypeString', 1], ['get_text', 1], ['put_text', 1],
    ['get_specified', 1], ['get_definition', 1], ['get_nodeTypedValue', 1],
    ['put_nodeTypedValue', 4], ['get_dataType', 1], ['put_dataType', 1], ['get_xml', 1],
    ['transformNode', 2], ['selectNodes', 2], ['selectSingleNode', 2], ['get_parsed', 1],
    ['get_namespaceURI', 1], ['get_prefix', 1], ['get_baseName', 1],
    ['transformNodeToObject', 5]]);
const DOCUMENT_SLOTS = /** @type {[string, number][]} */ ([['get_doctype', 1],
    ['get_implementation', 1], ['get_documentElement', 1], ['putref_documentElement', 1],
    ['createElement', 2], ['createDocumentFragment', 1], ['createTextNode', 2],
    ['createComment', 2], ['createCDATASection', 2], ['createProcessingInstruction', 3],
    ['createAttribute', 2], ['createEntityReference', 2], ['getElementsByTagName', 2],
    ['createNode', 7], ['nodeFromID', 2], ['load', 5], ['get_readyState', 1],
    ['get_parseError', 1], ['get_url', 1], ['get_async', 1], ['put_async', 1], ['abort', 0],
    ['loadXML', 2], ['save', 4], ['get_validateOnParse', 1], ['put_validateOnParse', 1],
    ['get_resolveExternals', 1], ['put_resolveExternals', 1], ['get_preserveWhiteSpace', 1],
    ['put_preserveWhiteSpace', 1], ['put_onreadystatechange', 4], ['put_ondataavailable', 4],
    ['put_ontransformnode', 4]]);
const DOCUMENT2_SLOTS = /** @type {[string, number][]} */ ([['get_namespaces', 1],
    ['get_schemas', 1], ['putref_schemas', 4], ['validate', 1], ['setProperty', 5],
    ['getProperty', 2]]);
const ELEMENT_SLOTS = /** @type {[string, number][]} */ ([['get_tagName', 1],
    ['getAttribute', 2], ['setAttribute', 5], ['removeAttribute', 1], ['getAttributeNode', 2],
    ['setAttributeNode', 2], ['removeAttributeNode', 2], ['getElementsByTagName', 2],
    ['normalize', 0]]);
const ATTRIBUTE_SLOTS = /** @type {[string, number][]} */ ([['get_name', 1], ['get_value', 1],
    ['put_value', 4]]);
const CHARACTER_SLOTS = /** @type {[string, number][]} */ ([['get_data', 1], ['put_data', 1],
    ['get_length', 1], ['substringData', 3], ['appendData', 1], ['insertData', 2],
    ['deleteData', 2], ['replaceData', 3]]);
const PI_SLOTS = /** @type {[string, number][]} */ ([['get_target', 1], ['get_data', 1],
    ['put_data', 1]]);
const LIST_SLOTS = /** @type {[string, number][]} */ ([['get_item', 2], ['get_length', 1],
    ['nextNode', 1], ['reset', 0], ['get__newEnum', 1]]);
const MAP_SLOTS = /** @type {[string, number][]} */ ([['getNamedItem', 2], ['setNamedItem', 2],
    ['removeNamedItem', 2], ['get_item', 2], ['get_length', 1], ['getQualifiedItem', 3],
    ['removeQualifiedItem', 3], ['nextNode', 1], ['reset', 0], ['get__newEnum', 1]]);
const ERROR_SLOTS = /** @type {[string, number][]} */ ([['get_errorCode', 1], ['get_url', 1],
    ['get_reason', 1], ['get_srcText', 1], ['get_line', 1], ['get_linepos', 1],
    ['get_filepos', 1]]);

/**
 * Registers every DOMDocument class.
 *
 * @param {MsxmlHost} host
 */
export function registerMsxmlClasses(host){
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>{
        if (!said.has(api))
        {
            said.add(api);
            host.divergence?.(api, detail);
        }
    };
    /** @param {string} name */
    const refuse = name=>{
        diverge(`IXMLDOM::${name}`, 'not served by this DOM; refused');
        return E_NOTIMPL;
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
            host.writeMemory(address >>> 0, bytes);
        }
    };
    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {boolean} value */
    const writeBool = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(address >>> 0, Uint8Array.of(value ? 0xff : 0, value ? 0xff : 0));
        }
    };
    /** @param {number} bstr */
    const readBstr = bstr=>((bstr >>> 0) === 0 ? ''
        : host.readWideString(bstr >>> 0, MAX_TEXT * 2));
    /** @param {string} text @returns {number} a BSTR from the heap, or 0 */
    const allocateBstr = text=>{
        const block = host.heap.allocate(4 + text.length * 2 + 2) >>> 0;
        if (block === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array(4 + text.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, text.length * 2, true);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(4 + i * 2, text.charCodeAt(i), true);
        }
        host.writeMemory(block, bytes);
        return block + 4;
    };
    /** A string answered through a BSTR*. @param {number} out @param {string} text */
    const answerString = (out, text)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const bstr = allocateBstr(text);
        writeU32(out, bstr);
        return bstr === 0 ? E_OUTOFMEMORY : S_OK;
    };
    /**
     * A VARIANT answered: a string, NULL for null, or a number.
     *
     * @param {number} out @param {string | number | null} value
     */
    const answerVariant = (out, value)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        if (value === null)
        {
            view.setUint16(0, VT_NULL, true);
        }
        else if (typeof value === 'number')
        {
            view.setUint16(0, VT_I4, true);
            view.setInt32(8, value, true);
        }
        else
        {
            const bstr = allocateBstr(value);
            if (bstr === 0)
            {
                return E_OUTOFMEMORY;
            }
            view.setUint16(0, VT_BSTR, true);
            view.setUint32(8, bstr, true);
        }
        host.writeMemory(out >>> 0, bytes);
        return S_OK;
    };
    /**
     * The bytes of a one-dimensional SAFEARRAY of VT_UI1: cDims at 0, the data
     * pointer at 12, the bound's element count at 16.
     *
     * @param {number} array
     */
    const arrayBytes = array=>{
        const header = new DataView(host.readMemory(array, 24).slice().buffer);
        return header.getUint16(0, true) === 1
            ? host.readMemory(header.getUint32(12, true), header.getUint32(16, true)).slice()
            : new Uint8Array(0);
    };
    /**
     * A VARIANT passed by value, as its four words: a string, a number, an
     * interface pointer, an array of bytes, or null for empty.
     *
     * @param {number[]} words
     * @returns {{ kind: 'string', value: string } | { kind: 'number', value: number }
     *     | { kind: 'object', value: number } | { kind: 'bytes', value: Uint8Array }
     *     | { kind: 'empty' }}
     */
    const readVariant = words=>{
        let type = words[0] & 0xffff;
        let low = words[2] >>> 0;
        if ((type & VT_BYREF) !== 0)
        {
            const pointed = low;
            type &= ~VT_BYREF;
            if (type === VT_VARIANT)
            {
                const inner = host.readMemory(pointed, 16).slice();
                const view = new DataView(inner.buffer);
                return readVariant([view.getUint32(0, true), 0, view.getUint32(8, true)]);
            }
            low = readU32(pointed);
        }
        switch (type)
        {
            case VT_BSTR:
                return { kind: 'string', value: readBstr(low) };
            case VT_I2:
                return { kind: 'number', value: (low << 16) >> 16 };
            case VT_I4:
                return { kind: 'number', value: low | 0 };
            case VT_BOOL:
                return { kind: 'number', value: (low & 0xffff) === 0 ? 0 : -1 };
            case VT_DISPATCH:
            case VT_UNKNOWN:
                return low === 0 ? { kind: 'empty' } : { kind: 'object', value: low };
            case VT_ARRAY | VT_UI1:
                return low === 0 ? { kind: 'empty' } : { kind: 'bytes', value: arrayBytes(low) };
            default:
                return { kind: 'empty' };
        }
    };

    /** The document a node belongs to, by its root. @type {WeakMap<XmlNode, DocumentState>} */
    const documents = new WeakMap();
    /** The objects of the nodes a program holds. @type {Map<XmlNode, any>} */
    const objects = new Map();
    /** The nodes behind the pointers handed out. @type {Map<number, XmlNode>} */
    const nodesByPointer = new Map();

    /** @param {XmlNode} node */
    const rootOf = node=>{
        let at = node;
        while (at.parent)
        {
            at = at.parent;
        }
        return at;
    };
    /** @param {XmlNode} node @returns {DocumentState | null} */
    const documentOf = node=>documents.get(rootOf(node)) ?? null;
    /** @param {XmlNode} node */
    const ownerOf = node=>{
        /** @type {any} */
        const owner = /** @type {any} */ (node).owner;
        return owner ?? rootOf(node);
    };

    /** The interface a node is answered as by default. @param {XmlNode} node */
    const primaryIid = node=>(node.type === NODE.DOCUMENT ? IID.DOCUMENT2 : IID.NODE);

    /**
     * A node's pointer as `iid`, holding a reference of its own; 0 when it
     * could not be made.
     *
     * @param {XmlNode} node @param {string} [iid]
     */
    const pointerOf = (node, iid = IID.NODE)=>{
        let object = objects.get(node);
        if (object && !object.destroyed)
        {
            object.addRef();
        }
        else
        {
            object = createComObject(node.type === NODE.DOCUMENT
                ? DOCUMENT_CLASSES[6].clsid : '{2933BF80-7B36-11D2-B20E-00C04F983E60}',
            definitionOf(node));
            objects.set(node, object);
        }
        const pointer = host.vtables.publish(object, iid) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return 0;
        }
        nodesByPointer.set(pointer, node);
        return pointer;
    };
    /**
     * A node answered through an out-parameter as `iid`, NULL and S_FALSE
     * for none.
     *
     * @param {number} out @param {XmlNode | null | undefined} node @param {string} [iid]
     */
    const answerNode = (out, node, iid = IID.NODE)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        if (!node)
        {
            writeU32(out, 0);
            return S_FALSE;
        }
        const pointer = pointerOf(node, iid);
        writeU32(out, pointer);
        return pointer === 0 ? E_OUTOFMEMORY : S_OK;
    };
    /**
     * A node answered as the interface of its own kind, for a method whose
     * out-parameter names that interface: IXMLDOMElement** is a vtable with
     * the element's methods, and a program calls through it by slot.
     *
     * @param {number} out @param {XmlNode | null | undefined} node
     */
    const answerTyped = (out, node)=>answerNode(out, node, node ? KIND_IIDS[node.type] ?? IID.NODE
        : IID.NODE);
    /** The node behind a pointer a program passed, if it is one of ours. @param {number} pointer */
    const nodeAt = pointer=>nodesByPointer.get(pointer >>> 0) ?? null;

    /** @param {XmlNode} node */
    const detach = node=>{
        if (node.parent)
        {
            const list = node.type === NODE.ATTRIBUTE ? node.parent.attributes
                : node.parent.children;
            list.splice(list.indexOf(node), 1);
            node.parent = null;
        }
    };
    /** Whether `child` may go under `parent`. @param {XmlNode} parent @param {XmlNode} child */
    const mayHold = (parent, child)=>{
        if (child.type === NODE.ATTRIBUTE || child.type === NODE.DOCUMENT)
        {
            return false;
        }
        for (let at = /** @type {XmlNode | null} */ (parent); at; at = at.parent)
        {
            if (at === child)
            {
                return false;
            }
        }
        if (parent.type === NODE.DOCUMENT)
        {
            return child.type !== NODE.TEXT && child.type !== NODE.CDATA
                && !(child.type === NODE.ELEMENT
                    && parent.children.some(one=>one.type === NODE.ELEMENT));
        }
        return parent.type === NODE.ELEMENT || parent.type === NODE.FRAGMENT;
    };
    /**
     * Puts `child` under `parent`, before `before` or last; a fragment's
     * children go in its place.
     *
     * @param {XmlNode} parent @param {XmlNode} child @param {XmlNode | null} before
     */
    const insert = (parent, child, before)=>{
        const moving = child.type === NODE.FRAGMENT ? [...child.children] : [child];
        for (const one of moving)
        {
            detach(one);
            const at = before ? parent.children.indexOf(before) : -1;
            parent.children.splice(at < 0 ? parent.children.length : at, 0, one);
            one.parent = parent;
        }
    };
    /** @param {XmlNode} node @param {boolean} deep @returns {XmlNode} */
    const clone = (node, deep)=>{
        const copy = makeNode(node.type, node.name, node.value);
        /** @type {any} */ (copy).owner = ownerOf(node);
        for (const attribute of node.attributes)
        {
            const made = makeNode(NODE.ATTRIBUTE, attribute.name, attribute.value);
            made.parent = copy;
            copy.attributes.push(made);
        }
        if (deep)
        {
            for (const child of node.children)
            {
                const made = clone(child, true);
                made.parent = copy;
                copy.children.push(made);
            }
        }
        return copy;
    };
    /** The namespace a prefix names where `node` is. @param {XmlNode} node @param {string} prefix */
    const namespaceOf = (node, prefix)=>{
        if (prefix === 'xml')
        {
            return 'http://www.w3.org/XML/1998/namespace';
        }
        const name = prefix ? `xmlns:${prefix}` : 'xmlns';
        for (let at = /** @type {XmlNode | null} */ (node.type === NODE.ATTRIBUTE
            ? node.parent : node); at; at = at.parent)
        {
            const found = at.attributes.find(one=>one.name === name);
            if (found)
            {
                return found.value;
            }
        }
        return '';
    };
    /** @param {string} name */
    const prefixOf = name=>(name.includes(':') ? name.slice(0, name.indexOf(':')) : '');

    /**
     * A node list: the nodes `nodes` answers each time it is asked, and a
     * cursor for nextNode.
     *
     * @param {() => XmlNode[]} nodes
     */
    const makeList = nodes=>{
        let cursor = 0;
        const handlers = {
            get_item: (/** @type {number[]} */ [index, out])=>answerNode(out, nodes()[index | 0]),
            get_length: (/** @type {number[]} */ [out])=>{
                writeU32(out, nodes().length);
                return S_OK;
            },
            nextNode: (/** @type {number[]} */ [out])=>answerNode(out, nodes()[cursor++]),
            reset: ()=>{
                cursor = 0;
                return S_OK;
            },
        };
        const listMethods = [...methods(DISPATCH_SLOTS, dispatchHandlers, refuse),
            ...methods(LIST_SLOTS, handlers, refuse)];
        return createComObject(IID.NODE_LIST, { interfaces: [
            { id: IID.NODE_LIST, methods: listMethods },
            { id: IID.SELECTION, methods: listMethods },
            { id: IID.DISPATCH, methods: listMethods.slice(0, 4) },
        ] });
    };
    /** @param {number} out @param {() => XmlNode[]} nodes */
    const answerList = (out, nodes)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const pointer = host.vtables.publish(makeList(nodes), IID.NODE_LIST) >>> 0;
        writeU32(out, pointer);
        return pointer === 0 ? E_OUTOFMEMORY : S_OK;
    };

    /** An element's attributes as a named node map. @param {XmlNode} element */
    const makeMap = element=>{
        let cursor = 0;
        /** @param {string} name */
        const named = name=>element.attributes.find(one=>one.name === name);
        const handlers = {
            getNamedItem: (/** @type {number[]} */ [name, out])=>answerNode(out, named(readBstr(name))),
            setNamedItem: (/** @type {number[]} */ [pointer, out])=>{
                const node = nodeAt(pointer);
                if (!node || node.type !== NODE.ATTRIBUTE)
                {
                    return E_INVALIDARG;
                }
                const old = named(node.name);
                if (old)
                {
                    detach(old);
                }
                detach(node);
                node.parent = element;
                element.attributes.push(node);
                return (out >>> 0) === 0 ? S_OK : answerNode(out, node);
            },
            removeNamedItem: (/** @type {number[]} */ [name, out])=>{
                const node = named(readBstr(name));
                if (node)
                {
                    detach(node);
                }
                return (out >>> 0) === 0 ? node ? S_OK : S_FALSE : answerNode(out, node);
            },
            get_item: (/** @type {number[]} */ [index, out])=>
                answerNode(out, element.attributes[index | 0]),
            get_length: (/** @type {number[]} */ [out])=>{
                writeU32(out, element.attributes.length);
                return S_OK;
            },
            getQualifiedItem: (/** @type {number[]} */ [name, uri, out])=>{
                const local = readBstr(name);
                const space = readBstr(uri);
                return answerNode(out, element.attributes.find(one=>
                    (one.name === local || one.name.endsWith(`:${local}`))
                    && namespaceOf(one, prefixOf(one.name)) === space)
                    ?? (space === '' ? named(local) : undefined));
            },
            nextNode: (/** @type {number[]} */ [out])=>answerNode(out, element.attributes[cursor++]),
            reset: ()=>{
                cursor = 0;
                return S_OK;
            },
        };
        const mapMethods = [...methods(DISPATCH_SLOTS, dispatchHandlers, refuse),
            ...methods(MAP_SLOTS, handlers, refuse)];
        return createComObject(IID.NAMED_NODE_MAP, { interfaces: [
            { id: IID.NAMED_NODE_MAP, methods: mapMethods },
            { id: IID.DISPATCH, methods: mapMethods.slice(0, 4) },
        ] });
    };

    const dispatchHandlers = {
        GetTypeInfoCount: (/** @type {number[]} */ [out])=>{
            writeU32(out, 0);
            return S_OK;
        },
    };

    /** The node methods, IDispatch's first, as every node interface begins. @param {XmlNode} node */
    const nodeMethods = node=>methods(DISPATCH_SLOTS, dispatchHandlers, refuse).concat(
        methods(NODE_SLOTS, {
            get_nodeName: ([out])=>answerString(out, node.name),
            get_nodeValue: ([out])=>(node.type === NODE.ELEMENT || node.type === NODE.DOCUMENT
                || node.type === NODE.FRAGMENT ? answerVariant(out, null)
                : answerVariant(out, node.value)),
            put_nodeValue: words=>{
                if (node.type === NODE.ELEMENT || node.type === NODE.DOCUMENT
                    || node.type === NODE.FRAGMENT)
                {
                    return E_FAIL;
                }
                const value = readVariant(words);
                node.value = value.kind === 'string' ? value.value
                    : value.kind === 'number' ? String(value.value) : '';
                return S_OK;
            },
            get_nodeType: ([out])=>{
                writeU32(out, node.type);
                return S_OK;
            },
            get_parentNode: ([out])=>answerNode(out, node.type === NODE.ATTRIBUTE ? null
                : node.parent),
            get_childNodes: ([out])=>answerList(out, ()=>node.children),
            get_firstChild: ([out])=>answerNode(out, node.children[0]),
            get_lastChild: ([out])=>answerNode(out, node.children.at(-1)),
            get_previousSibling: ([out])=>{
                const siblings = node.parent && node.type !== NODE.ATTRIBUTE ? node.parent.children
                    : [];
                return answerNode(out, siblings[siblings.indexOf(node) - 1]);
            },
            get_nextSibling: ([out])=>{
                const siblings = node.parent && node.type !== NODE.ATTRIBUTE ? node.parent.children
                    : [];
                const at = siblings.indexOf(node);
                return answerNode(out, at < 0 ? null : siblings[at + 1]);
            },
            get_attributes: ([out])=>{
                if (node.type !== NODE.ELEMENT)
                {
                    writeU32(out, 0);
                    return S_FALSE;
                }
                const pointer = host.vtables.publish(makeMap(node), IID.NAMED_NODE_MAP) >>> 0;
                writeU32(out, pointer);
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            },
            insertBefore: ([child, ...rest])=>{
                const reference = readVariant(rest.slice(0, 4));
                const out = rest[4];
                const made = nodeAt(child);
                const before = reference.kind === 'object' ? nodeAt(reference.value) : null;
                if (!made || !mayHold(node, made) || before && before.parent !== node)
                {
                    return E_INVALIDARG;
                }
                insert(node, made, before);
                return (out >>> 0) === 0 ? S_OK : answerNode(out, made);
            },
            replaceChild: ([fresh, old, out])=>{
                const made = nodeAt(fresh);
                const gone = nodeAt(old);
                if (!made || !gone || gone.parent !== node || !mayHold(node, made))
                {
                    return E_INVALIDARG;
                }
                const next = node.children[node.children.indexOf(gone) + 1] ?? null;
                detach(gone);
                insert(node, made, next);
                return (out >>> 0) === 0 ? S_OK : answerNode(out, gone);
            },
            removeChild: ([child, out])=>{
                const gone = nodeAt(child);
                if (!gone || gone.parent !== node || gone.type === NODE.ATTRIBUTE)
                {
                    return E_INVALIDARG;
                }
                detach(gone);
                /** @type {any} */ (gone).owner = rootOf(node);
                return (out >>> 0) === 0 ? S_OK : answerNode(out, gone);
            },
            appendChild: ([child, out])=>{
                const made = nodeAt(child);
                if (!made || !mayHold(node, made))
                {
                    return made ? E_UNEXPECTED : E_INVALIDARG;
                }
                insert(node, made, null);
                return (out >>> 0) === 0 ? S_OK : answerNode(out, made);
            },
            hasChildNodes: ([out])=>{
                writeBool(out, node.children.length > 0);
                return node.children.length > 0 ? S_OK : S_FALSE;
            },
            get_ownerDocument: ([out])=>{
                if (node.type === NODE.DOCUMENT)
                {
                    writeU32(out, 0);
                    return S_FALSE;
                }
                const owner = ownerOf(node);
                return owner.type === NODE.DOCUMENT
                    ? answerPointer(out, pointerOf(owner, IID.DOCUMENT)) : answerNode(out, null);
            },
            cloneNode: ([deep, out])=>{
                if (node.type === NODE.DOCUMENT)
                {
                    return refuse('cloneNode of a document');
                }
                return answerNode(out, clone(node, (deep & 0xffff) !== 0));
            },
            get_nodeTypeString: ([out])=>answerString(out,
                /** @type {Record<number, string>} */ (NODE_TYPE_STRINGS)[node.type] ?? ''),
            get_text: ([out])=>answerString(out, textOf(node,
                documentOf(node)?.preserveWhiteSpace ?? false)),
            put_text: ([text])=>{
                const value = readBstr(text);
                if (node.type === NODE.ELEMENT || node.type === NODE.DOCUMENT
                    || node.type === NODE.FRAGMENT)
                {
                    node.children.forEach(child=>{
                        child.parent = null;
                    });
                    node.children = [];
                    if (value !== '')
                    {
                        insert(node, makeNode(NODE.TEXT, '#text', value), null);
                    }
                }
                else
                {
                    node.value = value;
                }
                return S_OK;
            },
            get_specified: ([out])=>{
                writeBool(out, true);
                return S_OK;
            },
            get_nodeTypedValue: ([out])=>(node.type === NODE.ELEMENT || node.type === NODE.ATTRIBUTE
                ? answerVariant(out, textOf(node, true)) : answerVariant(out, node.value)),
            get_dataType: ([out])=>{
                answerVariant(out, null);
                return S_FALSE;
            },
            get_xml: ([out])=>answerString(out, serializeXml(node)),
            selectNodes: ([path, out])=>{
                try
                {
                    const found = selectNodes(node, readBstr(path));
                    return answerList(out, ()=>found);
                }
                catch (e){
                    if (!(e instanceof XPathError))
                    {
                        throw e;
                    }
                    diverge('IXMLDOMNode::selectNodes', e.message);
                    writeU32(out, 0);
                    return E_FAIL;
                }
            },
            selectSingleNode: ([path, out])=>{
                try
                {
                    return answerNode(out, selectNodes(node, readBstr(path))[0]);
                }
                catch (e){
                    if (!(e instanceof XPathError))
                    {
                        throw e;
                    }
                    diverge('IXMLDOMNode::selectSingleNode', e.message);
                    writeU32(out, 0);
                    return E_FAIL;
                }
            },
            get_parsed: ([out])=>{
                writeBool(out, true);
                return S_OK;
            },
            get_namespaceURI: ([out])=>answerString(out, node.type === NODE.ELEMENT
                || node.type === NODE.ATTRIBUTE && !node.name.startsWith('xmlns')
                ? namespaceOf(node, prefixOf(node.name)) : ''),
            get_prefix: ([out])=>answerString(out, prefixOf(node.name)),
            get_baseName: ([out])=>answerString(out, node.type === NODE.ELEMENT
                || node.type === NODE.ATTRIBUTE || node.type === NODE.PROCESSING_INSTRUCTION
                ? node.name.slice(node.name.indexOf(':') + 1) : ''),
        }, refuse));

    /** @param {number} out @param {number} pointer */
    const answerPointer = (out, pointer)=>{
        writeU32(out, pointer);
        return pointer === 0 ? E_OUTOFMEMORY : S_OK;
    };

    /** The element methods after the node's. @param {XmlNode} element */
    const elementHandlers = element=>{
        /** @param {string} name */
        const named = name=>element.attributes.find(one=>one.name === name);
        /** @param {string} name @param {string} value */
        const set = (name, value)=>{
            const found = named(name);
            if (found)
            {
                found.value = value;
                return;
            }
            const made = makeNode(NODE.ATTRIBUTE, name, value);
            made.parent = element;
            element.attributes.push(made);
        };
        return {
            get_tagName: (/** @type {number[]} */ [out])=>answerString(out, element.name),
            getAttribute: (/** @type {number[]} */ [name, out])=>{
                const found = named(readBstr(name));
                const hr = answerVariant(out, found ? found.value : null);
                return hr < 0 ? hr : found ? S_OK : S_FALSE;
            },
            setAttribute: (/** @type {number[]} */ [name, ...words])=>{
                const value = readVariant(words);
                set(readBstr(name), value.kind === 'string' ? value.value
                    : value.kind === 'number' ? String(value.value) : '');
                return S_OK;
            },
            removeAttribute: (/** @type {number[]} */ [name])=>{
                const found = named(readBstr(name));
                if (found)
                {
                    detach(found);
                }
                return S_OK;
            },
            getAttributeNode: (/** @type {number[]} */ [name, out])=>answerTyped(out,
                named(readBstr(name))),
            setAttributeNode: (/** @type {number[]} */ [pointer, out])=>{
                const node = nodeAt(pointer);
                if (!node || node.type !== NODE.ATTRIBUTE)
                {
                    return E_INVALIDARG;
                }
                const old = named(node.name);
                if (old)
                {
                    detach(old);
                }
                detach(node);
                node.parent = element;
                element.attributes.push(node);
                return (out >>> 0) === 0 ? S_OK : answerTyped(out, old);
            },
            removeAttributeNode: (/** @type {number[]} */ [pointer, out])=>{
                const node = nodeAt(pointer);
                if (!node || node.parent !== element)
                {
                    return E_INVALIDARG;
                }
                detach(node);
                return (out >>> 0) === 0 ? S_OK : answerTyped(out, node);
            },
            getElementsByTagName: (/** @type {number[]} */ [name, out])=>
                answerTagged(out, element, readBstr(name)),
            normalize: ()=>{
                normalize(element);
                return S_OK;
            },
        };
    };

    /**
     * The elements below `node` named `name` ('*' for all), as a list that
     * follows the tree. The name is read at the call: the program frees its
     * string once the call returns.
     *
     * @param {number} out @param {XmlNode} node @param {string} name
     */
    const answerTagged = (out, node, name)=>answerList(out, ()=>elementsNamed(node, name));

    /** @param {XmlNode} node @param {string} name */
    const elementsNamed = (node, name)=>{
        /** @type {XmlNode[]} */
        const found = [];
        /** @param {XmlNode} at */
        const walk = at=>{
            for (const child of at.children)
            {
                if (child.type === NODE.ELEMENT && (name === '*' || child.name === name))
                {
                    found.push(child);
                }
                walk(child);
            }
        };
        walk(node);
        return found;
    };
    /** Adjacent text nodes joined. @param {XmlNode} node */
    const normalize = node=>{
        /** @type {XmlNode[]} */
        const kept = [];
        for (const child of node.children)
        {
            const last = kept.at(-1);
            if (child.type === NODE.TEXT && last?.type === NODE.TEXT)
            {
                last.value += child.value;
                child.parent = null;
                continue;
            }
            if (child.type === NODE.ELEMENT)
            {
                normalize(child);
            }
            kept.push(child);
        }
        node.children = kept;
    };

    /** The character data methods. @param {XmlNode} node */
    const characterHandlers = node=>({
        get_data: (/** @type {number[]} */ [out])=>answerString(out, node.value),
        put_data: (/** @type {number[]} */ [text])=>{
            node.value = readBstr(text);
            return S_OK;
        },
        get_length: (/** @type {number[]} */ [out])=>{
            writeU32(out, node.value.length);
            return S_OK;
        },
        substringData: (/** @type {number[]} */ [offset, count, out])=>(offset >>> 0) > node.value.length
            ? E_INVALIDARG : answerString(out, node.value.substr(offset >>> 0, count >>> 0)),
        appendData: (/** @type {number[]} */ [text])=>{
            node.value += readBstr(text);
            return S_OK;
        },
        insertData: (/** @type {number[]} */ [offset, text])=>{
            if ((offset >>> 0) > node.value.length)
            {
                return E_INVALIDARG;
            }
            node.value = node.value.slice(0, offset >>> 0) + readBstr(text)
                + node.value.slice(offset >>> 0);
            return S_OK;
        },
        deleteData: (/** @type {number[]} */ [offset, count])=>{
            if ((offset >>> 0) > node.value.length)
            {
                return E_INVALIDARG;
            }
            node.value = node.value.slice(0, offset >>> 0)
                + node.value.slice((offset >>> 0) + (count >>> 0));
            return S_OK;
        },
        replaceData: (/** @type {number[]} */ [offset, count, text])=>{
            if ((offset >>> 0) > node.value.length)
            {
                return E_INVALIDARG;
            }
            node.value = node.value.slice(0, offset >>> 0) + readBstr(text)
                + node.value.slice((offset >>> 0) + (count >>> 0));
            return S_OK;
        },
        splitText: (/** @type {number[]} */ [offset, out])=>{
            if ((offset >>> 0) > node.value.length || !node.parent)
            {
                return E_INVALIDARG;
            }
            const tail = makeNode(node.type, node.name, node.value.slice(offset >>> 0));
            node.value = node.value.slice(0, offset >>> 0);
            insert(node.parent, tail, node.parent.children[node.parent.children.indexOf(node) + 1]
                ?? null);
            return answerNode(out, tail, IID.TEXT);
        },
    });

    /**
     * Parses `text` into the document, or records why it could not.
     *
     * @param {DocumentState} state @param {string} text @param {string} url
     * @returns {boolean}
     */
    const parseInto = (state, text, url)=>{
        state.url = url;
        try
        {
            const parsed = parseXml(text, { preserveWhiteSpace: state.preserveWhiteSpace });
            state.root.children.forEach(child=>{
                child.parent = null;
            });
            state.root.children = parsed.children;
            parsed.children.forEach(child=>{
                child.parent = state.root;
            });
            state.error = { ...NO_ERROR };
            return true;
        }
        catch (e){
            if (!(e instanceof XmlError))
            {
                throw e;
            }
            state.root.children = [];
            const lineStart = text.lastIndexOf('\n', e.at - 1) + 1;
            const lineEnd = text.indexOf('\n', e.at);
            state.error = { code: /must have a top level/.test(e.reason) ? XML_E_MISSINGROOT
                : XML_E_INVALID, reason: `${e.reason}\r\n`, line: e.line, column: e.column,
            at: e.at, source: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd), url };
            return false;
        }
    };

    /** The document's parse error, as its own object. @param {DocumentState} state */
    const makeParseError = state=>{
        const error = { ...state.error };
        const handlers = {
            get_errorCode: (/** @type {number[]} */ [out])=>{
                writeU32(out, error.code);
                return error.code === 0 ? S_FALSE : S_OK;
            },
            get_url: (/** @type {number[]} */ [out])=>answerString(out, error.url),
            get_reason: (/** @type {number[]} */ [out])=>answerString(out, error.reason),
            get_srcText: (/** @type {number[]} */ [out])=>answerString(out, error.source),
            get_line: (/** @type {number[]} */ [out])=>{
                writeU32(out, error.line);
                return S_OK;
            },
            get_linepos: (/** @type {number[]} */ [out])=>{
                writeU32(out, error.column);
                return S_OK;
            },
            get_filepos: (/** @type {number[]} */ [out])=>{
                writeU32(out, error.at);
                return S_OK;
            },
        };
        const errorMethods = [...methods(DISPATCH_SLOTS, dispatchHandlers, refuse),
            ...methods(ERROR_SLOTS, handlers, refuse)];
        return createComObject(IID.PARSE_ERROR, { interfaces: [
            { id: IID.PARSE_ERROR, methods: errorMethods },
            { id: IID.DISPATCH, methods: errorMethods.slice(0, 4) },
        ] });
    };

    /** A new node of the document's own, not yet in it. @param {XmlNode} root @param {number} type @param {string} name @param {string} [value] */
    const createIn = (root, type, name, value = '')=>{
        const made = makeNode(type, name, value);
        /** @type {any} */ (made).owner = root;
        return made;
    };

    /** The document methods. @param {XmlNode} root @param {DocumentState} state */
    const documentHandlers = (root, state)=>{
        /** @param {number} type @param {(args: number[]) => [string, string] | null} read */
        const creating = (type, read)=>(/** @type {number[]} */ args)=>{
            const named = read(args);
            if (!named)
            {
                return E_INVALIDARG;
            }
            return answerTyped(args.at(-1) ?? 0, createIn(root, type, named[0], named[1]));
        };
        /** @param {number} out @param {boolean} ok */
        const loaded = (out, ok)=>{
            writeBool(out, ok);
            return ok ? S_OK : S_FALSE;
        };
        return {
            get_doctype: (/** @type {number[]} */ [out])=>answerNode(out, null),
            get_documentElement: (/** @type {number[]} */ [out])=>answerTyped(out,
                root.children.find(child=>child.type === NODE.ELEMENT)),
            putref_documentElement: (/** @type {number[]} */ [pointer])=>{
                const element = nodeAt(pointer);
                if (!element || element.type !== NODE.ELEMENT)
                {
                    return E_INVALIDARG;
                }
                const old = root.children.find(child=>child.type === NODE.ELEMENT);
                if (old)
                {
                    detach(old);
                }
                insert(root, element, null);
                return S_OK;
            },
            createElement: creating(NODE.ELEMENT, ([name])=>(readBstr(name) ? [readBstr(name), '']
                : null)),
            createDocumentFragment: (/** @type {number[]} */ [out])=>answerTyped(out,
                createIn(root, NODE.FRAGMENT, '#document-fragment')),
            createTextNode: creating(NODE.TEXT, ([text])=>['#text', readBstr(text)]),
            createComment: creating(NODE.COMMENT, ([text])=>['#comment', readBstr(text)]),
            createCDATASection: creating(NODE.CDATA, ([text])=>['#cdata-section', readBstr(text)]),
            createProcessingInstruction: creating(NODE.PROCESSING_INSTRUCTION,
                ([target, data])=>(readBstr(target) ? [readBstr(target), readBstr(data)] : null)),
            createAttribute: creating(NODE.ATTRIBUTE, ([name])=>(readBstr(name)
                ? [readBstr(name), ''] : null)),
            getElementsByTagName: (/** @type {number[]} */ [name, out])=>
                answerTagged(out, root, readBstr(name)),
            createNode: (/** @type {number[]} */ args)=>{
                const type = readVariant(args.slice(0, 4));
                const name = readBstr(args[4]);
                const kind = type.kind === 'number' ? type.value
                    : type.kind === 'string' ? Object.entries(NODE_TYPE_STRINGS)
                        .find(([, string])=>string === type.value)?.[0] ?? 0 : 0;
                const made = Number(kind);
                const names = /** @type {Record<number, string>} */ ({ [NODE.TEXT]: '#text',
                    [NODE.COMMENT]: '#comment', [NODE.CDATA]: '#cdata-section',
                    [NODE.FRAGMENT]: '#document-fragment' });
                if (!/** @type {number[]} */ ([NODE.ELEMENT, NODE.ATTRIBUTE, NODE.TEXT, NODE.CDATA, NODE.COMMENT,
                    NODE.PROCESSING_INSTRUCTION, NODE.FRAGMENT]).includes(made))
                {
                    return E_INVALIDARG;
                }
                return answerNode(args[6], createIn(root, made, names[made] ?? name));
            },
            nodeFromID: (/** @type {number[]} */ [, out])=>answerNode(out, null),
            load: async(/** @type {number[]} */ args)=>{
                const source = readVariant(args.slice(0, 4));
                const out = args[4];
                if (source.kind === 'object')
                {
                    diverge('IXMLDOMDocument::load',
                        'a stream or an object as the source is not read');
                    return loaded(out, false);
                }
                if (source.kind === 'bytes')
                {
                    // A document held in memory, as a setup engine hands over
                    // the manifest it carries inside its own executable.
                    return loaded(out, parseInto(state, decodeDocument(source.value), ''));
                }
                if (source.kind !== 'string')
                {
                    return E_INVALIDARG;
                }
                const path = /^file:/i.test(source.value) ? source.value.replace(/^file:\/*/i, '')
                    .replace(/\//g, '\\').replace(/%20/g, ' ') : source.value;
                if (/^[a-z][a-z0-9+.-]+:\/\//i.test(path))
                {
                    diverge('IXMLDOMDocument::load', `${path.split(':')[0]}: is not fetched here`);
                    state.error = { ...NO_ERROR, code: RESOURCE_NOT_FOUND,
                        reason: 'The system cannot locate the resource specified.\r\n', url: path };
                    return loaded(out, false);
                }
                const bytes = await host.readFile(path);
                if (!bytes)
                {
                    state.root.children = [];
                    state.error = { ...NO_ERROR, code: RESOURCE_NOT_FOUND,
                        reason: 'The system cannot locate the object specified.\r\n', url: path };
                    return loaded(out, false);
                }
                return loaded(out, parseInto(state, decodeDocument(bytes), path));
            },
            get_readyState: (/** @type {number[]} */ [out])=>{
                writeU32(out, 4);
                return S_OK;
            },
            get_parseError: (/** @type {number[]} */ [out])=>{
                const pointer = host.vtables.publish(makeParseError(state), IID.PARSE_ERROR) >>> 0;
                return answerPointer(out, pointer);
            },
            get_url: (/** @type {number[]} */ [out])=>{
                if (!state.url)
                {
                    writeU32(out, 0);
                    return S_FALSE;
                }
                return answerString(out, state.url);
            },
            get_async: (/** @type {number[]} */ [out])=>{
                writeBool(out, state.async);
                return S_OK;
            },
            put_async: (/** @type {number[]} */ [value])=>{
                state.async = (value & 0xffff) !== 0;
                return S_OK;
            },
            abort: ()=>S_OK,
            loadXML: (/** @type {number[]} */ [text, out])=>loaded(out,
                parseInto(state, readBstr(text), '')),
            save: async(/** @type {number[]} */ args)=>{
                const target = readVariant(args.slice(0, 4));
                if (target.kind !== 'string' || !host.writeFile)
                {
                    diverge('IXMLDOMDocument::save', 'saved only to a file by its path');
                    return E_INVALIDARG;
                }
                const text = serializeXml(root);
                const bytes = new TextEncoder().encode(text);
                return await host.writeFile(target.value, bytes) ? S_OK : E_FAIL;
            },
            get_validateOnParse: (/** @type {number[]} */ [out])=>{
                writeBool(out, state.validateOnParse);
                return S_OK;
            },
            put_validateOnParse: (/** @type {number[]} */ [value])=>{
                state.validateOnParse = (value & 0xffff) !== 0;
                return S_OK;
            },
            get_resolveExternals: (/** @type {number[]} */ [out])=>{
                writeBool(out, state.resolveExternals);
                return S_OK;
            },
            put_resolveExternals: (/** @type {number[]} */ [value])=>{
                state.resolveExternals = (value & 0xffff) !== 0;
                return S_OK;
            },
            get_preserveWhiteSpace: (/** @type {number[]} */ [out])=>{
                writeBool(out, state.preserveWhiteSpace);
                return S_OK;
            },
            put_preserveWhiteSpace: (/** @type {number[]} */ [value])=>{
                state.preserveWhiteSpace = (value & 0xffff) !== 0;
                return S_OK;
            },
            put_onreadystatechange: ()=>S_OK,
            put_ondataavailable: ()=>S_OK,
            put_ontransformnode: ()=>S_OK,
            // IXMLDOMDocument2
            get_schemas: (/** @type {number[]} */ [out])=>{
                answerVariant(out, null);
                return S_FALSE;
            },
            putref_schemas: ()=>S_OK,
            validate: (/** @type {number[]} */ [out])=>{
                diverge('IXMLDOMDocument2::validate', 'no schema is applied: the document is taken'
                    + ' as valid');
                const pointer = host.vtables.publish(makeParseError({ ...state, error: NO_ERROR }),
                    IID.PARSE_ERROR) >>> 0;
                return (out >>> 0) === 0 ? S_OK : answerPointer(out, pointer);
            },
            setProperty: (/** @type {number[]} */ [name, ...words])=>{
                const value = readVariant(words);
                state.properties.set(readBstr(name), value.kind === 'string' ? value.value
                    : value.kind === 'number' ? String(value.value) : '');
                return S_OK;
            },
            getProperty: (/** @type {number[]} */ [name, out])=>{
                const key = readBstr(name);
                const value = state.properties.get(key) ?? (key === 'SelectionLanguage'
                    ? state.version >= 4 ? 'XPath' : 'XSLPattern'
                    : key === 'SelectionNamespaces' ? '' : null);
                return value === null ? E_FAIL : answerVariant(out, value);
            },
        };
    };

    /**
     * The COM definition of a node's object: the interfaces its kind
     * answers, each with IDispatch's and the node's methods first.
     *
     * @param {XmlNode} node
     * @returns {import('../ole32/objects.js').ComClassDefinition}
     */
    function definitionOf(node){
        const base = nodeMethods(node);
        /** @type {import('../ole32/objects.js').ComInterfaceDescriptor[]} */
        const interfaces = [{ id: IID.NODE, methods: base }, { id: IID.DISPATCH,
            methods: base.slice(0, 4) }];
        /** @param {string} id @param {ComMethod[]} extra */
        const add = (id, extra)=>interfaces.push({ id, methods: [...base, ...extra] });
        switch (node.type)
        {
            case NODE.ELEMENT:
                add(IID.ELEMENT, methods(ELEMENT_SLOTS, elementHandlers(node), refuse));
                break;
            case NODE.ATTRIBUTE:
                add(IID.ATTRIBUTE, methods(ATTRIBUTE_SLOTS, {
                    get_name: ([out])=>answerString(out, node.name),
                    get_value: ([out])=>answerVariant(out, node.value),
                    put_value: words=>{
                        const value = readVariant(words);
                        node.value = value.kind === 'string' ? value.value
                            : value.kind === 'number' ? String(value.value) : '';
                        return S_OK;
                    },
                }, refuse));
                break;
            case NODE.TEXT:
            case NODE.CDATA:
            case NODE.COMMENT: {
                const handlers = characterHandlers(node);
                const character = methods(CHARACTER_SLOTS, handlers, refuse);
                add(IID.CHARACTER_DATA, character);
                if (node.type === NODE.COMMENT)
                {
                    add(IID.COMMENT, character);
                }
                else
                {
                    const text = [...character, ...methods([['splitText', 2]], handlers, refuse)];
                    add(IID.TEXT, text);
                    if (node.type === NODE.CDATA)
                    {
                        add(IID.CDATA, text);
                    }
                }
                break;
            }
            case NODE.PROCESSING_INSTRUCTION:
                add(IID.PROCESSING_INSTRUCTION, methods(PI_SLOTS, {
                    get_target: ([out])=>answerString(out, node.name),
                    get_data: ([out])=>answerString(out, node.value),
                    put_data: ([text])=>{
                        node.value = readBstr(text);
                        return S_OK;
                    },
                }, refuse));
                break;
            case NODE.FRAGMENT:
                add(IID.FRAGMENT, []);
                break;
            case NODE.DOCUMENT: {
                const state = /** @type {DocumentState} */ (documents.get(node));
                const handlers = documentHandlers(node, state);
                const document = methods(DOCUMENT_SLOTS, handlers, refuse);
                add(IID.DOCUMENT, document);
                add(IID.DOCUMENT2, [...document, ...methods(DOCUMENT2_SLOTS, handlers, refuse)]);
                break;
            }
            default:
                break;
        }
        return {
            interfaces,
            destroy: ()=>{
                objects.delete(node);
                for (const [pointer, held] of nodesByPointer)
                {
                    if (held === node)
                    {
                        nodesByPointer.delete(pointer);
                    }
                }
            },
        };
    }

    for (const { clsid, version } of DOCUMENT_CLASSES)
    {
        host.registry.registerClass(clsid, ()=>{
            const root = makeNode(NODE.DOCUMENT, '#document');
            documents.set(root, { root, version, async: true, preserveWhiteSpace: false,
                validateOnParse: true, resolveExternals: version < 6, url: '',
                error: { ...NO_ERROR }, properties: new Map() });
            const definition = definitionOf(root);
            // The class factory's object is the document node's own, so a
            // node's ownerDocument is the pointer CoCreateInstance handed out.
            return { ...definition, state: { adopt: (/** @type {any} */ object)=>{
                if (!objects.has(root))
                {
                    objects.set(root, object);
                }
            } } };
        });
    }

    return {
        /** The document node behind a pointer, for a test or a caller beside. @param {number} pointer */
        nodeAt,
        primaryIid,
        E_POINTER,
    };
}
