import Olm from "@matrix-org/olm";

let olmInitialized = false;

export async function initOlm() {
  if (!olmInitialized) {
    await Olm.init({ locateFile: (filename) => `/${filename}` });
    olmInitialized = true;
    console.log("✅ Olm initialized");
  }
}

export function createOrLoadAccount() {
  const stored  = localStorage.getItem("olm_account");
  const account = new Olm.Account();
  if (stored) {
    account.unpickle("secret_passphrase", stored);
  } else {
    account.create();
    saveAccount(account);
  }
  return account;
}

export function saveAccount(account) {
  localStorage.setItem("olm_account", account.pickle("secret_passphrase"));
}

export function getDeviceKeys(account) {
  const keys = JSON.parse(account.identity_keys());
  return { curve25519: keys.curve25519, ed25519: keys.ed25519 };
}

export function generateOneTimeKeys(account, count = 10) {
  account.generate_one_time_keys(count);
  const otks = JSON.parse(account.one_time_keys());
  account.mark_keys_as_published();
  saveAccount(account);
  return otks.curve25519;
}

export function createOutboundSession() {
  const session = new Olm.OutboundGroupSession();

  session.create();

  return session;
}

export function encryptMessage(outboundSession, plaintext) {
  return outboundSession.encrypt(plaintext);
}

// ✅ Only call this with a session key received FROM the backend/other user
// Never call this with outbound.session_key() on the sender side
export function createInboundSession(sessionKey) {
  const session = new Olm.InboundGroupSession();
  session.create(sessionKey);
  return session;
}

export function decryptMessage(session, ciphertext) {
  const result = session.decrypt(ciphertext);
  return JSON.parse(result.plaintext);
}