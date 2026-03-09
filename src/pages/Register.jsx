import { useState } from "react";
import {
    Container,
    TextField,
    Button,
    Typography,
    Box,
    Paper,
    Checkbox,
    FormControlLabel,
} from "@mui/material";
import { Link, useNavigate } from "react-router-dom";
import { registerUser } from "../service/authService";
import { Link as RouterLink } from "react-router-dom";

export default function Register() {
    const navigate = useNavigate();

    const [form, setForm] = useState({
        username: "",
        password: "",
        admin: false,
    });

    const handleChange = (e) => {
        const { name, value, checked, type } = e.target;
        setForm({
            ...form,
            [name]: type === "checkbox" ? checked : value,
        });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            const res = await registerUser(form);
            console.log("Register Success:", res.data);
            alert("User Created Successfully");
            navigate("/");
        } catch (err) {
            alert("Registration Failed");
        }
    };

    return (
        <Container maxWidth="sm">
            <Paper elevation={3} sx={{ padding: 4, marginTop: 10 }}>
                <Typography variant="h5" align="center" gutterBottom>
                    Register
                </Typography>

                <Box component="form" onSubmit={handleSubmit}>
                    <TextField
                        fullWidth
                        label="Username"
                        name="username"
                        margin="normal"
                        onChange={handleChange}
                    />
                    <TextField
                        fullWidth
                        label="Password"
                        name="password"
                        type="password"
                        margin="normal"
                        onChange={handleChange}
                    />

                    <FormControlLabel
                        control={
                            <Checkbox
                                name="admin"
                                onChange={handleChange}
                            />
                        }
                        label="Is Admin?"
                    />

                    <Button
                        fullWidth
                        variant="contained"
                        type="submit"
                        sx={{ mt: 2 }}
                    >
                        Register
                    </Button>

                    <Typography align="center" sx={{ mt: 2 }}>
                        Already have an account?{" "}
                        <Link component={RouterLink} to="/">
                            Login
                        </Link>
                    </Typography>
                </Box>
            </Paper>
        </Container>
    );
}