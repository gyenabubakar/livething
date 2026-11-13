// The core max-params rule skips type signatures, so an interface method or a function type
// could still take 4 parameters. This one checks every place a parameter list appears.
const SIGNATURES = [
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
  'TSMethodSignature',
  'TSFunctionType',
  'TSConstructorType',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
];

function isThisParameter(param) {
  return param.type === 'Identifier' && param.name === 'this';
}

export const maxParams = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Allow at most `max` parameters on any function or function type.' },
    schema: [
      {
        type: 'object',
        properties: { max: { type: 'integer', minimum: 0 } },
        additionalProperties: false,
      },
    ],
    messages: {
      tooMany:
        'This takes {{count}} parameters; the limit is {{max}}. Group the extra ones in an options object.',
    },
  },
  create(context) {
    const max = context.options[0]?.max ?? 3;

    function check(node) {
      const count = (node.params ?? node.parameters ?? []).filter(
        (param) => !isThisParameter(param),
      ).length;
      if (count <= max) return;

      context.report({
        node,
        messageId: 'tooMany',
        data: { count: String(count), max: String(max) },
      });
    }

    return Object.fromEntries(SIGNATURES.map((type) => [type, check]));
  },
};
