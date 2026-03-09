import axios from "axios";

const API_BASE = "http://localhost:8080";

export const registerUser = async (data) => {
  return axios.post(`${API_BASE}/api/matrix/users`, data);
};

export const loginUser = async (data) => {
  return axios.post(`${API_BASE}/api/matrix/login`, data);
};