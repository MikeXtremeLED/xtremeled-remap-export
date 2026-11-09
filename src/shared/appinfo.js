'use strict';
// What the app says about itself: version comparison and the update notice rule.
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AppInfo = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const RELEASES_API = 'https://api.github.com/repos/MikeXtremeLED/xtremeled-remap-export/releases/latest';
  const RELEASES_PAGE = 'https://github.com/MikeXtremeLED/xtremeled-remap-export/releases';

  // "v1.2.3" -> [1, 2, 3]; null for anything that isn't a plain version
  function parseVersion(text) {
    const m = String(text == null ? '' : text).trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function isNewer(candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  }

  // The GitHub answer as a notice, or null: only a published release newer than this version counts
  function updateFromRelease(release, current) {
    if (!release || release.draft || release.prerelease) return null;
    const version = parseVersion(release.tag_name);
    if (!version || !isNewer(release.tag_name, current)) return null;
    const url = String(release.html_url || '').startsWith(`${RELEASES_PAGE}/`) ? release.html_url : RELEASES_PAGE;
    return { version: version.join('.'), url };
  }

  // Only the project's own release pages can be opened from the notice
  function isReleaseUrl(url) {
    return String(url) === RELEASES_PAGE || String(url).startsWith(`${RELEASES_PAGE}/`);
  }

  // The line in the About card. A version that isn't the pinned one is said so, never "verified".
  function pinLine(version, pin) {
    const name = `ffmpeg ${version}`;
    if (!pin || pin.state === 'checking') return { text: `${name} · checking…`, ok: false };
    if (pin.state === 'verified') return { text: `${name} · verified (SHA-256 matches)`, ok: true };
    if (pin.state === 'different') return { text: `${name} · not the pinned build (${pin.expected})`, ok: false };
    return { text: `${name} · not checked`, ok: false };
  }

  // Result of the test suite for this build, null when this build did not run it
  function testsLine(buildInfo) {
    if (!buildInfo || !(buildInfo.testsPassed > 0)) return { text: 'Tests: not run for this build', ok: false };
    return { text: `Tests: ${buildInfo.testsPassed} of ${buildInfo.testsPassed} passed`, ok: true };
  }

  return { RELEASES_API, RELEASES_PAGE, parseVersion, isNewer, updateFromRelease, isReleaseUrl, pinLine, testsLine };
});
