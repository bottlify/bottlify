/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The device installer's devices: device instances and their interfaces,
 * kept where Windows keeps them, and the device information sets a program
 * works on them through.
 *
 * A device instance is a key under CurrentControlSet\Enum, named by its
 * instance id -- enumerator, device and instance, `ROOT\LEGACY_BOGUS\0000`
 * -- holding its class and its properties. One a set has created is a
 * phantom (`Phantom` = 1) until it is registered, and goes with the set
 * that made it if it never is. An interface is a key under
 * Control\DeviceClasses, by its class and its device, and a symbolic link
 * a program opens it by: `\\?\root#legacy_bogus#0000#{guid}\reference`,
 * in lower case.
 *
 * A device information set is a list of devices taken from there, or made
 * in it: removing a device removes it from the registry and leaves it in
 * the set, marked; deleting it from a set leaves the registry alone.
 *
 * The machine's own hardware -- the display adapter and its monitor -- is
 * there from the start, present, as the system enumerates it at boot.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

const HKEY_LOCAL_MACHINE = 0x80000002;
const REG_SZ = 1;
const REG_DWORD = 4;

export const ENUM_KEY = 'SYSTEM\\CurrentControlSet\\Enum';
export const CLASS_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Class';
export const DEVICE_CLASSES_KEY = 'SYSTEM\\CurrentControlSet\\Control\\DeviceClasses';

/** The longest instance id, its terminator included. */
export const MAX_DEVICE_ID_LEN = 200;

/** The device tree's root: its device node and its instance id. */
export const ROOT_DEVNODE = 1;
export const ROOT_ID = 'HTREE\\ROOT\\0';

export const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';

/** SP_DEVICE_INTERFACE_DATA's flags. */
export const SPINT = Object.freeze({ ACTIVE: 1, DEFAULT: 2, REMOVED: 4 });

/**
 * The setup classes every Windows installation has, by GUID: installed
 * whether or not a device of theirs is present, as Windows installs them.
 */
const STANDARD_CLASSES = Object.freeze([
    ['{4d36e965-e325-11ce-bfc1-08002be10318}', 'CDROM'],
    ['{4d36e967-e325-11ce-bfc1-08002be10318}', 'DiskDrive'],
    ['{4d36e968-e325-11ce-bfc1-08002be10318}', 'Display'],
    ['{4d36e96b-e325-11ce-bfc1-08002be10318}', 'Keyboard'],
    ['{4d36e96c-e325-11ce-bfc1-08002be10318}', 'MEDIA'],
    ['{4d36e96e-e325-11ce-bfc1-08002be10318}', 'Monitor'],
    ['{4d36e96f-e325-11ce-bfc1-08002be10318}', 'Mouse'],
    ['{4d36e972-e325-11ce-bfc1-08002be10318}', 'Net'],
    ['{4d36e978-e325-11ce-bfc1-08002be10318}', 'Ports'],
    ['{4d36e979-e325-11ce-bfc1-08002be10318}', 'Printer'],
    ['{4d36e97d-e325-11ce-bfc1-08002be10318}', 'System'],
    ['{36fc9e60-c465-11cf-8056-444553540000}', 'USB'],
    ['{745a17a0-74d3-11d0-b6fe-00a0c90f57da}', 'HIDClass'],
]);

/** The hardware every machine here has, present from the start. */
const MACHINE_DEVICES = Object.freeze([
    {
        id: 'PCI\\VEN_0000&DEV_0000&SUBSYS_00000000&REV_00\\0000',
        classGuid: '{4d36e968-e325-11ce-bfc1-08002be10318}',
        className: 'Display',
        description: 'WebGPU Display Adapter',
        interfaces: ['{5b45201d-f2f2-4f3b-85bb-30ff1f953599}',
            '{1ca05180-a699-450a-9a0c-de4fbe3ddd89}'],
    },
    {
        id: 'DISPLAY\\DEFAULT_MONITOR\\0000',
        classGuid: '{4d36e96e-e325-11ce-bfc1-08002be10318}',
        className: 'Monitor',
        description: 'Default Monitor',
        interfaces: ['{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}'],
    },
]);

/**
 * @typedef {Object} DeviceInterface
 * @property {string} classGuid  Lower case, braced.
 * @property {string} reference  The reference string, '' for none.
 * @property {number} flags      SPINT bits.
 *
 * @typedef {Object} Device
 * @property {string} id          The instance id as made or found.
 * @property {string} classGuid   Lower case, braced.
 * @property {number} devnode     The device node, the same for the same instance.
 * @property {boolean} removed    SetupDiRemoveDevice took it out of the registry.
 * @property {number} key         What SP_DEVINFO_DATA's Reserved names it by.
 * @property {DeviceInterface[]} interfaces  The set's own view of them.
 *
 * @typedef {Object} DeviceSet
 * @property {string | null} classGuid  The set's class; null for any.
 * @property {Device[]} devices
 * @property {Set<string>} made  The instances this set created and has not registered.
 * @property {Map<number, { device: Device, face: DeviceInterface }>} faces
 *           The interfaces its interface data has named, by that data's Reserved.
 */

