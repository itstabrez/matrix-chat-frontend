import { useEffect, useRef } from "react";
import axios from "axios";
import { useUnread } from "./UnreadContext";

const API = "http://localhost:8080/api/matrix";

/**
 * Uses Matrix's built-in unread_notifications counts from the sync response.
 * More reliable than manual counting — server tracks it, works after offline.
 *
 * unread_notifications.notification_count = all unread messages
 * unread_notifications.highlight_count    = mentions / keywords (if you want a different colour later)
 */
export function useGlobalSync(activeRoomId) {

  const token            = localStorage.getItem("token");
  const { setRoomCount } = useUnread();

  const activeRoomRef = useRef(activeRoomId);
  useEffect(() => { activeRoomRef.current = activeRoomId; }, [activeRoomId]);

  const abortRef = useRef({ cancelled: false });

  useEffect(() => {
    if (!token) return;

    abortRef.current.cancelled = false;
    const abort = abortRef.current;

    const loop = async (since) => {
      if (abort.cancelled) return;

      try {
        const res = await axios.get(`${API}/sync`, {
          headers: { Authorization: `Bearer ${token}` },
          params:  { since },
        });

        if (abort.cancelled) return;

        const data  = res.data;
        const rooms = data.rooms?.join ?? {};

        Object.entries(rooms).forEach(([roomId, roomData]) => {
          const count = roomData.unread_notifications?.notification_count ?? 0;

          // For the active room, always treat as 0 — user is looking at it
          setRoomCount(roomId, roomId === activeRoomRef.current ? 0 : count);
        });

        loop(data.next_batch);

      } catch {
        if (!abort.cancelled) {
          setTimeout(() => loop(since), 3000);
        }
      }
    };

    loop(null);

    return () => { abort.cancelled = true; };
  }, [token]);
}