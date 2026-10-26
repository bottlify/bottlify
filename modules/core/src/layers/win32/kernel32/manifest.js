/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Assembly manifests: the XML an activation context is built from.
 *
 * What is read is what a context answers for: the assembly's identity, the
 * files it has and the window classes they register, the assemblies it
 * depends on, the run level, the compatibility and settings sections, and a
 * publisher policy's binding redirects. A manifest Windows refuses is refused
 * with the reason -- one that is not XML, a root that is not an asm.v1, v2 or
 * v3 `<assembly manifestVersion="1.0">`, anything after the root, a file
 * without a name, UTF-16 without its byte order mark, a run level given
 * twice. An element or attribute nothing here reads is passed over, where
 * Windows refuses one it does not know: a manifest refused here is a program
 * that does not start, which costs more than a check of a malformed one.
 */

/** The namespaces an assembly's root may be in. */
const ASSEMBLY_NAMESPACES = new Set([
    'urn:schemas-microsoft-com:asm.v1',
    'urn:schemas-microsoft-com:asm.v2',
    'urn:schemas-microsoft-com:asm.v3',
]);
/** The namespace an activatableClass must declare. */
const WINRT_NAMESPACE = 'urn:schemas-microsoft-com:winrt.v1';

/**
 * @typedef {Object} Identity
 * @property {string} name
 * @property {string | null} type
 * @property {number[] | null} version  four parts, or null when none was given
 * @property {string | null} processorArchitecture
 * @property {string | null} publicKeyToken
 * @property {string | null} language
 */

/**
 * @typedef {Object} ManifestFile
 * @property {string} name
 * @property {string | null} loadFrom
 * @property {{ name: string, versioned: boolean }[]} windowClasses
 */

/**
 * @typedef {Object} Manifest
 * @property {Identity | null} identity
 * @property {ManifestFile[]} files
 * @property {{ identity: Identity, optional: boolean, delayed: boolean }[]} dependencies
 * @property {boolean} noInheritable
 * @property {{ level: number, uiAccess: boolean } | null} runLevel
 *     ACTCTX_REQUESTED_RUN_LEVEL: 1 as invoker, 2 highest available, 3 administrator.
 * @property {{ supportedOs: string[], maxVersionTested: string[] }} compatibility
 * @property {Map<string, { namespace: string, value: string }>} settings
 * @property {{ oldVersion: [number[], number[]], newVersion: number[] }[]} redirects
 *     A publisher policy's bindingRedirects, for the assembly it names.
 * @property {Identity | null} redirectsFor
 */

/**
 * @typedef {Object} XmlElement
 * @property {string} name       the local name
 * @property {string | null} prefix
 * @property {string | null} namespace  as declared or inherited; null when the prefix is undeclared
 * @property {Map<string, string>} attributes  by local name, xmlns declarations left out
 * @property {XmlElement[]} children
 * @property {string} text       the character data directly inside it
 */

