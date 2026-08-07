"use client";

import { ArrowRight, MonitorUp, TabletSmartphone, Video } from "lucide-react";

type WelcomeCardProps = {
  onStart: () => void;
  onConnect: () => void;
};

export function WelcomeCard({ onStart, onConnect }: WelcomeCardProps) {
  return (
    <section className="welcome-card" aria-labelledby="welcome-title">
      <span className="eyebrow">A calmer place to think out loud</span>
      <h1 id="welcome-title">Your ideas, in motion.</h1>
      <p>
        Draw naturally, bring references onto the board, connect an iPad, and record the whole explanation without leaving your workspace.
      </p>
      <div className="welcome-actions">
        <button className="primary-button" onClick={onStart}>Start drawing <ArrowRight size={16} /></button>
        <button className="secondary-button" onClick={onConnect}><TabletSmartphone size={15} /> Connect iPad</button>
      </div>
      <div className="shortcut-grid" aria-label="CanvasRoom highlights">
        <div className="shortcut-card">
          <TabletSmartphone size={15} />
          <strong>Pencil-ready</strong>
          <span>Pressure-aware ink with palm rejection.</span>
        </div>
        <div className="shortcut-card">
          <MonitorUp size={15} />
          <strong>Bring context</strong>
          <span>Images, files, videos, and links stay close.</span>
        </div>
        <div className="shortcut-card">
          <Video size={15} />
          <strong>Record the story</strong>
          <span>Board, voice, and a shaped camera bubble.</span>
        </div>
      </div>
    </section>
  );
}
