import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../app/globals.css";
import { ClientErrorBoundary } from "../components/board/ClientErrorBoundary";
import { WhiteboardApp } from "../components/board/WhiteboardApp";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("CanvasRoom could not find its application root.");
}

createRoot(rootElement).render(
  <StrictMode>
    <ClientErrorBoundary>
      <WhiteboardApp />
    </ClientErrorBoundary>
  </StrictMode>,
);
