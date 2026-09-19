import { describe, expect, it } from 'vitest';
import {
  buildGrokBuildHeaders,
  GROK_BUILD_CLIENT_IDENTIFIER,
  GROK_BUILD_CLIENT_MODE,
  GROK_BUILD_CLIENT_VERSION,
} from './grokBuildCompat.js';

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

describe('Grok Build CLI proxy headers', () => {
  it('matches the official CLI identity contract and derives x-userid locally', () => {
    expect(buildGrokBuildHeaders(jwt({ sub: 'xai-user-123' }), 'grok-build')).toEqual({
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-version': GROK_BUILD_CLIENT_VERSION,
      'x-grok-client-identifier': GROK_BUILD_CLIENT_IDENTIFIER,
      'x-grok-client-mode': GROK_BUILD_CLIENT_MODE,
      'User-Agent': `grok-shell/${GROK_BUILD_CLIENT_VERSION}`,
      'x-userid': 'xai-user-123',
      'x-grok-model-override': 'grok-build',
    });
  });

  it('does not emit an unusable x-userid when the token is opaque', () => {
    expect(buildGrokBuildHeaders('opaque-token')).not.toHaveProperty('x-userid');
  });
});
