import { useState } from "react";
import {
  Modal,
  Box,
  TextField,
  Button,
  Typography,
} from "@mui/material";
import axios from "axios";

export default function CreateRoomModal({ open, handleClose }) {
  const [roomName, setRoomName] = useState("");
  const [topic, setTopic] = useState("");

  const token = localStorage.getItem("token");

  const createRoom = async () => {
    try {
      await axios.post(
        "http://localhost:8080/api/matrix/create-room",
        { 
            roomName: roomName,
            roomAlias: "Room_" + Math.random().toString(10).substring(2, 7),
            topic: topic
         },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      handleClose();
    } catch (err) {
      console.error("Error creating room", err);
    }
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <Box sx={{ p: 4, bgcolor: "white", m: "15% auto", width: 400 }}>
        <Typography variant="h6">Create Room</Typography>

        <TextField
          fullWidth
          label="Room Name"
          sx={{ mt: 2 }}
          onChange={(e) => setRoomName(e.target.value)}
        />
        <TextField
          fullWidth
          label="Topic"
          sx={{ mt: 2 }}
          onChange={(e) => setTopic(e.target.value)}
        />

        <Button fullWidth sx={{ mt: 2 }} variant="contained" onClick={createRoom}>
          Create
        </Button>
      </Box>
    </Modal>
  );
}