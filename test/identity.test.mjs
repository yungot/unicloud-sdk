import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOsName } from '../dist/index.js';

function withUA(ua, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
  }
}

test('UA 识别：iOS 不会被误判为 macOS，Android 不会被误判为 Linux', () => {
  assert.equal(withUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', detectOsName), 'ios');
  assert.equal(withUA('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', detectOsName), 'ios');
  assert.equal(withUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', detectOsName), 'android');
  assert.equal(withUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/33', detectOsName), 'windows');
  assert.equal(withUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', detectOsName), 'macos');
  assert.equal(withUA('Mozilla/5.0 (X11; Linux x86_64)', detectOsName), 'linux');
});
