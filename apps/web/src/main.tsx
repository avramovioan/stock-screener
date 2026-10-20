import "@/lib/zod-config";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/providers";
import { registerServiceWorker } from "@/register-sw";
import { router } from "@/router";
import "@/styles/index.css";
import "@/styles/status.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);

registerServiceWorker();
