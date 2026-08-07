import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CanvasRoom — connected whiteboard",
    short_name: "CanvasRoom",
    description: "A local-first whiteboard with iPad pen input, media, and recording.",
    start_url: "/",
    display: "standalone",
    background_color: "#111513",
    theme_color: "#111513",
    orientation: "any",
    categories: ["productivity", "education", "utilities"],
  };
}
