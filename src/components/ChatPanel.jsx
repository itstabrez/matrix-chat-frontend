import { useEffect, useRef, useState } from "react";
import { Box, Typography, TextField, Paper, Button } from "@mui/material";
import axios from "axios";
import {
  initOlm,
  createOrLoadAccount,
  getDeviceKeys,
  generateOneTimeKeys,
  createOutboundSession,
  encryptMessage,
  createInboundSession,
} from "../utils/matrixCrypto.js";

const megolmOutboundSessions = {};
const megolmInboundSessions = {};

export default function ChatPanel({ roomId }) {
  const token = localStorage.getItem("token");
  const userId = localStorage.getItem("userId");

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [olmInitialized, setOlmInitialized] = useState(false);
  const bottomRef = useRef(null);
  const syncingRef = useRef(false); // prevent double sync loops
  const processedEvents = useRef(new Set());
  const activeRoomRef = useRef(roomId);   // ← add this
  const [historyToken, setHistoryToken] = useState(null);
  // ── Step 1: Init Olm + upload device keys (runs once) ───────────────────────
  useEffect(() => {
    (async () => {
      try {
        await initOlm();

        const acc = createOrLoadAccount();
        const deviceKeys = getDeviceKeys(acc);
        const oneTimeKeys = generateOneTimeKeys(acc);

        // Upload keys — userId passed as query param to match @RequestParam
        await axios.post(
          `http://localhost:8080/api/matrix/keys/upload?userId=${encodeURIComponent(userId)}`,
          { deviceKeys, oneTimeKeys },
          { headers: { Authorization: `Bearer ${token}` } }
        );

        console.log("✅ Olm initialized & keys uploaded");
        setOlmInitialized(true);
      } catch (err) {
        console.error("❌ Olm init failed:", err);
      }
    })();
  }, []); // runs once on mount

  const sendShowingRequest = async () => {

    if (!olmInitialized) return;

    const nowEpoch = Date.now(); // milliseconds epoch

    const showingPayload = {
      type: "property.showing.request",
      payload: {
        requestId: "REQ_" + nowEpoch,
        propertyId: "PROP_123",
        address: "221B Baker Street",
        showingTime: nowEpoch + (60 * 60 * 1000) // 1 hour later
      },
      metadata: {
        createdAt: nowEpoch
      },
      ui: {
        actions: ["accept", "decline"]
      }
    };

    try {

      const session = await getOrCreateOutboundSession();

      const plaintext = JSON.stringify(showingPayload);

      const ciphertext = encryptMessage(session, plaintext);

      // Show locally
      setMessages(prev => [
        ...prev,
        {
          sender: userId,
          ...showingPayload
        }
      ]);

      await axios.post(
        `http://localhost:8080/api/matrix/rooms/${roomId}/message`,
        {
          encrypted: true,
          senderUserId: userId,
          sessionId: session.session_id(),
          ciphertext
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

    } catch (err) {
      console.error("Showing request failed", err);
    }
  };

  // ── Step 2: Load pending inbound sessions from backend ───────────────────────
  // So receiver can decrypt messages sent before they synced
  useEffect(() => {
    if (!olmInitialized || !userId) return;

    (async () => {
      try {
        const res = await axios.get(
          `http://localhost:8080/api/matrix/sessions/pending?userId=${encodeURIComponent(userId)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        res.data.forEach((session) => {
          if (!megolmInboundSessions[session.sessionId]) {
            megolmInboundSessions[session.sessionId] = createInboundSession(session.sessionKey);
            console.log("📬 Loaded inbound session:", session.sessionId);
          }
        });
      } catch (err) {
        console.error("❌ Failed to load pending sessions:", err);
      }
    })();
  }, [olmInitialized]);

  // ── Step 3: Start sync loop only after Olm is ready ─────────────────────────
  useEffect(() => {
    if (!olmInitialized) return;

    activeRoomRef.current = roomId;      // ← add this
    syncingRef.current = false;
    processedEvents.current = new Set();
    setMessages([]);
    loadChatHistory();   // ← load history first

    syncMessages(null);  // ← then start live sync
    return () => {
      syncingRef.current = true;
    };
  }, [roomId, olmInitialized]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const formatEpoch = (epoch) => {

    if (!epoch) return "";

    const date = new Date(epoch);

    return date.toLocaleString();
  };

  // ── Long poll sync ───────────────────────────────────────────────────────────
  const syncMessages = async (sinceToken) => {
    if (syncingRef.current) return;

    try {
      const res = await axios.get("http://localhost:8080/api/matrix/sync", {
        headers: { Authorization: `Bearer ${token}` },
        params: { since: sinceToken },
      });

      if (syncingRef.current) return; // room changed while waiting

      const data = res.data;
      const nextBatch = data.next_batch;

      const roomEvents = data.rooms?.join?.[activeRoomRef.current]?.timeline?.events || [];

      const newMessages = [];

      for (const event of roomEvents) {
        if (event.type !== "m.room.encrypted" && event.type !== "m.room.message") continue;

        // ✅ Deduplicate by event_id
        const eventId = event.event_id;
        if (eventId && processedEvents.current.has(eventId)) continue;
        if (eventId) processedEvents.current.add(eventId);

        // ✅ Skip own messages — already shown locally on send
        if (event.sender === userId) continue;

        if (event.type === "m.room.encrypted") {
          const { session_id, ciphertext, decrypted_body } = event.content;

          // Use backend-decrypted body if injected
          // if (decrypted_body) {
          //   newMessages.push({ sender: event.sender, body: decrypted_body });
          //   continue;
          // }
          console.log("Known sessions:", Object.keys(megolmInboundSessions));
          console.log("Incoming session:", session_id);
          // Fallback: local inbound session
          const session = megolmInboundSessions[session_id];
          console.log("Session lookup for", session)
          if (!session) {
            newMessages.push({ sender: event.sender, body: "🔐 [Encrypted — no session key]" });
            continue;
          }

          try {

            const result = session.decrypt(ciphertext);

            const parsed = JSON.parse(result.plaintext);

            newMessages.push({
              sender: event.sender,
              type: parsed.type,
              payload: parsed.payload,
              metadata: parsed.metadata,
              ui: parsed.ui
            });

          } catch {
            newMessages.push({
              sender: event.sender,
              body: "⚠️ [Decryption failed]"
            });
          }

        } else {
          newMessages.push({ sender: event.sender, body: event.content.body });
        }
      }

      if (newMessages.length > 0) {
        setMessages((prev) => [...prev, ...newMessages]);
      }

      if (!syncingRef.current) {
        syncMessages(nextBatch || sinceToken);
      }

    } catch (err) {
      console.error("Sync error", err);
      if (!syncingRef.current) {
        setTimeout(() => syncMessages(sinceToken), 3000);
      }
    }
  };

  // ── Get or create outbound Megolm session ────────────────────────────────────
  const getOrCreateOutboundSession = async () => {
    if (megolmOutboundSessions[roomId]) {
      return megolmOutboundSessions[roomId];
    }

    const session = createOutboundSession();
    megolmOutboundSessions[roomId] = session;

    // ✅ DO NOT create inbound session here — causes BAD_SIGNATURE
    // Sender reads their own messages from localSentMessages instead

    await axios.post(
      `http://localhost:8080/api/matrix/rooms/${roomId}/share-keys?senderUserId=${encodeURIComponent(userId)}`,
      { sessionId: session.session_id(), sessionKey: session.session_key() },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("🔑 Session key shared for room:", roomId);
    return session;
  };

  // ── Send message ─────────────────────────────────────────────────────────────
  const sendMessage = async () => {
    if (!input.trim() || !olmInitialized) return;

    const currentInput = input;  // capture before clearing
    setInput("");                // clear immediately for UX

    try {
      const session = await getOrCreateOutboundSession();
      const plaintext = JSON.stringify({ type: "m.text", body: currentInput });
      const ciphertext = encryptMessage(session, plaintext);

      // ✅ Add own message to UI immediately — no need to decrypt later
      const eventId = `local_${Date.now()}`;
      processedEvents.current.add(eventId);  // mark as processed so sync skips it
      setMessages((prev) => [...prev, { sender: userId, body: currentInput }]);

      await axios.post(
        `http://localhost:8080/api/matrix/rooms/${roomId}/message`,
        {
          encrypted: true,
          senderUserId: userId,
          message: currentInput,
          sessionId: session.session_id(),
          ciphertext,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

    } catch (err) {
      console.error("❌ Send failed:", err);
    }
  };

  const loadChatHistory = async () => {

    try {

      const res = await axios.get(
        `http://localhost:8080/api/matrix/rooms/${roomId}/history`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { limit: 20 }
        }
      );
      setHistoryToken(res.data.end);
      const events = res.data.chunk || [];

      const historyMessages = [];

      for (const event of events) {

        if (event.type !== "m.room.encrypted") continue;

        const { session_id, ciphertext } = event.content;

        let session = megolmInboundSessions[session_id];

        if (!session && event.sender === userId) {
          session = megolmOutboundSessions[roomId];
        }

        if (!session) {
          historyMessages.push({
            sender: event.sender,
            body: "🔐 [Encrypted — session not available]"
          });
          continue;
        }

        try {

          const result = session.decrypt(ciphertext);

          const parsed = JSON.parse(result.plaintext);

          historyMessages.push({
            sender: event.sender,
            ...parsed
          });

        } catch {
          console.warn("History decryption failed");
        }
      }
      // reverse because Matrix returns newest first
      setMessages(historyMessages.reverse());

    } catch (err) {
      console.error("History fetch failed", err);
    }

  };

  return (
    <Box p={2} display="flex" flexDirection="column" height="100%">
      <Typography variant="h6">
        🔐 Room: {roomId}
        {!olmInitialized && (
          <Typography component="span" variant="caption" color="warning.main" ml={1}>
            (initializing encryption...)
          </Typography>
        )}
      </Typography>

      <Box flex={1} overflow="auto" mt={2} mb={2} component={Paper} sx={{ p: 2 }}>
        {messages.map((msg, index) => {

          if (msg.type === "property.showing.request") {

            return (
              <Paper key={index} sx={{ p: 2, mb: 1, background: "#f5f5f5" }}>

                <Typography>
                  🏠 Showing Request
                </Typography>

                <Typography>
                  Property: {msg.payload?.address}
                </Typography>

                <Typography>
                  Showing Time: {formatEpoch(msg.payload?.showingTime)}
                </Typography>

                <Typography variant="caption">
                  Requested At: {formatEpoch(msg.metadata?.createdAt)}
                </Typography>

                <Box mt={1}>
                  <Button size="small" variant="contained">
                    Accept
                  </Button>

                  <Button size="small" color="error" sx={{ ml: 1 }}>
                    Decline
                  </Button>
                </Box>

              </Paper>
            );
          }

          return (
            <Box key={index} mb={1}>
              <strong>{msg.sender}</strong>: {msg.body}
            </Box>
          );

        })}
        <div ref={bottomRef} />
      </Box>
      <Button onClick={sendShowingRequest} disabled={!olmInitialized} variant="outlined" sx={{ mb: 1 }}>
        Request Showing
      </Button>
      <TextField
        fullWidth
        disabled={!olmInitialized}
        placeholder={olmInitialized ? "Type message and press Enter... (E2E Encrypted 🔐)" : "Initializing encryption..."}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") sendMessage(); }}
      />
    </Box>
  );
}