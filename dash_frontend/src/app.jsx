import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { FileText, Loader2, Search, Send, X, Info } from "lucide-react";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8020";

const SUGGESTIONS = [
  "find proteomics work on inflammatory skin conditions",
  "show me RNA-seq projects in metabolic disease",
  "what projects used Seurat?",
  "any imaging work on neurodegenerative disease?",
  "microbiome studies",
];

const starterText = `Hi - I help you find past DASH work. Ask in your own words. You're viewing as an analyst.`;

// The API Worker runs the MongoDB driver in-isolate, which intermittently
// hard-crashes (Cloudflare 1101, no CORS headers) and surfaces as a
// "Failed to fetch". Attempts are independent, so retry a few times before
// giving up.
async function askWithRetry(query, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${API_BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 8 }),
      });
      if (response.ok) return await response.json();
      lastErr = new Error("The DASH API could not process that search.");
    } catch (err) {
      lastErr = err; // network/CORS failure on a hard Worker crash
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500 + i * 400));
    }
  }
  throw lastErr;
}

function DashboardContent() {

  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState([{ role: "agent", text: starterText }]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [drawerProject, setDrawerProject] = useState(null);



  const canSend = useMemo(() => {
    return query.trim().length > 1 && !loading;
  }, [query, loading]);

  async function ask(nextQuery = query) {
    const cleanQuery = nextQuery.trim();
    if (!cleanQuery || loading) return;

    setError("");
    setLoading(true);
    setQuery("");
    setMessages((items) => [...items, { text: cleanQuery }]);

    try {
      const data = await askWithRetry(cleanQuery);
      setResult(data);
      setMessages((items) => [...items, { role: "agent", text: data.answer }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      setMessages((items) => [...items, { role: "agent", text: message }]);
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    ask();
  }


  return (
    <main className="shell">
      <section className="workspace" aria-label="Ask the DASH agent">
        <header className="topbar">
          <div>
            <h1>DASH Repository</h1>
            <p className="eyebrow">Ask the agent</p>
          </div>

        </header>

        <div className="content-grid">
          <section className="chat-panel" aria-label="Conversation">
            <div className="messages">
              {messages.map((message, index) => (
                <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                  {message.text}
                </div>
              ))}
              {loading && (
                <div className="message agent pending">
                  <Loader2 size={16} className="animate-spin" />
                  Searching project database files...
                </div>
              )}
            </div>

            <form className="composer" onSubmit={submit}>
              <Search size={18} aria-hidden="true" />
              <input
                aria-label="Ask in your own words"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Ask in your own words..."
              />
              <button type="submit" disabled={!canSend} aria-label="Send question">
                <Send size={18} />
              </button>
            </form>
          </section>

          <aside className="side-panel" aria-label="Suggested queries">
            <h2>Try these queries</h2>
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button type="button" key={suggestion} onClick={() => ask(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </aside>
        </div>

        {error && <div className="error">{error}</div>}

        {result && (
          <section className="results" aria-label="Search results">
            <div className="results-header">
              <div>
                <p className="eyebrow">Output</p>
                <h2>Matched DASH work</h2>
              </div>
            </div>

            <div
              className="result-list"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: "20px"
              }}
            >
              {result.matches.slice(0, 8).map((match) => (
                <article className="result-card" key={match.ref_number}>
                  <div className="card-heading">
                    <FileText size={20} />
                    <div>
                      <p>{match.ref_number}</p>
                      <h3>{match.title}</h3>
                    </div>
                    {typeof match.score === "number" && (
                      <span className="score-badge">Score: {match.score.toFixed(3)}</span>
                    )}
                  </div>

                  <dl style={{ margin: "16px 0 0 0", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div style={{ display: "flex", gap: "8px", fontSize: "14px" }}>
                      <dd style={{ backgroundColor: "#daadadff", padding: "10px", borderRadius: "4px", margin: 0, color: "#0f172a" }}>
                        {match.investigators?.lead_data_scientist || formatList(match.investigators?.analyst_team)}
                      </dd>
                    </div>
                    <div style={{ display: "flex", gap: "8px", fontSize: "14px" }}>
                      <dd style={{ backgroundColor: "#e3e8efff", padding: "5px", borderRadius: "4px", margin: 0, color: "#0f172a" }}>
                        {formatList(match.analytical_methods?.primary_methods)}
                      </dd>
                      <dd style={{ backgroundColor: "#d8dcf6ff", padding: "5px", borderRadius: "4px", margin: 0, color: "#0f172a" }}>
                        {formatList(match.project_details?.data_modality)}
                      </dd>
                    </div>
                    <div style={{ display: "flex", gap: "8px", fontSize: "14px" }}>
                      <dt style={{ fontWeight: "600", color: "#64748b", minWidth: "140px" }}>Status:</dt>
                      <dd style={{ backgroundColor: "#e7e9bcff", padding: "5px", borderRadius: "4px", margin: 0, color: "#0f172a" }}>
                        {formatList(match.status || "Not specified")}
                      </dd>
                    </div>
                  </dl>

                  <div className="card-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setDrawerProject(match)}
                    >
                      <Info size={16} />
                      Open Details
                    </button>


                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </section>

      {/* Side Details Drawer */}
      <div className={`drawer-overlay ${drawerProject ? "open" : ""}`} onClick={() => setDrawerProject(null)}>
        <div className="drawer-content" onClick={(e) => e.stopPropagation()}>
          <header className="drawer-header">
            <div>
              <p className="eyebrow">{drawerProject?.ref_number} • Status: {drawerProject?.status}</p>
              <h2>{drawerProject?.title}</h2>
            </div>
            <button className="close-btn" onClick={() => setDrawerProject(null)}>
              <X size={20} />
            </button>
          </header>

          {drawerProject && (
            <div className="drawer-body">
              <section className="drawer-section">
                <h3>Investigators</h3>
                <h4>Lead Data Scientist</h4>
                <p>{formatList(drawerProject.investigators?.lead_data_scientist)}</p>
                <h4>Analyst Team</h4>
                <p>{formatList(drawerProject.investigators?.analyst_team)}</p>
                <h4>Collaborator</h4>
                <p>{formatList(drawerProject.investigators?.collaborator)}</p>
                <h4>Research Leader</h4>
                <p>{formatList(drawerProject.investigators?.research_leader)}</p>
              </section>

              <section className="drawer-section">
                <h3>Description</h3>

                <h4>Research area</h4>
                {renderContentList(drawerProject.project_details?.research_area, "No research area.")}

                <h4>Disease</h4>
                {renderContentList(drawerProject.project_details?.disease, "No disease specified.")}

                <h4>Data Modality</h4>
                {renderContentList(drawerProject.project_details?.data_modality, "No data modality specified.")}
              </section>

              <section className="drawer-section">
                <h3>Analytical Approach</h3>
                <h4>Primary Methods</h4>
                {renderContentList(drawerProject.analytical_methods?.primary_methods, "No primary methods specified.")}
                <h4>Programming Languages</h4>
                {renderContentList(drawerProject.analytical_methods?.programming_languages, "No programming languages specified.")}
              </section>

              <section className="drawer-section">
                <h3>Analytical Questions</h3>
                <p>{drawerProject.analytical_questions?.primary_question || "No primary question specified."}</p>
                {renderContentList(drawerProject.analytical_questions?.other_questions, "")}
              </section>


            </div>
          )}
        </div>
      </div>
    </main >
  );
}

function formatList(items) {
  if (!items) return "Not specified";
  if (Array.isArray(items)) return items.length ? items.join(", ") : "Not specified";
  return items;
}

function renderContentList(value, fallbackText) {
  if (!value || (Array.isArray(value) && value.length === 0)) {
    return <p style={{ margin: "4px 0 12px 0", color: "#64748b", fontSize: "14px" }}>{fallbackText}</p>;
  }

  if (Array.isArray(value)) {
    return (
      <ul style={{ margin: "4px 0 12px 0", paddingLeft: "20px", fontSize: "14px", color: "#334155" }}>
        {value.map((item, idx) => (
          <li key={idx} style={{ marginBottom: "4px" }}>{item}</li>
        ))}
      </ul>
    );
  }

  return <p style={{ margin: "4px 0 12px 0", color: "#334155", fontSize: "14px" }}>{value}</p>;
}

function App() {
  return (

    <DashboardContent>

    </DashboardContent>
  );
}

createRoot(document.getElementById("root")).render(<App />);