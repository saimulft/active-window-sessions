import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { checkPlatformSupport, defaultIdleThresholdSeconds, isRemoteSession } from '../src/index.ts';

describe('checkPlatformSupport', () => {
  it('supports macOS and Windows without looking at anything', () => {
    assert.deepEqual(checkPlatformSupport({ platform: 'darwin' }), { supported: true });
    assert.deepEqual(checkPlatformSupport({ platform: 'win32' }), { supported: true });
  });

  it('rejects Wayland sessions', () => {
    const wayland = checkPlatformSupport({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland' },
      commandExists: () => true,
    });
    assert.equal(wayland.supported, false);
    assert.match(wayland.reason ?? '', /Wayland/);
    const noDisplay = checkPlatformSupport({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      commandExists: () => true,
    });
    assert.equal(noDisplay.supported, false);
  });

  it('accepts X11 with xprop and xwininfo, including XWayland', () => {
    const env = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };
    assert.deepEqual(checkPlatformSupport({ platform: 'linux', env, commandExists: () => true }), { supported: true });
    const xwayland = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
    assert.deepEqual(checkPlatformSupport({ platform: 'linux', env: xwayland, commandExists: () => true }), {
      supported: true,
    });
  });

  it('names the missing X11 tools', () => {
    const result = checkPlatformSupport({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      commandExists: (name) => name === 'xprop',
    });
    assert.equal(result.supported, false);
    assert.match(result.reason ?? '', /xwininfo/);
    assert.doesNotMatch(result.reason ?? '', /xprop/);
  });

  it('finds the X11 tools on PATH by checking for executable files, without running them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-platform-'));
    try {
      const env = { DISPLAY: ':0', PATH: `/nonexistent${delimiter}${dir}` };
      assert.equal(checkPlatformSupport({ platform: 'linux', env }).supported, false);
      for (const name of ['xprop', 'xwininfo']) writeFileSync(join(dir, name), '', { mode: 0o755 });
      assert.deepEqual(checkPlatformSupport({ platform: 'linux', env }), { supported: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('remote sessions and idle threshold', () => {
  it('detects RDP on Windows and SSH elsewhere', () => {
    assert.equal(isRemoteSession({ platform: 'win32', env: { SESSIONNAME: 'RDP-Tcp#1' } }), true);
    assert.equal(isRemoteSession({ platform: 'win32', env: { SESSIONNAME: 'Console' } }), false);
    assert.equal(isRemoteSession({ platform: 'darwin', env: { SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' } }), true);
    assert.equal(isRemoteSession({ platform: 'linux', env: {} }), false);
  });

  it('suggests 50 seconds locally and 30 on a remote session', () => {
    assert.equal(defaultIdleThresholdSeconds({ platform: 'darwin', env: {} }), 50);
    assert.equal(defaultIdleThresholdSeconds({ platform: 'linux', env: { SSH_CLIENT: 'x' } }), 30);
  });
});
