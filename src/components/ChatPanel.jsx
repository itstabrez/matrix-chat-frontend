import { useEffect, useRef, useState, useCallback } from "react";
import {
  Box, Typography, TextField, Paper, Button, CircularProgress,
} from "@mui/material";
import axios from "axios";
import { useUnread } from "./UnreadContext";
import ShowingEventCard from "./ShowingEventCard";

import {
  initOlm,
  createNewAccount,
  getDeviceKeys,
  generateOneTimeKeys,
  encryptAccountForVault,
  decryptAccountFromVault,
  generateP256KeyPair,
  exportP256PublicKey,
  exportP256PrivateKey,
  createOutboundSession,
  encryptMessage,
  createInboundSession,
  wrapSessionKey,
  unwrapSessionKey,
} from "../utils/matrixCrypto.js";

const API = "http://localhost:8080/api/matrix";

// ─────────────────────────────────────────────────────────────────────────────
// MODULE-LEVEL CRYPTO STATE
//
// These live outside React so they survive re-renders and room switches.
// They are reset only on a full page reload (F5).
//
// olmAccount   — the user's Olm identity. Recovered from the server vault
//                on every page load, so it also survives localStorage.clear().
//
// inboundSessions — map of sessionId → Olm.InboundGroupSession.
//                   Built once per session after unwrapping the key from the
//                   server.  Used by decryptEvent() to decrypt every message.
//
// outboundByRoom  — map of roomId → Olm.OutboundGroupSession.
//                   The active outbound session for each room.
//                   Used by sendMessage() to encrypt outgoing text.
//
// outboundById    — same sessions indexed by sessionId instead of roomId.
//                   Allows lookup when restoring after a page reload.
// ─────────────────────────────────────────────────────────────────────────────
let olmAccount = null;

const inboundSessions = {};
const outboundByRoom  = {};
const outboundById    = {};

// Password is stored in sessionStorage at login time.
// sessionStorage survives page reload but is cleared when the tab closes.
function getPassword() {
  return sessionStorage.getItem("password") ?? "";
}

