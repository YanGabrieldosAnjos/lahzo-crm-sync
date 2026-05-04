import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Link } from "react-router-dom";
import ContactList from "./pages/ContactList";
import ContactDetail from "./pages/ContactDetail";
import "./styles/app.css";

function Header() {
  return (
    <header>
      <Link to="/">Lahzo CRM Sync</Link>
      <span className="subtitle">Operator Dashboard</span>
    </header>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Header />
      <Routes>
        <Route path="/" element={<ContactList />} />
        <Route path="/contacts/:id" element={<ContactDetail />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
