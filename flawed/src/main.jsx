import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    fetch("/api/notes")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to fetch notes");
        return r.json();
      })
      .then(setNotes)
      .catch((err) => console.error(err));
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
        const newNote = await res.json();
        setNotes((prev) => [...prev, newNote]);
        setText("");
      }
    } catch (err) {
      console.error("Failed to add note:", err);
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
    } catch (err) {
      console.error("Failed to summarize notes:", err);
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
