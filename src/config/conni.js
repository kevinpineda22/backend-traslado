import axios from "axios";
import "dotenv/config";

const baseURL = process.env.CONNI_BASE_URL;

if (!baseURL) {
  console.warn("⚠️  CONNI_BASE_URL no está definida en .env");
  console.warn("   El servicio SIESA no funcionará hasta que la configures.");
}

/** Instancia Axios preconfigurada para consumir la API CONNI (SIESA) */
export const conni = axios.create({
  baseURL: baseURL || "http://localhost:9999", // placeholder hasta que definan la URL
  headers: {
    "CONNI-KEY": process.env.CONNI_KEY,
    "CONNI-TOKEN": process.env.CONNI_TOKEN,
    "Content-Type": "application/json",
  },
  timeout: 15_000,
});

// Interceptor para logging en desarrollo
conni.interceptors.response.use(
  (res) => res,
  (error) => {
    if (process.env.NODE_ENV === "development") {
      console.error("🔴 CONNI error:", {
        url: error.config?.url,
        status: error.response?.status,
        data: error.response?.data,
      });
    }
    return Promise.reject(error);
  },
);
