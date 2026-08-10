#!/usr/bin/env node
/** Legacy direct reauthentication entry point. Intentionally fail closed. */
console.error(
  'Claude direct browser/magic-link reauthentication is disabled. Use staged-enrollment.mjs with separately signed stage and activate approvals.',
);
process.exitCode = 2;
