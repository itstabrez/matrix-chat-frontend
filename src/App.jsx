import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";
import { UnreadProvider } from "./components/UnreadContext";

function App() {
  return (
    <BrowserRouter>
      <UnreadProvider>
        <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
      </UnreadProvider>
    </BrowserRouter>
  );
}

export default App;