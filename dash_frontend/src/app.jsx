import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { FileText, Loader2, Search, Send, X, Info } from "lucide-react";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8020";

const SUGGESTIONS = [
  "Find proteomics work on inflammatory skin conditions",
  "Show me RNA-seq projects in metabolic disease",
  "Which projects used Seurat?",
  "Any imaging work on neurodegenerative disease?",
  "Microbiome studies",
];

const starterText = `Hi - I can help you find past DASH work. Ask your question in your own words.`;

// /api/ask streams newline-delimited JSON events. The Worker can hard-crash on
// connect (Cloudflare 1101, no CORS headers -> "Failed to fetch"); retry
// opening the stream a few times. Once it's open we read the body directly.
async function openStream(query, history, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${API_BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 8, history }),
      });
      if (res.ok && res.body) return res;
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
  const [streaming, setStreaming] = useState(false);
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
    setStreaming(false);
    setQuery("");

    // Prior turns for the agent (skip the starter greeting at index 0).
    const history = messages.slice(1).map((m) => ({
      role: m.role === "agent" ? "assistant" : "user",
      text: m.text,
    }));

    setMessages((items) => [...items, { role: "user", text: cleanQuery }]);

    let agentStarted = false;
    try {
      const res = await openStream(cleanQuery, history);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }

          if (evt.type === "matches") {
            // Only emitted when the agent searched, so replace the cards; a
            // chat/follow-up turn emits none and keeps the current ones.
            setResult({ matches: evt.matches });
          } else if (evt.type === "token") {
            if (!agentStarted) {
              agentStarted = true;
              setStreaming(true);
              setMessages((items) => [...items, { role: "agent", text: evt.text }]);
            } else {
              setMessages((items) => {
                const copy = items.slice();
                const last = copy.length - 1;
                copy[last] = { ...copy[last], text: copy[last].text + evt.text };
                return copy;
              });
            }
          } else if (evt.type === "error") {
            throw new Error(evt.error || "The DASH API could not process that search.");
          }
        }
      }
      if (!agentStarted) {
        setMessages((items) => [...items, { role: "agent", text: "Sorry, I didn't get a response. Please try again." }]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      setMessages((items) => [...items, { role: "agent", text: message }]);
    } finally {
      setLoading(false);
      setStreaming(false);
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
          <div className="masthead">
            {/* Drop the official logo in public/usyd-logo.svg to show it here. */}
            <img
              className="masthead-logo"
              src="/usyd-logo.svg"
              alt="The University of Sydney"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
            <p className="masthead-brand">The University of Sydney</p>
            <h1>Charles Perkins Centre Data Science Hub (CPC DASH) Data Analytics Repository</h1>
          </div>

        </header>

        <div className="content-grid">
          <section className="chat-panel" aria-label="Conversation">
            <header className="chat-panel-header">
              <p className="eyebrow">Ask the agent</p>
            </header>

            <div className="messages">
              {messages.map((message, index) => (
                <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                  {message.text}
                </div>
              ))}
              {loading && !streaming && (
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

        {result && result.matches && result.matches.length > 0 && (
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
              {result.matches.slice(0, 4).map((match) => (
                <article className="result-card" key={match.ref_number}>
                  <div className="card-heading">
                    <FileText size={20} />
                    <div>
                      {/* <p>{match.ref_number}</p> */}
                      <h3>{match.title}</h3>
                    </div>
                    {/* <span className="score-badge">Score: {match.score.toFixed(3)}</span> */}
                  </div>

                  <dl style={{ margin: "16px 0 0 0", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div style={{ display: "flex", gap: "8px", fontSize: "14px" }}>
                      <dd style={{ backgroundColor: "#DAA8A2", padding: "10px", borderRadius: "4px", margin: 0, color: "#0f172a" }}>
                        {match.investigators?.lead_data_scientist || formatList(match.investigators?.analyst_team)}
                      </dd>
                    </div>
                    <div style={{ display: "flex", gap: "8px", fontSize: "14px" }}>
                      <dd style={{ backgroundColor: "#FCEDE2", padding: "5px", borderRadius: "4px", margin: 0, color: "#0f172a" }}>
                        {formatList(match.analytical_methods?.primary_methods)}
                      </dd>
                      <dd style={{ backgroundColor: "#FCEDE2", padding: "5px", borderRadius: "4px", margin: 0, color: "#0f172a" }}>
                        {formatList(match.project_details?.data_modality)}
                      </dd>
                    </div>
                    {/* <div style={{ display: "flex", gap: "8px", fontSize: "14px" }}>

                      <dd style={{ backgroundColor: "#e7e9bcff", padding: "5px", borderRadius: "4px", margin: 0, color: "#0f172a" }}>
                        {formatList(match.status || "Not specified")}
                      </dd>
                    </div> */}
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
                <h4>Research leader</h4>
                <p>{formatList(drawerProject.investigators?.research_leader)}</p>
                <h4>Lead Data Scientist</h4>
                <p>{formatList(drawerProject.investigators?.lead_data_scientist)}</p>
                <h4>Analyst team</h4>
                <p>{formatList(drawerProject.investigators?.analyst_team)}</p>
                <h4>Collaborator/s</h4>
                <p>{formatList(drawerProject.investigators?.collaborator)}</p>
              </section>

              <section className="drawer-section">
                <h3>Description</h3>

                <h4>Research area</h4>
                {renderContentList(drawerProject.project_details?.research_area, "No research area.")}

                <h4>Disease</h4>
                {renderContentList(drawerProject.project_details?.disease, "No disease specified.")}

                <h4>Data modality</h4>
                {renderContentList(drawerProject.project_details?.data_modality, "No data modality specified.")}
              </section>

              <section className="drawer-section">
                <h3>Analytical approach</h3>
                <h4>Primary methods</h4>
                {renderContentList(drawerProject.analytical_methods?.primary_methods, "No primary methods specified.")}
                <h4>Programming languages</h4>
                {renderContentList(drawerProject.analytical_methods?.programming_languages, "No programming languages specified.")}
              </section>

              {/* <section className="drawer-section">
                <h3>Key findings</h3>
                <p>{drawerProject.findings?.executive_summary || "No executive summary."}</p>
              </section> */}


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
