// net.test.js
// Covers the address classification behind the SSRF guard: which IPs this server is
// allowed to connect to. Pure function, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isPublicAddress } from '../server/net.js';

test('ordinary public addresses are allowed', () => {
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('loopback, private and cloud-metadata addresses are blocked', () => {
  assert.equal(isPublicAddress('127.0.0.1'), false);
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('192.168.1.1'), false);
  assert.equal(isPublicAddress('169.254.169.254'), false);
  assert.equal(isPublicAddress('::1'), false);
  assert.equal(isPublicAddress('fd00::1'), false);
});

test('an IPv4 address dressed up as IPv6 is judged as the IPv4 it is', () => {
  // ::ffff:127.0.0.1 is loopback - the mapped form must not slip past as "IPv6 unicast".
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
  assert.equal(isPublicAddress('::ffff:1.1.1.1'), true);
});

test('the local-use NAT64 range (RFC 8215) is blocked', () => {
  // 64:ff9b:1::/48 is translated to IPv4 by a gateway inside the network it sits in,
  // so an address in it can reach private IPv4 hosts behind that gateway.
  assert.equal(isPublicAddress('64:ff9b:1::a00:1'), false);
});

test('garbage is not a public address', () => {
  assert.equal(isPublicAddress('not an ip'), false);
  assert.equal(isPublicAddress(''), false);
});
