#!/usr/bin/env node
import { routeStatus } from '../scripts/account-rotation/route-state.mjs';

function block(reason) {
  console.log(
    JSON.stringify({
      decision: 'block',
      reason,
    }),
  );
  process.exit(2);
}

try {
  const status = routeStatus();
  const settings = status.settings;
  const route = status.state;

  if (settings.mixedProvider) {
    block(
      'Claude routing is unsafe: settings.json has both Bedrock and CRS/OAuth enabled. Run `claude-stack route --mode crs-oauth` or explicitly confirm Bedrock with `claude-stack route --mode bedrock-confirmed --confirm-metered-bedrock --reason "<reason>"`.',
    );
  }

  if (settings.bedrock && (route.mode !== 'bedrock-confirmed' || !status.bedrockConfirmationActive)) {
    block(
      'Bedrock fallback blocked. Bedrock is metered AWS usage, and OAuth/CRS is unavailable or not selected. Confirm only for this session with `claude-stack route --mode bedrock-confirmed --reason "<why OAuth is unavailable>" --ttl-minutes 60 --confirm-metered-bedrock`, or restore OAuth with `claude-stack route --mode crs-oauth`.',
    );
  }

  if (route.mode === 'fail-closed') {
    block(
      `Claude routing is fail-closed: ${route.reason || 'CRS OAuth is unavailable and Bedrock has not been explicitly confirmed'}. Run \`claude-stack doctor --json\` for current CRS/account status.`,
    );
  }

  console.log(JSON.stringify({ suppressOutput: true }));
} catch (e) {
  block(`Claude routing guard failed closed: ${e.message || String(e)}`);
}
