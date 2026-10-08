/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where the installer records what it installed: the registry, under the
 * keys Windows itself uses, so a program that reads them rather than asking
 * the installer -- the control panel's list, a patch looking for its product,
 * a setup checking for its prerequisite -- finds the same answer.
 *
 * A product, component or upgrade code is filed under its GUID "squashed":
 * its hexadecimal digits without punctuation, each of the first three groups
 * reversed and each byte of the last two swapped. Everything here is a
 * per-machine installation, as an administrator's is.
 */

import {
    HKEY_LOCAL_MACHINE, REG_DWORD, REG_EXPAND_SZ, REG_MULTI_SZ, REG_SZ,
} from '../advapi32/registry.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

const INSTALLER = 'Software\\Microsoft\\Windows\\CurrentVersion\\Installer';
const MACHINE_SID = 'S-1-5-18';
const USER_DATA = `${INSTALLER}\\UserData\\${MACHINE_SID}`;
const CLASSES = 'Software\\Classes\\Installer';
const UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

/** INSTALLSTATE values a product query answers. */
const INSTALLSTATE_UNKNOWN = -1;
const INSTALLSTATE_ADVERTISED = 1;
const INSTALLSTATE_DEFAULT = 5;

export const ERROR_UNKNOWN_PRODUCT = 1605;
export const ERROR_UNKNOWN_PROPERTY = 1608;
export const ERROR_UNKNOWN_COMPONENT = 1607;

/**
 * A GUID in its registry form, or null when the text is not a braced GUID.
 *
 * @param {string} guid @returns {string | null}
 */
