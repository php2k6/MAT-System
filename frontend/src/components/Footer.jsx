export default function Footer() {
    return (
      <footer style={styles.footer}>
       © {new Date().getFullYear()} | MAT System
      </footer>
    );
  }
  
  const styles = {
    footer: {
      height: "50px",
      background: "#0f172a",
      color: "#64748b",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      fontSize: "12px",
      borderTop: "1px solid rgba(34,197,94,0.2)"
    }
  };