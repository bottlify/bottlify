/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msi.dll's calls about what is installed, answered from the installer's own
 * records in the registry: products, their features and components and the
 * products that share them, the user a product was registered to, the
 * places its package can be found again, and the descriptors an advertised
 * shortcut or a published component names a feature and component by.
 *
 * Everything a Windows Installer 4.5 or 5.0 exports is here, MsiGetPatchFileList
 * aside. A patch is applied by
 * running the product's package again with it, and its records answer the
 * patch queries. A product advertised to this machine is installed by the
 * first use of a feature; an advertise script, whose format Windows does not
 * document, is refused, and that is said once.
 */

import { INSTALLSTATE } from './session.js';
import { squashGuid, unsquashGuid, valueText } from './registration.js';
import { decodeShellLink } from '../common/shell-link.js';
import { createMd5 } from '../crypto/digest.js';
import { formatGuid } from '../ole32/guid.js';
import { REG_EXPAND_SZ, REG_SZ } from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { BASE85 } from './system.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_INSTALL_FAILURE = 1603;
const ERROR_UNKNOWN_PRODUCT = 1605;
const ERROR_UNKNOWN_FEATURE = 1606;
const ERROR_UNKNOWN_COMPONENT = 1607;
const ERROR_INDEX_ABSENT = 1611;
const ERROR_INSTALL_PACKAGE_OPEN_FAILED = 1619;
const ERROR_INSTALL_PACKAGE_INVALID = 1620;
const ERROR_FUNCTION_FAILED = 1627;
const ERROR_PATCH_PACKAGE_UNSUPPORTED = 1637;
const ERROR_UNKNOWN_PATCH = 1647;
const ERROR_PATCH_TARGET_NOT_FOUND = 1642;
const ERROR_SUCCESS_REBOOT_REQUIRED = 3010;
/** MsiRemovePatches' one kind of removal, and MSIPATCHSEQUENCEINFO's patch given as a file. */
const INSTALLTYPE_SINGLE_INSTANCE = 2;
const MSIPATCH_DATATYPE_PATCHFILE = 0;
/** MsiEndTransaction's state for undoing what the transaction did. */
const MSITRANSACTIONSTATE_ROLLBACK = 0;
/** MsiAdvertiseProduct's script argument when it advertises to this machine, not a file. */
const ADVERTISEFLAGS_USERASSIGN = 1;
const ERROR_BAD_CONFIGURATION = 1610;
const ERROR_CALL_NOT_IMPLEMENTED = 120;

/** USERINFOSTATE: what MsiGetUserInfo found. */
const USERINFOSTATE = Object.freeze({ MOREDATA: -3, INVALIDARG: -2, UNKNOWN: -1, ABSENT: 0,
    PRESENT: 1 });

/** The one installation context this machine has: everything is per machine. */
const MSIINSTALLCONTEXT_MACHINE = 4;
/** MsiSourceList*Ex's options: what kind of source, and a patch's list rather than a product's. */
const MSISOURCETYPE_NETWORK = 0x1;
const MSISOURCETYPE_URL = 0x2;
const MSICODE_PATCH = 0x40000000;

/** A GUID's text in a fixed buffer: 38 characters and the terminator. */
const GUID_CHARS = 39;
/** A feature's name in MsiEnumFeatures' buffers. */
const MAX_FEATURE_CHARS = 38;

/** MSIDBSTATE: a database opened read-only, or for changes. */
const MSIDBSTATE_ERROR = -1;
const MSIDBSTATE_READ = 0;
const MSIDBSTATE_WRITE = 1;

/** The answers MsiGetFileSignatureInformation gives for an unsigned or missing file. */
const TRUST_E_NOSIGNATURE = 0x800b0100;
const HRESULT_FILE_NOT_FOUND = 0x80070002;
const E_INVALIDARG = 0x80070057;

/** The installer database's own class, which MsiVerifyPackage looks for. */
const CLSID_MSI_DATABASE = /^\{000C108[46]-0000-0000-C000-000000000046\}$/i;

/**
 * The sixteen bytes a descriptor packs into twenty base-85 characters, as a
 * GUID's text; null when the text is not twenty of them.
 *
 * @param {string} text @returns {string | null}
 */
export function unpackGuid(text){
    if (text.length < 20)
    {
        return null;
    }
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    for (let word = 0; word < 4; word++)
    {
        let value = 0;
        for (let digit = 4; digit >= 0; digit--)
        {
            const index = BASE85.indexOf(text[word * 5 + digit]);
            if (index < 0)
            {
                return null;
            }
            value = value * 85 + index;
        }
        if (value > 0xffffffff)
        {
            return null;
        }
        view.setUint32(word * 4, value, true);
    }
    return formatGuid(bytes);
}

/**
 * A descriptor taken apart: the product, the feature, the component -- null
 * when the descriptor leaves it to the feature's only one -- and how many
 * characters it took.
 *
 * @param {string} descriptor
 * @returns {{ product: string, feature: string, component: string | null, used: number } | null}
 */
export function decomposeDescriptor(descriptor){
    const product = unpackGuid(descriptor.slice(0, 20));
    if (product === null)
    {
        return null;
    }
    const rest = descriptor.slice(20);
    const end = rest.search(/[<>]/);
    if (end < 0)
    {
        return null;
    }
    const feature = rest.slice(0, end);
    if (rest[end] === '<')
    {
        return { product, feature, component: null, used: 20 + end + 1 };
    }
    const component = unpackGuid(rest.slice(end + 1, end + 21));
    return component === null ? null
        : { product, feature, component, used: 20 + end + 21 };
}

/**
 * @typedef {Object} ProductContext
 * @property {ReturnType<typeof import('./registration.js').createRegistration>} registration
 * @property {import('./registration.js').Hive} hive
 * @property {any} files
 * @property {(path: string) => string} fullPath
 * @property {(path: string) => any} statPath
 *     The entry a program's path names; null for none, a path that names
 *     nothing (an empty one) among them.
 * @property {(path: string) => Promise<Uint8Array | null>} readPath
 *     The bytes of the file a program's path names, or null.
 * @property {(wide: boolean) => (address: number) => string | null} reader
 * @property {(wide: boolean, text: string, buffer: number, size: number) => number} putString
 * @property {(wide: boolean, text: string, buffer: number) => void} putFixed
 *     A string into a buffer of fixed size the caller provides.
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU32
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(handle: number, kind: string) => any} get
 * @property {(path: string) => Promise<Uint8Array | null>} readFile
 * @property {(path: string) => Promise<{ compound: any } | null>} openPackage
 *     A package's compound file, or null for a file that is not one.
 * @property {(productCode: string | null, request: string) => Promise<number>} maintain
 * @property {(productCode: string) => Promise<import('./session.js').Session | number>}
 *     openProduct  An installed product's package opened as a session.
 * @property {(text: string, caption: string, type: number) => number | Promise<number>}
 *     [messageBox]
 * @property {(path: string) => Promise<{ code: string, targets: string[] } | number>}
 *     inspectPatch  A patch file's code and the products it targets, or an error code.
 * @property {(path: string) => Promise<string | null>} productCodeOf  A package's ProductCode.
 * @property {(kind: string, object: object) => number} openHandle  A new MSIHANDLE.
 * @property {(path: string, transforms: string | null) => Promise<number>} advertise
 *     A package advertised to this machine.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {ProductContext} context
 */
