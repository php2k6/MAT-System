import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import axios from "axios";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

export default function Register() {
  useEffect(() => { document.title = "Register — MAT System"; }, []);

  const navigate = useNavigate();

  const [formData, setFormData] = useState({ name: "", email: "", password: "", confirmPassword: "" });
  const [errors, setErrors]     = useState({});
  const [loading, setLoading]   = useState(false);
  const [serverError, setServerError] = useState("");

  const validate = () => {
    const e = {};
    if (!formData.name.trim())
      e.name = "Full name is required";
    if (!formData.email)
      e.email = "Email is required";
    else if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(formData.email))
      e.email = "Invalid email format";
    if (!formData.password)
      e.password = "Password is required";
    else if (formData.password.length < 6)
      e.password = "Password must be at least 6 characters";
    if (!formData.confirmPassword)
      e.confirmPassword = "Please confirm your password";
    else if (formData.password !== formData.confirmPassword)
      e.confirmPassword = "Passwords do not match";
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
      const response = await axios.post(`${API_BASE_URL}/auth/register`, {
        name: formData.name, email: formData.email, password: formData.password,
      });
      console.log("Success:", response.data);
      navigate("/login");
    } catch (error) {
      setServerError(error.response?.data?.message || "Registration failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const fields = [
    { id: "name",            type: "text",     label: "Full Name",       placeholder: "John Doe",          autoComplete: "name" },
    { id: "email",           type: "email",    label: "Email",           placeholder: "you@example.com",   autoComplete: "email" },
    { id: "password",        type: "password", label: "Password",        placeholder: "••••••••",          autoComplete: "new-password" },
    { id: "confirmPassword", type: "password", label: "Confirm Password",placeholder: "••••••••",          autoComplete: "new-password" },
  ];

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .rg-page {
          min-height: 100vh;
          background: #f2f2f2;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px 16px;
          font-family: ${SYS};
        }

        .rg-card {
          background: #fff;
          border: 1px solid #e0e0e0;
          border-radius: 10px;
          padding: 36px 32px 28px;
          width: 100%;
          max-width: 400px;
          display: flex;
          flex-direction: column;
        }

        .rg-logo-mark {
          width: 36px; height: 36px;
          background: #222; border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          font-family: ${MONO}; font-size: 15px; font-weight: 700; color: #fff;
          margin: 0 auto 18px;
        }
        .rg-title {
          font-size: 20px; font-weight: 700; color: #111;
          text-align: center; margin-bottom: 4px;
        }
        .rg-subtitle {
          font-size: 13px; color: #777;
          text-align: center; margin-bottom: 28px;
        }

        .rg-divider { height: 1px; background: #ebebeb; margin-bottom: 22px; }

        .rg-server-error {
          background: #fdecea; border: 1px solid #f5c6c6;
          border-radius: 6px; padding: 10px 12px;
          font-size: 12px; color: #c62828;
          text-align: center; margin-bottom: 16px;
        }

        .rg-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
        .rg-label { font-size: 12px; font-weight: 600; color: #333; }

        .rg-input {
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
        .rg-input:focus {
          border-color: #333;
          box-shadow: 0 0 0 3px rgba(0,0,0,0.07);
        }
        .rg-input.err { border-color: #c62828; }
        .rg-input.err:focus { box-shadow: 0 0 0 3px rgba(198,40,40,0.08); }

        .rg-field-error { font-size: 11px; color: #c62828; font-weight: 500; }

        .rg-btn {
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
        .rg-btn:hover:not(:disabled)  { background: #3a3a3a; }
        .rg-btn:active:not(:disabled) { background: #111; }
        .rg-btn:disabled { opacity: 0.55; cursor: not-allowed; }

        .rg-spinner {
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: rgSpin 0.7s linear infinite;
          flex-shrink: 0;
        }
        @keyframes rgSpin { to { transform: rotate(360deg); } }

        .rg-switch {
          font-size: 13px; color: #666;
          text-align: center; margin-bottom: 20px;
        }
        .rg-link { color: #111; font-weight: 700; text-decoration: none; }
        .rg-link:hover { text-decoration: underline; }

        .rg-footer {
          font-size: 11px; color: #aaa;
          text-align: center; font-family: ${MONO};
          border-top: 1px solid #f0f0f0; padding-top: 16px;
        }
      `}</style>

      <div className="rg-page">
        <div className="rg-card">

          <div className="rg-logo-mark">M</div>
          <div className="rg-title">Create Account</div>
          <div className="rg-subtitle">Join MAT System to start trading</div>

          <div className="rg-divider" />

          {serverError && (
            <div className="rg-server-error">⚠ {serverError}</div>
          )}

          <form onSubmit={handleSubmit} noValidate>
            {fields.map(({ id, type, label, placeholder, autoComplete }) => (
              <div key={id} className="rg-field">
                <label className="rg-label" htmlFor={id}>{label}</label>
                <input
                  id={id}
                  type={type}
                  name={id}
                  placeholder={placeholder}
                  value={formData[id]}
                  onChange={handleChange}
                  className={`rg-input ${errors[id] ? "err" : ""}`}
                  autoComplete={autoComplete}
                />
                {errors[id] && <span className="rg-field-error">⚠ {errors[id]}</span>}
              </div>
            ))}

            <button type="submit" className="rg-btn" disabled={loading}>
              {loading
                ? <><div className="rg-spinner" /><span>Creating account...</span></>
                : "Create Account"
              }
            </button>
          </form>

          <div className="rg-switch">
            Already have an account?{" "}
            <Link to="/login" className="rg-link">Sign In</Link>
          </div>

          <div className="rg-footer">
            © {new Date().getFullYear()} MAT Capital Markets
          </div>

        </div>
      </div>
    </>
  );
}