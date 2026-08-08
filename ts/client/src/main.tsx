/**
 * main.tsx — mount the window.
 *
 * Nothing else belongs here. The page is one component; everything it needs
 * comes from the server on the first fetch.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const host = document.getElementById("root");
if (!host) throw new Error("index.html has no #root to mount into");
createRoot(host).render(<StrictMode><App /></StrictMode>);
