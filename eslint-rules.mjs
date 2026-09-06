// Copyright Bottlify Project 2026
// Licenses and contributions: THIRD-PARTY-NOTICES.md

/**
 * House-style rules ESLint has no built-in equivalent for.
 *
 * Adapted from the owner's own lint configuration used across their other
 * projects. Two things from that configuration are deliberately not here:
 * identifier and class naming (this codebase mirrors Win32, whose names are
 * PascalCase and cannot be renamed), and the rule forbidding braces around
 * single-statement bodies — braces always stay, since a body that grows a
 * second line without them is the shape that produced Apple's `goto fail`.
 */

/** Opening brace placement: next line for a multi-line head, same line otherwise. */
const bracketPlacement = context=>{
    const src = context.sourceCode;
    const isBlock = node=>!!node && node.type === 'BlockStatement';
    const sameLine = (a, b)=>a.loc.start.line === b.loc.start.line;

    const checkBlock = (newline, props = ['body'])=>node=>props.forEach(prop=>{
        const block = node[prop];
        if (!isBlock(block)){
            return;
        }
        const prev = src.getTokenBefore(block);
        const open = src.getFirstToken(block);
        const close = src.getLastToken(block);

        if (!newline && !sameLine(prev, open)){
            context.report(node, 'Opening curly brace does not appear on the same line as controlling statement.');
        }
        if (!newline){
            return;
        }
        if (sameLine(prev, open)){
            context.report(node, 'Opening curly brace appears on the same line as controlling statement.');
        }
        if (!block.body.length){
            return;
        }
        if (sameLine(open, block.body[0])){
            context.report(block.body[0], 'Statement inside of curly braces should be on next line.');
        }
        if (sameLine(close, block.body[block.body.length - 1])){
            context.report(block.body[block.body.length - 1],
                'Closing curly brace appears on the same line as the subsequent block.');
        }
    });

    const getClosingParen = body=>{
        let token = src.getFirstToken(body);
        while (token && token.value !== ')'){
            token = src.getTokenBefore(token);
        }
        return token;
    };

    /** True when the head of the statement (its condition or signature) spans lines. */
    const isHeadMultiline = (body, node)=>{
        if (node.type === 'ArrowFunctionExpression' && node.params.length === 1){
            return false;
        }
        const closing = getClosingParen(body);
        return !!closing && closing.loc.end.line - node.loc.start.line > 0;
    };

    /** Braces are required as soon as the body spans more than one line. */
    const requireBracesWhenMultiline = (body, node)=>{
        if (isBlock(body)){
            return;
        }
        if (body.loc.end.line > body.loc.start.line || isHeadMultiline(body, node)){
            context.report(body,
                'Should always have braces in if, while, for statements when '
                + 'condition/then/else/loop part is more than one line.');
        }
    };

    const checkIf = node=>{
        checkBlock(true, ['consequent', 'alternate'])(node);
        requireBracesWhenMultiline(node.consequent, node);
        if (!node.alternate){
            return;
        }
        const tokens = src.getTokensBefore(node.alternate, 2);
        if (sameLine(tokens[0], tokens[1])){
            context.report(node.alternate,
                'Closing curly brace appears on the same line as the subsequent block.');
        }
    };

    const checkLoop = node=>{
        checkBlock(true, ['consequent', 'alternate'])(node);
        requireBracesWhenMultiline(node.body, node);
    };

    const checkFunction = node=>{
        const call = (()=>{
            let parent = node.parent;
            while (parent){
                if (parent.type === 'CallExpression'){
                    return parent;
                }
                parent = parent.parent;
            }
            return null;
        })();
        // A callback passed inline sits on its caller's line; its brace follows
        // the argument list, not the statement that opened the call.
        if (call && call.loc.start.line !== node.loc.start.line){
            if (!node.params.length){
                return;
            }
            if (node.params[node.params.length - 1].loc.end.line === node.loc.start.line){
                return;
            }
        }
        checkBlock(isHeadMultiline(node.body, node))(node);
    };

    return {
        FunctionDeclaration: checkFunction,
        FunctionExpression: checkFunction,
        ArrowFunctionExpression: checkFunction,
        IfStatement: checkIf,
        WhileStatement: checkLoop,
        ForStatement: checkLoop,
        ForInStatement: checkBlock(true),
        ForOfStatement: checkBlock(true),
        DoWhileStatement: checkBlock(),
        CatchClause: checkBlock(),
    };
};

