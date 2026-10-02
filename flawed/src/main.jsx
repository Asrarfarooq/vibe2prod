import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    fetch("/api/notes")
      .then((r) => r.json())
      .then(setNotes)
      .catch(() => {});
  }, []);

  async function addNote() {
    if (!text.trim()) return;
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const note = await res.json();
        setNotes((prevNotes) => [...prevNotes, note]);
        setText("");
      }
    } catch {
      // ignore
    }
  }

  async function summarize() {
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary || "");
      }
    } catch {
      // ignore
    }
  }

  return (
    <main>
      <h1>Notes</h1>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={addNote}>Add</button>
      <button onClick={summarize}>Summarize</button>
      <ul>
        {notes.map((n) => (
          <li key={n.id}>{n.text}</li>
        ))}
      </ul>
      <div style={{ whiteSpace: "pre-wrap" }}>{summary}</div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
