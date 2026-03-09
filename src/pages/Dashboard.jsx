import { useEffect, useState } from "react";
import {
  Container,
  Button,
  Typography,
  Box,
  Paper,
  List,
  ListItemButton,
  ListItemText,
} from "@mui/material";
import CreateRoomModal from "../components/CreateRoomModal";
import JoinRoomModal from "../components/JoinRoomModal";
import ChatPanel from "../components/ChatPanel";
import axios from "axios";
import InviteUserModal from "../components/InviteUserModal";

export default function Dashboard() {
  const [rooms, setRooms] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [openCreate, setOpenCreate] = useState(false);
  const [openJoin, setOpenJoin] = useState(false);
  const [openInvite, setOpenInvite] = useState(false);

  const token = localStorage.getItem("token");

  const fetchRooms = async () => {
    const res = await axios.get("http://localhost:8080/api/matrix/rooms", {
      headers: { Authorization: `Bearer ${token}` },
    });
    setRooms(res.data);
  };

  useEffect(() => {
    fetchRooms();
  }, []);

  return (
    <Box display="flex" height="100vh">
      {/* LEFT SIDE */}
      <Box width="30%" p={2} borderRight="1px solid #ddd">
        <Box display="flex" gap={2} mb={2}>
          <Button variant="contained" onClick={() => setOpenCreate(true)}>
            Create
          </Button>
          <Button variant="outlined" onClick={() => setOpenJoin(true)}>
            Join
          </Button>
          <Button variant="outlined" onClick={() => setOpenInvite(true)}>
            Invite
          </Button>
        </Box>

        <List>
          {rooms.map((room) => (
            <ListItemButton
              key={room.roomId}
              onClick={() => setSelectedRoom(room.roomId)}
            >
              <ListItemText primary={room.roomId} />
            </ListItemButton>
          ))}
        </List>
      </Box>

      {/* RIGHT SIDE */}
      <Box width="70%">
        {selectedRoom ? (
          <ChatPanel roomId={selectedRoom} />
        ) : (
          <Typography sx={{ mt: 5, textAlign: "center" }}>
            Select a room to start chatting
          </Typography>
        )}
      </Box>

      <CreateRoomModal open={openCreate} handleClose={() => {
        setOpenCreate(false);
        fetchRooms();
      }} />

      <JoinRoomModal open={openJoin} handleClose={() => {
        setOpenJoin(false);
        fetchRooms();
      }} />
      <InviteUserModal open={openInvite} handleClose={() => {
        setOpenInvite(false);
        fetchRooms();
      }} />
    </Box>
  );
}