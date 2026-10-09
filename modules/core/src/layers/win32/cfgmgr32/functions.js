/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cfgmgr32 — the Configuration Manager's user-mode client: the device tree and
 * the hardware resources (ports, interrupts, memory ranges) each device was
 * given.
 *
 * A program that reports on the machine walks a device's logical
 * configurations and their resource descriptors. This machine's devices are
 * the browser's, with no bus resources to show, so the tree holds its root
 * alone and the root has no configuration: every walk ends at its first step,
 * with the code that says "no more" rather than an error. A program linked
 * against the library at load time only needs it present and answering so.
 */

/** CONFIGRET codes, cfgmgr32.h. */
export const CR = Object.freeze({
    SUCCESS: 0x00,
    INVALID_POINTER: 0x03,
    INVALID_FLAG: 0x04,
    INVALID_DEVNODE: 0x05,
    INVALID_RES_DES: 0x06,
    INVALID_LOG_CONF: 0x07,
    NO_SUCH_DEVNODE: 0x0d,
    NO_MORE_LOG_CONF: 0x0e,
    NO_MORE_RES_DES: 0x0f,
});

/** The device instance handle of the tree's root, the only node there is. */
export const ROOT_DEVNODE = 1;
/** The root's instance ID, which locating it by name spells. */
const ROOT_ID = 'HTREE\\ROOT\\0';

/** CM_LOCATE_DEVNODE_BITS: NORMAL, PHANTOM, CANCELREMOVE, NOVALIDATION. */
const LOCATE_FLAGS = 0x7;
/** BASIC_LOG_CONF … BOOT_LOG_CONF, and LOG_CONF_BITS of CM_Get_First_Log_Conf. */
const LOG_CONF_FLAGS = 0x7;

const MAX_DEVICE_ID_LEN = 200;

/**
 * @typedef {Object} CfgmgrHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} [readCString]
 */

/**
 * @param {CfgmgrHost} host
 */
export function createCfgmgrFunctions(host){
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    return {
        /**
         * CONFIGRET CM_Locate_DevNodeA(PDEVINST pdnDevInst, DEVINSTID_A pDeviceID,
         *                              ULONG ulFlags)
         *
         * A null or empty ID names the root. The handle is cleared before the
         * search, so a miss leaves 0 behind.
         */
        CM_Locate_DevNodeA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, id, flags])=>{
                if ((out >>> 0) === 0)
                {
                    return CR.INVALID_POINTER;
                }
                writeDword(out, 0);
                if (((flags >>> 0) & ~LOCATE_FLAGS) !== 0)
                {
                    return CR.INVALID_FLAG;
                }
                const name = (id >>> 0) === 0 || !host.readCString
                    ? '' : host.readCString(id >>> 0, MAX_DEVICE_ID_LEN);
                if (name !== '' && name.toUpperCase() !== ROOT_ID)
                {
                    return CR.NO_SUCH_DEVNODE;
                }
                writeDword(out, ROOT_DEVNODE);
                return CR.SUCCESS;
            },
        },

        /**
         * CONFIGRET CM_Get_First_Log_Conf(PLOG_CONF plcLogConf, DEVINST dnDevInst,
         *                                 ULONG ulFlags)
         *
         * The out pointer may be null, to ask only whether one exists.
         */
        CM_Get_First_Log_Conf: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, devnode, flags])=>{
                if ((out >>> 0) !== 0)
                {
                    writeDword(out, 0);
                }
                if (((flags >>> 0) & ~LOG_CONF_FLAGS) !== 0)
                {
                    return CR.INVALID_FLAG;
                }
                return (devnode >>> 0) === ROOT_DEVNODE ? CR.NO_MORE_LOG_CONF : CR.INVALID_DEVNODE;
            },
        },

        /**
         * CONFIGRET CM_Get_Next_Res_Des(PRES_DES prdResDes, RES_DES rdResDes,
         *     RESOURCEID ForResource, PRESOURCEID pResourceID, ULONG ulFlags)
         *
         * No configuration is ever handed out, so whatever it is asked to
         * start from is not one of ours.
         */
        CM_Get_Next_Res_Des: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return CR.INVALID_POINTER;
                }
                writeDword(out, 0);
                return CR.INVALID_LOG_CONF;
            },
        },

        /** CONFIGRET CM_Get_Res_Des_Data_Size(PULONG pulSize, RES_DES rdResDes, ULONG ulFlags) */
        CM_Get_Res_Des_Data_Size: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return CR.INVALID_POINTER;
                }
                writeDword(out, 0);
                return CR.INVALID_RES_DES;
            },
        },

        /**
         * CONFIGRET CM_Get_Res_Des_Data(RES_DES rdResDes, PVOID Buffer,
         *                               ULONG BufferLen, ULONG ulFlags)
         */
        CM_Get_Res_Des_Data: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, buffer])=>((buffer >>> 0) === 0 ? CR.INVALID_POINTER : CR.INVALID_RES_DES),
        },

        /** CONFIGRET CM_Free_Log_Conf_Handle(LOG_CONF lcLogConf) */
        CM_Free_Log_Conf_Handle: {
            argBytes: 4,
            handler: ()=>CR.INVALID_LOG_CONF,
        },
    };
}
