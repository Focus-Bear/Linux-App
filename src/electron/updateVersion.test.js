import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, pickAsset, updateStatusText } from './updateVersion.js';

test('a higher version is newer, compared number by number', () => {
  assert.equal(isNewer('v0.2.0', '0.1.0'), true);
  assert.equal(isNewer('1.2.10', '1.2.9'), true);
  assert.equal(isNewer('1.3', '1.2.9'), true);
  assert.equal(isNewer('2.0.0', '10.0.0'), false);
});

test('the same or an older version is not newer', () => {
  assert.equal(isNewer('v0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1', '0.1.0'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
});

test('missing versions are never newer', () => {
  assert.equal(isNewer('', '0.1.0'), false);
  assert.equal(isNewer('1.0.0', undefined), false);
});

test('the download prefers AppImage, then deb, then rpm', () => {
  const assets = [
    { name: 'focusbear-0.2.0-x86_64.rpm', browser_download_url: 'https://example.test/rpm' },
    { name: 'focusbear-0.2.0-amd64.deb', browser_download_url: 'https://example.test/deb' },
    { name: 'focusbear-0.2.0-x86_64.AppImage', browser_download_url: 'https://example.test/appimage' },
  ];
  assert.equal(pickAsset(assets), 'https://example.test/appimage');
  assert.equal(pickAsset(assets.slice(0, 2)), 'https://example.test/deb');
  assert.equal(pickAsset(assets.slice(0, 1)), 'https://example.test/rpm');
});

test('unknown or missing assets give no download link', () => {
  assert.equal(pickAsset([{ name: 'notes.txt', browser_download_url: 'https://example.test/x' }]), '');
  assert.equal(pickAsset([{ name: 'a.deb' }]), '');
  assert.equal(pickAsset(null), '');
});

test('Settings > About describes the result of a check', () => {
  assert.equal(updateStatusText(null), 'Not checked yet.');
  assert.equal(
    updateStatusText({ status: 'update-available', latestVersion: '0.2.0', currentVersion: '0.1.0' }),
    'Focus Bear 0.2.0 is available. You have 0.1.0.',
  );
  assert.equal(updateStatusText({ status: 'up-to-date', currentVersion: '0.1.0' }), 'You have the latest version (0.1.0).');
  assert.equal(updateStatusText({ status: 'error', error: 'HTTP 404' }), 'No published release to compare with yet.');
  assert.match(updateStatusText({ status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' }), /internet connection/);
});
