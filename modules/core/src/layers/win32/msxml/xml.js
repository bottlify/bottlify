/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The XML MSXML's DOM holds: a document parsed into nodes, and nodes written
 * back out as text.
 *
 * What is read is XML 1.0 as a document of configuration has it: the
 * declaration (kept, as MSXML keeps it, as the processing instruction "xml"),
 * elements and their attributes in either quote, text with the five named
 * entities and character references, CDATA sections, comments, processing
 * instructions, and a DOCTYPE skipped over, its internal subset included. A
 * text node of whitespace alone is dropped unless whitespace is preserved, as
 * MSXML's default preserveWhiteSpace false drops it. What is not well-formed
 * is an error with its line and column, as IXMLDOMParseError reports one.
 */

/** DOMNodeType, as msxml.h numbers it. */
export const NODE = Object.freeze({
    ELEMENT: 1, ATTRIBUTE: 2, TEXT: 3, CDATA: 4, ENTITY_REFERENCE: 5, ENTITY: 6,
    PROCESSING_INSTRUCTION: 7, COMMENT: 8, DOCUMENT: 9, DOCUMENT_TYPE: 10, FRAGMENT: 11,
    NOTATION: 12,
});

/** What nodeTypeString names each type. */
export const NODE_TYPE_STRINGS = Object.freeze({ 1: 'element', 2: 'attribute', 3: 'text',
    4: 'cdatasection', 5: 'entityreference', 6: 'entity', 7: 'processinginstruction',
    8: 'comment', 9: 'document', 10: 'documenttype', 11: 'documentfragment', 12: 'notation' });

/**
 * @typedef {Object} XmlNode
 * @property {number} type        NODE.*
 * @property {string} name        An element's or attribute's qualified name, a PI's
 *                                target; '#text', '#comment' and the like otherwise.
 * @property {string} value       Text, an attribute's value, a PI's data, a comment.
 * @property {XmlNode[]} children
 * @property {XmlNode[]} attributes  An element's, in document order.
 * @property {XmlNode | null} parent  An attribute's is its element.
 */

/** @param {number} type @param {string} name @param {string} [value] @returns {XmlNode} */
export const makeNode = (type, name, value = '')=>({ type, name, value, children: [],
    attributes: [], parent: null });

/** A parse that failed: where, and why. */
export class XmlError extends Error {
    /** @param {string} reason @param {number} line @param {number} column @param {number} at */
    constructor(reason, line, column, at){
        super(reason);
        this.reason = reason;
        this.line = line;
        this.column = column;
        this.at = at;
    }
}

const NAMED = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' });
const NAME_START = /[A-Za-z_:À-�]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-�]/;

/**
 * Text as a document's bytes say it is: a byte-order mark first, then UTF-16
 * by its zero bytes, then the declaration's encoding - UTF-8 unless it names
 * another, read a byte a character.
 *
 * @param {Uint8Array} bytes
 */
