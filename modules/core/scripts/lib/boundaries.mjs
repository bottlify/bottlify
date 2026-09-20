/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Packages that implement the cpu layer's executor contract.
 *
 * The core loads one of them by a module URL in its configuration when a
 * launch selects it, and must run with every one of them absent -- a launch
 * that selects the vendored emulator needs no translator installed. So no
 * file under the core's `src/` may import one: the dependency would make the
 * optional engine a required one, and the boundary checker refuses it.
 */
export const ENGINE_PACKAGES = Object.freeze(['@bottlify/cork']);

/**
 * The boundary issue an import specifier raises, or null.
 *
 * @param {string} spec  the specifier as written in the import
 * @returns {string | null}
 */
export function enginePackageIssue(spec){
    const hit = ENGINE_PACKAGES.find(name=>spec === name || spec.startsWith(`${name}/`));
    return hit === undefined
        ? null
        : `imports ${hit}: core must not depend on an engine package`;
}
