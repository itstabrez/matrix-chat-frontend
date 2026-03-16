import Olm from "@matrix-org/olm";

let olmInitialized = false;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

export function fromBase64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// OLM INIT
// ─────────────────────────────────────────────────────────────────────────────

export async function initOlm() {
  if (!olmInitialized) {
    await Olm.init({ locateFile: (f) => `/${f}` });
    olmInitialized = true;
    console.log("✅ Olm initialized");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OLM ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────

const PICKLE_KEY = "secure_pickle_key";

export function createNewAccount() {
  const account = new Olm.Account();
  account.create();
  return account;
}

export function pickleAccount(account) {
  return account.pickle(PICKLE_KEY);
}

export function unpickleAccount(pickled) {
  const account = new Olm.Account();
  account.unpickle(PICKLE_KEY, pickled);
  return account;
}

export function getDeviceKeys(account) {
  const keys = JSON.parse(account.identity_keys());
  return { curve25519: keys.curve25519, ed25519: keys.ed25519 };
}

export function generateOneTimeKeys(account, count = 10) {
  account.generate_one_time_keys(count);
  const otks = JSON.parse(account.one_time_keys());
  account.mark_keys_as_published();
  return otks.curve25519;
}

// ─────────────────────────────────────────────────────────────────────────────
// P-256 KEYPAIR  — used for ECDH session key wrapping
// ─────────────────────────────────────────────────────────────────────────────

export async function generateP256KeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,          // extractable so we can export into vault
    ["deriveKey"]
  );
}

export async function exportP256PublicKey(keyPair) {
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return toBase64(spki);
}

export async function exportP256PrivateKey(keyPair) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  return toBase64(pkcs8);
}

/**
 * Load our P-256 private key from sessionStorage.
 * sessionStorage is populated:
 *   a) First login — after generateP256KeyPair()
 *   b) Every subsequent login — after decryptAccountFromVault()
 */
export async function loadP256PrivateKey() {
  const stored = sessionStorage.getItem("p256_private_key");
  if (!stored) {
    throw new Error("P-256 private key missing from sessionStorage — vault not decrypted yet");
  }
  return crypto.subtle.importKey(
    "pkcs8",
    fromBase64(stored),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VAULT  — AES-GCM encrypt/decrypt of { olmPickle + p256PrivateKey }
//
// The vault blob structure (before encryption):
//   JSON { olmPickle: string, p256PrivateKey: string }
//
// Encrypted with AES-256-GCM key derived from user's password via PBKDF2.
// Server stores { encryptedAccount, salt, nonce } — cannot decrypt any of it.
// ─────────────────────────────────────────────────────────────────────────────

async function deriveAesKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt the Olm account pickle + P-256 private key into a vault blob.
 *
 * Reads p256_private_key from sessionStorage automatically.
 * Call after:
 *   - First account creation
 *   - Generating OTKs (account state changed)
 *
 * @param {Olm.Account} olmAccount
 * @param {string} password  - user's login password (never sent to server)
 * @returns {{ encryptedAccount, salt, nonce }}  — safe to POST to server
 */
export async function encryptAccountForVault(olmAccount, password) {
  const p256PrivateKey = sessionStorage.getItem("p256_private_key") ?? "";

  const payload = JSON.stringify({
    olmPickle:     pickleAccount(olmAccount),
    p256PrivateKey,
  });

  const salt  = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key   = await deriveAesKey(password, salt);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(payload)
  );

  return {
    encryptedAccount: toBase64(encrypted),
    salt:             toBase64(salt),
    nonce:            toBase64(nonce),
  };
}

/**
 * Decrypt a vault blob from the server and restore both keys.
 *
 * Side effect: writes p256PrivateKey to sessionStorage so that
 * loadP256PrivateKey() works immediately after this call returns.
 *
 * @param {{ encryptedAccount, salt, nonce }} vaultData  — from server
 * @param {string} password
 * @returns {Olm.Account}
 */
export async function decryptAccountFromVault(vaultData, password) {
  const key = await deriveAesKey(password, fromBase64(vaultData.salt));

  let decryptedBytes;
  try {
    decryptedBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(vaultData.nonce) },
      key,
      fromBase64(vaultData.encryptedAccount)
    );
  } catch {
    throw new Error("Vault decryption failed — wrong password or corrupted data");
  }

  const { olmPickle, p256PrivateKey } = JSON.parse(
    new TextDecoder().decode(decryptedBytes)
  );

  // ✅ Restore P-256 private key to sessionStorage
  if (p256PrivateKey) {
    sessionStorage.setItem("p256_private_key", p256PrivateKey);
  }

  return unpickleAccount(olmPickle);
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION KEY WRAPPING  — ECDH P-256 + AES-GCM
//
// Flow:
//   WRAP (sender):
//     1. Generate ephemeral P-256 keypair
//     2. ECDH(ephemeralPrivate, recipientP256Public) → sharedAesKey
//     3. AES-GCM encrypt(rawMegolmSessionKey) → wrappedKey
//     4. Store: wrappedKey + keyNonce + ephemeralPublicKey in DB row
//
//   UNWRAP (recipient):
//     1. Load own P-256 private key from sessionStorage
//     2. ECDH(myPrivate, ephemeralPublicKey) → same sharedAesKey
//     3. AES-GCM decrypt(wrappedKey) → rawMegolmSessionKey
//
// The server stores opaque blobs — cannot derive sharedAesKey without
// the recipient's P-256 private key which never leaves the client.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a raw Megolm session key for one specific recipient.
 *
 * @param {string} rawSessionKey       - plaintext Megolm session.session_key()
 * @param {string} recipientP256B64    - recipient's P-256 public key (spki base64)
 *                                       stored in device_keys.p256_key
 * @returns {{ wrappedKey, keyNonce, ephemeralPublicKey, olmMessageType }}
 */