export function decodeDocument(bytes){
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
    {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
    {
        return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    {
        return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes[0] === 0x3c && bytes[1] === 0)
    {
        return new TextDecoder('utf-16le').decode(bytes);
    }
    const head = String.fromCharCode(...bytes.subarray(0, 200));
    const named = /encoding\s*=\s*["']([^"']+)["']/.exec(head)?.[1].toLowerCase() ?? 'utf-8';
    if (named === 'utf-8' || named === 'utf8')
    {
        return new TextDecoder('utf-8').decode(bytes);
    }
    let text = '';
    for (const byte of bytes)
    {
        text += String.fromCharCode(byte);
    }
    return text;
}

/**
 * A document's nodes, its children those of the document node.
 *
 * @param {string} text
 * @param {{ preserveWhiteSpace?: boolean }} [options]
 * @returns {XmlNode} the document node
 */
export function parseXml(text, options = {}){
    const preserve = options.preserveWhiteSpace === true;
    let at = 0;
    /** @param {string} reason @param {number} [where] @returns {never} */
    const fail = (reason, where = at)=>{
        const before = text.slice(0, where);
        const line = before.split('\n').length;
        const column = where - before.lastIndexOf('\n');
        throw new XmlError(reason, line, column, where);
    };
    const document = makeNode(NODE.DOCUMENT, '#document');
    /** @param {XmlNode} parent @param {XmlNode} node */
    const append = (parent, node)=>{
        node.parent = parent;
        parent.children.push(node);
    };
    /** @param {string} raw */
    const unescape = raw=>raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref)=>{
        if (ref[0] === '#')
        {
            const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
            return String.fromCodePoint(code);
        }
        const named = /** @type {Record<string, string>} */ (NAMED)[ref];
        if (named === undefined)
        {
            fail(`Reference to undefined entity '${ref}'.`, text.indexOf(whole, at - raw.length));
        }
        return named;
    });
    const space = ()=>{
        while (at < text.length && /\s/.test(text[at]))
        {
            at++;
        }
    };
    const name = ()=>{
        const start = at;
        if (!NAME_START.test(text[at] ?? ''))
        {
            fail('A name was started with an invalid character.');
        }
        while (at < text.length && NAME_CHAR.test(text[at]))
        {
            at++;
        }
        return text.slice(start, at);
    };
    /** @param {string} until */
    const upTo = until=>{
        const end = text.indexOf(until, at);
        if (end < 0)
        {
            fail(`Expected '${until}'.`, text.length);
        }
        const piece = text.slice(at, end);
        at = end + until.length;
        return piece;
    };

    /** @type {XmlNode[]} */
    const open = [document];
    if (text.charCodeAt(0) === 0xfeff)
    {
        at = 1;
    }
    while (at < text.length)
    {
        const parent = open[open.length - 1];
        if (text[at] !== '<')
        {
            const start = at;
            const end = text.indexOf('<', at);
            at = end < 0 ? text.length : end;
            const raw = text.slice(start, at);
            if (parent === document)
            {
                if (raw.trim() !== '')
                {
                    fail('Invalid at the top level of the document.', start);
                }
                continue;
            }
            if (preserve || raw.trim() !== '')
            {
                append(parent, makeNode(NODE.TEXT, '#text', unescape(raw)));
            }
            continue;
        }
        if (text.startsWith('<!--', at))
        {
            at += 4;
            append(parent, makeNode(NODE.COMMENT, '#comment', upTo('-->')));
            continue;
        }
        if (text.startsWith('<![CDATA[', at))
        {
            at += 9;
            if (parent === document)
            {
                fail('Invalid at the top level of the document.', at - 9);
            }
            append(parent, makeNode(NODE.CDATA, '#cdata-section', upTo(']]>')));
            continue;
        }
        if (text.startsWith('<!DOCTYPE', at))
        {
            // Skipped whole, a bracketed internal subset with it.
            let depth = 0;
            for (; at < text.length; at++)
            {
                if (text[at] === '[')
                {
                    depth++;
                }
                else if (text[at] === ']')
                {
                    depth--;
                }
                else if (text[at] === '>' && depth === 0)
                {
                    at++;
                    break;
                }
            }
            continue;
        }
        if (text.startsWith('<?', at))
        {
            at += 2;
            const target = name();
            space();
            const data = upTo('?>').replace(/\s+$/, '');
            append(parent, makeNode(NODE.PROCESSING_INSTRUCTION, target, data));
            continue;
        }
        if (text.startsWith('</', at))
        {
            at += 2;
            const closing = name();
            space();
            if (text[at] !== '>')
            {
                fail('Expected \'>\'.');
            }
            at++;
            if (parent === document || parent.name !== closing)
            {
                fail(`End tag '${closing}' does not match the start tag '${parent.name}'.`,
                    at - closing.length - 3);
            }
            open.pop();
            continue;
        }
        at++;
        const element = makeNode(NODE.ELEMENT, name());
        for (;;)
        {
            const before = at;
            space();
            if (text.startsWith('/>', at) || text[at] === '>')
            {
                break;
            }
            if (at === before)
            {
                fail('Required white space was missing.');
            }
            const attribute = name();
            space();
            if (text[at] !== '=')
            {
                fail('Missing equals sign between attribute and attribute value.');
            }
            at++;
            space();
            const quote = text[at];
            if (quote !== '"' && quote !== '\'')
            {
                fail('A string literal was expected, but no opening quote character was found.');
            }
            at++;
            const raw = upTo(quote);
            if (element.attributes.some(one=>one.name === attribute))
            {
                fail(`Duplicate attribute '${attribute}'.`, before);
            }
            const node = makeNode(NODE.ATTRIBUTE, attribute, unescape(raw).replace(/[\t\n\r]/g, ' '));
            node.parent = element;
            element.attributes.push(node);
        }
        if (parent === document && document.children.some(child=>child.type === NODE.ELEMENT))
        {
            fail('Only one top level element is allowed in an XML document.', at);
        }
        append(parent, element);
        if (text[at] === '>')
        {
            at++;
            open.push(element);
        }
        else
        {
            at += 2;
        }
    }
    if (open.length > 1)
    {
        fail(`The following tags were not closed: ${open.slice(1).map(one=>one.name).join(', ')}.`,
            text.length);
    }
    if (!document.children.some(child=>child.type === NODE.ELEMENT))
    {
        fail('XML document must have a top level element.', text.length);
    }
    return document;
}

