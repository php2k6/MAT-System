import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../components/Authcontext.jsx";


const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

export default function Login() {
  const { refresh } = useAuth();
  useEffect(() => { document.title = "Login — MAT System"; }, []);

  const navigate = useNavigate();

  const [formData, setFormData]     = useState({ email: "", password: "" });
  const [errors, setErrors]         = useState({});
  const [loading, setLoading]       = useState(false);
  const [serverError, setServerError] = useState("");

  const validate = () => {
    const e = {};
    if (!formData.email)
      e.email = "Email is required";
    else if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(formData.email))
      e.email = "Invalid email format";
    if (!formData.password)
      e.password = "Password is required";
    else if (formData.password.length < 6)
      e.password = "Password must be at least 6 characters";
    return e;
  };

  const handleChange = (e) => {
    setFormData(f => ({ ...f, [e.target.name]: e.target.value }));
    setErrors(er => ({ ...er, [e.target.name]: "" }));
    setServerError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) { setErrors(validationErrors); return; }
    try {
      setLoading(true);
      const response = await axios.post(`${API_BASE_URL}/auth/login`, formData, { withCredentials: true });
      console.log("Login Success:", response.data);
      await refresh();
      navigate("/dashboard");
    } catch (error) {
      setServerError(error.response?.data?.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .lg-page {
          min-height: 100vh;
          background: #f2f2f2;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px 16px;
          font-family: ${SYS};
        }

        .lg-card {
          background: #fff;
          border: 1px solid #e0e0e0;
          border-radius: 10px;
          padding: 36px 32px 28px;
          width: 100%;
          max-width: 380px;
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        /* Header */
        .lg-logo-mark {
          width: 36px; height: 36px;
          background: #222; border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          font-family: ${MONO}; font-size: 15px; font-weight: 700; color: #fff;
          margin: 0 auto 18px;
        }
        .lg-title {
          font-size: 20px; font-weight: 700; color: #111;
          text-align: center; margin-bottom: 4px;
        }
        .lg-subtitle {
          font-size: 13px; color: #777;
          text-align: center; margin-bottom: 28px;
        }

        /* Divider */
        .lg-divider {
          height: 1px; background: #ebebeb; margin-bottom: 22px;
        }

        /* Server error */
        .lg-server-error {
          background: #fdecea; border: 1px solid #f5c6c6;
          border-radius: 6px; padding: 10px 12px;
          font-size: 12px; color: #c62828;
          text-align: center; margin-bottom: 16px;
        }

        /* Field group */
        .lg-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
        .lg-label {
          font-size: 12px; font-weight: 600; color: #333;
        }
        .lg-input {
          padding: 10px 12px;
          border-radius: 6px;
          border: 1.5px solid #ccc;
          background: #fff;
          color: #111;
          outline: none;
          font-size: 14px;
          font-family: ${SYS};
          width: 100%;
          transition: border-color 0.14s, box-shadow 0.14s;
        }
        .lg-input:focus {
          border-color: #333;
          box-shadow: 0 0 0 3px rgba(0,0,0,0.07);
        }
        .lg-input.err { border-color: #c62828; }
        .lg-input.err:focus { box-shadow: 0 0 0 3px rgba(198,40,40,0.08); }
        .lg-field-error {
          font-size: 11px; color: #c62828; font-weight: 500;
        }

        /* Button */
        .lg-btn {
          width: 100%; padding: 12px;
          border-radius: 7px; border: none;
          background: #222; color: #fff;
          font-size: 13px; font-weight: 700;
          letter-spacing: 0.03em; text-transform: uppercase;
          cursor: pointer; font-family: ${SYS};
          margin-top: 6px; margin-bottom: 20px;
          transition: background 0.14s;
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .lg-btn:hover:not(:disabled)  { background: #3a3a3a; }
        .lg-btn:active:not(:disabled) { background: #111; }
        .lg-btn:disabled { opacity: 0.55; cursor: not-allowed; }

        /* Spinner inside button */
        .lg-spinner {
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: lgSpin 0.7s linear infinite;
          flex-shrink: 0;
        }
        @keyframes lgSpin { to { transform: rotate(360deg); } }

        /* Footer links */
        .lg-switch {
          font-size: 13px; color: #666;
          text-align: center; margin-bottom: 20px;
        }
        .lg-link {
          color: #111; font-weight: 700;
          text-decoration: none;
        }
        .lg-link:hover { text-decoration: underline; }

        .lg-footer {
          font-size: 11px; color: #aaa;
          text-align: center; font-family: ${MONO};
          border-top: 1px solid #f0f0f0; padding-top: 16px;
        }
      `}</style>

      <div className="lg-page">
        <div className="lg-card">

          {/* Logo + header */}
          <div className="lg-logo-mark">M</div>
          <div className="lg-title">MAT System</div>
          <div className="lg-subtitle">Sign in to your account</div>

          <div className="lg-divider" />

          {/* Server error */}
          {serverError && (
            <div className="lg-server-error">⚠ {serverError}</div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} noValidate>

            <div className="lg-field">
              <label className="lg-label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                name="email"
                placeholder="you@example.com"
                value={formData.email}
                onChange={handleChange}
                className={`lg-input ${errors.email ? "err" : ""}`}
                autoComplete="email"
              />
              {errors.email && <span className="lg-field-error">⚠ {errors.email}</span>}
            </div>

            <div className="lg-field">
              <label className="lg-label" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                name="password"
                placeholder="••••••••"
                value={formData.password}
                onChange={handleChange}
                className={`lg-input ${errors.password ? "err" : ""}`}
                autoComplete="current-password"
              />
              {errors.password && <span className="lg-field-error">⚠ {errors.password}</span>}
            </div>

            <button type="submit" className="lg-btn" disabled={loading}>
              {loading
                ? <><div className="lg-spinner" /><span>Signing in...</span></>
                : "Access Dashboard"
              }
            </button>

          </form>

          <div className="lg-switch">
            New trader?{" "}
            <Link to="/register" className="lg-link">Create Account</Link>
          </div>

          <div className="lg-footer">
            © {new Date().getFullYear()} MAT Capital Markets
          </div>

        </div>
      </div>
    </>
  );
}