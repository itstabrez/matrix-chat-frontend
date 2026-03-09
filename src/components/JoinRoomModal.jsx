import { useState } from "react";
import {
  Modal,
  Box,
  TextField,
  Button,
  Typography,
} from "@mui/material";
import axios from "axios";

export default function JoinRoomModal({ open, handleClose }) {
  const [roomId, setRoomId] = useState("");

  const token = localStorage.getItem("token");

  const joinRoom = async () => {
    try {
      await axios.post(
        `http://localhost:8080/api/matrix/${roomId}/join`,
        { roomId },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      handleClose();
    } catch (err) {
      console.error("Error joining room", err);
    }
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <Box sx={{ p: 4, bgcolor: "white", m: "15% auto", width: 400 }}>
        <Typography variant="h6">Join Room</Typography>

        <TextField
          fullWidth
          label="Room ID"
          sx={{ mt: 2 }}
          onChange={(e) => setRoomId(e.target.value)}
        />

        <Button fullWidth sx={{ mt: 2 }} variant="contained" onClick={joinRoom}>
          Join
        </Button>
      </Box>
    </Modal>
  );
}