export default function ChatPanel({ roomId }) {

  const token  = localStorage.getItem("token");   // Matrix access token
  const userId = localStorage.getItem("userId");  // e.g. "@alice:matrix.local"
  const { markRead } = useUnread();

  // ── UI state ──────────────────────────────────────────────────────────────
  const [messages,     setMessages]     = useState([]);
  const [input,        setInput]        = useState("");
  const [olmReady,     setOlmReady]     = useState(false);  // gates all UI
  const [loading,      setLoading]      = useState(true);   // room init spinner
  const [historyToken, setHistoryToken] = useState(null);   // Matrix pagination token
  const [loadingMore,  setLoadingMore]  = useState(false);  // scroll-up spinner

  // ── Refs (don't trigger re-renders) ──────────────────────────────────────
  const processedEventIds = useRef(new Set()); // dedup — never show same event twice
  const syncAbort         = useRef({ cancelled: false }); // cancel old sync loop on room change
  const bottomRef         = useRef(null);   // scroll anchor at bottom of message list
  const paperRef          = useRef(null);   // scroll container — used for pagination
  const hasMoreHistory    = useRef(true);   // false when server has no older pages

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — INIT OLM + VAULT
  //
  // Runs once on mount. Goal: get a live olmAccount into memory and restore
  // the P-256 private key to sessionStorage so key-unwrapping works.
  //
  // Flow:
  //   a) olmAccount already in memory → skip (room switch, not first mount)
  //   b) Vault exists on server → download encrypted blob → decrypt with
  //      password → restores olmAccount AND writes p256_private_key to
  //      sessionStorage as a side effect inside decryptAccountFromVault()
  //   c) First ever login → create fresh Olm account + P-256 keypair →
  //      encrypt both into vault → upload vault → upload public keys
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    let mounted = true;
    (async () => {
      await initOlm(); // loads the Olm WASM binary

      if (!olmAccount) {
        const password = getPassword();

        try {
          // Check server: does this user already have a vault?
          const existsRes = await axios.get(
            `${API}/vault/${encodeURIComponent(userId)}/exists`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (existsRes.data.exists) {
            // ── RETURNING USER ──────────────────────────────────────────
            // Download the encrypted blob the server is holding.
            // The server cannot read it — it's AES-GCM encrypted with a
            // key derived from the user's password via PBKDF2.
            const vaultRes = await axios.get(
              `${API}/vault/${encodeURIComponent(userId)}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );

            // Decrypt:
            //   PBKDF2(password, salt) → AES key
            //   AES-GCM decrypt(encryptedAccount) → { olmPickle, p256PrivateKey }
            //   unpickle(olmPickle) → olmAccount  (returned)
            //   p256PrivateKey → sessionStorage   (side effect)
            olmAccount = await decryptAccountFromVault(vaultRes.data, password);
            console.log("🔓 Olm account + P-256 key restored from vault");

          } else {
            // ── FIRST LOGIN ─────────────────────────────────────────────
            // Create a brand-new Olm identity keypair.
            olmAccount = createNewAccount();

            // Create a P-256 keypair for ECDH session key wrapping.
            // This is separate from Olm — it's a standard WebCrypto keypair.
            const p256KeyPair = await generateP256KeyPair();
            const p256PrivB64 = await exportP256PrivateKey(p256KeyPair);

            // Store private key in sessionStorage.
            // encryptAccountForVault() reads it from here automatically,
            // so it gets bundled into the vault blob.
            sessionStorage.setItem("p256_private_key", p256PrivB64);

            // Encrypt { olmPickle + p256PrivateKey } with PBKDF2(password).
            // Upload to server — server stores opaque blob it cannot read.
            const vaultPayload = await encryptAccountForVault(olmAccount, password);
            await axios.post(
              `${API}/vault/${encodeURIComponent(userId)}`,
              vaultPayload,
              { headers: { Authorization: `Bearer ${token}` } }
            );

            // Upload PUBLIC keys to device_keys table.
            // These are safe to store — they reveal nothing secret.
            //   curve25519 / ed25519 — Olm identity keys
            //   p256 (public)        — used by others to wrap session keys for us
            const p256PubB64  = await exportP256PublicKey(p256KeyPair);
            const olmKeys     = getDeviceKeys(olmAccount);

            await axios.post(
              `${API}/keys/upload?userId=${encodeURIComponent(userId)}`,
              { deviceKeys: { ...olmKeys, p256: p256PubB64 } },
              { headers: { Authorization: `Bearer ${token}` } }
            );
            console.log("🆕 First login: account created, keys uploaded");
          }
        } catch (err) {
          console.error("Vault/account init failed:", err);
          // Last-resort fallback. This account has no vault so wrapping
          // won't work until the user logs out and back in.
          olmAccount = createNewAccount();
        }
      }

      if (mounted) setOlmReady(true); // unlocks the UI
    })();
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — LOAD + UNWRAP SESSION KEYS
  //
  // Called on room open and whenever the sync loop sees an unknown session_id.
  //
  // The server holds one room_session row per (room, sessionId, recipient).
  // Each row contains a wrapped Megolm session key — AES-GCM encrypted using
  // a shared secret derived via ECDH between:
  //   • the sender's ephemeral P-256 keypair  (ephemeralPublicKey in the row)
  //   • the recipient's P-256 private key     (in sessionStorage)
  //
  // The server cannot derive that shared secret — it doesn't have any P-256
  // private key. So the blobs are useless to it.
  //
  // After unwrapping, we build an Olm.InboundGroupSession from the raw key.
  // That session is then used by decryptEvent() for every message.
  // ═══════════════════════════════════════════════════════════════════════════
  const loadSessions = useCallback(async () => {
    if (!olmAccount) return;

    const res = await axios.get(
      `${API}/sessions/pending?userId=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    for (const s of res.data) {
      const { sessionId, senderUserId, roomId: sRoom } = s;

      // Already unwrapped this session in this page session — skip.
      if (inboundSessions[sessionId]) continue;

      // Guard: old rows saved before the ECDH migration won't have these fields.
      if (!s.ephemeralPublicKey || !s.keyNonce || !s.wrappedSessionKey) {
        console.warn("⚠ Session row missing ECDH fields — delete old rows and resend:", sessionId);
        continue;
      }

      try {
        // ECDH unwrap:
        //   loadP256PrivateKey() reads our private key from sessionStorage
        //   ECDH(myPrivKey, ephemeralPublicKey) → sharedAesKey
        //   AES-GCM decrypt(wrappedSessionKey, keyNonce) → rawMegolmSessionKey
        const rawSessionKey = await unwrapSessionKey(
          s.wrappedSessionKey,
          s.keyNonce,
          s.ephemeralPublicKey
        );

        // Build the inbound Megolm session.
        // From this point on, any message with this session_id can be decrypted.
        inboundSessions[sessionId] = createInboundSession(rawSessionKey);
        console.log("🔓 Session unwrapped:", sessionId);

        // If we are the original sender and the page was reloaded, try to
        // restore the outbound session so we keep the same sessionId and
        // don't force recipients to re-fetch keys on every reload.
        if (senderUserId === userId && !outboundByRoom[sRoom]) {
          try {
            const outbound = createOutboundSession();
            outbound.import_session(rawSessionKey); // not available in all Olm builds
            outboundByRoom[sRoom]   = outbound;
            outboundById[sessionId] = outbound;
          } catch {
            // import_session unavailable — a fresh outbound session will be
            // created on the next send() call and re-shared automatically.
          }
        }
      } catch (err) {
        console.warn("❌ Failed to unwrap session", sessionId, err);
      }
    }
  }, [userId, token]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — DECRYPT A SINGLE MATRIX EVENT
  //
  // Two event types arrive from Matrix:
  //
  //   m.room.message   — unencrypted (plain text or showing-event JSON).
  //                      We still handle these for backwards compatibility
  //                      and for server-generated showing events.
  //
  //   m.room.encrypted — Megolm-encrypted event. We look up the inbound
  //                      session by session_id and call session.decrypt().
  //                      Returns null if we don't have the session yet
  //                      (caller must call loadSessions() first).
  // ═══════════════════════════════════════════════════════════════════════════
  const decryptEvent = useCallback((event) => {
    if (event.type !== "m.room.encrypted" && event.type !== "m.room.message") {
      return null; // state events, receipts, etc. — ignore
    }

    if (event.type === "m.room.message") {
      const raw = event.content.body ?? "";
      try {
        const parsed = JSON.parse(raw);
        // Server-generated showing events arrive as plain JSON inside body
        if (parsed.type?.startsWith("property.showing.")) {
          return { eventId: event.event_id, sender: event.sender,
                   ts: event.origin_server_ts ?? Date.now(), ...parsed };
        }
      } catch { /* not JSON — treat as plain text */ }
      return { eventId: event.event_id, sender: event.sender,
               type: "m.text", body: raw, ts: event.origin_server_ts ?? Date.now() };
    }

    // m.room.encrypted
    const { session_id, ciphertext } = event.content;
    const session = inboundSessions[session_id];
    if (!session) return null; // session not loaded yet — sync loop will retry

    try {
      const result = session.decrypt(ciphertext);
      // result.plaintext is the JSON string we passed to encryptMessage()
      const parsed = JSON.parse(result.plaintext);
      return { eventId: event.event_id, sender: event.sender,
               ts: event.origin_server_ts ?? Date.now(), ...parsed };
    } catch {
      // Megolm ratchet has advanced past this message index (already decrypted
      // in a previous session).  Show a placeholder instead of crashing.
      return { eventId: event.event_id, sender: event.sender,
               ts: event.origin_server_ts ?? Date.now(),
               type: "m.text", body: "🔐 [Already decrypted]" };
    }
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — LOAD HISTORY (initial page of messages)
  //
  // Fetches the most recent 20 messages from your Java service, which proxies
  // GET /_matrix/client/v3/rooms/{roomId}/messages?dir=b from Matrix.
  //
  // Events come back newest-first so we reverse() before rendering.
  // Each event is passed through decryptEvent(). If the inbound session
  // isn't loaded yet, decryptEvent() returns null and the event is skipped
  // (it will reappear via the sync loop once loadSessions() has run).
  //
  // Returns the last event_id so the caller can send a read receipt.
  // ═══════════════════════════════════════════════════════════════════════════
  const loadHistory = useCallback(async (currentRoomId) => {
    const res = await axios.get(
      `${API}/rooms/${currentRoomId}/history`,
      { headers: { Authorization: `Bearer ${token}` }, params: { limit: 20 } }
    );

    const events = (res.data.chunk || []).reverse();
    const parsed = [];
    let lastEventId = null;

    for (const event of events) {
      if (!event.event_id || processedEventIds.current.has(event.event_id)) continue;
      const msg = decryptEvent(event);
      if (msg) {
        processedEventIds.current.add(event.event_id);
        parsed.push(msg);
        lastEventId = event.event_id;
      }
    }

    // res.data.end is the Matrix pagination token for the next (older) page
    setHistoryToken(res.data.end ?? null);
    if (!res.data.end || events.length < 20) hasMoreHistory.current = false;
    setMessages(parsed);
    return lastEventId;
  }, [token, decryptEvent]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4b — LOAD MORE HISTORY (scroll-up pagination)
  //
  // Triggered when the user scrolls within 80px of the top of the message
  // list (see onScroll handler in the Paper component below).
  //
  // Uses historyToken (the Matrix 'end' token from the previous page) to
  // fetch the next older page. Prepends to messages[] while preserving the
  // user's current scroll position using prevScrollHeight arithmetic.
  // ═══════════════════════════════════════════════════════════════════════════
  const loadMoreHistory = useCallback(async () => {
    if (loadingMore || !hasMoreHistory.current || !historyToken) return;
    setLoadingMore(true);
    try {
      const res = await axios.get(`${API}/rooms/${roomId}/history`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { limit: 20, from: historyToken },
      });
      const events    = (res.data.chunk || []).reverse();
      const nextToken = res.data.end ?? null;
      setHistoryToken(nextToken);
      if (!nextToken || events.length < 20) hasMoreHistory.current = false;

      const parsed = [];
      for (const event of events) {
        if (!event.event_id || processedEventIds.current.has(event.event_id)) continue;
        const msg = decryptEvent(event);
        if (msg) { processedEventIds.current.add(event.event_id); parsed.push(msg); }
      }
      if (parsed.length > 0) {
        const container  = paperRef.current;
        const prevHeight = container?.scrollHeight ?? 0;
        setMessages(prev => [...parsed, ...prev]);
        // After React re-renders the prepended messages, restore scroll
        // position so the user stays at the same visual point.
        requestAnimationFrame(() => {
          if (container) container.scrollTop = container.scrollHeight - prevHeight;
        });
      }
    } catch (err) {
      console.error("loadMoreHistory failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [roomId, token, historyToken, loadingMore, decryptEvent]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — SYNC LOOP (long-poll for real-time messages)
  //
  // Calls GET /sync which proxies Matrix's /_matrix/client/v3/sync?timeout=30000
  // Matrix holds the connection open for up to 30 seconds then returns any
  // new events. We immediately start the next poll (tail-recursive call).
  //
  // Key behaviour:
  //   • Unknown session_id detected → call loadSessions() to unwrap new keys
  //     before attempting to decrypt. This handles the case where the other
  //     user sent their first message and we haven't fetched their session yet.
  //   • processedEventIds guards against showing the same event twice (history
  //     and sync can overlap).
  //   • On error, waits 3 seconds then retries (network blip handling).
  //   • abort.cancelled flag stops the loop when the user switches rooms.
  // ═══════════════════════════════════════════════════════════════════════════
  const syncLoop = useCallback(async (since, abort, currentRoomId) => {
    if (abort.cancelled) return;
    try {
      const res = await axios.get(`${API}/sync`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { since },
      });
      if (abort.cancelled) return;

      const data   = res.data;
      const events = data.rooms?.join?.[currentRoomId]?.timeline?.events ?? [];

      // If any incoming event has a session_id we haven't unwrapped yet,
      // fetch + unwrap before trying to decrypt.
      const hasUnknown = events.some(
        e => e.type === "m.room.encrypted"
          && e.content?.session_id
          && !inboundSessions[e.content.session_id]
      );
      if (hasUnknown) await loadSessions();

      const newMsgs = [];
      for (const event of events) {
        const id = event.event_id;
        if (!id || processedEventIds.current.has(id)) continue;
        const msg = decryptEvent(event);
        if (msg) { processedEventIds.current.add(id); newMsgs.push(msg); }
      }

      if (newMsgs.length) {
        setMessages(prev => [...prev, ...newMsgs]);
        // Tell Matrix we've read up to the last event → resets notification count
        const last = events[events.length - 1];
        if (last?.event_id) sendReadReceipt(last.event_id);
      }

      // Tail-recursive: immediately start next long-poll
      syncLoop(data.next_batch, abort, currentRoomId);
    } catch {
      // Network error / timeout — retry after 3s
      if (!abort.cancelled) setTimeout(() => syncLoop(since, abort, currentRoomId), 3000);
    }
  }, [token, decryptEvent, loadSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — ROOM CHANGE EFFECT
  //
  // Fires whenever roomId changes (user clicks a different room) or when
  // olmReady becomes true (initial load).
  //
  // Steps:
  //   1. Cancel the previous room's sync loop
  //   2. Reset all per-room state
  //   3. loadSessions()  — unwrap any keys we have for this room
  //   4. loadHistory()   — show the last 20 messages
  //   5. sendReadReceipt() — reset notification badge
  //   6. syncLoop()      — start listening for new messages
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!olmReady) return;

    markRead(roomId); // clear local unread dot immediately

    // Cancel the previous sync loop
    syncAbort.current.cancelled = true;
    const abort = { cancelled: false };
    syncAbort.current = abort;

    // Reset per-room state
    processedEventIds.current.clear();
    setMessages([]);
    setHistoryToken(null);
    hasMoreHistory.current = true;
    setLoading(true);

    (async () => {
      try {
        await loadSessions();
        const lastEventId = await loadHistory(roomId);
        if (lastEventId) sendReadReceipt(lastEventId);
        // Double rAF: wait for React to paint the messages before scrolling
        // and revealing the panel (avoids flash from top to bottom)
        requestAnimationFrame(() => requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: "instant" });
          setLoading(false);
        }));
        syncLoop(null, abort, roomId);
      } catch (err) {
        console.error("Room init error:", err);
        setLoading(false);
      }
    })();

    return () => { abort.cancelled = true; }; // cleanup on next room change
  }, [roomId, olmReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — AUTO-SCROLL
  //
  // After messages state updates, scroll to the bottom — but only if the
  // user is already near the bottom (within 150px). This prevents hijacking
  // the scroll position when the user is reading old messages.
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (loading) return; // don't scroll while panel is hidden
    const container = paperRef.current;
    if (!container) return;
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (dist < 150) {
      bottomRef.current?.scrollIntoView({
        behavior: messages.length <= 20 ? "instant" : "smooth"
      });
    }
  }, [messages, loading]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — OUTBOUND SESSION MANAGEMENT
  //
  // getOrCreateOutboundSession() is called before every send.
  //
  // If outboundByRoom[roomId] exists (same room, same page session) → reuse it.
  // The same sessionId means recipients don't need to re-fetch keys.
  //
  // If not (first message in room, or page was reloaded and import_session
  // failed) → create a fresh Megolm outbound session, then:
  //
  //   1. Fetch all room members
  //   2. For each member, GET their P-256 public key from device_keys
  //   3. wrapSessionKey(rawKey, p256PubKey):
  //        Generate ephemeral P-256 keypair
  //        ECDH(ephemeralPriv, recipientP256Pub) → sharedAesKey
  //        AES-GCM encrypt(rawMegolmKey) → { wrappedKey, keyNonce, ephemeralPublicKey }
  //      Each member gets a different blob because each ECDH uses a fresh
  //      ephemeral keypair and a different recipient public key.
  //   4. POST all blobs to /share-keys in one request
  //   5. Also build our own inboundSession immediately so we can decrypt
  //      our own messages when they come back via sync.
  // ═══════════════════════════════════════════════════════════════════════════
  const getOrCreateOutboundSession = async () => {
    if (outboundByRoom[roomId]) return outboundByRoom[roomId];

    const session    = createOutboundSession();
    const sessionId  = session.session_id();
    const sessionKey = session.session_key(); // raw Megolm key — wrap before sending

    outboundByRoom[roomId]   = session;
    outboundById[sessionId]  = session;
    inboundSessions[sessionId] = createInboundSession(sessionKey); // self-decrypt

    // Fetch room members
    let members = [];
    try {
      const res = await axios.get(
        `${API}/rooms/${roomId}/members`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      members = Array.isArray(res.data)
        ? res.data
        : (res.data.chunk ?? []).map(e => e.state_key ?? e);
    } catch (err) {
      console.error("Failed to fetch room members:", err);
    }
    if (!members.includes(userId)) members.push(userId); // always include self

    // Wrap session key per-recipient
    const recipients = {};
    for (const memberId of members) {
      try {
        const keysRes = await axios.get(
          `${API}/keys/${encodeURIComponent(memberId)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const p256Key = keysRes.data?.[0]?.p256Key;
        if (!p256Key) {
          console.warn(`No P-256 key for ${memberId} — skipping`);
          continue;
        }
        recipients[memberId] = await wrapSessionKey(sessionKey, p256Key);
      } catch (err) {
        console.warn("Key wrap failed for", memberId, err);
      }
    }

    // Upload all wrapped keys to server in one call
    await axios.post(
      `${API}/rooms/${roomId}/share-keys?senderUserId=${encodeURIComponent(userId)}`,
      { sessionId, recipients },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return session;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 8b — READ RECEIPT
  //
  // Tells the Matrix server this user has read up to eventId.
  // The server then sets unread_notifications.notification_count = 0 for
  // this room in all subsequent sync responses.
  // ═══════════════════════════════════════════════════════════════════════════
  const sendReadReceipt = async (eventId) => {
    if (!eventId) return;
    try {
      await axios.post(
        `${API}/rooms/${roomId}/receipt`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, params: { eventId } }
      );
    } catch (err) {
      console.error("Read receipt failed:", err);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 9 — SEND TEXT MESSAGE
  //
  // 1. getOrCreateOutboundSession() — ensures we have a Megolm outbound
  //    session and that all room members have received the wrapped key.
  // 2. encryptMessage(session, JSON) — Megolm encrypts the plaintext.
  //    Megolm is a ratchet: each message advances the ratchet so older
  //    messages cannot be decrypted with a key captured later (forward secrecy).
  // 3. POST /rooms/{roomId}/message — your Java service proxies
  //    PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.encrypted/{txnId}
  //    to Synapse. Synapse stores only the ciphertext.
  //
  // No optimistic render — the message appears when it comes back via sync,
  // which is the single source of truth.  On failure the input is restored.
  // ═══════════════════════════════════════════════════════════════════════════
  const sendMessage = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");

    try {
      const session    = await getOrCreateOutboundSession();
      const ciphertext = encryptMessage(session, JSON.stringify({ type: "m.text", body: text }));
      await axios.post(
        `${API}/rooms/${roomId}/message`,
        { encrypted: true, senderUserId: userId, sessionId: session.session_id(), ciphertext },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) {
      console.error("Send failed:", err);
      setInput(text); // restore so user can retry
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 10 — SHOWING ACTIONS (property tour requests)
  //
  // These are structured events (REQUESTED / ACCEPTED / DECLINED / RESCHEDULED)
  // sent to a backend endpoint that builds the event server-side and forwards
  // it to Matrix as a plain m.room.message with a JSON body.
  // decryptEvent() recognises them by parsed.type.startsWith("property.showing.")
  // and routes them to <ShowingEventCard> for rendering.
  // ═══════════════════════════════════════════════════════════════════════════
  const sendShowingAction = async (actionType, showingPayload, proposedTimeIso = null) => {
    try {
      await axios.post(
        `${API}/rooms/${roomId}/showing-event`,
        {
          actionType,
          actorUserId:  userId,
          propertyId:   showingPayload?.propertyId,
          address:      showingPayload?.address,
          agentUserId:  showingPayload?.agentUserId,
          buyerUserId:  showingPayload?.buyerUserId,
          proposedTime: proposedTimeIso ? new Date(proposedTimeIso).getTime() : null,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) {
      console.error("Showing action failed:", err);
    }
  };

  const sendShowingRequest = async () => {
    await sendShowingAction("REQUESTED", {
      propertyId: "PROP123", address: "221B Baker Street",
      agentUserId: userId, buyerUserId: null,
    });
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // UI
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <Box p={2} display="flex" flexDirection="column" height="100%">
      <Typography variant="h6">🔐 Room {roomId}</Typography>

      {/* Full-area spinner while history is loading — hides the paper entirely
          so the user never sees a flash of content scrolling from top to bottom */}
      {loading && (
        <Box sx={{ flex: 1, display: "flex", alignItems: "center",
                   justifyContent: "center", mt: 2, mb: 2 }}>
          <CircularProgress size={32} />
        </Box>
      )}

      {/* Message list — scroll container */}
      <Paper
        ref={paperRef}
        sx={{ flex: 1, p: 2, mt: 2, mb: 2,
              overflow:   loading ? "hidden" : "auto",
              visibility: loading ? "hidden" : "visible" }}
        onScroll={e => {
          // User scrolled near the top → load the previous page of history
          if (e.currentTarget.scrollTop < 80 && !loadingMore && hasMoreHistory.current) {
            loadMoreHistory();
          }
        }}
      >
        {/* Spinner at top while older messages are loading */}
        {loadingMore && (
          <Box display="flex" justifyContent="center" pb={1}>
            <CircularProgress size={18} />
          </Box>
        )}

        {/* Shown when there are no more older pages */}
        {!hasMoreHistory.current && !loading && (
          <Typography variant="caption" color="text.secondary"
                      display="block" textAlign="center" pb={1}>
            — beginning of conversation —
          </Typography>
        )}

        {/* Empty state */}
        {!loading && messages.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No messages yet. Start the conversation 👋
          </Typography>
        )}

        {messages.map((msg, i) => {
          // Showing events get a specialised card with action buttons
          if (msg.type?.startsWith("property.showing.")) {
            const latestByProperty = {};
            messages.forEach(m => {
              if (m.type?.startsWith("property.showing.") && m.payload?.propertyId) {
                latestByProperty[m.payload.propertyId] = m.eventId;
              }
            });
            return (
              <ShowingEventCard
                key={msg.eventId ?? i}
                msg={msg}
                currentUserId={userId}
                // Only the most recent card for each property shows action buttons
                isLatest={latestByProperty[msg.payload?.propertyId] === msg.eventId}
                onAction={(action, payload, iso) => sendShowingAction(action, payload, iso)}
              />
            );
          }

          // Regular text message bubble
          const isMine = msg.sender === userId;
          return (
            <Box key={msg.eventId ?? i} mb={1} display="flex"
                 justifyContent={isMine ? "flex-end" : "flex-start"}>
              <Box sx={{
                maxWidth: "70%", borderRadius: 2, px: 1.5, py: 0.75,
                bgcolor: isMine ? "primary.main" : "grey.200",
                color:   isMine ? "white" : "text.primary",
              }}>
                {/* Only show sender name for messages from others */}
                {!isMine && (
                  <Typography variant="caption" display="block" sx={{ opacity: 0.7 }}>
                    {msg.sender}
                  </Typography>
                )}
                <Typography variant="body2">{msg.body}</Typography>
              </Box>
            </Box>
          );
        })}

        {/* Invisible anchor — scrollIntoView() targets this */}
        <div ref={bottomRef} />
      </Paper>

      <Button variant="outlined" onClick={sendShowingRequest}
              sx={{ mb: 1 }} disabled={!olmReady}>
        🏠 Send Showing Request
      </Button>

      <TextField fullWidth placeholder="Type a message…"
        value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
        disabled={!olmReady}
      />
    </Box>
  );
}