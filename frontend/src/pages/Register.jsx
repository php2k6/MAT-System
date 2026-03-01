import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import { useEffect } from "react";

export default function Register() {

    useEffect(() => {
        document.title = "register";
      }, []);

  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: ""
  });

  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState("");

  const validate = () => {
    const newErrors = {};

    if (!formData.name.trim()) {
      newErrors.name = "Full name is required";
    }

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

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = "Confirm your password";
    } else if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
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
        "http://localhost:5000/api/auth/register",
        {
          name: formData.name,
          email: formData.email,
          password: formData.password
        }
      );

      console.log("Success:", response.data);

      // ✅ Redirect after success
      navigate("/login");

    } catch (error) {
      if (error.response) {
        setServerError(error.response.data.message || "Registration failed");
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
        <h2 style={styles.title}>Create Trading Account</h2>

        {serverError && (
          <span style={{ ...styles.error, textAlign: "center" }}>
            {serverError}
          </span>
        )}

        <input
          type="text"
          name="name"
          placeholder="Full Name"
          value={formData.name}
          onChange={handleChange}
          style={{
            ...styles.input,
            border: errors.name ? "1px solid #ef4444" : styles.input.border
          }}
        />
        {errors.name && <span style={styles.error}>{errors.name}</span>}

        <input
          type="email"
          name="email"
          placeholder="Email"
          value={formData.email}
          onChange={handleChange}
          style={{
            ...styles.input,
            border: errors.email ? "1px solid #ef4444" : styles.input.border
          }}
        />
        {errors.email && <span style={styles.error}>{errors.email}</span>}

        <input
          type="password"
          name="password"
          placeholder="Password"
          value={formData.password}
          onChange={handleChange}
          style={{
            ...styles.input,
            border: errors.password ? "1px solid #ef4444" : styles.input.border
          }}
        />
        {errors.password && <span style={styles.error}>{errors.password}</span>}

        <input
          type="password"
          name="confirmPassword"
          placeholder="Confirm Password"
          value={formData.confirmPassword}
          onChange={handleChange}
          style={{
            ...styles.input,
            border: errors.confirmPassword
              ? "1px solid #ef4444"
              : styles.input.border
          }}
        />
        {errors.confirmPassword && (
          <span style={styles.error}>{errors.confirmPassword}</span>
        )}

        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? "Registering..." : "Register"}
        </button>

        <p style={styles.switchText}>
          Already have account?{" "}
          <Link to="/login" style={styles.link}>
            Login
          </Link>
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
      padding: "clamp(20px, 5vw, 40px)", // responsive padding
      width: "100%",
      maxWidth: "400px", // instead of fixed width
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
      marginBottom: "15px",
      fontSize: "clamp(18px, 4vw, 22px)" // responsive font
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
    switchText: {
      textAlign: "center",
      fontSize: "13px",
      color: "#94a3b8",
      marginTop: "10px"
    },
    link: {
      color: "#22c55e",
      textDecoration: "none",
      fontWeight: "bold"
    }
  };