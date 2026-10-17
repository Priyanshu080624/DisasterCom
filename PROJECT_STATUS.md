# DisasterMesh Sentinel: Project Overview & Task Execution Roadmap

---

## 1. Executive Summary & Project Context

**DisasterMesh Sentinel** is a resilient, delay-tolerant communication and tactical response system engineered for disaster environments where conventional infrastructure—cellular towers, fiber lines, and power grids—has suffered catastrophic failure.

During disasters (hurricanes, earthquakes, floods), first responders and civilians cannot rely on persistent internet connections. DisasterMesh bridges this gap by combining:
1. **Peer-to-Peer Mobile Mesh Networking:** Mobile devices exchange disaster incident reports, resource requests, and telemetry over localized links (Bluetooth Low Energy and Wi-Fi Direct) using Delay-Tolerant Networking (DTN) and store-and-forward bundle routing.
2. **Deterministic & ML-Driven Priority Triage:** Incidents are classified into priority tiers (**P0 Critical** down to **P3 Routine**) to ensure life-saving medical and rescue bundles travel first through bandwidth-constrained mesh hops.
3. **Gateway Backend & Command Center:** Field gateways collect bundles and sync them into a FastAPI central coordination hub.
4. **Real-Time Tactical Dashboard:** A desktop command center built with React, Vite, TypeScript, and MapLibre GL for dispatchers to track incidents, visualize the mesh topology, and allocate relief resources.

```
                           DISASTER ZONE (OFFLINE MESH)
   [Mobile Node A] <---- BLE / Wi-Fi Direct ----> [Mobile Node B]
          │                                              │
          │ Store & Forward                              │ Multi-Hop
          ▼                                              ▼
   [Mobile Node C] <-----------------------------> [Gateway Node]
                                                         │
─────────────────────────────────────────────────────────┼───────────────────────────
                           COMMAND CENTER (ONLINE)       ▼
                                                  [FastAPI Gateway]
                                                  (:8000 / SQLite)
                                                    │         │
                        WebSocket / REST Invalidation         │ REST API
                                                    │         ▼
                                            [Dashboard]   [AI Service]
                                            (:5173 / UI)  (:8001 / ML)
```

---

## 2. Architecture & Tech Stack

| Layer | Technologies | Role |
|---|---|---|
| **Mesh Protocol** | Python 3.12, Ed25519, AES-GCM, Pydantic | Secure bundle encapsulation, store-and-forward routing, peer discovery, TTL expiry. |
| **Priority Engine** | Python, deterministic rules + ML proposer | Multi-tier priority assignment (P0 life-threat floor = 85, down to P3 info). |
| **Gateway Backend** | FastAPI, SQLite, SQLAlchemy, WebSockets | REST API (:8000), push invalidations over WebSocket `/v1/ws/incidents`. |
| **AI Service** | FastAPI (:8001), Scikit-Learn | Incident classification, triage recommendations, duplicate clustering. |
| **Command Dashboard** | React 18, Vite, TypeScript, TanStack Query | Real-time incident inbox, map telemetry, mesh simulation, dispatcher tools. |
| **Mobile Client** | Android (Kotlin, Jetpack Compose) | Peer-to-peer mesh node, local SQLite store, Nearby Connections API. |

---

## 3. High-Level Task Roadmap & Current Status

The user identified 4 key operational goals:
1. Fix connection drops and glitches between dashboard and nodes.
2. Add a visual dashboard connection quality indicator.
3. Build a working interactive animation showing N communicating phones, node failure, and dynamic packet rerouting.
4. Replace the mock AI triage model with a fine-tuned/trained ML model (supporting English/Hindi/Tamil) and wire it into the backend.

These were broken down into 5 sequential tasks:

```
[Task 1: Fix Socket Reliability]    ──►  ✅ COMPLETED & VERIFIED
                 │
[Task 2: Dashboard Quality Badge]   ──►  🟡 IN PROGRESS (~40%)
                 │
[Task 3: Dynamic Mesh Animation]    ──►  ⏳ YET TO BE DONE
                 │
[Task 4: ML Triage Model]           ──►  ⏳ YET TO BE DONE
                 │
[Task 5: Wire ML into Backend/AI]   ──►  ⏳ YET TO BE DONE
```

---

## 4. Deep Dive: Completed Tasks

### ✅ Task 1: Fix `useIncidentSocket.ts` Reliability & Glitches
- **File:** `dashboard/src/hooks/useIncidentSocket.ts`
- **Status:** **100% COMPLETE & VERIFIED**
- **Root Cause & Fixes:**
  1. **Teardown Render Loop (Primary Glitch Cause):** `onIncidentCreated` was listed in the `useEffect` dependency array. Whenever parent components re-rendered with a new function reference, the WebSocket was forcibly closed and reopened. **Fixed** by storing the callback in a `useRef(onIncidentCreated)` and keeping the effect dependency array strictly stable `[queryClient]`.
  2. **Stuck Backoff Ceiling:** When reconnecting after an outage, the `attempt` counter was never reset. Even on healthy reconnects, any subsequent single blip resulted in waiting the maximum 20-second delay. **Fixed** by adding `attempt = 0;` inside `socket.onopen`.
  3. **Silent TCP Dropouts:** On mobile networks, WiFi sleep, or NAT proxy timeouts, connections dropped silently without triggering `onclose`. **Fixed** by implementing a 25-second active heartbeat ping (`{"type": "ping"}`) that terminates dead sockets and triggers fast reconnection.
  4. **Background Tab Sleep:** Mobile OS and desktop browsers freeze inactive tabs. **Fixed** with a `visibilitychange` listener that triggers instant reconnection when the user returns to the tab.
