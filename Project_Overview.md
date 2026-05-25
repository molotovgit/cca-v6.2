# Creative Content Automation v6.2 — Project Overview

Welcome to the **Creative Content Automation** project. This Obsidian vault provides a structured view of the repository and its documentation.

## 🗺️ Map of Content (MOC)

### 🚀 Getting Started
- [[docs/user/QUICKSTART|Quick Start]] — Get up and running in 5 minutes.
- [[docs/user/SETUP|Setup Guide]] — Detailed installation and configuration.
- [[docs/user/RUN|Execution Guide]] — How to run the pipeline and batch jobs.

### 🏗️ Core Architecture
- [[docs/core/ARCHITECTURE|System Architecture]] — Deep dive into the 5-stage pipeline.
- [[docs/core/CLAUDE|Claude/AI Orientation]] — Essential reading for AI assistants.
- [[docs/user/GUIDE|User Guide]] — Detailed functional overview.

### 🛠️ Operations & Maintenance
- [[docs/ops/DEPLOYMENT|Deployment Guide]] — Multi-host scaling with MeshCentral.
- [[docs/ops/TROUBLESHOOTING|Troubleshooting]] — Common issues and fixes.

### 🧠 Workspace Memory
- [[MEMORY_INDEX|Memory Index]] — Start here for current context and issue priority.
- [[MASTER_MEMORY|Master Memory]] — Durable project operating memory.
- [[ROADMAP|Roadmap]] — Phased stabilization plan.
- [[WISHLIST|Wishlist]] — Backlog ideas and follow-ons.
- [[docs/core/FLOW_VIDEO_IMPLEMENTATION_PLAN|Flow Video Plan]] — Implementation-ready Flow-first video plan.

---

## 📁 Repository Structure

- `src/` — Source code
    - `python/` — Pipeline stages, drivers, and auth.
    - `node/` — Orchestrators, workers, and dashboard.
- `config/` — Configuration templates and prompt formulas.
- `data/` — Generated content (chapters, images, zips).
- `docs/` — Documentation (this vault's content).
- `deploy/` — Deployment templates.

---

## 📊 Live Status
- Dashboard: [http://localhost:7777](http://localhost:7777) (when running)
