import { ClientErrorBoundary } from "../components/board/ClientErrorBoundary";
import { WhiteboardApp } from "../components/board/WhiteboardApp";

export default function Home() {
  return (
    <ClientErrorBoundary>
      <WhiteboardApp />
    </ClientErrorBoundary>
  );
}