/** @param {string} text */
const sz = text=>encodeAnsi(`${text}\0`);

/** @param {Uint8Array | undefined} data */
const textOf = data=>(data ? decodeAnsi(data).replace(/\0[\s\S]*$/, '') : '');

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * An instance id's case as Windows keeps it: the enumerator and the
 * device upper case, the instance as given.
 *
 * @param {string} id
 */
const canonical = id=>{
    const parts = id.split('\\');
    return [...parts.slice(0, 2).map(part=>part.toUpperCase()), ...parts.slice(2)].join('\\');
};

/**
 * An interface's symbolic link: `\\?\`, the instance id with `#` for `\`,
 * the class, and the reference after a `\` -- all in lower case.
 *
 * @param {string} id @param {string} classGuid @param {string} reference
 */
export const interfacePath = (id, classGuid, reference)=>
    `\\\\?\\${id.replace(/\\/g, '#')}#${classGuid}${reference === '' ? '' : `\\${reference}`}`
        .toLowerCase();

/** The key an interface is kept under in its class's. @param {string} id @param {string} guid */
const linkName = (id, guid)=>`##?#${id.replace(/\\/g, '#')}#${guid}`;

/**
 * @param {any} hive  The registry the devices are kept in.
 */
export function createDeviceStore(hive){
    const machine = ()=>hive.root(HKEY_LOCAL_MACHINE);

    /** @param {string} path */
    const open = path=>hive.open(machine(), path);

    /** @param {string} id */
    const instanceKey = id=>open(`${ENUM_KEY}\\${id}`);

    /**
     * Each instance's device node, made the first time it is asked for, in
     * the order the instances came to be: the device tree's order. The
     * root's is 1, as cfgmgr32 numbers it.
     */
    const devnodes = new Map();
    /** The instance id each device node was made for. @type {Map<number, string>} */
    const ids = new Map([[ROOT_DEVNODE, ROOT_ID]]);
    let nextDevnode = 2;
    let nextKey = 1;

    /** @param {string} id */
    const devnodeOf = id=>{
        const name = id.toUpperCase();
        if (!devnodes.has(name))
        {
            devnodes.set(name, nextDevnode);
            ids.set(nextDevnode++, id);
        }
        return /** @type {number} */ (devnodes.get(name));
    };

    /**
     * Removes a key and everything under it, deepest first, as the hive
     * removes only a key with no subkeys.
     *
     * @param {any} parent @param {string} name
     */
    const removeTree = (parent, name)=>{
        const key = hive.open(parent, name);
        if (!key)
        {
            return;
        }
        for (const child of hive.subkeys(key))
        {
            removeTree(key, child);
        }
        hive.remove(parent, name);
    };

    /**
     * Whether an instance's key is there and not a phantom's.
     *
     * @param {string} id
     */
    const registered = id=>{
        const key = instanceKey(id);
        if (!key)
        {
            return false;
        }
        const phantom = hive.getValue(key, 'Phantom')?.data;
        return !(phantom instanceof Uint8Array && phantom.length >= 4
            && new DataView(phantom.buffer, phantom.byteOffset).getUint32(0, true) !== 0);
    };

    /** The class an instance's key names, GUID_NULL for none. @param {string} id */
    const classOf = id=>{
        const key = instanceKey(id);
        const text = key ? textOf(hive.getValue(key, 'ClassGUID')?.data).toLowerCase() : '';
        return /^\{[0-9a-f-]{36}\}$/.test(text) ? text : GUID_NULL;
    };

    /**
     * The interfaces the registry keeps for an instance, in the order they
     * were made.
     *
     * @param {string} id
     * @returns {{ classGuid: string, reference: string }[]}
     */
    const storedInterfaces = id=>{
        const classes = open(DEVICE_CLASSES_KEY);
        if (!classes)
        {
            return [];
        }
        /** @type {{ classGuid: string, reference: string }[]} */
        const found = [];
        for (const guid of hive.subkeys(classes))
        {
            const link = hive.open(classes, `${guid}\\${linkName(id, guid)}`);
            for (const reference of link ? hive.subkeys(link) : [])
            {
                found.push({ classGuid: guid.toLowerCase(), reference: reference.slice(1) });
            }
        }
        return found;
    };

    /**
     * Every instance under Enum, three levels down, in the device tree's
     * order: the order they were made in, as Windows enumerates them -- an
     * instance this run has not met yet after them, sorted, case aside.
     *
     * @returns {string[]}
     */
    const allInstances = ()=>{
        const root = open(ENUM_KEY);
        if (!root)
        {
            return [];
        }
        /** @param {string[]} names */
        const sorted = names=>[...names].sort((a, b)=>(a.toUpperCase() < b.toUpperCase() ? -1
            : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
        /** @type {string[]} */
        const found = [];
        for (const enumerator of sorted(hive.subkeys(root)))
        {
            const enumKey = hive.open(root, enumerator);
            for (const device of sorted(hive.subkeys(enumKey)))
            {
                const deviceKey = hive.open(enumKey, device);
                for (const instance of sorted(hive.subkeys(deviceKey)))
                {
                    found.push(`${enumerator}\\${device}\\${instance}`);
                }
            }
        }
        found.forEach(devnodeOf);
        return found.sort((a, b)=>devnodeOf(a) - devnodeOf(b));
    };

    const store = {
        devnodeOf,
        registered,
        classOf,
        storedInterfaces,
        allInstances,

        /**
         * The instance id a device node was made for, null for one never
         * made; the root's is HTREE\\ROOT\\0.
         *
         * @param {number} devnode
         */
        idOf: (/** @type {number} */ devnode)=>ids.get(devnode) ?? null,

        /** Whether an instance's key is there, phantom or not. @param {string} id */
        exists: (/** @type {string} */ id)=>instanceKey(id) !== null,

        /**
         * The instance id a name stands for, or why it stands for none:
         * three parts, shorter than MAX_DEVICE_ID_LEN,
         * none empty. To generate one, the name is the device's alone and
         * the instance the first ROOT\NAME\NNNN neither the registry nor
         * `taken` has.
         *
         * @param {string} name @param {boolean} generate @param {Set<string>} taken
         * @returns {string | null}
         */
        instanceId(name, generate, taken){
            if (generate)
            {
                if (name === '' || name.includes('\\'))
                {
                    return null;
                }
                for (let n = 0; n < 10000; n++)
                {
                    const id = canonical(`ROOT\\${name}\\${String(n).padStart(4, '0')}`);
                    if (!store.exists(id) && !taken.has(id.toUpperCase()))
                    {
                        return id;
                    }
                }
                return null;
            }
            const parts = name.split('\\');
            if (name.length >= MAX_DEVICE_ID_LEN || parts.length !== 3
                || parts.some(part=>part === ''))
            {
                return null;
            }
            return canonical(name);
        },

        /**
         * A new phantom instance's key, with its class -- and the class's
         * name when the class is installed, its description when given.
         *
         * @param {string} id @param {string} classGuid @param {string | null} [description]
         */
        createPhantom(id, classGuid, description = null){
            const { key } = hive.create(machine(), `${ENUM_KEY}\\${id}`);
            hive.setValue(key, 'ClassGUID', REG_SZ, sz(classGuid));
            hive.setValue(key, 'Phantom', REG_DWORD, dword(1));
            const installed = open(`${CLASS_KEY}\\${classGuid}`);
            const name = installed ? hive.getValue(installed, 'Class') : null;
            if (name)
            {
                hive.setValue(key, 'Class', REG_SZ, name.data);
            }
            if (description)
            {
                hive.setValue(key, 'DeviceDesc', REG_SZ, sz(description));
            }
        },

        /** An instance's key, null for none. @param {string} id */
        instanceKey,

        /**
         * Where an instance's driver key is, under the class key: its
         * Driver value, null when it has none.
         *
         * @param {string} id
         */
        driverPath(id){
            const key = instanceKey(id);
            const driver = key ? textOf(hive.getValue(key, 'Driver')?.data) : '';
            return driver === '' ? null : `${CLASS_KEY}\\${driver}`;
        },

        /**
         * An instance's driver key, made when it has none: the first
         * four-digit subkey free under its class's key, which the Driver
         * value names.
         *
         * @param {string} id
         */
        makeDriver(id){
            const there = store.driverPath(id);
            if (there && open(there))
            {
                return there;
            }
            const guid = classOf(id);
            const { key: classKey } = hive.create(machine(), `${CLASS_KEY}\\${guid}`);
            let number = 0;
            const name = ()=>String(number).padStart(4, '0');
            while (hive.open(classKey, name()))
            {
                number++;
            }
            hive.create(classKey, name());
            hive.setValue(instanceKey(id), 'Driver', REG_SZ, sz(`${guid}\\${name()}`));
            return `${CLASS_KEY}\\${guid}\\${name()}`;
        },

        /** An instance's driver key gone, and the value naming it. @param {string} id */
        removeDriver(id){
            const path = store.driverPath(id);
            if (!path)
            {
                return false;
            }
            const at = path.lastIndexOf('\\');
            const parent = open(path.slice(0, at));
            const had = parent !== null && hive.open(parent, path.slice(at + 1)) !== null;
            if (had)
            {
                removeTree(parent, path.slice(at + 1));
            }
            const key = instanceKey(id);
            if (key)
            {
                hive.deleteValue(key, 'Driver');
            }
            return had;
        },

        /** An instance made real: no longer a phantom. @param {string} id */
        register(id){
            const key = instanceKey(id);
            if (key)
            {
                hive.deleteValue(key, 'Phantom');
            }
        },

        /**
         * An instance gone from the registry, its interfaces with it, and
         * its device's key when it was the last instance of it.
         *
         * @param {string} id
         */
        removeInstance(id){
            store.removeDriver(id);
            for (const { classGuid } of storedInterfaces(id))
            {
                const classKey = open(`${DEVICE_CLASSES_KEY}\\${classGuid}`);
                if (classKey)
                {
                    removeTree(classKey, linkName(id, classGuid));
                }
            }
            const parts = id.split('\\');
            const deviceKey = open(`${ENUM_KEY}\\${parts[0]}\\${parts[1]}`);
            if (!deviceKey)
            {
                return;
            }
            removeTree(deviceKey, parts[2]);
            if (hive.subkeys(deviceKey).length === 0)
            {
                hive.remove(/** @type {any} */ (open(`${ENUM_KEY}\\${parts[0]}`)), parts[1]);
            }
        },

        /**
         * Where an interface's own key is: its reference's, under the
         * device's link in its class's key.
         *
         * @param {string} id @param {string} classGuid @param {string} reference
         */
        interfaceKeyPath: (/** @type {string} */ id, /** @type {string} */ classGuid,
            /** @type {string} */ reference)=>
            `${DEVICE_CLASSES_KEY}\\${classGuid}\\${linkName(id, classGuid)}\\#${reference}`,

        /**
         * An interface kept for an instance: its class's key, the device's
         * link under it, and the reference's under that.
         *
         * @param {string} id @param {string} classGuid @param {string} reference
         */
        addInterface(id, classGuid, reference){
            const { key: link } = hive.create(machine(),
                `${DEVICE_CLASSES_KEY}\\${classGuid}\\${linkName(id, classGuid)}`);
            hive.setValue(link, 'DeviceInstance', REG_SZ, sz(id));
            const { key: refKey } = hive.create(link, `#${reference}`);
            hive.setValue(refKey, 'SymbolicLink', REG_SZ,
                sz(interfacePath(id, classGuid, reference)));
        },

        /**
         * An interface's keys gone: the reference's, and the device's link
         * once no reference is left under it.
         *
         * @param {string} id @param {string} classGuid @param {string} reference
         */
        removeInterface(id, classGuid, reference){
            const classKey = open(`${DEVICE_CLASSES_KEY}\\${classGuid}`);
            const link = classKey ? hive.open(classKey, linkName(id, classGuid)) : null;
            if (!link)
            {
                return;
            }
            removeTree(link, `#${reference}`);
            if (hive.subkeys(link).length === 0)
            {
                hive.remove(classKey, linkName(id, classGuid));
            }
        },

        /**
         * A device entry for a set: its node, its class and the interfaces
         * the registry keeps for it.
         *
         * @param {string} id @param {string} classGuid
         * @returns {Device}
         */
        entry(id, classGuid){
            return {
                id, classGuid, devnode: devnodeOf(id), removed: false, key: nextKey++,
                interfaces: storedInterfaces(id).map(face=>({ ...face, flags: 0 })),
            };
        },

        /** The machine's own hardware, there unless the registry already has it. */
        seedMachine(){
            for (const [guid, name] of STANDARD_CLASSES)
            {
                const { key: installed } = hive.create(machine(), `${CLASS_KEY}\\${guid}`);
                if (!hive.getValue(installed, 'Class'))
                {
                    hive.setValue(installed, 'Class', REG_SZ, sz(name));
                }
            }
            for (const device of MACHINE_DEVICES)
            {
                if (store.exists(device.id))
                {
                    continue;
                }
                const { key } = hive.create(machine(), `${ENUM_KEY}\\${device.id}`);
                hive.setValue(key, 'ClassGUID', REG_SZ, sz(device.classGuid));
                hive.setValue(key, 'Class', REG_SZ, sz(device.className));
                hive.setValue(key, 'DeviceDesc', REG_SZ, sz(device.description));
                for (const guid of device.interfaces)
                {
                    store.addInterface(device.id, guid, '');
                }
            }
        },
    };
    return store;
}