- **Verification:**
  - `npm --prefix dashboard run build`: Built cleanly in 3.48s (0 TypeScript errors).
  - `npm --prefix dashboard run test`: 13/13 Vitest unit tests passed.

---

## 5. Tasks in Progress & Yet to be Done

### 🟡 Task 2: Add Dashboard Connection Quality Indicator
- **Estimated Duration:** 20 min
- **Current Progress:** **~40%**
- **Objective:** Give command operators immediate visual feedback on gateway connectivity without needing to guess if incoming data is real-time push or delayed polling fallback.
- **What is Done:**
  - Updated `useIncidentSocket.ts` to export `status: "connected" | "reconnecting" | "offline"`.
  - Added an internal grace timer (`MAX_BACKOFF_MS + 2000`) before downgrading to `"offline"`.
- **Remaining Work:**
  - **`App.tsx` Integration:** Render the status badge in the command rail HUD:
    - 🟢 **LIVE PUSH** (`connected`): Low-latency WebSocket active.
    - 🟡 **RECONNECTING** (`reconnecting`): Backing off with jitter, polling fallback active.
    - 🔴 **POLLING ONLY** (`offline`): Gateway push unreachable; fallback polling keeping system operational.
  - **Thundering Herd Prevention:** Add `±500ms` jitter to `REFRESH_MS` polling intervals in `App.tsx`.
  - **Styling (`app.css`):** Add tactile badge styles and animated pulse indicators.
  - **Testing & Verification:** Run build and unit tests.

---

### ⏳ Task 3: Interactive MeshSimulation Animation
- **Estimated Duration:** 2 hours
- **Current Progress:** **0% (Pending)**
- **Objective:** Replace the static scripted scenario player in `MeshSimulation.tsx` with a dynamic, interactive canvas/SVG simulation that demonstrates how the mesh adapts when mobile phones lose signal.
- **Planned Capabilities:**
  - **Configurable Dynamic Nodes:** Configurable topology of $N$ nodes (3 to 10 mobile devices) placed in spatial coordinates.
  - **Interactive Node Toggling:** Operator can click any node to simulate battery death, destruction, or out-of-range status.
  - **Dynamic Shortest Path Routing:** Live Dijkstra / Bellman-Ford algorithm calculating the active multi-hop path from Source to Gateway in real time.
  - **Animated Packets:** Visual packets traveling along active mesh links with hop delay simulation.
  - **Dynamic Rerouting Visuals:** When an intermediate node goes offline mid-transit:
    - Red failure ring / drop marker at the dead node.
    - Path automatically recalculates and highlights the new alternate route in real time.
    - Visual packet re-transmits along the newly discovered path.
  - **Telemetry HUD:** Live readout of current hop count, latency, dropped packets, and route re-convergence event log.

---

### ⏳ Task 4: Training Data + ML Triage Model
- **Estimated Duration:** 1 hour
- **Current Progress:** **0% (Pending)**
- **Objective:** Replace the placeholder mock AI classification with a fast, dependency-light machine learning model trained to prioritize distress calls based on real disaster semantics.
- **Planned Capabilities:**
  - **Dataset Creation (`protocol/dms/ai/training_data.py`):**
    - ~200+ curated synthetic disaster messages across critical categories:
      - Trapped victims / structural collapse (P0 Critical)
      - Severe hemorrhaging / medical trauma (P0 Critical)
      - Rising flood waters / stranded civilians (P1 Urgent)
      - Food / drinking water shortages (P2 Operational)
      - General status checks / minor queries (P3 Routine)
    - Multilingual coverage: English, Hindi, and Tamil phrases.
  - **Scikit-Learn Classifier (`protocol/dms/ai/ml_triage.py`):**
    - TF-IDF vectorizer + Logistic Regression / Linear SVM.
    - Predicts Priority Class (P0–P3) and Confidence Score.
    - Proposes resource allocations (Rescue Team, Boat, Ambulance, Supplies).
  - **Evaluation & Training Script (`scripts/train_triage_model.py`):**
    - Trains and serializes the model to disk (`artifacts/triage_model.joblib`).
    - Reports precision, recall, and F1-score across all 4 priority classes.

---

### ⏳ Task 5: Wire ML Model into Backend & AI Service
- **Estimated Duration:** 30 min
- **Current Progress:** **0% (Pending)**
- **Objective:** Connect the trained ML model directly into the live ingestion and recommendation pipelines.
- **Planned Capabilities:**
  - **AI Service Endpoint:** Update `ai-service/app/main.py` `/v1/triage` endpoint to load the serialized model and perform real-time inferences.
  - **Backend Fallback Ingestion:** Wire `backend/app/main.py` `_classify_text()` to use the ML triage model when `DMS_AI_MODE=ml`.
  - **Integration Verification:** Submit sample distress reports (in English, Hindi, and Tamil) to verify that high-severity distress messages automatically trigger P0 priority classification and immediate rescue resource proposals in the dashboard.

---

## 6. Verification & Quality Gates

Every task must pass strict validation before proceeding to subsequent tasks:
1. **Frontend:** `npm --prefix dashboard run build` (tsc zero-error check) and `npm --prefix dashboard run test` (Vitest suites).
2. **Backend & Protocol:** `pytest protocol`, `pytest backend`, and `pytest ai-service/tests`.
3. **Sequential Agreement:** Explicit user sign-off required prior to beginning each task.
