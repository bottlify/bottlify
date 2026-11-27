/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */


/**
 * hkeys - the registry's predefined roots, by the constants a guest names them by.
 * Apart from registry.js, which re-exports them, so that the views registry.js
 * reaches through (wow64-registry.js) can name them without importing it back.
 */

/** The predefined roots. A guest names these by constant; it never opens them. */
export const HKEY_CLASSES_ROOT = 0x80000000;
export const HKEY_CURRENT_USER = 0x80000001;
export const HKEY_LOCAL_MACHINE = 0x80000002;
export const HKEY_USERS = 0x80000003;
