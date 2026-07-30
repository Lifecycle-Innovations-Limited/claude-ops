/**
 * Unit tests: ops-accounts-gateway classify / seat pick / auth (no listen).
 */
import { classifyRoute, pickSchedulableSeat, authorize, extractApiKey } from '../ops-accounts-gateway.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(classifyRoute('GET', '/health').kind === 'health', 'health');
assert(classifyRoute('GET', '/v1/health').kind === 'health', 'v1 health');
assert(classifyRoute('GET', '/v1/models').kind === 'models', 'models');
assert(classifyRoute('POST', '/grok/v1/chat/completions').kind === 'grok-proxy', 'grok path');
assert(classifyRoute('POST', '/v1/images/generations').kind === 'grok-proxy', 'images → grok');
assert(classifyRoute('POST', '/v1/chat/completions').kind === 'claude', 'chat');
assert(classifyRoute('POST', '/v1/messages').kind === 'claude', 'messages');
assert(classifyRoute('GET', '/v1/unknown-thing').kind === 'openai-passthrough', 'passthrough');
assert(classifyRoute('GET', '/nope').kind === 'unknown', 'unknown');

const state = {
  providers: {
    claude: {
      seats: {
        'hot@example.com': { schedulable: false, util5h: 99 },
        'cool@example.com': { schedulable: true, util5h: 5 },
        'exhausted@example.com': {
          schedulable: true,
          exhaustedUntil: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    },
  },
};
const pick = pickSchedulableSeat(state, 'claude');
assert(pick?.email === 'cool@example.com', `picked ${pick?.email}`);
assert(pickSchedulableSeat({ providers: {} }, 'claude') === null, 'empty');

assert(authorize({ headers: {} }, '').ok === true, 'open');
assert(authorize({ headers: {} }, 'k').ok === false, 'missing');
assert(authorize({ headers: { authorization: 'Bearer k' } }, 'k').ok === true, 'bearer');
assert(authorize({ headers: { 'x-api-key': 'k' } }, 'k').ok === true, 'x-api-key');
assert(authorize({ headers: { authorization: 'Bearer wrong' } }, 'k').ok === false, 'bad');
assert(extractApiKey({ headers: { 'api-key': 'z' } }) === 'z', 'api-key header');

console.log('ops-accounts-gateway.test.mjs: ok');
