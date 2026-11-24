import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLabel } from '../../lib/device-label.mjs';

const AGENTS = {
  'Chrome on macOS':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  'Safari on macOS':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  'Safari on iPhone':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
  'Chrome on iPhone':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1',
  'Edge on Windows':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  'Firefox on Linux': 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0',
  'Chrome on Android':
    'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  'Samsung Internet on Android':
    'Mozilla/5.0 (Linux; Android 16; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36',
  'Safari on iPad':
    'Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
};

test('device labels name the browser and system', () => {
  for (const [label, agent] of Object.entries(AGENTS)) assert.equal(deviceLabel(agent), label);
});

test('device labels fall back for missing or unknown agents', () => {
  assert.equal(deviceLabel(null), 'Unknown device');
  assert.equal(deviceLabel(''), 'Unknown device');
  assert.equal(deviceLabel('node'), 'Unknown device');
  assert.equal(deviceLabel('curl/8.7.1 (Windows)'), 'Windows');
});
