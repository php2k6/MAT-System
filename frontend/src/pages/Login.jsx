import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import { useEffect } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export default function Login() {

    useEffect(() => {
        document.title = "login";
      }, []);


  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    email: "",
    password: ""
  });

  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState("");

  const validate = () => {
    const newErrors = {};

    if (!formData.email) {
      newErrors.email = "Email is required";
    } else if (
      !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(formData.email)
    ) {
      newErrors.email = "Invalid email format";
    }

    if (!formData.password) {
      newErrors.password = "Password is required";
    } else if (formData.password.length < 6) {
      newErrors.password = "Password must be at least 6 characters";
    }

    return newErrors;
  };

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });

    setErrors({
      ...errors,
      [e.target.name]: ""
    });

    setServerError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
  
    const validationErrors = validate();
  
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
  
    try {
      setLoading(true);
  
      const response = await axios.post(
        `${API_BASE_URL}/auth/login`,
        formData,
        {
          withCredentials: true
        }
      );
  
      console.log("Login Success:", response.data);
  
  
      navigate("/dashboard");
  
    } catch (error) {
      if (error.response) {
        setServerError(error.response.data.message || "Login failed");
      } else {
        setServerError("Server not responding");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.overlay}></div>

      <form style={styles.card} onSubmit={handleSubmit}>
        <h2 style={styles.title}>MAT System</h2>
        <p style={styles.subtitle}>Secure Trader Login</p>

        {serverError && (
          <span style={{ ...styles.error, textAlign: "center" }}>
            {serverError}
          </span>
        )}

        <input
          type="email"
          name="email"
          placeholder="Trader Email"
          value={formData.email}
          onChange={handleChange}
          style={{
            ...styles.input,
            border: errors.email ? "1px solid #ef4444" : styles.input.border
          }}
        />
        {errors.email && (
          <span style={styles.error}>{errors.email}</span>
        )}

        <input
          type="password"
          name="password"
          placeholder="Password"
          value={formData.password}
          onChange={handleChange}
          style={{
            ...styles.input,
            border: errors.password
              ? "1px solid #ef4444"
              : styles.input.border
          }}
        />
        {errors.password && (
          <span style={styles.error}>{errors.password}</span>
        )}

        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? "Accessing..." : "Access Dashboard"}
        </button>

        <p style={styles.switchText}>
          New trader?{" "}
          <Link to="/register" style={styles.link}>
            Create Account
          </Link>
        </p>

        <p style={styles.footer}>
          © {new Date().getFullYear()} MAT Capital Markets
        </p>
      </form>
    </div>
  );
}


const styles = {
    container: {
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f172a, #020617)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      position: "relative",
      fontFamily: "Arial, sans-serif",
      padding: "20px" // important for mobile spacing
    },
  
    overlay: {
      position: "absolute",
      width: "100%",
      height: "100%",
      background:
        "radial-gradient(circle at top right, rgba(34,197,94,0.15), transparent 40%)"
    },
  
    card: {
      position: "relative",
      background: "rgba(15, 23, 42, 0.95)",
      padding: "clamp(20px, 5vw, 40px)",
      width: "100%",
      maxWidth: "400px", // responsive width
      borderRadius: "12px",
      backdropFilter: "blur(10px)",
      boxShadow: "0 0 40px rgba(34,197,94,0.15)",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      border: "1px solid rgba(34,197,94,0.2)"
    },
  
    title: {
      color: "#22c55e",
      textAlign: "center",
      margin: 0,
      fontSize: "clamp(20px, 4vw, 24px)",
      letterSpacing: "1px"
    },
  
    subtitle: {
      color: "#94a3b8",
      textAlign: "center",
      fontSize: "clamp(12px, 3vw, 14px)",
      marginBottom: "15px"
    },
  
    input: {
      padding: "12px",
      borderRadius: "6px",
      border: "1px solid #1e293b",
      background: "#0f172a",
      color: "white",
      outline: "none",
      fontSize: "14px",
      width: "100%"
    },
  
    button: {
      marginTop: "10px",
      padding: "12px",
      borderRadius: "6px",
      border: "none",
      background: "#22c55e",
      color: "#0f172a",
      fontWeight: "bold",
      cursor: "pointer",
      fontSize: "15px",
      width: "100%"
    },
  
    error: {
      color: "#ef4444",
      fontSize: "12px",
      marginBottom: "6px"
    },
  
    footer: {
      fontSize: "11px",
      textAlign: "center",
      color: "#64748b",
      marginTop: "12px"
    },
  
    switchText: {
      textAlign: "center",
      fontSize: "13px",
      color: "#94a3b8",
      marginTop: "8px"
    },
  
    link: {
      color: "#22c55e",
      textDecoration: "none",
      fontWeight: "bold"
    }
  };