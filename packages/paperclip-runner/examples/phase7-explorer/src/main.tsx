import { createRoot } from "react-dom/client";

import {
  buildPhase7ScenarioIndex,
  phase7EvalSuiteLookup,
} from "@paperclip-runner-local/phase7";

import "@paperclipai/paperclip-runner/styles.css";
import "./explorer.css";

import evalReport from "virtual:phase7-eval-report";
import manifestSource from "virtual:phase7-scenario-manifest";

import { ExplorerApp } from "./app.js";

/**
 * Package-local entry. The scenario index and every fixture are bundled from
 * checked-in artifacts, so fake mode performs zero network I/O and holds no
 * Paperclip or provider credential (UX map §1, §5).
 */

const container = document.querySelector("#root");
if (container === null) throw new Error("explorer root element is missing");

const index = buildPhase7ScenarioIndex(manifestSource);

createRoot(container).render(
  <ExplorerApp
    index={index}
    evalSuite={evalReport === null ? undefined : phase7EvalSuiteLookup(evalReport)}
    codexAvailable={false}
  />,
);
