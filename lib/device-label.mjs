// A short, readable name for a signed-in device, from its browser's user agent: "Chrome on
// macOS", "Safari on iPhone". Only the browser and system are shown; the rest is ignored.

// Checked in order: Edge, Opera and Samsung also claim to be Chrome, and Chrome claims Safari.
const BROWSERS = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

// Checked in order: iPhone and Android user agents also mention Mac OS X and Linux.
const SYSTEMS = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/**
 * "Browser on system" for a user agent, or "Unknown device" when neither is recognized.
 * @param {string | null | undefined} userAgent
 */
export function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser || system || 'Unknown device';
}
