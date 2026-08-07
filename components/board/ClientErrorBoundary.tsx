"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ClientErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("CanvasRoom recovered from an interface error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-shell" style={{ display: "grid", placeItems: "center", color: "white", padding: 24 }}>
        <section style={{ width: "min(460px, 100%)", padding: 28, border: "1px solid rgba(255,255,255,.12)", borderRadius: 20, background: "#1b211e" }}>
          <span className="eyebrow">The board paused safely</span>
          <h1 style={{ margin: "8px 0", letterSpacing: "-.04em" }}>Something interrupted this view.</h1>
          <p style={{ color: "#aeb7b1", fontSize: 13, lineHeight: 1.6 }}>Your last locally saved board is still available. Reload the workspace to continue.</p>
          <button className="primary-button" onClick={() => window.location.reload()}>Reload workspace</button>
        </section>
      </main>
    );
  }
}
