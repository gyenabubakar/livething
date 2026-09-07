function hasBlankLineBetween(earlier, later) {
  return later.loc.start.line - earlier.loc.end.line > 1;
}

function hasEmptyLineBetween(context, earlier, later) {
  return /\r?\n[^\S\r\n]*\r?\n/.test(gapBetween(context, earlier, later).text);
}

function gapBetween(context, earlier, later) {
  const lastToken = context.sourceCode.getLastToken(earlier);
  const firstToken = context.sourceCode.getFirstToken(later);
  const text = context.sourceCode.text.slice(lastToken.range[1], firstToken.range[0]);
  return { lastToken, text };
}

function isExit(statement) {
  if (
    statement.type === 'ReturnStatement' ||
    statement.type === 'ThrowStatement' ||
    statement.type === 'BreakStatement' ||
    statement.type === 'ContinueStatement'
  ) {
    return true;
  }

  if (statement.type === 'BlockStatement' || statement.type === 'LabeledStatement') {
    const child = statement.type === 'BlockStatement' ? statement.body.at(-1) : statement.body;
    return child !== undefined && isExit(child);
  }

  return false;
}

function isGuardClause(statement) {
  return (
    statement.type === 'IfStatement' && statement.alternate === null && isExit(statement.consequent)
  );
}

function endsWithBlock(statement, context) {
  return context.sourceCode.getText(statement).trimEnd().endsWith('}');
}

function isMultilineObjectLiteralDeclaration(statement) {
  if (statement.type !== 'VariableDeclaration') return false;

  return statement.declarations.some((declaration) => {
    const value = declaration.init;
    return value?.type === 'ObjectExpression' && value.loc.start.line !== value.loc.end.line;
  });
}

function reportMissingGap(context, details) {
  if (hasEmptyLineBetween(context, details.earlier, details.later)) return;

  const gap = gapBetween(context, details.earlier, details.later);

  context.report({
    node: details.later,
    messageId: details.messageId,
    fix(fixer) {
      const newlines = gap.text.includes('\n') ? '\n' : '\n\n';
      return fixer.insertTextAfterRange([gap.lastToken.range[1], gap.lastToken.range[1]], newlines);
    },
  });
}

function forEachAdjacentStatement(body, callback) {
  for (let index = 1; index < body.length; index++) {
    callback(body[index - 1], body[index]);
  }
}

function statementList(node) {
  return node.type === 'SwitchCase' ? node.consequent : node.body;
}

export const maxConsecutiveStatements = {
  meta: {
    type: 'suggestion',
    fixable: 'whitespace',
    docs: { description: 'Break dense blocks into groups separated by blank lines.' },
    schema: [
      {
        type: 'object',
        properties: { max: { type: 'integer', minimum: 1 } },
        additionalProperties: false,
      },
    ],
    messages: {
      congested:
        'More than {{max}} consecutive statements without a blank line — separate them into smaller groups.',
    },
  },
  create(context) {
    const max = context.options[0]?.max ?? 4;

    function check(statements) {
      let runStart = 0;

      for (let index = 1; index <= statements.length; index++) {
        const runEnded =
          index === statements.length ||
          hasBlankLineBetween(statements[index - 1], statements[index]);
        if (!runEnded) continue;

        if (index - runStart > max) {
          const overflow = statements[runStart + max];
          context.report({
            node: overflow,
            messageId: 'congested',
            data: { max },
            fix(fixer) {
              return fixer.insertTextBefore(overflow, '\n');
            },
          });
        }

        runStart = index;
      }
    }

    return {
      BlockStatement(node) {
        check(node.body);
      },
      SwitchCase(node) {
        check(node.consequent);
      },
    };
  },
};

export const paddingBeforeFinalReturn = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    docs: { description: "Blank line above a long function's final return statement." },
    schema: [
      {
        type: 'object',
        properties: { minStatements: { type: 'integer', minimum: 2 } },
        additionalProperties: false,
      },
    ],
    messages: {
      needsBlank: "Separate a long function's final return with a blank line above it.",
    },
  },
  create(context) {
    const minStatements = context.options[0]?.minStatements ?? 5;

    return {
      ReturnStatement(node) {
        const block = node.parent;
        if (!block || block.type !== 'BlockStatement') return;

        if (!block.parent || !/Function/.test(block.parent.type)) return;

        const body = block.body;
        if (body[body.length - 1] !== node || body.length < minStatements) return;

        const previous = body[body.length - 2];
        if (!previous || hasBlankLineBetween(previous, node)) return;

        context.report({
          node,
          messageId: 'needsBlank',
          fix(fixer) {
            return fixer.insertTextBefore(node, '\n');
          },
        });
      },
    };
  },
};

export const paddingAfterGuardClause = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    docs: { description: 'Separate an early-exit guard clause from the normal path.' },
    schema: [],
    messages: {
      needsBlank: 'Put a blank line after an early-exit guard clause.',
    },
  },
  create(context) {
    function check(node) {
      forEachAdjacentStatement(statementList(node), (previous, current) => {
        if (isGuardClause(previous)) {
          reportMissingGap(context, {
            earlier: previous,
            later: current,
            messageId: 'needsBlank',
          });
        }
      });
    }

    return {
      BlockStatement: check,
      SwitchCase: check,
    };
  },
};

export const paddingAfterBlock = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    docs: { description: 'Separate a completed block statement from what follows.' },
    schema: [],
    messages: {
      needsBlank: 'Put a blank line after a block statement.',
    },
  },
  create(context) {
    function check(node) {
      forEachAdjacentStatement(statementList(node), (previous, current) => {
        if (endsWithBlock(previous, context)) {
          reportMissingGap(context, {
            earlier: previous,
            later: current,
            messageId: 'needsBlank',
          });
        }
      });
    }

    return {
      Program: check,
      BlockStatement: check,
      SwitchCase: check,
    };
  },
};

export const paddingAfterObjectLiteralDeclaration = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    docs: {
      description: 'Separate a multi-line object-literal declaration from what follows.',
    },
    schema: [],
    messages: {
      needsBlank: 'Put a blank line after a multi-line object-literal declaration.',
    },
  },
  create(context) {
    function check(node) {
      forEachAdjacentStatement(statementList(node), (previous, current) => {
        if (isMultilineObjectLiteralDeclaration(previous)) {
          reportMissingGap(context, {
            earlier: previous,
            later: current,
            messageId: 'needsBlank',
          });
        }
      });
    }

    return {
      Program: check,
      BlockStatement: check,
      SwitchCase: check,
    };
  },
};

export const switchCasePadding = {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    docs: { description: 'Separate body-bearing switch cases with a blank line.' },
    schema: [
      {
        type: 'object',
        properties: { minCases: { type: 'integer', minimum: 2 } },
        additionalProperties: false,
      },
    ],
    messages: {
      needsBlank: 'Put a blank line between switch cases so each case block reads on its own.',
    },
  },
  create(context) {
    const minCases = context.options[0]?.minCases ?? 3;

    return {
      SwitchStatement(node) {
        if (node.cases.length < minCases) return;

        for (let index = 1; index < node.cases.length; index++) {
          const previous = node.cases[index - 1];
          const current = node.cases[index];
          if (!previous.consequent.length || hasBlankLineBetween(previous, current)) continue;

          context.report({
            node: current,
            messageId: 'needsBlank',
            fix(fixer) {
              return fixer.insertTextBefore(current, '\n');
            },
          });
        }
      },
    };
  },
};
