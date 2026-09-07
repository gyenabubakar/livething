import {
  maxConsecutiveStatements,
  paddingAfterBlock,
  paddingAfterGuardClause,
  paddingAfterObjectLiteralDeclaration,
  paddingBeforeFinalReturn,
  switchCasePadding,
} from './readable-spacing.mjs';

export default {
  meta: { name: 'wskit' },
  rules: {
    'max-consecutive-statements': maxConsecutiveStatements,
    'padding-after-block': paddingAfterBlock,
    'padding-after-guard-clause': paddingAfterGuardClause,
    'padding-after-object-literal-declaration': paddingAfterObjectLiteralDeclaration,
    'padding-before-final-return': paddingBeforeFinalReturn,
    'switch-case-padding': switchCasePadding,
  },
};
