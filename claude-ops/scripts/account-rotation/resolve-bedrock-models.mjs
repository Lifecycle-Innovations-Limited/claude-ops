#!/usr/bin/env node
/**
 * Emit JSON with latest Bedrock inference profile IDs for Claude Code.
 * Usage: node resolve-bedrock-models.mjs [region]
 * Env: AWS_BEDROCK_REGION, BEDROCK_SKIP_RESOLVE=1
 */
import { resolveBedrockClaudeModelIds } from './claude-settings-mode.mjs';

const region =
  process.env.AWS_BEDROCK_REGION ||
  process.argv[2] ||
  'us-east-1';

console.log(JSON.stringify(resolveBedrockClaudeModelIds(region)));
