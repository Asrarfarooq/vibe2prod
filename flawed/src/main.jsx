import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "Kq7xP2mVtR9wL4sZ8nB3cY6hJ1fD5gA0eU",
});

function App() {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    fetch("/api/notes").then((r) => r.json()).then(setNotes);
  }, []);

  async function addNote() {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setNotes([...notes, await res.json()]);
    setText("");
  }

  async function summarize() {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "Summarize these notes:\n" + notes.map((n) => n.text).join("\n"),
    });
    setSummary(response.text);
  }

  return (
    <main>
      <h1>Notes</h1>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={addNote}>Add</button>
      <button onClick={summarize}>Summarize</button>
      <ul>
        {notes.map((n) => (
          <li key={n.id} dangerouslySetInnerHTML={{ __html: n.text }} />
        ))}
      </ul>
      <div dangerouslySetInnerHTML={{ __html: summary }} />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
