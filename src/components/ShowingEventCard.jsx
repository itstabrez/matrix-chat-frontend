import { useState } from "react";
import { Box, Paper, Typography, Button, TextField } from "@mui/material";

/**
 * Renders a showing event card.
 *
 * Sender (actorUserId === currentUserId) → plain status card, no actions.
 * Receiver → contextual action buttons based on actionType:
 *   REQUESTED   → Accept / Decline / Reschedule
 *   RESCHEDULED → Accept / Decline
 *   ACCEPTED    → no actions
 *   DECLINED    → Reschedule only
 */
export default function ShowingEventCard({ msg, currentUserId, roomId, onAction }) {

  const [showReschedule, setShowReschedule] = useState(false);
  const [newTime,        setNewTime]        = useState("");

  const payload    = msg.payload  ?? {};
  const metadata   = msg.metadata ?? {};
  const actionType = payload.actionType ?? "";
  const isMine     = metadata.actorUserId === currentUserId;

  const statusMeta = {
    "property.showing.requested":   { icon: "🏠", label: "Showing Request",    bg: "#f3f4f6" },
    "property.showing.accepted":    { icon: "✅", label: "Showing Accepted",    bg: "#e8f5e9" },
    "property.showing.declined":    { icon: "❌", label: "Showing Declined",    bg: "#ffebee" },
    "property.showing.rescheduled": { icon: "🔄", label: "Showing Rescheduled", bg: "#fff8e1" },
  }[msg.type] ?? { icon: "📅", label: "Showing Update", bg: "#f3f4f6" };

  const handleAction = (action) => {
    onAction(action, payload, action === "RESCHEDULED" ? newTime : null);
    setShowReschedule(false);
    setNewTime("");
  };

  // Which buttons to show on the receiver side
  const receiverButtons = () => {
    if (isMine) return null;

    return (
      <Box mt={1} display="flex" flexWrap="wrap" gap={1}>
        {["REQUESTED", "RESCHEDULED"].includes(actionType) && (
          <Button size="small" variant="contained" color="success"
            onClick={() => handleAction("ACCEPTED")}>
            Accept
          </Button>
        )}
        {["REQUESTED", "RESCHEDULED"].includes(actionType) && (
          <Button size="small" variant="outlined" color="error"
            onClick={() => handleAction("DECLINED")}>
            Decline
          </Button>
        )}
        {["REQUESTED", "DECLINED"].includes(actionType) && (
          <Button size="small" variant="outlined"
            onClick={() => setShowReschedule(v => !v)}>
            Reschedule
          </Button>
        )}

        {showReschedule && (
          <Box display="flex" gap={1} width="100%" mt={0.5}>
            <TextField
              size="small"
              type="datetime-local"
              value={newTime}
              onChange={e => setNewTime(e.target.value)}
              sx={{ flex: 1 }}
            />
            <Button size="small" variant="contained"
              disabled={!newTime}
              onClick={() => handleAction("RESCHEDULED")}>
              Confirm
            </Button>
          </Box>
        )}
      </Box>
    );
  };

  return (
    <Paper sx={{ p: 2, mb: 1, bgcolor: statusMeta.bg }}>

      <Typography fontWeight="bold">
        {statusMeta.icon} {statusMeta.label}
        {isMine && (
          <Typography component="span" variant="caption"
            sx={{ ml: 1, opacity: 0.6 }}>
            (sent)
          </Typography>
        )}
      </Typography>

      <Typography variant="body2" sx={{ mt: 0.5 }}>
        {metadata.actionText}
      </Typography>

      {payload.address && (
        <Typography variant="caption" color="text.secondary" display="block">
          📍 {payload.address}
        </Typography>
      )}

      {payload.humanTime && (
        <Typography variant="caption" color="text.secondary" display="block">
          🕐 {payload.humanTime}
        </Typography>
      )}

      {receiverButtons()}

    </Paper>
  );
}