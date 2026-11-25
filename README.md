# Nebula

Requisition Lifecycle & Fulfillment Audit Platform. It records each healthcare requisition from the original WhatsApp photo or PDF through validation, finance, invoicing, pick & pack, dispatch and delivery, and measures Order Fulfillment Rate (OFR) by facility, item and programme.

- Product requirements: [`docs/PRD.md`](docs/PRD.md)
- How V1 implements them, and its limits: [`docs/V1.md`](docs/V1.md)

## V2 (web app on Render)

FastAPI + PostgreSQL backend (`backend/`) with the PRD's rules enforced in the database, Clerk sign-in, OpenRouter document reading with per-user limits and a monthly budget, and the React app (`app/`) built for the web. Deploy with `render.yaml`; step-by-step guide: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## V1 (claude.ai artifact)

V1 runs as a claude.ai artifact: one page with a shared database, file storage and Claude-assisted document reading. Share the artifact to give people access; their share level sets their role (Editor = Administrator, Contributor = Requisition Assistant, Viewer = Supervisor).

## Develop

```bash
cd backend && python -m pytest -q   # V2 API tests (needs a local PostgreSQL)
```

```bash
cd app
npm install
npm test          # domain rule tests
npm run typecheck
npm run build     # V1: writes dist/nebula.html
npm run build:web # V2: writes dist/web/
node e2e/smoke.mjs  # end-to-end run in headless Chromium (preview mode)
```

Opened outside claude.ai, the page runs in preview mode: data stays in that browser and Claude reading is off.

## First run

1. Open the artifact as its owner and go to Administration → Setup.
2. Load the starter master data, then replace or extend facilities and items (CSV paste import is available).
3. Add unit conversions for items that are requested in packs or cartons.
4. Share the artifact with Requisition Assistants (Contributor) and Supervisors (Viewer).