export async function wrapSessionKey(rawSessionKey, recipientP256B64) {
  // 1. Ephemeral keypair — fresh per recipient per session
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );

  // 2. Import recipient's P-256 public key
  const recipientKey = await crypto.subtle.importKey(
    "spki",
    fromBase64(recipientP256B64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // 3. Derive shared AES key via ECDH
  const sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: recipientKey },
    ephemeral.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  // 4. Encrypt the raw Megolm session key
  const nonce     = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    sharedKey,
    new TextEncoder().encode(rawSessionKey)
  );

  // 5. Export ephemeral public key for the DB row
  const ephemeralPubSpki = await crypto.subtle.exportKey("spki", ephemeral.publicKey);

  return {
    wrappedKey:         toBase64(encrypted),
    keyNonce:           toBase64(nonce),
    ephemeralPublicKey: toBase64(ephemeralPubSpki),
    olmMessageType:     1,
  };
}

/**
 * Unwrap a wrapped Megolm session key using our own P-256 private key.
 *
 * @param {string} wrappedKey            - AES-GCM ciphertext (base64)
 * @param {string} keyNonce              - AES-GCM nonce (base64)
 * @param {string} ephemeralPublicKeyB64 - sender's ephemeral P-256 public key (base64)
 * @returns {string} rawSessionKey       - pass directly to createInboundSession()
 */
export async function unwrapSessionKey(wrappedKey, keyNonce, ephemeralPublicKeyB64) {
  if (!wrappedKey || !keyNonce || !ephemeralPublicKeyB64) {
    throw new Error(
      `unwrapSessionKey: missing fields — ` +
      `wrappedKey=${!!wrappedKey} keyNonce=${!!keyNonce} ephemeralPublicKey=${!!ephemeralPublicKeyB64}`
    );
  }

  // 1. Our P-256 private key (from sessionStorage via vault decrypt)
  const myPrivateKey = await loadP256PrivateKey();

  // 2. Import sender's ephemeral public key
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "spki",
    fromBase64(ephemeralPublicKeyB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // 3. Derive the same shared AES key the sender used
  const sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: ephemeralPublicKey },
    myPrivateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // 4. Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(keyNonce) },
    sharedKey,
    fromBase64(wrappedKey)
  );

  return new TextDecoder().decode(decrypted);
}

// ─────────────────────────────────────────────────────────────────────────────
// MEGOLM GROUP SESSIONS
// ─────────────────────────────────────────────────────────────────────────────

export function createOutboundSession() {
  const session = new Olm.OutboundGroupSession();
  session.create();
  return session;
}

export function encryptMessage(outboundSession, plaintext) {
  return outboundSession.encrypt(plaintext);
}

/**
 * Build an inbound group session from the RAW (already unwrapped) Megolm key.
 * NEVER call with the wrapped blob from the server — unwrap first.
 */
export function createInboundSession(rawSessionKey) {
  const session = new Olm.InboundGroupSession();
  session.create(rawSessionKey);
  return session;
}