/** The body of an `if` belongs on its own line. */
const onelineIfs = context =>({
    IfStatement: node=>{
        if (node.loc.start.line === node.loc.end.line){
            context.report(node, 'Body of an IF statement has to be on the next line');
        }
    },
});

/** Caught errors are named `e`, or `_e` when nested inside another catch. */
const errorNames = context=>{
    const ancestors = (node, acc = [])=>{
        acc.push(node);
        return node.parent ? ancestors(node.parent, acc) : acc;
    };
    return {
        Identifier: node=>{
            if (node.parent.type !== 'CatchClause' || node.name === 'e'){
                return;
            }
            const nested = ancestors(node.parent.parent).some(a=>a.type === 'CatchClause');
            if (nested){
                if (node.name !== '_e'){
                    context.report(node, 'Nested error variable should be named "_e".');
                }
                return;
            }
            context.report(node, 'Error variable should be named "e".');
        },
    };
};

/** No spaces around `=>`. */
const arrowSpaces = context=>{
    const src = context.sourceCode;
    return {
        ArrowFunctionExpression: node=>{
            const arrow = src.getTokenBefore(node.body);
            const before = src.getTokenBefore(arrow);
            const after = src.getTokenAfter(arrow);
            if (arrow.range[0] - before.range[1] > 0){
                context.report({
                    node: before,
                    message: 'Unexpected space before =>',
                    fix: fixer=>fixer.removeRange([before.range[1], arrow.range[0]]),
                });
            }
            if (arrow.loc.end.line === after.loc.start.line && after.range[0] - arrow.range[1] > 0){
                context.report({
                    node: after,
                    message: 'Unexpected space after =>',
                    fix: fixer=>fixer.removeRange([arrow.range[1], after.range[0]]),
                });
            }
        },
    };
};

/** Non-ASCII is fine in strings and comments, not in code. */
const nonAscii = context =>({
    Program: ()=>{
        const src = context.sourceCode;
        const text = src.getText();
        for (let i = 0; i < text.length; i++){
            if (text.charCodeAt(i) < 127){
                continue;
            }
            const node = src.getNodeByRangeIndex(i) || src.getTokenByRangeStart(i);
            if (!node || node.type === 'Literal' || node.type === 'TemplateElement'){
                continue;
            }
            const comment = src.getAllComments().some(c=>i >= c.range[0] && i < c.range[1]);
            if (comment){
                continue;
            }
            context.report(node,
                `Non-ascii char outside string literal is not allowed, check character ${i}`);
        }
    },
});

/** `a = b`, never `a=b`. */
const spacesAroundAssignment = context=>{
    const src = context.sourceCode;
    return {
        AssignmentExpression: node=>{
            const parent = node.parent;
            // `for (let i=0; i<n; i+=2)` is idiomatic and stays exempt.
            if (parent.type === 'ForStatement' && (parent.init === node || parent.update === node)){
                return;
            }
            if (parent.type === 'SequenceExpression' && parent.parent?.type === 'ForStatement'
                && parent.parent.update === parent){
                return;
            }
            const op = src.getFirstTokenBetween(node.left, node.right);
            if (op.value !== '='){
                return;
            }
            const before = src.getTokenBefore(op);
            const after = src.getTokenAfter(op);
            if (src.isSpaceBetween(before, op) && src.isSpaceBetween(op, after)){
                return;
            }
            context.report({ node, message: `Assignment needs a space around the '${op.value}'` });
        },
    };
};

export const houseStyle = {
    meta: { name: 'bottlify-style', version: '1.0.0' },
    rules: {
        'bracket-placement': { create: bracketPlacement },
        'oneline-ifs': { create: onelineIfs },
        'error-names': { create: errorNames },
        'arrow-spaces': { create: arrowSpaces, meta: { fixable: 'code' } },
        'non-ascii': { create: nonAscii },
        'spaces-around-assignment': { create: spacesAroundAssignment },
    },
};
