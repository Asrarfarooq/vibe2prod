import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  const [products, setProducts] = useState([]);
  const [tab, setTab] = useState("all");
  const [cartCount, setCartCount] = useState(2);
  const [name, setName] = useState("");
  const [aisle, setAisle] = useState("Snacks");
  const [price, setPrice] = useState("4.99");
  const [description, setDescription] = useState("");
  const [goal, setGoal] = useState("Quick healthy weeknight snacks and drinks under $25");
  const [assistantReply, setAssistantReply] = useState("");
  const [loadingConcierge, setLoadingConcierge] = useState(false);

  useEffect(() => {
    const endpoint = tab === "new" ? "/api/newproducts" : "/api/products";
    fetch(endpoint)
      .then((r) => r.json())
      .then(setProducts)
      .catch(() => {});
  }, [tab]);

  async function addProduct(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          aisle: aisle.trim() || "Grocery",
          price: Number(price) || 4.99,
          quantity: 25,
          isNew: true,
          description: description.trim(),
        }),
      });
      if (res.ok) {
        const created = await res.json();
        setProducts([...products, created]);
        setName("");
        setDescription("");
      }
    } catch {
      // Network error
    }
  }

  async function askConcierge() {
    if (!goal.trim() || loadingConcierge) return;
    setLoadingConcierge(true);
    try {
      const res = await fetch("/api/concierge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setAssistantReply(err.error || "Unable to get recommendation at this time.");
        return;
      }
      const data = await res.json();
      setAssistantReply(data.reply || "");
    } catch {
      setAssistantReply("Unable to contact shopping concierge.");
    } finally {
      setLoadingConcierge(false);
    }
  }

  return (
    <div>
      <header className="topbar">
        <div className="brand">
          <img src="/images/logo.png" alt="Cymbal Superstore" />
          <div className="nav-tabs">
            <button
              className={`tab-btn ${tab === "all" ? "active" : ""}`}
              onClick={() => setTab("all")}
            >
              All Inventory
            </button>
            <button
              className={`tab-btn ${tab === "new" ? "active" : ""}`}
              onClick={() => setTab("new")}
            >
              New Arrivals
            </button>
          </div>
        </div>
        <div className="store-meta">
          <span>Store #104 · 465 Turret Ave, Columbus, OH</span>
          <span className="cart-pill">Cart ({cartCount})</span>
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <div>
            <h1>
              {tab === "new"
                ? "New Arrivals at Cymbal Superstore"
                : "Fresh Groceries & Weekly Essentials"}
            </h1>
            <p>
              Cymbal Superstore brings you fresh produce, pantry staples, and local arrivals every week.
            </p>
          </div>
        </section>

        <div className="layout">
          <section>
            <div className="grid">
              {products.map((p) => (
                <article key={p.id} className="card">
                  <div>
                    {p.imgfile && (
                      <img
                        className="product-img"
                        src={p.imgfile}
                        alt={p.name}
                      />
                    )}
                    <div className="badge-row">
                      <span className="aisle-tag">{p.aisle || "Grocery"}</span>
                      {p.quantity === 0 ? (
                        <span className="oos-badge">Out of Stock</span>
                      ) : p.isNew ? (
                        <span className="new-badge">New Arrival</span>
                      ) : null}
                    </div>
                    <h3>{p.name}</h3>
                    <div className="card-desc">
                      {p.description || ""}
                    </div>
                  </div>
                  <div className="card-footer">
                    <div>
                      <div className="price">${Number(p.price).toFixed(2)}</div>
                      <div className="stock">{p.quantity} in stock</div>
                    </div>
                    <button
                      className="btn-primary"
                      disabled={p.quantity === 0}
                      onClick={() => setCartCount((c) => c + 1)}
                    >
                      Add to Cart
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <aside>
            <div className="panel">
              <h2>Cymbal AI Shopping Concierge</h2>
              <textarea
                className="textarea"
                rows={3}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
              <button
                className="btn-primary"
                onClick={askConcierge}
                disabled={loadingConcierge}
              >
                {loadingConcierge ? "Recommending..." : "Recommend Basket"}
              </button>
              {assistantReply && (
                <div className="ai-output">
                  {assistantReply}
                </div>
              )}
            </div>

            <form className="panel" onSubmit={addProduct}>
              <h2>Add Inventory Item</h2>
              <input
                className="input"
                placeholder="Product name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="input"
                placeholder="Aisle (e.g. Produce, Bakery, Snacks)"
                value={aisle}
                onChange={(e) => setAisle(e.target.value)}
              />
              <input
                className="input"
                placeholder="Price (USD)"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
              <input
                className="input"
                placeholder="Short description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <button className="btn-primary" type="submit">
                Add Product
              </button>
            </form>
          </aside>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
