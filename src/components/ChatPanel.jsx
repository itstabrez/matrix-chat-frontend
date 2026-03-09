import { useEffect, useRef, useState, useCallback } from "react";
import { Box, Typography, TextField, Paper, Button, CircularProgress } from "@mui/material";
import axios from "axios";
import { useUnread } from "./UnreadContext";
import ShowingEventCard from "./ShowingEventCard";

import {
  initOlm,
  createOrLoadAccount,
  getDeviceKeys,
  generateOneTimeKeys,
  createOutboundSession,
  encryptMessage,
  createInboundSession
} from "../utils/matrixCrypto.js";

const API = "http://localhost:8080/api/matrix";

// Module-level — survive React re-renders, cleared on full page reload
const inboundSessions = {};   // sessionId  → Olm.InboundGroupSession
const outboundByRoom  = {};   // roomId     → Olm.OutboundGroupSession
const outboundById    = {};   // sessionId  → Olm.OutboundGroupSession

export default function ChatPanel({ roomId }) {

  const token  = localStorage.getItem("token");
  const userId = localStorage.getItem("userId");
  const { markRead } = useUnread();

  const [messages, setMessages] = useState([]);
  const [input,    setInput]    = useState("");
  const [olmReady, setOlmReady] = useState(false);
  const [loading,  setLoading]  = useState(true);

  const processedEventIds = useRef(new Set());
  const syncAbort         = useRef({ cancelled: false });
  const bottomRef         = useRef(null);
  const paperRef          = useRef(null);   // scroll container ref for pagination

  const [historyToken,  setHistoryToken]  = useState(null);  // Matrix 'end' token for older pages
  const [loadingMore,   setLoadingMore]   = useState(false);
  const hasMoreHistory  = useRef(true);   // false once server returns no more events

  /* ─────────────────────────────────────────
     1.  INIT OLM  (once on mount)
  ───────────────────────────────────────── */
  useEffect(() => {
    let mounted = true;
    (async () => {
      await initOlm();
      const account     = createOrLoadAccount();
      const deviceKeys  = getDeviceKeys(account);
      const oneTimeKeys = generateOneTimeKeys(account);

      await axios.post(
        `${API}/keys/upload?userId=${encodeURIComponent(userId)}`,
        { deviceKeys, oneTimeKeys },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (mounted) setOlmReady(true);
    })();
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─────────────────────────────────────────
     2.  LOAD SESSION KEYS FROM SERVER
         Safe to call multiple times — only
         creates a new session object if one
         doesn't already exist for that id.
  ───────────────────────────────────────── */
  const loadSessions = useCallback(async () => {
    const res = await axios.get(
      `${API}/sessions/pending?userId=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    for (const s of res.data) {
      const { sessionId, sessionKey, roomId: sRoom, senderUserId } = s;

      // Always build an inbound session — both sender and recipient need this
      if (!inboundSessions[sessionId]) {
        inboundSessions[sessionId] = createInboundSession(sessionKey);
      }

      // FIX — Reload session reuse: restore the outbound session from DB so
      // we keep using the same sessionId instead of creating a new one on
      // every page reload and forcing recipients to re-fetch keys.
      if (senderUserId === userId && !outboundByRoom[sRoom]) {
        try {
          const outbound = createOutboundSession();
          outbound.import_session(sessionKey);
          outboundByRoom[sRoom]   = outbound;
          outboundById[sessionId] = outbound;
        } catch {
          // import_session not available in this OLM build — a fresh session
          // will be created on next send and shared automatically.
        }
      }
    }
  }, [userId, token]);

  /* ─────────────────────────────────────────
     3.  DECRYPT A SINGLE EVENT
  ───────────────────────────────────────── */
  const decryptEvent = useCallback((event) => {
    if (event.type !== "m.room.encrypted" && event.type !== "m.room.message") {
      return null;
    }

    if (event.type === "m.room.message") {
      const raw = event.content.body ?? "";
      try {
        const parsed = JSON.parse(raw);
        // Server-sent showing status event (accepted / declined / rescheduled)
        if (parsed.type?.startsWith("property.showing.")) {
          return {
            eventId: event.event_id,
            sender:  event.sender,
            ts:      event.origin_server_ts ?? Date.now(),
            ...parsed,
          };
        }
      } catch { /* not JSON — fall through to plain text */ }
      return {
        eventId: event.event_id,
        sender:  event.sender,
        type:    "m.text",
        body:    raw,
        ts:      event.origin_server_ts ?? Date.now(),
      };
    }

    const { session_id, ciphertext } = event.content;
    const session = inboundSessions[session_id];

    if (!session) return null; // caller must loadSessions first

    try {
      const result = session.decrypt(ciphertext);
      const parsed = JSON.parse(result.plaintext);
      return {
        eventId: event.event_id,
        sender:  event.sender,
        ts:      event.origin_server_ts ?? Date.now(),
        ...parsed,
      };
    } catch {
      return {
        eventId: event.event_id,
        sender:  event.sender,
        ts:      event.origin_server_ts ?? Date.now(),
        type:    "m.text",
        body:    "🔐 [Already decrypted]",
      };
    }
  }, []);

  /* ─────────────────────────────────────────
     4.  LOAD HISTORY
  ───────────────────────────────────────── */
  const loadHistory = useCallback(async (currentRoomId) => {
    const res = await axios.get(
      `${API}/rooms/${currentRoomId}/history`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params:  { limit: 20 },
      }
    );

    const events = (res.data.chunk || []).reverse();

    const parsed = [];
    let lastEventId = null;

    for (const event of events) {
      if (!event.event_id) continue;
      if (processedEventIds.current.has(event.event_id)) continue;
      const msg = decryptEvent(event);
      if (msg) {
        processedEventIds.current.add(event.event_id);
        parsed.push(msg);
        lastEventId = event.event_id;
      }
    }

    const pageToken = res.data.end ?? null;
    setHistoryToken(pageToken);
    if (!pageToken || events.length < 20) hasMoreHistory.current = false;

    setMessages(parsed);
    return lastEventId; // caller sends read receipt with this
  }, [token, decryptEvent]);

  /* ─────────────────────────────────────────
     4b. LOAD MORE HISTORY  (pagination)
         Triggered when user scrolls to top.
         Prepends older messages without
         disturbing the current scroll position.
  ───────────────────────────────────────── */
  const loadMoreHistory = useCallback(async () => {
    if (loadingMore || !hasMoreHistory.current || !historyToken) return;

    setLoadingMore(true);

    try {
      const res = await axios.get(
        `${API}/rooms/${roomId}/history`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params:  { limit: 20, from: historyToken },
        }
      );

      const events = (res.data.chunk || []).reverse();
      const nextToken = res.data.end ?? null;

      setHistoryToken(nextToken);
      if (!nextToken || events.length < 20) hasMoreHistory.current = false;

      const parsed = [];
      for (const event of events) {
        if (!event.event_id) continue;
        if (processedEventIds.current.has(event.event_id)) continue;
        const msg = decryptEvent(event);
        if (msg) {
          processedEventIds.current.add(event.event_id);
          parsed.push(msg);
        }
      }

      if (parsed.length > 0) {
        // Preserve scroll position — measure before prepend, restore after
        const container = paperRef.current;
        const prevScrollHeight = container?.scrollHeight ?? 0;

        setMessages(prev => [...parsed, ...prev]);

        // After React renders the new messages, restore the scroll offset
        requestAnimationFrame(() => {
          if (container) {
            container.scrollTop = container.scrollHeight - prevScrollHeight;
          }
        });
      }
    } catch (err) {
      console.error("Load more history failed", err);
    } finally {
      setLoadingMore(false);
    }
  }, [roomId, token, historyToken, loadingMore, decryptEvent]);

  /* ─────────────────────────────────────────
     5.  SYNC LOOP  (long-poll)
  ───────────────────────────────────────── */
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

      // ── KEY FIX: detect unknown session_ids ───────────────────────────
      // The other user may have reloaded (creating a new outbound session)
      // or joined fresh.  Their share-keys call saved a new row for us in
      // room_session.  We detect this by checking if any encrypted event
      // carries a session_id we have no inbound session for, then fetch.
      const hasUnknownSession = events.some(
        e => e.type === "m.room.encrypted"
          && e.content?.session_id
          && !inboundSessions[e.content.session_id]
      );

      if (hasUnknownSession) {
        await loadSessions();
      }

      const newMessages = [];
      for (const event of events) {
        const id = event.event_id;
        if (!id || processedEventIds.current.has(id)) continue;
        const msg = decryptEvent(event);
        if (msg) {
          processedEventIds.current.add(id);
          newMessages.push(msg);
        }
      }

      if (newMessages.length) {
        setMessages(prev => [...prev, ...newMessages]);
        // Mark last received event as read so server resets notification_count
        const lastEvent = events[events.length - 1];
        if (lastEvent?.event_id) {
          sendReadReceipt(lastEvent.event_id);
        }
      }

      syncLoop(data.next_batch, abort, currentRoomId);

    } catch {
      if (!abort.cancelled) {
        setTimeout(() => syncLoop(since, abort, currentRoomId), 3000);
      }
    }
  }, [token, decryptEvent, loadSessions]);

  /* ─────────────────────────────────────────
     6.  ROOM CHANGE EFFECT
  ───────────────────────────────────────── */
  useEffect(() => {
    if (!olmReady) return;

    markRead(roomId);   // clear unread dot as soon as room is opened

    syncAbort.current.cancelled = true;
    const abort = { cancelled: false };
    syncAbort.current = abort;

    processedEventIds.current.clear();
    setMessages([]);
    setHistoryToken(null);
    hasMoreHistory.current = true;
    setLoading(true);

    (async () => {
      try {
        await loadSessions();
        const lastEventId = await loadHistory(roomId);
        // Send read receipt so Matrix server resets notification_count
        if (lastEventId) sendReadReceipt(lastEventId);
        // Scroll to bottom instantly before revealing messages so user never
        // sees the content flash from top → bottom
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            bottomRef.current?.scrollIntoView({ behavior: "instant" });
            setLoading(false);
          });
        });
        syncLoop(null, abort, roomId);
      } catch (err) {
        console.error("Room init error", err);
        setLoading(false);
      }
    })();

    return () => { abort.cancelled = true; };
  }, [roomId, olmReady]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─────────────────────────────────────────
     7.  AUTO-SCROLL
         On initial load  → instant jump (no animation, so user never sees top)
         On new messages  → smooth scroll (only when already near bottom)
  ───────────────────────────────────────── */
  useEffect(() => {
    if (loading) return; // don't scroll while hidden — wait for reveal

    const container = paperRef.current;
    if (!container) return;

    const distFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    // If within 150px of bottom (or just loaded), scroll to bottom.
    // This prevents hijacking scroll when user is reading old messages.
    if (distFromBottom < 150) {
      bottomRef.current?.scrollIntoView({ behavior: messages.length <= 20 ? "instant" : "smooth" });
    }
  }, [messages, loading]);

  /* ─────────────────────────────────────────
     8.  SESSION MANAGEMENT
  ───────────────────────────────────────── */
  const getOrCreateOutboundSession = async () => {
    if (outboundByRoom[roomId]) return outboundByRoom[roomId];

    const session    = createOutboundSession();
    const sessionId  = session.session_id();
    const sessionKey = session.session_key();

    outboundByRoom[roomId]   = session;
    outboundById[sessionId]  = session;
    inboundSessions[sessionId] = createInboundSession(sessionKey);

    await axios.post(
      `${API}/rooms/${roomId}/share-keys?senderUserId=${encodeURIComponent(userId)}`,
      { sessionId, sessionKey },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return session;
  };
  /* ─────────────────────────────────────────
       8b. SEND READ RECEIPT
           Tells Matrix server this user has read
           up to this eventId — server resets
           notification_count to 0 for this room
           in all subsequent sync responses.
    ───────────────────────────────────────── */
  const sendReadReceipt = async (eventId) => {
    if (!eventId) return;
    try {
      await axios.post(
        `${API}/rooms/${roomId}/receipt`,
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { eventId },   // passed as ?eventId=... avoids path encoding issues
        }
      );
    } catch (err) {
      console.error("Read receipt failed", err);
    }
  };

  /* ─────────────────────────────────────────
     9.  SEND TEXT MESSAGE
         FIX: No optimistic render.
         Sync is the single source of truth.
         The sender's own event comes back via
         the sync loop and is decrypted normally
         via inboundSessions — no echo possible.
         On failure the input text is restored.
  ───────────────────────────────────────── */
  const sendMessage = async () => {
    const text = input.trim();
    if (!text) return;

    setInput("");

    const session    = await getOrCreateOutboundSession();
    const payload    = { type: "m.text", body: text };
    const ciphertext = encryptMessage(session, JSON.stringify(payload));

    try {
      await axios.post(
        `${API}/rooms/${roomId}/message`,
        {
          encrypted:    true,
          senderUserId: userId,
          sessionId:    session.session_id(),
          ciphertext,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) {
      console.error("Send failed", err);
      setInput(text); // restore so user can retry
    }
  };

  /* ─────────────────────────────────────────
     10. SHOWING ACTION  (accept/decline/reschedule)
         Calls the backend endpoint which builds
         the encrypted message server-side and
         sends it to the Matrix room.  The message
         arrives back via the sync loop for all
         clients including the sender.
  ───────────────────────────────────────── */
  // actionType: REQUESTED | ACCEPTED | DECLINED | RESCHEDULED
  // proposedTime: ISO datetime string from the reschedule picker (converted to epoch ms)
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
      console.error("Showing action failed", err);
    }
  };

  /* ─────────────────────────────────────────
     11. SEND SHOWING REQUEST
         Uses showing-event endpoint so it is
         stored in chat_events and rendered via
         ShowingEventCard with action buttons.
  ───────────────────────────────────────── */
  const sendShowingRequest = async () => {
    await sendShowingAction("REQUESTED", {
      propertyId:  "PROP123",
      address:     "221B Baker Street",
      agentUserId: userId,
      buyerUserId: null,
    });
  };

  /* ─────────────────────────────────────────
     UI
  ───────────────────────────────────────── */
  return (
    <Box p={2} display="flex" flexDirection="column" height="100%">
      <Typography variant="h6">🔐 Room {roomId}</Typography>

      {/* Full-area loader shown while history is fetching — overlays the Paper */}
      {loading && (
        <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", mt: 2, mb: 2 }}>
          <CircularProgress size={32} />
        </Box>
      )}

      <Paper
        ref={paperRef}
        sx={{ flex: 1, p: 2, mt: 2, mb: 2, overflow: loading ? "hidden" : "auto", visibility: loading ? "hidden" : "visible" }}
        onScroll={e => {
          if (e.currentTarget.scrollTop < 80 && !loadingMore && hasMoreHistory.current) {
            loadMoreHistory();
          }
        }}
      >

        {loadingMore && (
          <Box display="flex" justifyContent="center" pb={1}>
            <CircularProgress size={18} />
          </Box>
        )}

        {!hasMoreHistory.current && !loading && (
          <Typography variant="caption" color="text.secondary" display="block" textAlign="center" pb={1}>
            — beginning of conversation —
          </Typography>
        )}

        {!loading && messages.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No messages yet. Start the conversation 👋
          </Typography>
        )}

        {messages.map((msg, i) => {


          // ── All showing event types → unified ShowingEventCard ──────────
          if (msg.type?.startsWith("property.showing.")) {
            // Build a map of propertyId → latest eventId so only the most
            // recent card for each property shows action buttons.
            // Computed inline here — messages array is already in order.
            const latestEventIdByProperty = {};
            messages.forEach(m => {
              if (m.type?.startsWith("property.showing.") && m.payload?.propertyId) {
                latestEventIdByProperty[m.payload.propertyId] = m.eventId;
              }
            });
            const isLatest = latestEventIdByProperty[msg.payload?.propertyId] === msg.eventId;

            return (
              <ShowingEventCard
                key={msg.eventId ?? i}
                msg={msg}
                currentUserId={userId}
                isLatest={isLatest}
                onAction={(action, payload, proposedTimeIso) =>
                  sendShowingAction(action, payload, proposedTimeIso)}
              />
            );
          }


          const isMine = msg.sender === userId;
          return (
            <Box
              key={msg.eventId ?? i}
              mb={1}
              display="flex"
              justifyContent={isMine ? "flex-end" : "flex-start"}
            >
              <Box
                sx={{
                  maxWidth:     "70%",
                  bgcolor:      isMine ? "primary.main" : "grey.200",
                  color:        isMine ? "white" : "text.primary",
                  borderRadius: 2,
                  px: 1.5,
                  py: 0.75,
                }}
              >
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

        <div ref={bottomRef} />
      </Paper>

      <Button
        variant="outlined"
        onClick={sendShowingRequest}
        sx={{ mb: 1 }}
        disabled={!olmReady}
      >
        🏠 Send Showing Request
      </Button>

      <TextField
        fullWidth
        placeholder="Type a message…"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
        disabled={!olmReady}
      />
    </Box>
  );
}