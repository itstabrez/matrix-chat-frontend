import { useState } from "react";
import {
    Modal,
    Box,
    TextField,
    Button,
    Typography,
} from "@mui/material";
import axios from "axios";

export default function InviteUserModal({ open, handleClose }) {
    const [roomId, setRoomId] = useState("");
    const [userId, setUserId] = useState("");

    const token = localStorage.getItem("token");

    const inviteUser = async () => {
        try {
            await axios.post(
                `http://localhost:8080/api/matrix/${roomId}/invite`,
                { roomId, userId },
                {
                    headers: { Authorization: `Bearer ${token}` },
                }
            );
            handleClose();
        } catch (err) {
            console.error("Error inviting user", err);
        }
    };

    return (
        <Modal open={open} onClose={handleClose}>
            <Box sx={{ p: 4, bgcolor: "white", m: "15% auto", width: 400 }}>
                <Typography variant="h6">Invite To Room</Typography>

                <TextField
                    fullWidth
                    label="Room ID"
                    sx={{ mt: 2 }}
                    onChange={(e) => setRoomId(e.target.value)}
                />

                <TextField
                    fullWidth
                    label="User ID"
                    sx={{ mt: 2 }}
                    onChange={(e) => setUserId(e.target.value)}
                />

                <Button fullWidth sx={{ mt: 2 }} variant="contained" onClick={inviteUser}>
                    Invite
                </Button>
            </Box>
        </Modal>
    );
}