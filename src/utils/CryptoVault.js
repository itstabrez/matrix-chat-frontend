// Derive AES key from password using PBKDF2
export async function deriveKey(password, salt) {
    const keyMaterial = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false, ["encrypt", "decrypt"]
    );
}

// Wrap Olm account pickle → encrypted blob → upload to server
export async function uploadEncryptedAccount(olmAccount, password, userId, token) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const pickle = olmAccount.pickle("secure");
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        key,
        new TextEncoder().encode(pickle)
    );
    await fetch(`/api/matrix/vault/${userId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            encryptedAccount: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
            salt: btoa(String.fromCharCode(...salt)),
            nonce: btoa(String.fromCharCode(...nonce))
        })
    });
}

// Download + decrypt Olm account → survives localStorage.clear()
export async function downloadAndDecryptAccount(password, userId, token) {
    const res = await fetch(`/api/matrix/vault/${userId}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const { encryptedAccount, salt, nonce } = await res.json();
    const key = await deriveKey(
        password,
        Uint8Array.from(atob(salt), c => c.charCodeAt(0))
    );
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: Uint8Array.from(atob(nonce), c => c.charCodeAt(0)) },
        key,
        Uint8Array.from(atob(encryptedAccount), c => c.charCodeAt(0))
    );
    const pickle = new TextDecoder().decode(decrypted);
    const account = new Olm.Account();
    account.unpickle("secure", pickle);
    return account;
}

// Generate once, store encrypted in vault alongside Olm account
export async function generateP256KeyPair() {
    return crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,   // extractable so we can pickle it into vault
        ["deriveKey"]
    );
}

export async function exportP256PublicKey(keyPair) {
    const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    return toBase64(spki);
}

// Call this once at account creation, store result in vault blob
export async function exportP256PrivateKey(keyPair) {
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    return toBase64(pkcs8);
}

export async function loadP256PrivateKey() {
    // Stored as part of vault blob: { olmPickle, p256PrivateKey }
    const stored = sessionStorage.getItem("p256_private_key");
    if (!stored) throw new Error("P-256 private key not loaded from vault");
    return crypto.subtle.importKey(
        "pkcs8", fromBase64(stored),
        { name: "ECDH", namedCurve: "P-256" },
        false, ["deriveKey"]
    );
}
```

---

### Key Sharing Flow (Fixed)
```
// SENDER sends a message:
// 1. getOrCreateOutboundSession() → Megolm session
// 2. For EACH room member:
//    a. Fetch their Curve25519 public key from /api/matrix/keys/{userId}
//    b. Create ephemeral Olm session: olmEncrypt(theirCurve25519, sessionKey)
//    c. POST /rooms/{roomId}/share-keys with:
//       { sessionId, recipients: { userId: { wrappedKey, nonce } } }
// 3. Java stores one row per recipient — each row has DIFFERENT wrapped key
// 4. No recipient can decrypt another's row

// RECIPIENT receives a message:
// 1. GET /sessions/pending?userId=... → gets their wrapped key blob
// 2. olmDecrypt(myPrivateKey, wrappedKey) → raw Megolm sessionKey
// 3. createInboundSession(sessionKey) → decrypt message
// 4. Account private key is recovered from server vault using password