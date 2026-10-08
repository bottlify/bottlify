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
    HKEY_LOCAL_MACHINE, REG_DWORD, REG_EXPAND_SZ, REG_SZ,
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
         *     date: string, extras: Record<string, string> }} product
         */
        registerProduct: product=>{
            const keys = productKeys(product.productCode);
            if (!keys)
            {
                return;
            }
            const [major = 0, minor = 0, build = 0] = product.version.split('.')
                .map(part=>Number(part) || 0);
            const version = ((major & 0xff) << 24 | (minor & 0xff) << 16 | (build & 0xffff)) >>> 0;
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
            const advertised = create(keys.advertised);
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

        /** @param {string} productCode @param {string} feature @param {string} components */
        registerFeature: (productCode, feature, components)=>{
            const keys = productKeys(productCode);
            if (keys)
            {
                hive.setValue(create(keys.features), feature, REG_SZ, sz(components));
                hive.setValue(create(`${CLASSES}\\Features\\${keys.squashed}`), feature, REG_SZ,
                    sz(''));
            }
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

        /** @param {string} upgradeCode @returns {string[]} the products filed under it */
        relatedProducts: upgradeCode=>{
            const upgrade = squashGuid(upgradeCode);
            const key = upgrade ? open(`${CLASSES}\\UpgradeCodes\\${upgrade}`) : null;
            return key ? hive.values(key).map(value=>unsquashGuid(value.name)) : [];
        },
    };
}
