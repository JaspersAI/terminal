import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPublicAddress } from './address.ts'

test('loopback, private, link local, unspecified, and mapped addresses are not public', () => {
  for (const ip of [
    '127.0.0.1',
    '127.255.255.255',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip)
  }
})

test('public addresses are public, and nonsense is not', () => {
  for (const ip of ['8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip)
  }
  for (const ip of ['', 'localhost', '1.2.3', '999.1.1.1', 'zz::1']) assert.equal(isPublicAddress(ip), false, ip)
})