export function squashGuid(guid){
    const match = /^\{([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{12})\}$/
        .exec(guid);
    if (!match)
    {
        return null;
    }
    const reverse = (/** @type {string} */ text)=>[...text].reverse().join('');
    const swapped = (/** @type {string} */ text)=>text.replace(/(.)(.)/g, '$2$1');
    return (reverse(match[1]) + reverse(match[2]) + reverse(match[3]) + swapped(match[4])
        + swapped(match[5])).toUpperCase();
}

/** @param {string} squashed @returns {string} the braced GUID it was made from */
export function unsquashGuid(squashed){
    const reverse = (/** @type {string} */ text)=>[...text].reverse().join('');
    const swapped = (/** @type {string} */ text)=>text.replace(/(.)(.)/g, '$2$1');
    const s = squashed.toUpperCase();
    return `{${reverse(s.slice(0, 8))}-${reverse(s.slice(8, 12))}-${reverse(s.slice(12, 16))}-`
        + `${swapped(s.slice(16, 20))}-${swapped(s.slice(20, 32))}}`;
}

/**
 * The registry, as advapi32's hive offers it.
 *
 * @typedef {Object} Hive
 * @property {(id: number) => any} root
 * @property {(key: any, path?: string | null) => any} open
 * @property {(key: any, path?: string | null) => { key: any, created: boolean }} create
 * @property {(key: any, path?: string | null) => string} remove
 * @property {(key: any) => string[]} subkeys
 * @property {(key: any) => { name: string, type: number, data: Uint8Array }[]} values
 * @property {(key: any, name: string)
 *     => { name: string, type: number, data: Uint8Array } | null} getValue
 * @property {(key: any, name: string, type: number, data: Uint8Array) => any} setValue
 * @property {(key: any, name: string) => any} deleteValue
 */

/** A string as the hive keeps one: in the ANSI page, with its terminator. @param {string} text */
const sz = text=>encodeAnsi(`${text}\0`);
/** @param {number} value */
const dword = value=>new Uint8Array(Uint32Array.of(value >>> 0).buffer);

/**
 * Text of a registry value: a string as the hive keeps it, a number as its
 * digits.
 *
 * @param {{ type: number, data: Uint8Array } | null} value
 */
export function valueText(value){
    if (!value)
    {
        return null;
    }
    if (value.type === REG_DWORD)
    {
        return String(new DataView(value.data.buffer, value.data.byteOffset, 4)
            .getUint32(0, true));
    }
    const end = value.data.indexOf(0);
    const text = decodeAnsi(end < 0 ? value.data : value.data.subarray(0, end));
    return text;
}

/**
 * A version as the installer's records keep it: major, minor and build in
 * one number.
 *
 * @param {string} text
 */
const packedVersion = text=>{
    const [major = 0, minor = 0, build = 0] = text.split('.').map(part=>Number(part) || 0);
    return ((major & 0xff) << 24 | (minor & 0xff) << 16 | (build & 0xffff)) >>> 0;
};

/**
 * The strings of a REG_MULTI_SZ value, in order.
 *
 * @param {{ data: Uint8Array } | null} value @returns {string[]}
 */
const multiText = value=>(value ? decodeAnsi(value.data).split('\0') : []);

/**
 * The installed product's properties MsiGetProductInfo reads from
 * InstallProperties, by the name the call takes.
 */
const INSTALL_PROPERTIES = Object.freeze({
    InstalledProductName: 'DisplayName', VersionString: 'DisplayVersion', HelpLink: 'HelpLink',
    HelpTelephone: 'HelpTelephone', InstallLocation: 'InstallLocation',
    InstallSource: 'InstallSource', InstallDate: 'InstallDate', Publisher: 'Publisher',
    LocalPackage: 'LocalPackage', URLInfoAbout: 'URLInfoAbout', URLUpdateInfo: 'URLUpdateInfo',
    VersionMinor: 'VersionMinor', VersionMajor: 'VersionMajor', ProductID: 'ProductID',
    RegCompany: 'RegCompany', RegOwner: 'RegOwner', Uninstallable: 'Uninstallable',
});

/** And those it reads from the advertised product's key. */
const ADVERTISED_PROPERTIES = Object.freeze({
    ProductName: 'ProductName', PackageCode: 'PackageCode', Version: 'Version',
    Language: 'Language', AssignmentType: 'Assignment', ProductIcon: 'ProductIcon',
    Transforms: 'Transforms', PackageName: 'PackageName',
});

/**
 * Deletes a key and everything under it. The hive refuses a key that has
 * subkeys, as NT does, so the tree goes from its leaves up.
 *
 * @param {Hive} hive @param {any} root @param {string} path
 */
export function removeKeyTree(hive, root, path){
    const key = hive.open(root, path);
    if (!key)
    {
        return;
    }
    for (const name of hive.subkeys(key))
    {
        removeKeyTree(hive, root, `${path}\\${name}`);
    }
    hive.remove(root, path);
}

/**
 * @param {Hive} hive
 */
export function createRegistration(hive){
    const machine = hive.root(HKEY_LOCAL_MACHINE);

    /** @param {string} path */
    const open = path=>hive.open(machine, path);
    /** @param {string} path */
    const create = path=>hive.create(machine, path).key;

    /** @param {string} productCode */
    const productKeys = productCode=>{
        const squashed = squashGuid(productCode);
        return squashed ? {
            properties: `${USER_DATA}\\Products\\${squashed}\\InstallProperties`,
            advertised: `${CLASSES}\\Products\\${squashed}`,
            features: `${USER_DATA}\\Products\\${squashed}\\Features`,
            uninstall: `${UNINSTALL}\\${productCode}`,
            squashed,
        } : null;
    };

    /**
     * The product as published to the machine, installed or only
     * advertised: its name, package, version and language under the
     * classes' Installer key, where its package can be found again, and its
     * place under its upgrade code.
     *
     * @param {{ productCode: string, packageCode: string, upgradeCode: string | null,
     *     name: string, version: string, language: number, installSource: string,
     *     packageName: string }} product
     */
    const advertise = product=>{
        const keys = productKeys(product.productCode);
        if (!keys)
        {
            return;
        }
        const version = packedVersion(product.version);
        const advertised = create(keys.advertised);
        // Where the package came from, for a repair that needs its source:
        // the folder as the first network source and the last one used.
        const sources = create(`${keys.advertised}\\SourceList`);
        const folder = product.installSource;
        hive.setValue(sources, 'PackageName', REG_SZ, sz(product.packageName));
        hive.setValue(sources, 'LastUsedSource', REG_EXPAND_SZ, sz(`n;1;${folder}`));
        hive.setValue(create(`${keys.advertised}\\SourceList\\Net`), '1', REG_EXPAND_SZ,
            sz(folder));
        hive.setValue(advertised, 'ProductName', REG_SZ, sz(product.name));
        hive.setValue(advertised, 'PackageCode', REG_SZ,
            sz(squashGuid(product.packageCode) ?? ''));
        hive.setValue(advertised, 'Language', REG_DWORD, dword(product.language));
        hive.setValue(advertised, 'Version', REG_DWORD, dword(version));
        hive.setValue(advertised, 'Assignment', REG_DWORD, dword(1));
        if (product.upgradeCode)
        {
            const upgrade = squashGuid(product.upgradeCode);
            if (upgrade)
            {
                hive.setValue(create(`${CLASSES}\\UpgradeCodes\\${upgrade}`), keys.squashed,
                    REG_SZ, sz(''));
            }
        }
    };

    return {
        /** @param {string} productCode @returns {number} an INSTALLSTATE */
        productState: productCode=>{
            const keys = productKeys(productCode);
            if (!keys)
            {
                return INSTALLSTATE_UNKNOWN;
            }
            if (open(keys.properties))
            {
                return INSTALLSTATE_DEFAULT;
            }
            return open(keys.advertised) ? INSTALLSTATE_ADVERTISED : INSTALLSTATE_UNKNOWN;
        },

        /**
         * MsiGetProductInfo's answer.
         *
         * @param {string} productCode @param {string} property
         * @returns {{ value: string } | { error: number }}
         */
        productInfo: (productCode, property)=>{
            const keys = productKeys(productCode);
            if (!keys || (!open(keys.properties) && !open(keys.advertised)))
            {
                return { error: ERROR_UNKNOWN_PRODUCT };
            }
            const installed = /** @type {Record<string, string>} */ (INSTALL_PROPERTIES)[property];
            const advertised = /** @type {Record<string, string>} */ (ADVERTISED_PROPERTIES)[property];
            if (!installed && !advertised)
            {
                return { error: ERROR_UNKNOWN_PROPERTY };
            }
            const key = installed ? open(keys.properties) : open(keys.advertised);
            const text = key ? valueText(hive.getValue(key, installed ?? advertised)) : null;
            if (text === null)
            {
                return installed && open(keys.properties) ? { value: '' }
                    : { error: ERROR_UNKNOWN_PROPERTY };
            }
            return { value: property === 'PackageCode' ? unsquashGuid(text) : text };
        },

        /** @returns {string[]} every product installed or advertised, as GUIDs */
        products: ()=>{
            const found = new Set();
            for (const path of [`${USER_DATA}\\Products`, `${CLASSES}\\Products`])
            {
                const key = open(path);
                for (const name of key ? hive.subkeys(key) : [])
                {
                    if (/^[0-9A-F]{32}$/i.test(name))
                    {
                        found.add(unsquashGuid(name));
                    }
                }
            }
            return [...found];
        },

        /**
         * Records an installed product.
         *
         * @param {{ productCode: string, packageCode: string, upgradeCode: string | null,
         *     name: string, version: string, manufacturer: string, language: number,
         *     installLocation: string, installSource: string, localPackage: string,
 *     packageName: string,
         *     date: string, extras: Record<string, string> }} product
         */
        registerProduct: product=>{
            const keys = productKeys(product.productCode);
            if (!keys)
            {
                return;
            }
            const [major = 0, minor = 0] = product.version.split('.').map(part=>Number(part) || 0);
            const version = packedVersion(product.version);
            /** @type {[string, number, Uint8Array][]} */
            const values = [
                ['DisplayName', REG_SZ, sz(product.name)],
                ['DisplayVersion', REG_SZ, sz(product.version)],
                ['Publisher', REG_SZ, sz(product.manufacturer)],
                ['InstallLocation', REG_SZ, sz(product.installLocation)],
                ['InstallSource', REG_SZ, sz(product.installSource)],
                ['InstallDate', REG_SZ, sz(product.date)],
                ['LocalPackage', REG_SZ, sz(product.localPackage)],
                ['Language', REG_DWORD, dword(product.language)],
                ['Version', REG_DWORD, dword(version)],
                ['VersionMajor', REG_DWORD, dword(major)],
                ['VersionMinor', REG_DWORD, dword(minor)],
                ['WindowsInstaller', REG_DWORD, dword(1)],
                ['UninstallString', REG_EXPAND_SZ,
                    sz(`MsiExec.exe /I${product.productCode}`)],
                ['ModifyPath', REG_EXPAND_SZ, sz(`MsiExec.exe /I${product.productCode}`)],
                ...Object.entries(product.extras).map(([name, text])=>
                    /** @type {[string, number, Uint8Array]} */ ([name, REG_SZ, sz(text)])),
            ];
            for (const path of [keys.properties, keys.uninstall])
            {
                const key = create(path);
                for (const [name, type, data] of values)
                {
                    hive.setValue(key, name, type, data);
                }
            }
            advertise(product);
        },

        /**
         * Records where an installed component's key path is, for its product.
         *
         * @param {string} componentId @param {string} productCode @param {string} keyPath
         */
        registerComponent: (componentId, productCode, keyPath)=>{
            const component = squashGuid(componentId);
            const product = squashGuid(productCode);
            if (component && product)
            {
                hive.setValue(create(`${USER_DATA}\\Components\\${component}`), product, REG_SZ,
                    sz(keyPath));
            }
        },

        /**
         * MsiGetComponentPath's lookup: the key path a product recorded, or
         * null when it recorded none.
         *
         * @param {string} productCode @param {string} componentId
         */
        componentPath: (productCode, componentId)=>{
            const component = squashGuid(componentId);
            const product = squashGuid(productCode);
            const key = component && product ? open(`${USER_DATA}\\Components\\${component}`)
                : null;
            return key ? valueText(hive.getValue(key, /** @type {string} */ (product))) : null;
        },

        /**
         * Whether a component is registered for any product but this one: a
         * shared component, whose files stay until its last product goes.
         *
         * @param {string} componentId @param {string} productCode
         */
        sharedWith: (componentId, productCode)=>{
            const component = squashGuid(componentId);
            const product = squashGuid(productCode);
            const key = component ? open(`${USER_DATA}\\Components\\${component}`) : null;
            return Boolean(key && hive.values(key).some(value=>value.name.toUpperCase()
                !== product));
        },

        /**
         * Records an installed feature: its components for the product, and
         * its parent where the advertised features are listed.
         *
         * @param {string} productCode @param {string} feature @param {string} components
         * @param {string | null} [parent]
         * @param {boolean} [advertised]  Published only, for a first use to install.
         */
        registerFeature: (productCode, feature, components, parent = null, advertised = false)=>{
            const keys = productKeys(productCode);
            if (keys)
            {
                if (!advertised)
                {
                    hive.setValue(create(keys.features), feature, REG_SZ, sz(components));
                }
                hive.setValue(create(`${CLASSES}\\Features\\${keys.squashed}`), feature, REG_SZ,
                    sz(parent ?? ''));
            }
        },

        /**
         * A product's features as the machine lists them, each with its parent.
         *
         * @param {string} productCode @returns {{ feature: string, parent: string }[] | null}
         *     null for a product the machine has no record of
         */
        productFeatures: productCode=>{
            const keys = productKeys(productCode);
            const key = keys ? open(`${CLASSES}\\Features\\${keys.squashed}`) : null;
            if (!keys || (!key && !open(keys.properties)))
            {
                return null;
            }
            return key ? hive.values(key).map(value=>({ feature: value.name,
                parent: valueText(value) ?? '' })) : [];
        },

        /** @returns {string[]} every component some product has registered */
        components: ()=>{
            const key = open(`${USER_DATA}\\Components`);
            return key ? hive.subkeys(key).filter(name=>/^[0-9A-F]{32}$/i.test(name))
                .map(unsquashGuid) : [];
        },

        /** @param {string} componentId @returns {string[]} the products that have it */
        clients: componentId=>{
            const component = squashGuid(componentId);
            const key = component ? open(`${USER_DATA}\\Components\\${component}`) : null;
            return key ? hive.values(key).filter(value=>/^[0-9A-F]{32}$/i.test(value.name))
                .map(value=>unsquashGuid(value.name)) : [];
        },

        /**
         * A product's source list: where its package can be found again --
         * network or local folders, URLs, media -- and the package's name.
         *
         * @param {string} productCode @param {boolean} [make]
         */
        sourceList: (productCode, make = false)=>{
            const keys = productKeys(productCode);
            if (!keys || !open(keys.advertised))
            {
                return null;
            }
            const path = `${keys.advertised}\\SourceList`;
            return make ? create(path) : open(path);
        },

        /** @param {string} productCode @param {string} feature @returns {boolean} */
        featureInstalled: (productCode, feature)=>{
            const keys = productKeys(productCode);
            const key = keys ? open(keys.features) : null;
            return Boolean(key && hive.getValue(key, feature));
        },

        /**
         * Forgets a component's key path for one product: the component stays
         * registered for the others that share it.
         *
         * @param {string} componentId @param {string} productCode
         */
        unregisterComponent: (componentId, productCode)=>{
            const component = squashGuid(componentId);
            const product = squashGuid(productCode);
            const path = `${USER_DATA}\\Components\\${component}`;
            const key = component && product ? open(path) : null;
            if (!key)
            {
                return;
            }
            hive.deleteValue(key, /** @type {string} */ (product));
            if (hive.values(key).length === 0 && hive.subkeys(key).length === 0)
            {
                hive.remove(machine, path);
            }
        },

        /** @param {string} productCode @param {string} feature */
        unregisterFeature: (productCode, feature)=>{
            const keys = productKeys(productCode);
            for (const path of keys ? [keys.features, `${CLASSES}\\Features\\${keys.squashed}`]
                : [])
            {
                const key = open(path);
                if (key)
                {
                    hive.deleteValue(key, feature);
                }
            }
        },

        /**
         * Forgets a product entirely, as a removal leaves the machine: its
         * properties, its line in the control panel, its advertisement, its
         * features, its components' key paths and its place under its upgrade
         * code.
         *
         * @param {string} productCode
         */
        unregisterProduct: productCode=>{
            const keys = productKeys(productCode);
            if (!keys)
            {
                return;
            }
            for (const path of [`${USER_DATA}\\Products\\${keys.squashed}`, keys.uninstall,
                keys.advertised, `${CLASSES}\\Features\\${keys.squashed}`])
            {
                removeKeyTree(hive, machine, path);
            }
            const components = open(`${USER_DATA}\\Components`);
            for (const name of components ? hive.subkeys(components) : [])
            {
                const path = `${USER_DATA}\\Components\\${name}`;
                const key = open(path);
                if (key && hive.getValue(key, keys.squashed))
                {
                    hive.deleteValue(key, keys.squashed);
                    if (hive.values(key).length === 0 && hive.subkeys(key).length === 0)
                    {
                        hive.remove(machine, path);
                    }
                }
            }
            const upgrades = open(`${CLASSES}\\UpgradeCodes`);
            for (const name of upgrades ? hive.subkeys(upgrades) : [])
            {
                const path = `${CLASSES}\\UpgradeCodes\\${name}`;
                const key = open(path);
                if (key && hive.getValue(key, keys.squashed))
                {
                    hive.deleteValue(key, keys.squashed);
                    if (hive.values(key).length === 0)
                    {
                        hive.remove(machine, path);
                    }
                }
            }
        },

        /**
         * Records a patch applied to a product: the transforms it applied, its
         * kept copy, and its place in the product's list of patches.
         *
         * @param {string} productCode @param {string} patchCode
         * @param {string} localPackage @param {string} transforms
         */
        registerPatch: (productCode, patchCode, localPackage, transforms)=>{
            const keys = productKeys(productCode);
            const patch = squashGuid(patchCode);
            if (!keys || !patch)
            {
                return;
            }
            const list = create(`${keys.advertised}\\Patches`);
            hive.setValue(list, patch, REG_SZ, sz(transforms));
            const names = multiText(hive.getValue(list, 'Patches'))
                .filter(Boolean);
            const all = [...new Set([...names, patch])];
            hive.setValue(list, 'Patches', REG_MULTI_SZ, encodeAnsi(`${all.join('\0')}\0\0`));
            hive.setValue(create(`${USER_DATA}\\Patches\\${patch}`), 'LocalPackage', REG_SZ,
                sz(localPackage));
            const state = create(
                `${USER_DATA}\\Products\\${keys.squashed}\\Patches\\${patch}`);
            hive.setValue(state, 'State', REG_DWORD, dword(1));
        },

        /** @param {string} productCode @param {string} patchCode */
        unregisterPatch: (productCode, patchCode)=>{
            const keys = productKeys(productCode);
            const patch = squashGuid(patchCode);
            if (!keys || !patch)
            {
                return;
            }
            const list = open(`${keys.advertised}\\Patches`);
            if (list)
            {
                hive.deleteValue(list, patch);
                const names = multiText(hive.getValue(list, 'Patches'))
                    .filter(name=>name !== '' && name !== patch);
                hive.setValue(list, 'Patches', REG_MULTI_SZ,
                    encodeAnsi(`${names.join('\0')}\0\0`));
            }
            removeKeyTree(hive, machine,
                `${USER_DATA}\\Products\\${keys.squashed}\\Patches\\${patch}`);
            removeKeyTree(hive, machine, `${USER_DATA}\\Patches\\${patch}`);
        },

        /**
         * The patches applied to a product, each with its kept copy.
         *
         * @param {string} productCode
         * @returns {{ code: string, localPackage: string, transforms: string }[]}
         */
        patches: productCode=>{
            const keys = productKeys(productCode);
            const list = keys ? open(`${keys.advertised}\\Patches`) : null;
            if (!list)
            {
                return [];
            }
            return multiText(hive.getValue(list, 'Patches')).filter(Boolean)
                .map(name=>({
                    code: unsquashGuid(name),
                    localPackage: valueText(hive.getValue(
                        open(`${USER_DATA}\\Patches\\${name}`) ?? list, 'LocalPackage')) ?? '',
                    transforms: valueText(hive.getValue(list, name)) ?? '',
                }));
        },

        advertiseProduct: advertise,

        /** @returns {any} the machine's root, for callers that keep keys of their own */
        machine: ()=>machine,

        /** @param {string} upgradeCode @returns {string[]} the products filed under it */
        relatedProducts: upgradeCode=>{
            const upgrade = squashGuid(upgradeCode);
            const key = upgrade ? open(`${CLASSES}\\UpgradeCodes\\${upgrade}`) : null;
            return key ? hive.values(key).map(value=>unsquashGuid(value.name)) : [];
        },
    };
}
