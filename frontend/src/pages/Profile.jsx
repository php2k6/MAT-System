import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import toast from "react-hot-toast";
import { useAuth } from "../components/Authcontext.jsx";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const SYS  = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `'Courier New', Courier, monospace`;

export default function Profile() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  useEffect(() => { document.title = "Profile — MAT System"; }, []);

  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [savingWhatsApp, setSavingWhatsApp] = useState(false);
  const [testingWhatsApp, setTestingWhatsApp] = useState(false);
  const [formData, setFormData] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setWhatsappNumber(user?.whatsappNumber || "");
  }, [user?.whatsappNumber]);

  const handleChange = (e) => {
    setFormData(f => ({ ...f, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.currentPassword || !formData.newPassword || !formData.confirmPassword) {
      toast.error("Please fill all fields.");
      return;
    }
    if (formData.newPassword !== formData.confirmPassword) {
      toast.error("New passwords do not match.");
      return;
    }
    if (formData.newPassword.length < 6) {
      toast.error("New password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    try {
      const resp = await axios.post(
        `${API_BASE_URL}/auth/change-password`,
        { currentPassword: formData.currentPassword, newPassword: formData.newPassword },
        { withCredentials: true }
      );
      toast.success(resp.data.message || "Password updated successfully.");
      
      // Cookie is destroyed by the API, flush frontend state and go to login
      await refresh();
      navigate("/login");
    } catch (err) {
      const msg = err.response?.data?.detail?.message || err.response?.data?.message || err.message || "Failed to update password.";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveWhatsApp = async (e) => {
    e.preventDefault();
    setSavingWhatsApp(true);
    try {
      const resp = await axios.put(
        `${API_BASE_URL}/auth/profile`,
        { whatsappNumber: whatsappNumber || null },
        { withCredentials: true }
      );
      toast.success(resp.data.message || "Profile updated successfully.");
      await refresh();
    } catch (err) {
      const msg = err.response?.data?.detail?.message || err.response?.data?.message || err.message || "Failed to update profile.";
      toast.error(msg);
    } finally {
      setSavingWhatsApp(false);
    }
  };

  const handleTestWhatsApp = async () => {
    setTestingWhatsApp(true);
    try {
      const resp = await axios.post(
        `${API_BASE_URL}/auth/testing/whatsapp`,
        { phone: whatsappNumber || null },
        { withCredentials: true }
      );
      toast.success(resp.data.message || "WhatsApp test sent.");
    } catch (err) {
      const msg = err.response?.data?.detail?.message || err.response?.data?.message || err.message || "WhatsApp test failed.";
      toast.error(msg);
    } finally {
      setTestingWhatsApp(false);
    }
  };

  return (
    <>
      <style>{`
        .pf-page {
          padding: 24px;
          font-family: ${SYS};
          max-width: 600px;
          margin: 0 auto;
          width: 100%;
        }

        .pf-header {
          margin-bottom: 24px;
        }

        .pf-title {
          font-size: 22px;
          font-weight: 700;
          color: #111;
          letter-spacing: -0.01em;
          margin-bottom: 4px;
        }

        .pf-subtitle {
          font-size: 13px;
          color: #777;
        }

        .pf-card {
          background: #fff;
          border: 1px solid #e5e5e5;
          border-radius: 8px;
          padding: 24px;
          margin-bottom: 24px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.02);
        }

        .pf-card-highlight {
          border-left: 4px solid #1b6f3e;
          background: linear-gradient(180deg, #ffffff 0%, #f9fcfa 100%);
        }

        .pf-card-title {
          font-size: 14px;
          font-weight: 700;
          color: #111;
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid #f0f0f0;
          letter-spacing: -0.01em;
        }

        /* Value display */
        .pf-info-row {
          display: flex;
          flex-direction: column;
          margin-bottom: 16px;
        }
        .pf-info-row:last-child {
          margin-bottom: 0;
        }
        .pf-info-label {
          font-size: 11px;
          font-weight: 700;
          color: #999;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 4px;
        }
        .pf-info-value {
          font-size: 14px;
          font-weight: 500;
          color: #111;
        }

        /* Form fields */
        .pf-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-bottom: 16px;
        }
        .pf-label {
          font-size: 12px;
          font-weight: 600;
          color: #333;
        }
        .pf-input {
          padding: 10px 12px;
          border-radius: 6px;
          border: 1.5px solid #ccc;
          background: #fafafa;
          color: #111;
          outline: none;
          font-size: 14px;
          font-family: ${SYS};
          width: 100%;
          transition: border-color 0.14s, box-shadow 0.14s, background 0.14s;
        }
        .pf-input:focus {
          border-color: #333;
          background: #fff;
          box-shadow: 0 0 0 3px rgba(0,0,0,0.05);
        }

        /* Button */
        .pf-btn {
          padding: 10px 16px;
          border-radius: 6px;
          border: none;
          background: #111;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          font-family: ${SYS};
          transition: background 0.14s;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-width: 140px;
        }
        .pf-btn:hover:not(:disabled) { background: #333; }
        .pf-btn:active:not(:disabled) { background: #000; }
        .pf-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        .pf-btn-secondary {
          background: #f4f4f4;
          color: #222;
          border: 1px solid #ddd;
        }
        .pf-btn-secondary:hover:not(:disabled) {
          background: #ececec;
        }

        .pf-inline-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .pf-help {
          font-size: 12px;
          color: #666;
          margin-top: 8px;
          line-height: 1.4;
        }

        .pf-spinner {
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: pfSpin 0.7s linear infinite;
        }
        @keyframes pfSpin { to { transform: rotate(360deg); } }
      `}</style>
      
      <div className="pf-page">
        <div className="pf-header">
          <div className="pf-title">Profile Management</div>
          <div className="pf-subtitle">Manage your account details and security settings.</div>
        </div>

        {/* Account Details */}
        <div className="pf-card">
          <div className="pf-card-title">Account Details</div>
          <div className="pf-info-row">
            <span className="pf-info-label">Name</span>
            <span className="pf-info-value">{user?.name || "—"}</span>
          </div>
          <div className="pf-info-row">
            <span className="pf-info-label">Email Address</span>
            <span className="pf-info-value">{user?.email || "—"}</span>
          </div>
        </div>

        <div className="pf-card pf-card-highlight">
          <div className="pf-card-title">WhatsApp Notifications</div>
          <form onSubmit={handleSaveWhatsApp}>
            <div className="pf-field">
              <label className="pf-label" htmlFor="whatsappNumber">WhatsApp Number</label>
              <input
                id="whatsappNumber"
                type="text"
                name="whatsappNumber"
                value={whatsappNumber}
                onChange={(e) => setWhatsappNumber(e.target.value)}
                className="pf-input"
                placeholder="+91XXXXXXXXXX"
                autoComplete="tel"
              />
              <div className="pf-help">
                Used for rebalance reminders and completion status alerts.
              </div>
            </div>

            <div className="pf-inline-actions">
              <button type="submit" className="pf-btn" disabled={savingWhatsApp}>
                {savingWhatsApp ? <><div className="pf-spinner" /><span>Saving…</span></> : "Save WhatsApp"}
              </button>
              <button
                type="button"
                className="pf-btn pf-btn-secondary"
                disabled={testingWhatsApp || !whatsappNumber}
                onClick={handleTestWhatsApp}
              >
                {testingWhatsApp ? <><div className="pf-spinner" /><span>Sending…</span></> : "Send Test Message"}
              </button>
            </div>
          </form>
        </div>

        {/* Security / Password Change */}
        <div className="pf-card">
          <div className="pf-card-title">Change Password</div>
          <form onSubmit={handleSubmit}>
            <div className="pf-field">
              <label className="pf-label" htmlFor="currentPassword">Current Password</label>
              <input
                id="currentPassword"
                type="password"
                name="currentPassword"
                value={formData.currentPassword}
                onChange={handleChange}
                className="pf-input"
                autoComplete="current-password"
              />
            </div>
            
            <div className="pf-field">
              <label className="pf-label" htmlFor="newPassword">New Password</label>
              <input
                id="newPassword"
                type="password"
                name="newPassword"
                value={formData.newPassword}
                onChange={handleChange}
                className="pf-input"
                autoComplete="new-password"
              />
            </div>

            <div className="pf-field" style={{ marginBottom: "24px" }}>
              <label className="pf-label" htmlFor="confirmPassword">Confirm New Password</label>
              <input
                id="confirmPassword"
                type="password"
                name="confirmPassword"
                value={formData.confirmPassword}
                onChange={handleChange}
                className="pf-input"
                autoComplete="new-password"
              />
            </div>

            <button type="submit" className="pf-btn" disabled={loading}>
              {loading ? (
                <><div className="pf-spinner"/><span>Updating…</span></>
              ) : (
                "Update Password"
              )}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