/** A manifest's text, from its bytes: UTF-8 (a BOM or none), or UTF-16 with its BOM. */
function decode(/** @type {Uint8Array} */ bytes){
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
    {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
    {
        return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    return new TextDecoder('utf-8').decode(bytes[0] === 0xef && bytes[1] === 0xbb
        && bytes[2] === 0xbf ? bytes.subarray(3) : bytes);
}

/** @param {string} text */
const unescape = text=>text.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, what)=>{
    const named = /** @type {Record<string, string>} */ (
        { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[what.toLowerCase()];
    if (named !== undefined)
    {
        return named;
    }
    const code = what[1] === 'x' || what[1] === 'X' ? parseInt(what.slice(2), 16)
        : parseInt(what.slice(1), 10);
    return String.fromCodePoint(code);
});

/**
 * One XML document's root element, or the reason it is not one.
 *
 * @param {string} text
 * @returns {XmlElement | string}
 */
export function parseXml(text){
    let at = 0;
    /** @type {XmlElement | null} */
    let root = null;
    /** @type {{ element: XmlElement, scope: Map<string, string> }[]} */
    const open = [];
    const nameOf = /^([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?/;
    while (at < text.length)
    {
        const lt = text.indexOf('<', at);
        const chunk = text.slice(at, lt < 0 ? text.length : lt);
        if (chunk.trim() !== '')
        {
            if (open.length === 0)
            {
                return 'character data outside the root';
            }
            open[open.length - 1].element.text += unescape(chunk);
        }
        else if (open.length > 0)
        {
            open[open.length - 1].element.text += chunk;
        }
        if (lt < 0)
        {
            break;
        }
        if (text.startsWith('<?', lt))
        {
            const end = text.indexOf('?>', lt);
            if (end < 0)
            {
                return 'an unterminated processing instruction';
            }
            at = end + 2;
            continue;
        }
        if (text.startsWith('<!--', lt))
        {
            const end = text.indexOf('-->', lt);
            if (end < 0)
            {
                return 'an unterminated comment';
            }
            at = end + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', lt))
        {
            const end = text.indexOf(']]>', lt);
            if (end < 0 || open.length === 0)
            {
                return 'misplaced character data';
            }
            open[open.length - 1].element.text += text.slice(lt + 9, end);
            at = end + 3;
            continue;
        }
        if (text.startsWith('<!', lt))
        {
            const end = text.indexOf('>', lt);
            if (end < 0 || root !== null)
            {
                return 'a misplaced declaration';
            }
            at = end + 1;
            continue;
        }
        if (text[lt + 1] === '/')
        {
            const end = text.indexOf('>', lt);
            const closing = end < 0 ? '' : text.slice(lt + 2, end).trim();
            const top = open.pop();
            const spelled = top ? (top.element.prefix ? `${top.element.prefix}:` : '')
                + top.element.name : null;
            if (end < 0 || spelled !== closing)
            {
                return `a closing tag that does not match: ${closing}`;
            }
            at = end + 1;
            continue;
        }
        // A start tag: its name, its attributes, and whether it closes itself.
        const named = nameOf.exec(text.slice(lt + 1));
        if (!named)
        {
            return 'a tag without a name';
        }
        if (open.length === 0 && root !== null)
        {
            return 'an element after the root';
        }
        let cursor = lt + 1 + named[0].length;
        /** @type {Map<string, string>} */
        const raw = new Map();
        let selfClosing = false;
        for (;;)
        {
            const space = /^\s*/.exec(text.slice(cursor));
            cursor += space ? space[0].length : 0;
            if (text.startsWith('/>', cursor))
            {
                selfClosing = true;
                cursor += 2;
                break;
            }
            if (text[cursor] === '>')
            {
                cursor += 1;
                break;
            }
            const attribute = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/
                .exec(text.slice(cursor));
            if (!attribute || space?.[0] === '')
            {
                return 'a malformed attribute';
            }
            if (raw.has(attribute[1]))
            {
                return `the attribute ${attribute[1]} twice`;
            }
            raw.set(attribute[1], unescape(attribute[3] ?? attribute[4] ?? ''));
            cursor += attribute[0].length;
        }
        const parentScope = open.length > 0 ? open[open.length - 1].scope : new Map();
        const scope = new Map(parentScope);
        /** @type {Map<string, string>} */
        const attributes = new Map();
        for (const [key, value] of raw)
        {
            if (key === 'xmlns')
            {
                scope.set('', value);
            }
            else if (key.startsWith('xmlns:'))
            {
                scope.set(key.slice(6), value);
            }
            else
            {
                attributes.set(key.includes(':') ? key.slice(key.indexOf(':') + 1) : key, value);
            }
        }
        const prefix = named[2] === undefined ? null : named[1];
        /** @type {XmlElement} */
        const element = {
            name: named[2] ?? named[1],
            prefix,
            namespace: scope.get(prefix ?? '') ?? null,
            attributes,
            children: [],
            text: '',
        };
        if (open.length > 0)
        {
            open[open.length - 1].element.children.push(element);
        }
        else
        {
            root = element;
        }
        if (!selfClosing)
        {
            open.push({ element, scope });
        }
        at = cursor;
    }
    if (open.length > 0)
    {
        return `an element left open: ${open[open.length - 1].element.name}`;
    }
    return root ?? 'no element';
}

/**
 * A version as its four parts, or null for one that is not `a.b.c.d` of
 * numbers that fit in 16 bits.
 *
 * @param {string | undefined} text
 */
export function parseVersion(text){
    if (text === undefined)
    {
        return null;
    }
    const parts = text.trim().split('.');
    if (parts.length !== 4 || parts.some(part=>!/^\d{1,5}$/.test(part) || Number(part) > 65535))
    {
        return null;
    }
    return parts.map(Number);
}

/** @param {number[]} a @param {number[]} b */
export const compareVersions = (a, b)=>{
    for (let at = 0; at < 4; at++)
    {
        if (a[at] !== b[at])
        {
            return a[at] < b[at] ? -1 : 1;
        }
    }
    return 0;
};

/**
 * An assemblyIdentity element's identity, or the reason it is not one.
 *
 * @param {XmlElement} element
 * @returns {Identity | string}
 */
function identityOf(element){
    const get = (/** @type {string} */ key)=>element.attributes.get(key) ?? null;
    const name = get('name');
    if (name === null || name === '')
    {
        return 'an assembly identity without a name';
    }
    const versionText = element.attributes.get('version');
    const version = parseVersion(versionText);
    if (versionText !== undefined && version === null)
    {
        return `a version that is not four numbers: ${versionText}`;
    }
    return {
        name, type: get('type'), version, processorArchitecture: get('processorArchitecture'),
        publicKeyToken: get('publicKeyToken'), language: get('language'),
    };
}

/** What requestedExecutionLevel's level says, as ACTCTX_REQUESTED_RUN_LEVEL. */
const RUN_LEVELS = new Map([
    ['asinvoker', 1], ['highestavailable', 2], ['requireadministrator', 3],
]);

/**
 * A manifest, or the reason Windows would not build a context from it.
 *
 * @param {Uint8Array} bytes
 * @returns {{ manifest: Manifest } | { refused: string }}
 */
export function parseManifest(bytes){
    if (bytes.length >= 2 && (bytes[1] === 0 || bytes[0] === 0)
        && !(bytes[0] === 0xff && bytes[1] === 0xfe) && !(bytes[0] === 0xfe && bytes[1] === 0xff))
    {
        return { refused: 'UTF-16 without a byte order mark' };
    }
    // A resource is padded out with NULs, which end the text rather than follow it.
    const text = decode(bytes);
    const end = text.indexOf('\0');
    const root = parseXml(end < 0 ? text : text.slice(0, end));
    if (typeof root === 'string')
    {
        return { refused: root };
    }
    if (root.name !== 'assembly' || !ASSEMBLY_NAMESPACES.has(root.namespace ?? ''))
    {
        return { refused: 'the root is not an assembly in the asm.v1, v2 or v3 namespace' };
    }
    if (root.attributes.get('manifestVersion') !== '1.0')
    {
        return { refused: 'the manifest version is not 1.0' };
    }
    /** @type {Manifest} */
    const manifest = {
        identity: null, files: [], dependencies: [], noInheritable: false, runLevel: null,
        compatibility: { supportedOs: [], maxVersionTested: [] }, settings: new Map(),
        redirects: [], redirectsFor: null,
    };
    for (const child of root.children)
    {
        switch (child.name)
        {
            case 'assemblyIdentity': {
                const identity = identityOf(child);
                if (typeof identity === 'string')
                {
                    return { refused: identity };
                }
                if (manifest.identity !== null)
                {
                    return { refused: 'two assembly identities' };
                }
                manifest.identity = identity;
                break;
            }
            case 'noInheritable':
            case 'noInherit':
                manifest.noInheritable = true;
                break;
            case 'file': {
                const file = fileOf(child);
                if (typeof file === 'string')
                {
                    return { refused: file };
                }
                manifest.files.push(file);
                break;
            }
            case 'dependency': {
                const refused = readDependency(child, manifest);
                if (refused !== null)
                {
                    return { refused };
                }
                break;
            }
            case 'trustInfo': {
                const refused = readTrust(child, manifest);
                if (refused !== null)
                {
                    return { refused };
                }
                break;
            }
            case 'compatibility':
                for (const application of child.children.filter(node=>node.name === 'application'))
                {
                    for (const os of application.children)
                    {
                        const id = os.attributes.get('Id');
                        if (os.name === 'supportedOS' && id)
                        {
                            manifest.compatibility.supportedOs.push(id.toLowerCase());
                        }
                        else if (os.name === 'maxversiontested' && id)
                        {
                            manifest.compatibility.maxVersionTested.push(id);
                        }
                    }
                }
                break;
            case 'application':
                for (const settings of child.children.filter(node=>node.name === 'windowsSettings'))
                {
                    for (const setting of settings.children)
                    {
                        manifest.settings.set(setting.name, { namespace: setting.namespace ?? '',
                            value: setting.text.trim() });
                    }
                }
                break;
            default:
                // description, COM and CLR redirections, and whatever else:
                // nothing here answers for them.
                break;
        }
    }
    return { manifest };
}

/**
 * A file element: its name, where it loads from, its window classes.
 *
 * @param {XmlElement} element
 * @returns {ManifestFile | string}
 */
function fileOf(element){
    const name = element.attributes.get('name');
    if (!name)
    {
        return 'a file without a name';
    }
    /** @type {ManifestFile} */
    const file = { name, loadFrom: element.attributes.get('loadFrom') ?? null, windowClasses: [] };
    for (const child of element.children)
    {
        if (child.name === 'windowClass')
        {
            const className = child.text.trim();
            if (className === '')
            {
                return 'a window class without a name';
            }
            file.windowClasses.push({ name: className,
                versioned: (child.attributes.get('versioned') ?? 'yes').toLowerCase() !== 'no' });
        }
        else if (child.name === 'activatableClass' && child.namespace !== WINRT_NAMESPACE)
        {
            return 'an activatable class outside the WinRT namespace';
        }
    }
    return file;
}

/**
 * A dependency element's assemblies, and a policy's binding redirects.
 *
 * @param {XmlElement} element @param {Manifest} manifest
 * @returns {string | null} the reason it is refused
 */
function readDependency(element, manifest){
    for (const dependent of element.children.filter(node=>node.name === 'dependentAssembly'))
    {
        const node = dependent.children.find(child=>child.name === 'assemblyIdentity');
        if (!node)
        {
            continue;
        }
        const identity = identityOf(node);
        if (typeof identity === 'string')
        {
            return identity;
        }
        const redirects = dependent.children.filter(child=>child.name === 'bindingRedirect');
        if (redirects.length > 0)
        {
            manifest.redirectsFor = identity;
            for (const redirect of redirects)
            {
                const [from, to = from] = (redirect.attributes.get('oldVersion') ?? '').split('-');
                const low = parseVersion(from);
                const high = parseVersion(to);
                const target = parseVersion(redirect.attributes.get('newVersion'));
                if (!low || !high || !target)
                {
                    return 'a binding redirect without versions';
                }
                manifest.redirects.push({ oldVersion: [low, high], newVersion: target });
            }
            continue;
        }
        manifest.dependencies.push({
            identity,
            optional: (dependent.attributes.get('optional') ?? '').toLowerCase() === 'yes',
            delayed: (dependent.attributes.get('allowDelayedBinding') ?? '').toLowerCase()
                === 'true',
        });
    }
    return null;
}

/**
 * trustInfo's requested run level, given once in the whole manifest.
 *
 * @param {XmlElement} element @param {Manifest} manifest
 * @returns {string | null} the reason it is refused
 */
function readTrust(element, manifest){
    for (const security of element.children.filter(node=>node.name === 'security'))
    {
        for (const privileges of security.children
            .filter(node=>node.name === 'requestedPrivileges'))
        {
            for (const level of privileges.children
                .filter(node=>node.name === 'requestedExecutionLevel'))
            {
                if (manifest.runLevel !== null)
                {
                    return 'a requested execution level twice';
                }
                const named = RUN_LEVELS.get((level.attributes.get('level') ?? '').toLowerCase());
                if (named === undefined)
                {
                    return 'an execution level that is none';
                }
                manifest.runLevel = { level: named,
                    uiAccess: (level.attributes.get('uiAccess') ?? '').toLowerCase() === 'true' };
            }
        }
    }
    return null;
}

/**
 * An identity as an encoded assembly identity: the name, then each attribute
 * given, in the order of their names, as `key="value"`.
 *
 * @param {Identity} identity
 */
export function encodeIdentity(identity){
    /** @type {[string, string][]} */
    const attributes = [];
    if (identity.language && identity.language !== '*')
    {
        attributes.push(['language', identity.language]);
    }
    if (identity.processorArchitecture)
    {
        attributes.push(['processorArchitecture', identity.processorArchitecture]);
    }
    if (identity.publicKeyToken)
    {
        attributes.push(['publicKeyToken', identity.publicKeyToken]);
    }
    if (identity.type)
    {
        attributes.push(['type', identity.type]);
    }
    if (identity.version)
    {
        attributes.push(['version', identity.version.join('.')]);
    }
    return [identity.name, ...attributes.map(([key, value])=>`${key}="${value}"`)].join(',');
}

/**
 * Whether an assembly found answers a dependency on `wanted`: the same name,
 * and every other attribute both give the same, `*` matching anything; the
 * version exactly, when the dependency names one.
 *
 * @param {Identity} wanted @param {Identity} found
 */
export function identityMatches(wanted, found){
    const same = (/** @type {string | null} */ a, /** @type {string | null} */ b)=>
        a === null || b === null || a === '*' || b === '*' || a.toLowerCase() === b.toLowerCase();
    return wanted.name.toLowerCase() === found.name.toLowerCase()
        && same(wanted.processorArchitecture, found.processorArchitecture)
        && same(wanted.publicKeyToken, found.publicKeyToken)
        && same(wanted.language, found.language)
        && (wanted.version === null || found.version === null
            || compareVersions(wanted.version, found.version) === 0);
}