/** @param {string} text */
const escapeText = text=>text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** @param {string} text */
const escapeAttribute = text=>escapeText(text).replace(/"/g, '&quot;');

/**
 * A node as IXMLDOMNode::get_xml writes it: an empty element closed in its
 * start tag, a document's top-level nodes each on a line of its own.
 *
 * @param {XmlNode} node
 * @returns {string}
 */
export function serializeXml(node){
    switch (node.type)
    {
        case NODE.DOCUMENT:
        case NODE.FRAGMENT:
            return node.children.map(child=>`${serializeXml(child)}${node.type === NODE.DOCUMENT
                ? '\r\n' : ''}`).join('');
        case NODE.ELEMENT: {
            const attributes = node.attributes
                .map(one=>` ${one.name}="${escapeAttribute(one.value)}"`).join('');
            return node.children.length === 0 ? `<${node.name}${attributes}/>`
                : `<${node.name}${attributes}>${node.children.map(serializeXml).join('')}`
                    + `</${node.name}>`;
        }
        case NODE.ATTRIBUTE:
            return `${node.name}="${escapeAttribute(node.value)}"`;
        case NODE.TEXT:
            return escapeText(node.value);
        case NODE.CDATA:
            return `<![CDATA[${node.value}]]>`;
        case NODE.COMMENT:
            return `<!--${node.value}-->`;
        case NODE.PROCESSING_INSTRUCTION:
            return `<?${node.name}${node.value ? ` ${node.value}` : ''}?>`;
        default:
            return '';
    }
}

/**
 * A node's text as IXMLDOMNode::get_text gives it: the text of the node and
 * every node below it, comments and processing instructions left out; with
 * whitespace not preserved, an element's is trimmed.
 *
 * @param {XmlNode} node @param {boolean} [preserve]
 * @returns {string}
 */
export function textOf(node, preserve = false){
    switch (node.type)
    {
        case NODE.TEXT:
        case NODE.CDATA:
        case NODE.ATTRIBUTE:
        case NODE.COMMENT:
        case NODE.PROCESSING_INSTRUCTION:
            return node.value;
        default: {
            /** @type {string[]} */
            const parts = [];
            /** @param {XmlNode} at */
            const walk = at=>{
                for (const child of at.children)
                {
                    if (child.type === NODE.TEXT || child.type === NODE.CDATA)
                    {
                        parts.push(child.value);
                    }
                    else if (child.type === NODE.ELEMENT)
                    {
                        walk(child);
                    }
                }
            };
            walk(node);
            const text = parts.join('');
            return preserve ? text : text.trim();
        }
    }
}