export function createProductFunctions(context){
    const { registration, hive, reader, putString, putFixed, writeU32, get } = context;
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} why */
    const sayOnce = (api, why)=>{
        if (!said.has(api))
        {
            said.add(api);
            context.divergence?.(api, why);
        }
    };

    /** @param {string} name @param {number} argBytes @param {(wide: boolean) => (args: number[]) => any} make */
    const both = (name, argBytes, make)=>({
        [`${name}A`]: { argBytes, handler: make(false) },
        [`${name}W`]: { argBytes, handler: make(true) },
    });

    /** @param {string | null} code whether it names a product the machine has */
    const known = code=>code !== null && squashGuid(code) !== null
        && registration.productState(code) !== INSTALLSTATE.UNKNOWN;

    /**
     * An installed product's record, by the name MsiGetProductInfo takes.
     *
     * @param {string} code @param {string} property
     */
    const info = (code, property)=>{
        const answer = registration.productInfo(code, property);
        return 'value' in answer ? answer.value : '';
    };

    /**
     * Whether a product's feature is there, and the path of a component it
     * holds, with whether that path is on the volume now.
     *
     * @param {string} product @param {string} component
     */
    const componentState = (product, component)=>{
        const path = registration.componentPath(product, component);
        if (path === null)
        {
            return { path: null, state: INSTALLSTATE.UNKNOWN };
        }
        const present = path === '' || context.files.stat(path)?.exists !== false
            && context.files.stat(path) !== null;
        return { path, state: present ? INSTALLSTATE.LOCAL : INSTALLSTATE.ABSENT };
    };

    /**
     * A feature's state as MsiQueryFeatureState answers it, with the
     * components it lists all where they should be.
     *
     * @param {string} product @param {string} feature
     */
    const featureState = (product, feature)=>{
        const features = registration.productFeatures(product);
        if (features === null)
        {
            return INSTALLSTATE.UNKNOWN;
        }
        if (!features.some(entry=>entry.feature === feature))
        {
            return INSTALLSTATE.UNKNOWN;
        }
        return registration.featureInstalled(product, feature) ? INSTALLSTATE.LOCAL
            : INSTALLSTATE.ADVERTISED;
    };

    /**
     * A component's path through a descriptor, installing what is missing
     * when the mode allows it, as MsiProvideComponent does.
     *
     * @param {string} product @param {string} feature @param {string | null} component
     * @param {number} mode  INSTALLMODE: 0 default, -1 existing, -2 no detection, -3 no
     *     source resolution, -4 no detection or source resolution.
     * @returns {Promise<{ code: number, path: string }>}
     */
    const provide = async(product, feature, component, mode)=>{
        if (!known(product))
        {
            return { code: ERROR_UNKNOWN_PRODUCT, path: '' };
        }
        const id = component ?? (await componentOf(product, feature));
        if (id === null)
        {
            return { code: ERROR_UNKNOWN_COMPONENT, path: '' };
        }
        if (featureState(product, feature) === INSTALLSTATE.ADVERTISED && mode !== -1
            && mode !== -2 && mode !== -4)
        {
            // An advertised feature's first use installs it.
            const code = await context.maintain(product, `ADDLOCAL="${feature}"`);
            if (code !== ERROR_SUCCESS && code !== ERROR_SUCCESS_REBOOT_REQUIRED)
            {
                return { code, path: '' };
            }
        }
        let { path, state } = componentState(product, id);
        if (path === null)
        {
            return { code: ERROR_UNKNOWN_COMPONENT, path: '' };
        }
        const detect = mode !== -2 && mode !== -4;
        if (state !== INSTALLSTATE.LOCAL && detect && mode !== -1)
        {
            await context.maintain(product, `REINSTALL="${feature}" REINSTALLMODE=omus`);
            ({ path, state } = componentState(product, id));
        }
        return { code: state === INSTALLSTATE.LOCAL || !detect ? ERROR_SUCCESS
            : ERROR_FILE_NOT_FOUND, path: path ?? '' };
    };

    /**
     * The one component a feature holds, read from the product's package.
     *
     * @param {string} product @param {string} feature @returns {Promise<string | null>}
     */
    const componentOf = async(product, feature)=>{
        const session = await context.openProduct(product);
        if (typeof session === 'number')
        {
            return null;
        }
        const key = session.features.get(feature)?.components[0];
        return key ? session.components.get(key)?.id ?? null : null;
    };

    /**
     * A source list's key and, beneath it, the subkey of one kind of source.
     *
     * @param {string | null} code @param {number} options
     */
    const sources = (code, options)=>{
        if (code === null || (options & MSICODE_PATCH) !== 0)
        {
            return null;
        }
        return registration.sourceList(code, true);
    };
    /** @param {number} options @returns {string} the subkey for the options' source type */
    const kindOf = options=>((options & MSISOURCETYPE_URL) !== 0 ? 'URL' : 'Net');

    /**
     * The sources of one kind, in their order.
     *
     * @param {any} list @param {string} kind
     */
    const listed = (list, kind)=>{
        const key = hive.open(list, kind);
        return key ? hive.values(key).filter(value=>/^\d+$/.test(value.name))
            .sort((left, right)=>Number(left.name) - Number(right.name))
            .map(value=>valueText(value) ?? '') : [];
    };

    /**
     * Writes a kind of source's list again, numbered from one.
     *
     * @param {any} list @param {string} kind @param {string[]} entries
     */
    const relist = (list, kind, entries)=>{
        const key = hive.create(list, kind).key;
        for (const value of hive.values(key))
        {
            hive.deleteValue(key, value.name);
        }
        entries.forEach((entry, index)=>{
            hive.setValue(key, String(index + 1), REG_EXPAND_SZ, encodeAnsi(`${entry}\0`));
        });
    };

    /** @param {string} source a source folder as the list keeps it, with its separator */
    const asSource = source=>(/[\\/]$/.test(source) ? source : `${source}\\`);

    /**
     * A patch call: no patch is ever applied here, so there is nothing to
     * find, and one asked to be applied is refused as a package this
     * installer cannot apply.
     *
     * @param {string} api @param {number} answer
     */
    const noPatches = (api, answer)=>()=>{
        sayOnce(api, 'no patch engine: a .msp is not applied, and none is installed');
        return answer;
    };

    /** @param {string} api @param {number} answer */
    const noAdvertising = (api, answer)=>()=>{
        sayOnce(api, 'no advertising: a product is installed, never advertised or scripted');
        return answer;
    };

    return {
        ...both('MsiEnumFeatures', 16, wide=>([product, index, feature, parent])=>{
            const code = reader(wide)(product);
            if (code === null || (feature >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const features = registration.productFeatures(code);
            if (features === null)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const entry = features[index >>> 0];
            if (!entry)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            putFixed(wide, entry.feature.slice(0, MAX_FEATURE_CHARS), feature);
            if ((parent >>> 0) !== 0)
            {
                putFixed(wide, entry.parent.slice(0, MAX_FEATURE_CHARS), parent);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiEnumComponents', 8, wide=>([index, buffer])=>{
            if ((buffer >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const component = registration.components()[index >>> 0];
            if (!component)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            putFixed(wide, component, buffer);
            return ERROR_SUCCESS;
        }),
        ...both('MsiEnumClients', 12, wide=>([component, index, buffer])=>{
            const id = reader(wide)(component);
            if (id === null || squashGuid(id) === null || (buffer >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const clients = registration.clients(id);
            if (clients.length === 0)
            {
                return ERROR_UNKNOWN_COMPONENT;
            }
            const product = clients[index >>> 0];
            if (!product)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            putFixed(wide, product, buffer);
            return ERROR_SUCCESS;
        }),
        ...both('MsiEnumRelatedProducts', 16, wide=>([upgrade, reserved, index, buffer])=>{
            const code = reader(wide)(upgrade);
            if (code === null || squashGuid(code) === null || (reserved >>> 0) !== 0
                || (buffer >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const product = registration.relatedProducts(code)[index >>> 0];
            if (!product)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            putFixed(wide, product, buffer);
            return ERROR_SUCCESS;
        }),
        ...both('MsiEnumComponentQualifiers', 24, wide=>([category, index, qualifier,
            qualifierSize, data, dataSize])=>{
            const code = reader(wide)(category);
            const squashed = code === null ? null : squashGuid(code);
            if (squashed === null || (qualifier >>> 0) === 0 || (qualifierSize >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const key = hive.open(registration.machine(),
                `Software\\Classes\\Installer\\Components\\${squashed}`);
            if (!key)
            {
                return ERROR_UNKNOWN_COMPONENT;
            }
            const value = hive.values(key)[index >>> 0];
            if (!value)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            const text = new TextDecoder('latin1').decode(value.data).split('\0')[0];
            const parts = decomposeDescriptor(text);
            const written = putString(wide, value.name, qualifier, qualifierSize);
            const extra = putString(wide, parts ? text.slice(parts.used) : '', data, dataSize);
            return written !== ERROR_SUCCESS ? written : extra;
        }),
        ...both('MsiEnumPatches', 20, wide=>([product, index, patch, transforms, size])=>{
            const code = reader(wide)(product);
            if (code === null || squashGuid(code) === null || (patch >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const entry = registration.patches(code)[index >>> 0];
            if (!entry)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            putFixed(wide, entry.code, patch);
            return putString(wide, entry.transforms, transforms, size);
        }),
        ...both('MsiEnumPatchesEx', 40, ()=>()=>ERROR_NO_MORE_ITEMS),
        ...both('MsiEnumProductsEx', 32, wide=>([product, sid, contextMask, index, installed,
            installedContext, sidBuffer, sidSize])=>{
            void sid;
            const wanted = reader(wide)(product);
            if ((contextMask & MSIINSTALLCONTEXT_MACHINE) === 0)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            const all = registration.products().filter(code=>wanted === null || wanted === ''
                || code.toUpperCase() === wanted.toUpperCase());
            const code = all[index >>> 0];
            if (!code)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            if ((installed >>> 0) !== 0)
            {
                putFixed(wide, code, installed);
            }
            if ((installedContext >>> 0) !== 0)
            {
                writeU32(installedContext, MSIINSTALLCONTEXT_MACHINE);
            }
            // A per-machine product has no user's SID.
            return putString(wide, '', sidBuffer, sidSize);
        }),
        ...both('MsiGetFeatureInfo', 28, wide=>([handle, name, attributes, title, titleSize,
            help, helpSize])=>{
            const owner = get(handle, 'session');
            const feature = reader(wide)(name);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            if (feature === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const row = owner.session.db.table('Feature')?.rows
                .find((/** @type {any[]} */ entry)=>entry[0] === feature);
            if (!row)
            {
                return ERROR_UNKNOWN_FEATURE;
            }
            if ((attributes >>> 0) !== 0)
            {
                writeU32(attributes, Number(row[7] ?? 0));
            }
            const first = putString(wide, String(row[2] ?? ''), title, titleSize);
            const second = putString(wide, String(row[3] ?? ''), help, helpSize);
            return first !== ERROR_SUCCESS ? first : second;
        }),
        ...both('MsiGetFeatureUsage', 16, wide=>([product, feature, count, date])=>{
            const code = reader(wide)(product);
            const name = reader(wide)(feature);
            if (code === null || name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            if (featureState(code, name) === INSTALLSTATE.UNKNOWN)
            {
                return ERROR_UNKNOWN_FEATURE;
            }
            // Nothing counts uses through MsiUseFeature here, which is
            // where Windows counts them.
            if ((count >>> 0) !== 0)
            {
                writeU32(count, 0);
            }
            if ((date >>> 0) !== 0)
            {
                context.writeMemory(date >>> 0, new Uint8Array(2));
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiUseFeature', 8, wide=>([product, feature])=>{
            const code = reader(wide)(product);
            const name = reader(wide)(feature);
            return code === null || name === null ? INSTALLSTATE.INVALIDARG
                : featureState(code, name);
        }),
        ...both('MsiUseFeatureEx', 16, wide=>([product, feature, mode, reserved])=>{
            void mode;
            const code = reader(wide)(product);
            const name = reader(wide)(feature);
            return code === null || name === null || (reserved >>> 0) !== 0
                ? INSTALLSTATE.INVALIDARG : featureState(code, name);
        }),
        ...both('MsiQueryFeatureStateEx', 20, wide=>([product, sid, contextMask, feature,
            state])=>{
            void sid;
            const code = reader(wide)(product);
            const name = reader(wide)(feature);
            if (code === null || name === null || squashGuid(code) === null
                || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const answer = featureState(code, name);
            if (answer === INSTALLSTATE.UNKNOWN)
            {
                return ERROR_UNKNOWN_FEATURE;
            }
            if ((state >>> 0) !== 0)
            {
                writeU32(state, answer);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetUserInfo', 28, wide=>([product, user, userSize, company, companySize,
            serial, serialSize])=>{
            const code = reader(wide)(product);
            if (code === null || squashGuid(code) === null)
            {
                return USERINFOSTATE.INVALIDARG;
            }
            if (!known(code))
            {
                return USERINFOSTATE.UNKNOWN;
            }
            const owner = info(code, 'RegOwner');
            const answers = [putString(wide, owner, user, userSize),
                putString(wide, info(code, 'RegCompany'), company, companySize),
                putString(wide, info(code, 'ProductID'), serial, serialSize)];
            if (answers.includes(ERROR_MORE_DATA))
            {
                return USERINFOSTATE.MOREDATA;
            }
            return owner === '' ? USERINFOSTATE.ABSENT : USERINFOSTATE.PRESENT;
        }),
        ...both('MsiCollectUserInfo', 4, wide=>([product])=>{
            const code = reader(wide)(product);
            if (code === null || !known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            sayOnce('MsiCollectUserInfo', 'no internal user interface to show the first-run'
                + ' dialog: the user information stays as installed');
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetProductProperty', 16, wide=>([handle, name, buffer, size])=>{
            const owner = get(handle, 'session');
            const property = reader(wide)(name);
            if (!owner)
            {
                return ERROR_INVALID_HANDLE;
            }
            if (property === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            // The package's Property table, not the session's properties.
            const row = owner.session.db.table('Property')?.rows
                .find((/** @type {any[]} */ entry)=>entry[0] === property);
            return putString(wide, row?.[1] === null || row?.[1] === undefined ? ''
                : String(row[1]), buffer, size);
        }),
        ...both('MsiGetProductCode', 8, wide=>([component, buffer])=>{
            const id = reader(wide)(component);
            if (id === null || squashGuid(id) === null || (buffer >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const product = registration.clients(id)[0];
            if (!product)
            {
                return ERROR_UNKNOWN_COMPONENT;
            }
            putFixed(wide, product, buffer);
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetProductCodeFromPackageCode', 8, wide=>([packageCode, buffer])=>{
            const code = reader(wide)(packageCode);
            if (code === null || squashGuid(code) === null || (buffer >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const product = registration.products().find(entry=>
                info(entry, 'PackageCode').toUpperCase() === code.toUpperCase());
            if (!product)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            putFixed(wide, product, buffer);
            return ERROR_SUCCESS;
        }),
        ...both('MsiQueryComponentState', 20, wide=>([product, sid, contextMask, component,
            state])=>{
            void sid;
            const code = reader(wide)(product);
            const id = reader(wide)(component);
            if (code === null || id === null || squashGuid(code) === null
                || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const answer = componentState(code, id);
            if (answer.path === null)
            {
                return ERROR_UNKNOWN_COMPONENT;
            }
            if ((state >>> 0) !== 0)
            {
                writeU32(state, answer.state);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetProductInfoEx', 24, wide=>([product, sid, contextMask, property, buffer,
            size])=>{
            void sid;
            const code = reader(wide)(product);
            const name = reader(wide)(property);
            if (code === null || name === null || squashGuid(code) === null
                || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            if (name === 'State')
            {
                return putString(wide, String(registration.productState(code)), buffer, size);
            }
            const answer = registration.productInfo(code, name);
            return 'error' in answer ? answer.error : putString(wide, answer.value, buffer, size);
        }),
        ...both('MsiIsProductElevated', 8, wide=>([product, elevated])=>{
            const code = reader(wide)(product);
            if (code === null || squashGuid(code) === null || (elevated >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            // Every installation here is an administrator's, per machine.
            writeU32(elevated, 1);
            return ERROR_SUCCESS;
        }),
        MsiGetDatabaseState: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const opened = get(handle, 'database') ?? get(handle, 'session')?.session;
                if (!opened)
                {
                    return MSIDBSTATE_ERROR;
                }
                return opened.db?.readOnly ? MSIDBSTATE_READ : MSIDBSTATE_WRITE;
            },
        },
        ...both('MsiGetFileHash', 12, wide=>async([path, options, hash])=>{
            const name = reader(wide)(path);
            if (name === null || (hash >>> 0) === 0 || (options >>> 0) !== 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (context.readU32(hash) !== 20)
            {
                return ERROR_INVALID_PARAMETER;
            }
            // An empty path names no directory to look in.
            if (name === '')
            {
                return ERROR_PATH_NOT_FOUND;
            }
            const bytes = await context.readPath(name);
            if (!bytes)
            {
                return ERROR_FILE_NOT_FOUND;
            }
            const md5 = createMd5();
            md5.update(bytes);
            context.writeMemory((hash >>> 0) + 4, md5.digest());
            return ERROR_SUCCESS;
        }),
        ...both('MsiGetFileSignatureInformation', 20, wide=>([path, flags, certificate])=>{
            void flags;
            const name = reader(wide)(path);
            if (name === null || (certificate >>> 0) === 0)
            {
                return E_INVALIDARG | 0;
            }
            writeU32(certificate, 0);
            const stat = context.statPath(name);
            return (!stat || stat.exists === false ? HRESULT_FILE_NOT_FOUND
                : TRUST_E_NOSIGNATURE) | 0;
        }),
        ...both('MsiGetShortcutTarget', 16, wide=>async([shortcut, product, feature,
            component])=>{
            const path = reader(wide)(shortcut);
            if (path === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const bytes = await context.readPath(path);
            const link = bytes ? decodeShellLink(bytes) : null;
            const parts = link?.darwinId ? decomposeDescriptor(link.darwinId) : null;
            if (!parts)
            {
                return ERROR_FUNCTION_FAILED;
            }
            if ((product >>> 0) !== 0)
            {
                putFixed(wide, parts.product, product);
            }
            if ((feature >>> 0) !== 0)
            {
                putFixed(wide, parts.feature, feature);
            }
            if ((component >>> 0) !== 0)
            {
                putFixed(wide, parts.component ?? '', component);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiDecomposeDescriptor', 20, wide=>([descriptor, product, feature, component,
            used])=>{
            const text = reader(wide)(descriptor);
            const parts = text === null ? null : decomposeDescriptor(text);
            if (!parts)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if ((product >>> 0) !== 0)
            {
                putFixed(wide, parts.product, product);
            }
            if ((feature >>> 0) !== 0)
            {
                putFixed(wide, parts.feature, feature);
            }
            if ((component >>> 0) !== 0)
            {
                putFixed(wide, parts.component ?? '', component);
            }
            if ((used >>> 0) !== 0)
            {
                writeU32(used, parts.used);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiQueryFeatureStateFromDescriptor', 4, wide=>([descriptor])=>{
            const text = reader(wide)(descriptor);
            const parts = text === null ? null : decomposeDescriptor(text);
            return parts ? featureState(parts.product, parts.feature) : INSTALLSTATE.INVALIDARG;
        }),
        ...both('MsiProvideComponentFromDescriptor', 16, wide=>async([descriptor, buffer, size,
            argsOffset])=>{
            const text = reader(wide)(descriptor);
            const parts = text === null ? null : decomposeDescriptor(text);
            if (!parts)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const { code, path } = await provide(parts.product, parts.feature, parts.component,
                0);
            if (code !== ERROR_SUCCESS)
            {
                return code;
            }
            if ((argsOffset >>> 0) !== 0)
            {
                writeU32(argsOffset, 0);
            }
            return putString(wide, path, buffer, size);
        }),
        ...both('MsiConfigureFeatureFromDescriptor', 8, wide=>async([descriptor, state])=>{
            const text = reader(wide)(descriptor);
            const parts = text === null ? null : decomposeDescriptor(text);
            const request = new Map([[2, 'REMOVE'], [3, 'ADDLOCAL'], [4, 'ADDSOURCE'],
                [5, 'ADDDEFAULT']]).get(state | 0);
            if (!parts || request === undefined)
            {
                return ERROR_INVALID_PARAMETER;
            }
            return context.maintain(parts.product, `${request}="${parts.feature}"`);
        }),
        ...both('MsiReinstallFeatureFromDescriptor', 8, wide=>async([descriptor])=>{
            const text = reader(wide)(descriptor);
            const parts = text === null ? null : decomposeDescriptor(text);
            if (!parts)
            {
                return ERROR_INVALID_PARAMETER;
            }
            return context.maintain(parts.product,
                `REINSTALL="${parts.feature}" REINSTALLMODE=omus`);
        }),
        ...both('MsiProvideComponent', 24, wide=>async([product, feature, component, mode,
            buffer, size])=>{
            const code = reader(wide)(product);
            const name = reader(wide)(feature);
            const id = reader(wide)(component);
            if (code === null || name === null || id === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const provided = await provide(code, name, id, mode | 0);
            return provided.code !== ERROR_SUCCESS ? provided.code
                : putString(wide, provided.path, buffer, size);
        }),
        ...both('MsiProvideQualifiedComponent', 20, wide=>async([category, qualifier, mode,
            buffer, size])=>providedQualified(wide, category, qualifier, mode, buffer, size)),
        ...both('MsiProvideQualifiedComponentEx', 32, wide=>async([category, qualifier, mode,
            product, , , buffer, size])=>
            providedQualified(wide, category, qualifier, mode, buffer, size,
                reader(wide)(product))),
        ...both('MsiProvideAssembly', 24, ()=>()=>{
            sayOnce('MsiProvideAssembly', 'no assembly is ever installed here');
            return ERROR_UNKNOWN_COMPONENT;
        }),
        ...both('MsiInstallMissingComponent', 12, wide=>async([product, component])=>{
            const code = reader(wide)(product);
            const id = reader(wide)(component);
            if (code === null || id === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const session = await context.openProduct(code);
            if (typeof session === 'number')
            {
                return session;
            }
            const owned = [...session.components.values()].find(entry=>entry.id?.toUpperCase()
                === id.toUpperCase());
            if (!owned)
            {
                return ERROR_UNKNOWN_COMPONENT;
            }
            return context.maintain(code, `REINSTALL="${owned.features.join(',')}"`
                + ' REINSTALLMODE=omus');
        }),
        ...both('MsiInstallMissingFile', 8, wide=>async([product, file])=>{
            const code = reader(wide)(product);
            const name = reader(wide)(file);
            if (code === null || name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const session = await context.openProduct(code);
            if (typeof session === 'number')
            {
                return session;
            }
            const owned = [...session.files.values()].find(entry=>
                entry.name.toLowerCase() === name.toLowerCase()
                || entry.shortName.toLowerCase() === name.toLowerCase());
            const features = owned ? session.components.get(owned.component)?.features : null;
            if (!features || features.length === 0)
            {
                return ERROR_FILE_NOT_FOUND;
            }
            return context.maintain(code, `REINSTALL="${features.join(',')}" REINSTALLMODE=omus`);
        }),
        ...both('MsiVerifyPackage', 4, wide=>async([path])=>{
            const name = reader(wide)(path);
            if (name === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const stat = context.statPath(name);
            if (!stat || stat.exists === false)
            {
                return ERROR_INSTALL_PACKAGE_OPEN_FAILED;
            }
            const opened = await context.openPackage(name);
            const clsid = opened?.compound?.root?.clsid ?? '';
            return opened && CLSID_MSI_DATABASE.test(clsid) ? ERROR_SUCCESS
                : ERROR_INSTALL_PACKAGE_INVALID;
        }),

        // ----- source lists ------------------------------------------------
        ...both('MsiSourceListAddSource', 16, wide=>([product, user, reserved, source])=>{
            void user;
            const code = reader(wide)(product);
            const folder = reader(wide)(source);
            if (code === null || folder === null || folder === '' || (reserved >>> 0) !== 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, 0);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const net = listed(list, 'Net');
            if (!net.some(entry=>entry.toLowerCase() === asSource(folder).toLowerCase()))
            {
                relist(list, 'Net', [...net, asSource(folder)]);
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListAddSourceEx', 24, wide=>([product, sid, contextMask, options,
            source, index])=>{
            void sid;
            const code = reader(wide)(product);
            const folder = reader(wide)(source);
            if (code === null || folder === null || folder === ''
                || contextMask !== MSIINSTALLCONTEXT_MACHINE
                || (options & (MSISOURCETYPE_NETWORK | MSISOURCETYPE_URL)) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const kind = kindOf(options);
            const entries = listed(list, kind).filter(entry=>entry.toLowerCase()
                !== asSource(folder).toLowerCase());
            const at = (index >>> 0) === 0 || (index >>> 0) > entries.length ? entries.length
                : (index >>> 0) - 1;
            entries.splice(at, 0, asSource(folder));
            relist(list, kind, entries);
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListClearAll', 12, wide=>([product, user, reserved])=>{
            void user;
            const code = reader(wide)(product);
            if (code === null || (reserved >>> 0) !== 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, 0);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            relist(list, 'Net', []);
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListClearAllEx', 16, wide=>([product, sid, contextMask, options])=>{
            void sid;
            const code = reader(wide)(product);
            if (code === null || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            relist(list, kindOf(options), []);
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListClearSource', 20, wide=>([product, sid, contextMask, options,
            source])=>{
            void sid;
            const code = reader(wide)(product);
            const folder = reader(wide)(source);
            if (code === null || folder === null || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const kind = kindOf(options);
            relist(list, kind, listed(list, kind).filter(entry=>entry.toLowerCase()
                !== asSource(folder).toLowerCase()));
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListForceResolution', 12, wide=>([product, user, reserved])=>{
            void user;
            const code = reader(wide)(product);
            if (code === null || (reserved >>> 0) !== 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, 0);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            hive.deleteValue(list, 'LastUsedSource');
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListForceResolutionEx', 16, wide=>([product, sid, contextMask,
            options])=>{
            void sid;
            const code = reader(wide)(product);
            if (code === null || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            hive.deleteValue(list, 'LastUsedSource');
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListEnumSources', 28, wide=>([product, sid, contextMask, options,
            index, source, size])=>{
            void sid;
            const code = reader(wide)(product);
            if (code === null || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const entry = listed(list, kindOf(options))[index >>> 0];
            return entry === undefined ? ERROR_NO_MORE_ITEMS
                : putString(wide, entry, source, size);
        }),
        ...both('MsiSourceListGetInfo', 28, wide=>([product, sid, contextMask, options,
            property, value, size])=>{
            void sid;
            const code = reader(wide)(product);
            const name = reader(wide)(property);
            if (code === null || name === null || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const last = valueText(hive.getValue(list, 'LastUsedSource')) ?? '';
            const [type = '', , path = ''] = last.split(';');
            /** @type {Record<string, string>} */
            const answers = {
                PackageName: valueText(hive.getValue(list, 'PackageName')) ?? '',
                LastUsedSource: path,
                LastUsedType: type,
                MediaPackagePath: valueText(hive.getValue(hive.open(list, 'Media') ?? list,
                    'MediaPackage')) ?? '',
                DiskPrompt: valueText(hive.getValue(hive.open(list, 'Media') ?? list,
                    'DiskPrompt')) ?? '',
            };
            if (!(name in answers))
            {
                return ERROR_UNKNOWN_PROPERTY_SOURCE;
            }
            return putString(wide, answers[name], value, size);
        }),
        ...both('MsiSourceListSetInfo', 24, wide=>([product, sid, contextMask, options,
            property, value])=>{
            void sid;
            const code = reader(wide)(product);
            const name = reader(wide)(property);
            const text = reader(wide)(value);
            if (code === null || name === null || text === null
                || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            if (name === 'PackageName')
            {
                hive.setValue(list, 'PackageName', REG_SZ, encodeAnsi(`${text}\0`));
            }
            else if (name === 'LastUsedSource')
            {
                const kind = (options & MSISOURCETYPE_URL) !== 0 ? 'u' : 'n';
                hive.setValue(list, 'LastUsedSource', REG_EXPAND_SZ,
                    encodeAnsi(`${kind};1;${asSource(text)}\0`));
            }
            else if (name === 'MediaPackagePath' || name === 'DiskPrompt')
            {
                hive.setValue(hive.create(list, 'Media').key,
                    name === 'MediaPackagePath' ? 'MediaPackage' : 'DiskPrompt', REG_SZ,
                    encodeAnsi(`${text}\0`));
            }
            else
            {
                return ERROR_UNKNOWN_PROPERTY_SOURCE;
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListEnumMediaDisks', 40, wide=>([product, sid, contextMask, options,
            index, disk, label, labelSize, prompt, promptSize])=>{
            void sid;
            const code = reader(wide)(product);
            if (code === null || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const media = hive.open(list, 'Media');
            const disks = media ? hive.values(media).filter(value=>/^\d+$/.test(value.name))
                .sort((left, right)=>Number(left.name) - Number(right.name)) : [];
            const entry = disks[index >>> 0];
            if (!entry)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            const [volume = '', text = ''] = (valueText(entry) ?? '').split(';');
            if ((disk >>> 0) !== 0)
            {
                writeU32(disk, Number(entry.name));
            }
            const first = putString(wide, volume, label, labelSize);
            const second = putString(wide, text, prompt, promptSize);
            return first !== ERROR_SUCCESS ? first : second;
        }),
        ...both('MsiSourceListAddMediaDisk', 28, wide=>([product, sid, contextMask, options,
            disk, label, prompt])=>{
            void sid;
            const code = reader(wide)(product);
            if (code === null || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            hive.setValue(hive.create(list, 'Media').key, String(disk >>> 0), REG_SZ,
                encodeAnsi(`${reader(wide)(label) ?? ''};${reader(wide)(prompt) ?? ''}\0`));
            return ERROR_SUCCESS;
        }),
        ...both('MsiSourceListClearMediaDisk', 20, wide=>([product, sid, contextMask, options,
            disk])=>{
            void sid;
            const code = reader(wide)(product);
            if (code === null || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const list = sources(code, options);
            const media = list ? hive.open(list, 'Media') : null;
            if (!list)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            if (media)
            {
                hive.deleteValue(media, String(disk >>> 0));
            }
            return ERROR_SUCCESS;
        }),

        // ----- what has no engine behind it --------------------------------
        ...both('MsiApplyPatch', 16, wide=>async([patch, installPackage, type, commandLine])=>{
            const path = reader(wide)(patch);
            if (path === null || (installPackage >>> 0) !== 0 || (type >>> 0) !== 0)
            {
                // Patching an administrative image has no image to patch here.
                return ERROR_INVALID_PARAMETER;
            }
            const opened = await context.inspectPatch(path);
            if (typeof opened === 'number')
            {
                return opened;
            }
            const targets = opened.targets.filter(code=>known(code));
            if (targets.length === 0)
            {
                return ERROR_PATCH_TARGET_NOT_FOUND;
            }
            const extra = reader(wide)(commandLine) ?? '';
            for (const product of targets)
            {
                const code = await context.maintain(product, [`PATCH="${path}"`,
                    /\bREINSTALL=/i.test(extra) ? '' : 'REINSTALL=ALL',
                    /\bREINSTALLMODE=/i.test(extra) ? '' : 'REINSTALLMODE=omus', extra]
                    .filter(Boolean).join(' '));
                if (code !== ERROR_SUCCESS && code !== ERROR_SUCCESS_REBOOT_REQUIRED)
                {
                    return code;
                }
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiApplyMultiplePatches', 12, wide=>async([patches, product, properties])=>{
            const list = reader(wide)(patches);
            if (list === null || list.trim() === '')
            {
                return ERROR_INVALID_PARAMETER;
            }
            const only = reader(wide)(product);
            /** @type {Set<string>} */
            const targets = new Set();
            for (const path of list.split(';').map(entry=>entry.trim()).filter(Boolean))
            {
                const opened = await context.inspectPatch(path);
                if (typeof opened === 'number')
                {
                    return opened;
                }
                opened.targets.filter(code=>known(code) && (!only
                    || code.toUpperCase() === only.toUpperCase())).forEach(code=>targets.add(code));
            }
            if (targets.size === 0)
            {
                return ERROR_PATCH_TARGET_NOT_FOUND;
            }
            for (const code of targets)
            {
                const answer = await context.maintain(code, `PATCH="${list}" REINSTALL=ALL`
                    + ` REINSTALLMODE=omus ${reader(wide)(properties) ?? ''}`);
                if (answer !== ERROR_SUCCESS && answer !== ERROR_SUCCESS_REBOOT_REQUIRED)
                {
                    return answer;
                }
            }
            return ERROR_SUCCESS;
        }),
        ...both('MsiRemovePatches', 16, wide=>async([patches, product, type, properties])=>{
            const list = reader(wide)(patches);
            const code = reader(wide)(product);
            if (list === null || code === null || squashGuid(code) === null
                || (type >>> 0) !== INSTALLTYPE_SINGLE_INSTANCE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const applied = registration.patches(code).map(entry=>entry.code.toUpperCase());
            // The list names each patch by its code or by the path of its
            // package, as the reference allows; a package is asked its code.
            const asked = [];
            for (const entry of list.split(';').map(each=>each.trim()).filter(Boolean))
            {
                if (squashGuid(entry) !== null)
                {
                    asked.push(entry.toUpperCase());
                    continue;
                }
                const opened = await context.inspectPatch(entry.replace(/^"(.*)"$/, '$1'));
                if (typeof opened === 'number')
                {
                    return ERROR_UNKNOWN_PATCH;
                }
                asked.push(opened.code.toUpperCase());
            }
            if (asked.length === 0 || !asked.every(entry=>applied.includes(entry)))
            {
                return ERROR_UNKNOWN_PATCH;
            }
            // What the patches brought goes back to what the product shipped:
            // any file of another version is put back.
            return context.maintain(code, `MSIPATCHREMOVE="${asked.join(';')}" REINSTALL=ALL`
                + ` REINSTALLMODE=dmus ${reader(wide)(properties) ?? ''}`);
        }),
        ...both('MsiGetPatchInfo', 16, wide=>([patch, attribute, buffer, size])=>{
            const code = reader(wide)(patch);
            const name = reader(wide)(attribute);
            if (code === null || name === null || squashGuid(code) === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const found = registration.products().flatMap(product=>registration.patches(product))
                .find(entry=>entry.code.toUpperCase() === code.toUpperCase());
            if (!found)
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            if (name !== 'LocalPackage')
            {
                return ERROR_UNKNOWN_PROPERTY_SOURCE;
            }
            return putString(wide, found.localPackage, buffer, size);
        }),
        ...both('MsiGetPatchInfoEx', 28, wide=>([patch, product, sid, contextMask, property,
            buffer, size])=>{
            void sid;
            const code = reader(wide)(patch);
            const target = reader(wide)(product);
            const name = reader(wide)(property);
            if (code === null || target === null || name === null || squashGuid(code) === null
                || contextMask !== MSIINSTALLCONTEXT_MACHINE)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(target))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            const found = registration.patches(target)
                .find(entry=>entry.code.toUpperCase() === code.toUpperCase());
            if (!found)
            {
                return ERROR_UNKNOWN_PATCH;
            }
            /** @type {Record<string, string>} */
            const answers = { LocalPackage: found.localPackage, Transforms: found.transforms,
                State: '1', Uninstallable: '1', InstallDate: '', DisplayName: '', MoreInfoURL: '' };
            return name in answers ? putString(wide, answers[name], buffer, size)
                : ERROR_UNKNOWN_PROPERTY_SOURCE;
        }),
        ...both('MsiDeterminePatchSequence', 20, wide=>async([product, sid, contextMask, count,
            infos])=>{
            void sid;
            const code = reader(wide)(product);
            if (code === null || contextMask !== MSIINSTALLCONTEXT_MACHINE || (infos >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            if (!known(code))
            {
                return ERROR_UNKNOWN_PRODUCT;
            }
            return sequencePatches(wide, count >>> 0, infos >>> 0, [code]);
        }),
        ...both('MsiDetermineApplicablePatches', 12, wide=>async([packagePath, count, infos])=>{
            const path = reader(wide)(packagePath);
            if (path === null || (infos >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const product = await context.productCodeOf(path);
            if (product === null)
            {
                return ERROR_INSTALL_PACKAGE_INVALID;
            }
            return sequencePatches(wide, count >>> 0, infos >>> 0, [product]);
        }),
        ...both('MsiExtractPatchXMLData', 16, ()=>noPatches('MsiExtractPatchXMLData',
            ERROR_PATCH_PACKAGE_UNSUPPORTED)),
        ...both('MsiAdvertiseProduct', 16, wide=>async([path, script, transforms])=>
            advertiseProduct(wide, path, script, transforms)),
        ...both('MsiAdvertiseProductEx', 24, wide=>async([path, script, transforms, , platform,
            options])=>((platform >>> 0) > 2 || (options >>> 0) > 1 ? ERROR_INVALID_PARAMETER
            : advertiseProduct(wide, path, script, transforms))),
        ...both('MsiAdvertiseScript', 16, ()=>noAdvertising('MsiAdvertiseScript',
            ERROR_CALL_NOT_IMPLEMENTED)),
        ...both('MsiProcessAdvertiseScript', 20, ()=>noAdvertising('MsiProcessAdvertiseScript',
            ERROR_CALL_NOT_IMPLEMENTED)),
        ...both('MsiGetProductInfoFromScript', 32, ()=>noAdvertising(
            'MsiGetProductInfoFromScript', ERROR_INSTALL_FAILURE)),
        MsiEnableUIPreview: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([database, preview])=>{
                if (!get(database, 'database'))
                {
                    return ERROR_INVALID_HANDLE;
                }
                if ((preview >>> 0) !== 0)
                {
                    writeU32(preview, 0);
                }
                sayOnce('MsiEnableUIPreview', 'no internal user interface to preview dialogs in');
                return ERROR_CALL_NOT_IMPLEMENTED;
            },
        },
        ...both('MsiPreviewDialog', 8, ()=>()=>ERROR_INVALID_HANDLE),
        ...both('MsiPreviewBillboard', 12, ()=>()=>ERROR_INVALID_HANDLE),

        // ----- Windows Installer 4.5 and 5.0 ----------------------------------
        ...both('MsiBeginTransaction', 16, wide=>([name, attributes, transaction, event])=>{
            void attributes;
            if (reader(wide)(name) === null || (transaction >>> 0) === 0 || (event >>> 0) === 0)
            {
                return ERROR_INVALID_PARAMETER;
            }
            writeU32(transaction, context.openHandle('transaction', {}));
            // No other process takes a transaction over, so there is no event
            // to wait for its ownership changing.
            writeU32(event, 0);
            return ERROR_SUCCESS;
        }),
        MsiJoinTransaction: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([transaction, , event])=>{
                if (!get(transaction, 'transaction'))
                {
                    return ERROR_INVALID_HANDLE;
                }
                if ((event >>> 0) !== 0)
                {
                    writeU32(event, 0);
                }
                return ERROR_SUCCESS;
            },
        },
        MsiEndTransaction: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([state])=>{
                if ((state >>> 0) === MSITRANSACTIONSTATE_ROLLBACK)
                {
                    sayOnce('MsiEndTransaction', 'nothing is rolled back: the installations in'
                        + ' the transaction stay');
                }
                return ERROR_SUCCESS;
            },
        },
        ...both('MsiEnumComponentsEx', 28, wide=>([sid, contextMask, index, component,
            installedContext, sidBuffer, sidSize])=>{
            void sid;
            if ((contextMask & MSIINSTALLCONTEXT_MACHINE) === 0)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            const id = registration.components()[index >>> 0];
            if (!id)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            if ((component >>> 0) !== 0)
            {
                putFixed(wide, id, component);
            }
            if ((installedContext >>> 0) !== 0)
            {
                writeU32(installedContext, MSIINSTALLCONTEXT_MACHINE);
            }
            return putString(wide, '', sidBuffer, sidSize);
        }),
        ...both('MsiEnumClientsEx', 32, wide=>([component, sid, contextMask, index, product,
            installedContext, sidBuffer, sidSize])=>{
            void sid;
            const id = reader(wide)(component);
            if (id === null || squashGuid(id) === null)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const clients = (contextMask & MSIINSTALLCONTEXT_MACHINE) === 0 ? []
                : registration.clients(id);
            const code = clients[index >>> 0];
            if (!code)
            {
                return ERROR_NO_MORE_ITEMS;
            }
            if ((product >>> 0) !== 0)
            {
                putFixed(wide, code, product);
            }
            if ((installedContext >>> 0) !== 0)
            {
                writeU32(installedContext, MSIINSTALLCONTEXT_MACHINE);
            }
            return putString(wide, '', sidBuffer, sidSize);
        }),
        ...both('MsiGetComponentPathEx', 24, wide=>([product, component, sid, contextMask,
            buffer, size])=>{
            void sid;
            const code = reader(wide)(product);
            const id = reader(wide)(component);
            if (code === null || id === null || (contextMask & MSIINSTALLCONTEXT_MACHINE) === 0)
            {
                return INSTALLSTATE.INVALIDARG;
            }
            const answer = componentState(code, id);
            if (answer.path === null)
            {
                return INSTALLSTATE.UNKNOWN;
            }
            putString(wide, answer.path, buffer, size);
            return answer.state;
        }),
        ...both('MsiGetPatchFileList', 16, ()=>noPatches('MsiGetPatchFileList',
            ERROR_FUNCTION_FAILED)),

        // ----- housekeeping --------------------------------------------------
        MsiInvalidateFeatureCache: { argBytes: 8, handler: ()=>ERROR_SUCCESS },
        MsiCreateAndVerifyInstallerDirectory: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([reserved])=>{
                if ((reserved >>> 0) !== 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const folder = context.fullPath('C:\\WINDOWS\\Installer');
                if (!context.files.stat(folder)?.isDirectory)
                {
                    context.files.mkdir(folder);
                }
                return ERROR_SUCCESS;
            },
        },
        ...both('MsiNotifySidChange', 8, ()=>()=>ERROR_SUCCESS),
        ...both('MsiDeleteUserData', 12, ()=>()=>ERROR_SUCCESS),
        ...both('Migrate10CachedPackages', 16, ()=>()=>ERROR_SUCCESS),
        ...both('MsiLoadString', 20, ()=>([, , buffer, room])=>{
            // msi.dll's own string table: none of its strings is carried here.
            if ((buffer >>> 0) !== 0 && (room | 0) > 0)
            {
                context.writeMemory(buffer >>> 0, new Uint8Array(2));
            }
            return 0;
        }),
        ...both('MsiMessageBox', 24, wide=>async([, text, caption, type])=>
            await context.messageBox?.(reader(wide)(text) ?? '', reader(wide)(caption) ?? '',
                type >>> 0) ?? 0),
        ...both('MsiMessageBoxEx', 28, wide=>async([, text, caption, type])=>
            await context.messageBox?.(reader(wide)(text) ?? '', reader(wide)(caption) ?? '',
                type >>> 0) ?? 0),
        QueryInstanceCount: { argBytes: 0, handler: ()=>0 },
    };

    /**
     * MsiAdvertiseProduct(Ex): the package published to this machine with
     * none of its files, which the first use of a feature then installs. An
     * advertise script written to a file instead has a format Windows does
     * not document, and is refused.
     *
     * @param {boolean} wide @param {number} path @param {number} script
     * @param {number} transforms
     */
    async function advertiseProduct(wide, path, script, transforms){
        const name = reader(wide)(path);
        if (name === null)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if ((script >>> 0) > ADVERTISEFLAGS_USERASSIGN)
        {
            return noAdvertising('MsiAdvertiseProduct', ERROR_CALL_NOT_IMPLEMENTED)();
        }
        return context.advertise(name, reader(wide)(transforms));
    }

    /**
     * MsiDeterminePatchSequence's and MsiDetermineApplicablePatches' answer
     * over an array of MSIPATCHSEQUENCEINFO -- a path, its type, the order it
     * goes in and its status: each patch file that targets the product, in
     * the order given, the others marked as not applying.
     *
     * @param {boolean} wide @param {number} count @param {number} infos
     * @param {string[]} products
     */
    async function sequencePatches(wide, count, infos, products){
        let order = 0;
        for (let at = 0; at < count; at++)
        {
            const entry = infos + at * 16;
            const path = reader(wide)(context.readU32(entry));
            const type = context.readU32(entry + 4);
            const opened = path === null || type !== MSIPATCH_DATATYPE_PATCHFILE ? null
                : await context.inspectPatch(path);
            const applies = opened && typeof opened !== 'number'
                && opened.targets.some(code=>products.some(product=>product.toUpperCase()
                    === code.toUpperCase()));
            writeU32(entry + 8, applies ? order++ : 0xffffffff);
            writeU32(entry + 12, applies ? ERROR_SUCCESS : ERROR_PATCH_TARGET_NOT_FOUND);
        }
        return ERROR_SUCCESS;
    }

    /**
     * MsiProvideQualifiedComponent(Ex): a category's qualifier, its
     * descriptor read from where PublishComponents filed it, and the
     * component it names provided.
     *
     * @param {boolean} wide @param {number} category @param {number} qualifier
     * @param {number} mode @param {number} buffer @param {number} size
     * @param {string | null} [product]  Only this product's.
     */
    async function providedQualified(wide, category, qualifier, mode, buffer, size, product){
        const code = reader(wide)(category);
        const name = reader(wide)(qualifier);
        const squashed = code === null ? null : squashGuid(code);
        if (squashed === null || name === null)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const key = hive.open(registration.machine(),
            `Software\\Classes\\Installer\\Components\\${squashed}`);
        const value = key ? hive.getValue(key, name) : null;
        if (!value)
        {
            return ERROR_INDEX_ABSENT;
        }
        const descriptors = new TextDecoder('latin1').decode(value.data).split('\0')
            .filter(Boolean).map(decomposeDescriptor);
        const chosen = descriptors.find(parts=>parts && (!product
            || parts.product.toUpperCase() === product.toUpperCase()));
        if (!chosen)
        {
            return ERROR_BAD_CONFIGURATION;
        }
        const provided = await provide(chosen.product, chosen.feature, chosen.component,
            mode | 0);
        return provided.code !== ERROR_SUCCESS ? provided.code
            : putString(wide, provided.path, buffer, size);
    }
}

/** MsiSourceListGetInfo and SetInfo for a property they do not know. */
const ERROR_UNKNOWN_PROPERTY_SOURCE = 1608;

export { unsquashGuid, GUID_CHARS };
