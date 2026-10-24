/**
 * The small amount of crypto Ruijie's eWeb login and API calls need, done the way the
 * router's own web page does it (verified against a RG-EG105G-V3, ReyeeOS 2.324, 2026-10-24):
 *
 * - The page encrypts the login password with GibberishAES: OpenSSL's "Salted__" format,
 *   AES-256-CBC with key and IV from EVP_BytesToKey (MD5). Its key is itself shipped in the
 *   page, encrypted with the passphrase "eweb". This hides the password from a casual look at
 *   the traffic; it is not a secret, so the transport should still be HTTPS.
 * - Every API request carries two checksum headers, MD5 of a fixed string plus the body's
 *   byte length (Content-Accept) and plus the body itself (Contents-Accept).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** The login-page key blob (GibberishAES of the key, passphrase "eweb"), as the page ships it. */
const PAGE_KEY_BLOB = 'U2FsdGVkX19ecPYL/ZAlcSG29wb6ivqD9YjEM30k1h8=';
const PAGE_KEY_PASSPHRASE = 'eweb';
const CHECKSUM_PREFIX = 'Web@Rj$2020!';
const SALTED = Buffer.from('Salted__');

function evpBytesToKey(passphrase: Buffer, salt: Buffer): { key: Buffer; iv: Buffer } {
    let previous = Buffer.alloc(0);
    let derived = Buffer.alloc(0);
    while (derived.length < 48) {
        previous = createHash('md5').update(Buffer.concat([previous, passphrase, salt])).digest();
        derived = Buffer.concat([derived, previous]);
    }
    return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) };
}

/** GibberishAES / `openssl enc -aes-256-cbc -md md5` encryption, base64 with the "Salted__" header. */
export function gibberishEncrypt(text: string, passphrase: string, salt: Buffer = randomBytes(8)): string {
    const { key, iv } = evpBytesToKey(Buffer.from(passphrase), salt);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([SALTED, salt, cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

export function gibberishDecrypt(blob: string, passphrase: string): string {
    const raw = Buffer.from(blob, 'base64');
    if (raw.length < 32 || !raw.subarray(0, 8).equals(SALTED)) throw new Error('Not an OpenSSL salted AES blob');
    const { key, iv } = evpBytesToKey(Buffer.from(passphrase), raw.subarray(8, 16));
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
}

/** The key the login page encrypts the password with. */
export function pageKey(): string {
    return gibberishDecrypt(PAGE_KEY_BLOB, PAGE_KEY_PASSPHRASE);
}

/** The password as the login page sends it. */
export function encryptPassword(password: string): string {
    return gibberishEncrypt(password, pageKey());
}

/** The two checksum headers the web page sends with every API request. */
export function checksumHeaders(body: string): Record<string, string> {
    const md5 = (value: string) => createHash('md5').update(value).digest('hex');
    return {
        'Content-Accept': md5(CHECKSUM_PREFIX + Buffer.byteLength(body, 'utf8')),
        'Contents-Accept': md5(CHECKSUM_PREFIX + body),
    };
}
