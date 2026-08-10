import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from './home.mjs';

export const CREDENTIAL_PROVIDERS = Object.freeze(['openai', 'gemini', 'safe_browsing']);

const ENV_NAMES = Object.freeze({
  openai: ['AP_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  gemini: ['AP_GEMINI_API_KEY', 'GEMINI_API_KEY'],
  safe_browsing: ['AP_GOOGLE_SAFE_BROWSING_API_KEY', 'GOOGLE_SAFE_BROWSING_API_KEY'],
});

function assertProvider(provider) {
  if (!CREDENTIAL_PROVIDERS.includes(provider)) {
    throw Object.assign(new Error('provider must be openai, gemini, or safe_browsing'), { status: 422 });
  }
  return provider;
}

function cleanKey(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('api_key must be a string'), { status: 422 });
  const key = value.trim();
  if (!key || key.length > 1_024
    || Array.from(key).some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw Object.assign(new Error('api_key must contain 1-1024 non-whitespace characters'), { status: 422 });
  }
  return key;
}

export class ProviderSecretStore {
  constructor({ home, env = process.env } = {}) {
    this.home = home ? path.resolve(home) : null;
    this.file = this.home ? path.join(this.home, 'provider-secrets.json') : null;
    this.env = env;
  }

  environmentKey(provider) {
    for (const name of ENV_NAMES[provider]) {
      const value = String(this.env[name] || '').trim();
      if (value) return value;
    }
    return '';
  }

  local() {
    if (!this.file) return {};
    let stat;
    try { stat = fs.lstatSync(this.file); }
    catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw Object.assign(new Error('provider secret store must be a regular file'), { status: 503 });
    }
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(this.file, 0o600);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { throw Object.assign(new Error('provider secret store is unreadable'), { status: 503 }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('provider secret store is invalid'), { status: 503 });
    }
    return Object.fromEntries(CREDENTIAL_PROVIDERS
      .filter(provider => typeof parsed[provider] === 'string' && parsed[provider])
      .map(provider => [provider, parsed[provider]]));
  }

  key(provider) {
    provider = assertProvider(provider);
    return this.local()[provider] || this.environmentKey(provider);
  }

  validate(value) { return cleanKey(value); }

  status() {
    const local = this.local();
    return Object.fromEntries(CREDENTIAL_PROVIDERS.map(provider => {
      const source = local[provider] ? 'local' : this.environmentKey(provider) ? 'environment' : null;
      return [provider, { configured: source !== null, source }];
    }));
  }

  set(provider, value) {
    provider = assertProvider(provider);
    if (!this.file) throw Object.assign(new Error('FediPod identity directory is unavailable'), { status: 503 });
    const next = { ...this.local(), [provider]: cleanKey(value) };
    writeJsonAtomic(this.file, next, { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
    return this.status()[provider];
  }

  delete(provider) {
    provider = assertProvider(provider);
    if (!this.file) throw Object.assign(new Error('FediPod identity directory is unavailable'), { status: 503 });
    const next = this.local();
    delete next[provider];
    writeJsonAtomic(this.file, next, { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
    return this.status()[provider];
  }
}
