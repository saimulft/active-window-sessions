import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hostFromUrl } from '../src/index.ts';
import { parseHttpUrl } from '../src/host.ts';

describe('hostFromUrl', () => {
  it('returns the lower-case host of http and https URLs', () => {
    assert.equal(hostFromUrl('https://GitHub.com/user/repo?tab=1#top'), 'github.com');
    assert.equal(hostFromUrl('http://example.org'), 'example.org');
  });

  it('drops port, credentials, path, query and fragment', () => {
    assert.equal(hostFromUrl('https://me:secret@app.example.com:8443/a/b?token=1#x'), 'app.example.com');
  });

  it('keeps subdomains and does not strip www', () => {
    assert.equal(hostFromUrl('https://www.example.com/'), 'www.example.com');
    assert.equal(hostFromUrl('https://docs.a.b.example.com/'), 'docs.a.b.example.com');
  });

  it('handles IP addresses and localhost', () => {
    assert.equal(hostFromUrl('http://127.0.0.1:3000/x'), '127.0.0.1');
    assert.equal(hostFromUrl('http://localhost:5173'), 'localhost');
    assert.equal(hostFromUrl('http://[::1]:8080/'), '[::1]');
  });

  it('returns null for schemes other than http and https', () => {
    for (const url of [
      'file:///Users/me/notes.txt',
      'about:blank',
      'chrome://settings',
      'ftp://example.com',
      'mailto:a@b.c',
    ]) {
      assert.equal(hostFromUrl(url), null, url);
    }
  });

  it('returns null for malformed, empty and missing input', () => {
    for (const url of ['', 'not a url', 'http://', '://example.com', 'example.com', undefined, null]) {
      assert.equal(hostFromUrl(url), null, String(url));
    }
  });
});

describe('parseHttpUrl', () => {
  it('returns the href without the fragment', () => {
    assert.deepEqual(parseHttpUrl('https://Example.com/a?b=1#section'), {
      host: 'example.com',
      href: 'https://example.com/a?b=1',
    });
  });

  it('returns null for non-http input', () => {
    assert.equal(parseHttpUrl('file:///x'), null);
  });
});
