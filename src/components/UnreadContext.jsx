import { createContext, useContext, useState, useCallback } from "react";

const UnreadContext = createContext({
  unreadCounts: {},
  setRoomCount: () => {},
  markRead:     () => {},
});

export function UnreadProvider({ children }) {
  const [unreadCounts, setUnreadCounts] = useState({});

  // Called by global sync with the server's notification_count per room
  const setRoomCount = useCallback((roomId, count) => {
    setUnreadCounts(prev => {
      if (prev[roomId] === count) return prev; // skip re-render if unchanged
      return { ...prev, [roomId]: count };
    });
  }, []);

  // Called by ChatPanel when user opens a room — immediately zero the dot
  // without waiting for the next sync response
  const markRead = useCallback((roomId) => {
    setUnreadCounts(prev => ({ ...prev, [roomId]: 0 }));
  }, []);

  return (
    <UnreadContext.Provider value={{ unreadCounts, setRoomCount, markRead }}>
      {children}
    </UnreadContext.Provider>
  );
}

export const useUnread = () => useContext(UnreadContext);