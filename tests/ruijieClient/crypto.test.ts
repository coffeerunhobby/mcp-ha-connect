/**
 * The Ruijie eWeb crypto must match what the router's page does: GibberishAES is OpenSSL's
 * "Salted__" AES-256-CBC with an MD5 key derivation, checked here against a vector made with
 * `openssl enc -aes-256-cbc -md md5 -S 0102030405060708 -pass pass:testkey` (made-up values).
 */

import { createHash } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import { checksumHeaders, encryptPassword, gibberishDecrypt, gibberishEncrypt, pageKey } from '../../src/ruijieClient/crypto.js';

const VECTOR = 'U2FsdGVkX18BAgMEBQYHCDLHidul4am1UhxV5X4RV2U=';
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('GibberishAES (OpenSSL salted AES-256-CBC, MD5 key derivation)', () => {
    it('decrypts what OpenSSL encrypted, and encrypts to the same bytes with the same salt', () => {
        expect(gibberishDecrypt(VECTOR, 'testkey')).toBe('Pa55word!');
        expect(gibberishEncrypt('Pa55word!', 'testkey', Buffer.from('0102030405060708', 'hex'))).toBe(VECTOR);
    });

    it('uses a fresh salt each time, and round-trips text with non-ASCII characters', () => {
        const a = gibberishEncrypt('pässwörd', 'k');
        const b = gibberishEncrypt('pässwörd', 'k');
        expect(a).not.toBe(b);
        expect(Buffer.from(a, 'base64').subarray(0, 8).toString()).toBe('Salted__');
        expect(gibberishDecrypt(a, 'k')).toBe('pässwörd');
    });

    it('refuses something that is not a salted blob', () => {
        expect(() => gibberishDecrypt(Buffer.from('not salted at all, just text').toString('base64'), 'k')).toThrow('Not an OpenSSL salted AES blob');
        expect(() => gibberishDecrypt('', 'k')).toThrow();
        // long enough, but without the header
        expect(() => gibberishDecrypt(Buffer.alloc(48, 7).toString('base64'), 'k')).toThrow('Not an OpenSSL salted AES blob');
        // the header and salt, but no encrypted block
        expect(() => gibberishDecrypt(Buffer.from('Salted__12345678').toString('base64'), 'k')).toThrow('Not an OpenSSL salted AES blob');
    });

    it('unpacks the login page key (shipped encrypted with "eweb") and encrypts the password with it', () => {
        const key = pageKey();
        expect(key).toMatch(/^\S{8,}$/);
        expect(gibberishDecrypt(encryptPassword('Pa55word!'), key)).toBe('Pa55word!');
        expect(encryptPassword('x')).not.toMatch(/\s/);
    });
});

describe('the checksum headers', () => {
    it('are MD5 of the fixed prefix plus the UTF-8 byte length, and plus the body', () => {
        const body = '{"a":"é"}';
        expect(Buffer.byteLength(body)).toBe(10);
        expect(checksumHeaders(body)).toEqual({ 'Content-Accept': md5('Web@Rj$2020!10'), 'Contents-Accept': md5(`Web@Rj$2020!${body}`) });
    });
});
