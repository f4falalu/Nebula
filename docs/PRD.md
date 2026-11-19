# REQUISITION LIFECYCLE & FULFILLMENT AUDIT PLATFORM
## Product Requirements Document (PRD)

**Version:** 2.0
**Date:** 18 November 2026
**Status:** Implementation-ready draft

---

# 0. Document Conventions

- **MUST** marks a mandatory requirement. **SHOULD** marks a strong recommendation. **MAY** marks something optional.
- The platform has three separate state models: **Record Status**, **Lifecycle Stage** and **Fulfillment Status**. They are defined in Section 5 and are never merged. Wherever this document says "status" without a qualifier, the qualifier is given by context and the three models must not be confused.
- All timestamps are stored in UTC (`timestamptz`). All business dates, date buckets (day/week/month/quarter/year) and the date component of the requisition number use the **Africa/Lagos** timezone.
- "Base quantity" means a quantity converted into the item's base unit using an approved unit conversion (Section 19).
- "Effective record" means an append-only record (lifecycle event or fulfillment record) that has not been superseded by a correction or void (Section 12.8 and Section 20.8).
- "Official reporting scope" is defined in Section 21.9.

---

# 1. Product Overview

The Requisition Lifecycle & Fulfillment Audit Platform is a standalone audit, visibility, and fulfillment tracking layer around the existing requisition and supply process.

The platform does not replace mSupply or any existing ERP/WMS.

mSupply remains the operational system used for transactions such as invoicing, pick-slip generation, stock management, and financial/warehouse operations.

The platform captures and maintains the lifecycle of requisitions from receipt through fulfillment so that management can answer:

- What was requested?
- When was it requested?
- When was it received?
- When was it entered into the system?
- Who processed it?
- Was it validated?
- Was Finance completed?
- Was it invoiced?
- Was it picked/issued?
- Was it dispatched?
- What quantity was actually fulfilled?
- What evidence supports each stage?
- Where did fulfillment drop?
- How long did each stage take?
- What is the fulfillment performance of each facility?
- What is the historical fulfillment performance of each item?
- What is the overall Order Fulfillment Rate (OFR)?
- What is the audit history of every change?

The platform therefore acts as an operational visibility and audit layer around the existing workflow.

---

# 2. Core Objective

The primary objective is to create a reliable digital record of the requisition lifecycle and fulfillment performance without requiring the organization to replace its existing operational systems.

The platform establishes a single searchable record for each requisition containing:

1. Original requisition document
2. Extracted requisition information
3. Corrected/validated information
4. Facility, item and programme matching
5. Lifecycle events
6. Supporting evidence
7. Requested quantities
8. Invoiced quantities
9. Issued/picked quantities
10. Delivered quantities
11. Order Fulfillment Rate
12. Facility and item history
13. Audit trail

---

# 3. Product Principles

## 3.1 Auditability First

Every material action MUST leave an audit trail (Section 30).

The system must be able to answer:

- What changed?
- Who changed it?
- When did they change it?
- What was the previous value?
- What is the new value?
- Why was it changed?
- What evidence supports the change?

## 3.2 Preserve the Original Source

The original requisition document MUST remain unchanged. The platform never overwrites, replaces, or modifies an uploaded file. The original file is the immutable source document for the requisition.

## 3.3 Human-in-the-Loop

OCR, computer vision, LLMs, and matching algorithms provide suggestions. They never become the authoritative source automatically. The Requisition Assistant (RA) is responsible for reviewing and confirming extracted information.

## 3.4 Operational System vs Audit System

mSupply performs operational transactions. The platform records and tracks those transactions and their supporting evidence.

The platform does not generate invoices, pick slips, stock transactions or financial transactions unless a future integration explicitly introduces such functionality.

## 3.5 History Is Append-Only

Lifecycle events, fulfillment records, documents and audit events are append-only. A mistake is corrected by adding a new record that supersedes the old one, with a reason. History is never silently edited or deleted. This is enforced in the database, not only in the user interface.

## 3.6 Reported Figures Are Honest About Their Coverage

A figure the platform cannot calculate safely, for example because a unit conversion is unknown, is left out of the calculation and reported as a coverage gap. It is never treated as zero and never hidden.

---

# 4. Product Boundary

The platform is NOT:

- A replacement for mSupply
- A WMS
- An invoicing system
- A stock-management system
- A financial accounting system
- A routing platform
- A fleet-management system

It is a:

**Requisition Lifecycle + Fulfillment + Audit + Visibility Platform**

---

# 5. Core Concepts: Three Separate State Models

Every requisition carries three independent states. They answer different questions and change for different reasons.

| Model | Question it answers | Values | Stored as |
|---|---|---|---|
| **Record Status** | Is the requisition's *data* complete, trustworthy and locked? | Draft → Processing → Validation Pending → Validated → Finalized → Reopened → Cancelled | `requisition.record_status` |
| **Lifecycle Stage** | How far has the requisition progressed *operationally*? | Received → Entered → Validated → Finance → Invoicing → Pick & Pack → Dispatched → Completed | Derived from foundational timestamps plus `lifecycle_event` records |
| **Fulfillment Status** | Is the *capture of fulfillment quantities* complete for reporting? | Open → Partial → Closed | `requisition.fulfillment_status` |

Rules:

- The three models MUST NOT be merged into one status field.
- **Validated** appears in both Record Status and Lifecycle Stage. The lifecycle stage "Validated" is derived from the first time the record reached Record Status Validated (`first_validated_at`). It is not recorded separately.
- **Closed** fulfillment does NOT mean 100% fulfilled. It means fulfillment capture for that requisition is complete and its figures are final for reporting. A requisition can be `Fulfillment Status = Closed` with `Issued OFR = 70%`.
- **Completed** (lifecycle) means the operational process has ended. It does not by itself close fulfillment. Closing fulfillment is a separate, explicit action (Section 20.9).

Example of one requisition at one moment:

- Record Status: Finalized
- Current Lifecycle Stage: Dispatched
- Fulfillment Status: Partial

---

# 6. Users, Roles and Permissions

## 6.1 Roles

The platform has three roles. A user may hold more than one role. Roles are granted and revoked by an Administrator and every grant/revocation is audited.

### Requisition Assistant (RA)

The RA is the primary operational user and maintains the digital audit trail for the requisition lifecycle. The RA's permissions are listed in Section 6.3.

### Administrator

The Administrator controls the system: users, roles, master data, aliases, unit conversions, substitution equivalences, settings, reopening finalized records and approving edit requests. An Administrator can also perform all RA actions.

### Supervisor / Management

Supervisors and management are **view-only by default**. They can view and search all requisitions, histories, dashboards, analytics, lifecycle history and the audit log, and can view documents in the browser. They cannot create, change, record, approve or download anything unless an elevated permission is explicitly granted (Section 6.2).

## 6.2 Elevated Permission Grants

Any permission beyond a role's default MUST be granted explicitly. It is never implied.

Grantable permissions:

| Permission | Effect | Grantable to |
|---|---|---|
| `requisition.reopen` | Reopen a finalized requisition (Section 10.6) | Supervisor |
| `edit_request.approve` | Approve or reject edit requests (Section 11) | Supervisor |
| `documents.download` | Download original and evidence files | Supervisor |

Each grant records who granted it, when, an optional expiry, and when it was revoked. Grants and revocations are audited. Only Administrators can grant or revoke.

## 6.3 Permission Matrix

✓ = allowed by default. G = allowed only with an explicit grant (Section 6.2). — = not allowed.

| Action | RA | Supervisor | Admin |
|---|---|---|---|
| View/search requisitions, facility history, item history, dashboards, analytics | ✓ | ✓ | ✓ |
| View the requisition-level audit history (on the requisition page) | ✓ | ✓ | ✓ |
| View the global audit log | — | ✓ | ✓ |
| View original and evidence documents in the browser | ✓ | ✓ | ✓ |
| Download original and evidence documents | ✓ | G | ✓ |
| Export analytics/tables | ✓ | ✓ | ✓ |
| Upload a requisition / create a requisition record | ✓ | — | ✓ |
| Review and correct extraction; edit header and lines while not Finalized | ✓ | — | ✓ |
| Validate a requisition | ✓ | — | ✓ |
| Finalize a requisition | ✓ | — | ✓ |
| Cancel a requisition that is not Finalized and has no effective fulfillment records | ✓ | — | ✓ |
| Cancel a Finalized requisition, or one with effective fulfillment records | — | — | ✓ |
| Record lifecycle events (Finance → Completed) | ✓ | — | ✓ |
| Record fulfillment quantities | ✓ | — | ✓ |
| Upload evidence documents | ✓ | — | ✓ |
| Correct/void lifecycle events or fulfillment records while fulfillment is not Closed | ✓ | — | ✓ |
| Correct/void lifecycle events or fulfillment records after fulfillment is Closed | Approved edit request only | — | Via reopening fulfillment (Section 20.9) |
| Close fulfillment | ✓ | — | ✓ |
| Reopen closed fulfillment | — | — | ✓ |
| Submit an edit request for a Finalized requisition | ✓ | — | — (Admins use Reopen) |
| Approve/reject an edit request | — | G | ✓ |
| Reopen a Finalized requisition | — | G | ✓ |
| Propose facility/item aliases (created as candidates from RA matching choices) | ✓ | — | ✓ |
| Approve aliases | — | — | ✓ |
| Propose a unit conversion or substitution equivalence | ✓ | — | ✓ |
| Approve/retire unit conversions and substitution equivalences | — | — | ✓ |
| Manage facilities, items, programmes; import master data | — | — | ✓ |
| Manage users, roles and grants | — | — | ✓ |
| Change system settings (e.g. OFR threshold) | — | — | ✓ |
| Retry failed processing jobs | ✓ | — | ✓ |

## 6.4 Permission Rules

- Nobody can approve their own edit request. This is enforced in the database (`decided_by ≠ requested_by`).
- Administrators change Finalized data only through Reopen (Section 10.6), never by editing directly.
- Every document download is audited, whoever performs it.
- Permission checks are performed by the API on every request. The UI hides actions a user cannot perform, but the UI is never the enforcement point.

---

# 7. Authentication and Authorization

Authentication may be handled by an external provider such as Clerk. The platform links each authenticated identity to its own `user` record through `external_auth_id`.

Authorization is controlled entirely by the platform's own role and grant model (Section 6). Access follows least-privilege principles. A deactivated user cannot sign in to the platform, but their historical actions remain attributed to them.

---

# 8. Date and Time Definitions

The platform distinguishes the following dates and timestamps. Each has a single authoritative source.

## 8.1 Requisition Date

- The date written on the original facility requisition. It is a date, not a timestamp.
- Normally extracted from the document and confirmed by the RA.
- If missing or illegible, the RA enters it manually. If the RA estimates it, `requisition_date_estimated = true` and the date is shown as estimated everywhere.
- It MUST NOT be later than the date of `received_at`.
- Metrics that start from the requisition date exclude estimated dates from averages by default, and report how many were excluded.

## 8.2 Received At

- The date/time the requisition was received, for example the WhatsApp message timestamp.
- Entered by the RA when the requisition record is created. It is required.
- It MUST NOT be in the future and MUST NOT be later than `entry_at`.
- `received_at` is the authoritative timestamp for the **Received** lifecycle stage.
- It is editable before finalization (audited). After finalization it is protected (Section 10.5).

## 8.3 Entry At

- The date/time the RA registered the requisition in the platform.
- Generated automatically by the system when the requisition record is created. Never user-editable, never changed.
- `entry_at` is the authoritative timestamp for the **Entered** lifecycle stage.

## 8.4 First Validated At

- System timestamp of the first time the record reached Record Status Validated.
- Never changed by later re-validation (re-validations are in the audit log).
- `first_validated_at` is the authoritative timestamp for the **Validated** lifecycle stage.

## 8.5 Occurred At

- The actual date/time an operational event or fulfillment happened, for example the invoice time in mSupply.
- Entered by the RA when recording the event, so events can be recorded after they happened.
- Validated according to Section 12.7.

## 8.6 Recorded At

- System timestamp of when the RA recorded the event or fulfillment in the platform.
- Generated by the database. Immutable.
- `recorded_at − occurred_at` is the **Recording Latency** (Section 22.4).

Example:

- Invoice created in mSupply: 18 Nov 2026, 10:30 → `occurred_at`
- RA records it in the platform: 19 Nov 2026, 14:20 → `recorded_at`
- Recording latency: 1 day 3 h 50 min

Keeping both timestamps lets the organization separate **operational delay** from **administrative recording delay**.

---

# 9. Requisition Number

Each requisition receives a unique, system-generated requisition number when the record is created.

**Format:** `REQ-YY-MM-DD_NNN`

**Example:** `REQ-26-11-19_001`

Rules:

- The date component is the **entry date** (`entry_at` in Africa/Lagos), not the facility requisition date.
- The serial starts at `001` each entry day and is zero-padded to at least three digits. It is not capped: after `_999` comes `_1000`.
- The serial MUST be generated by a database-backed per-day counter inside the same transaction that creates the requisition (for example `UPDATE requisition_number_counter SET last_serial = last_serial + 1 WHERE entry_date = … RETURNING last_serial`, inserting the day's row if absent). Concurrent users can never receive the same number. A unique constraint on `requisition_number` is a second safeguard.
- Numbers are never reused. A cancelled requisition keeps its number. Gaps in the sequence are acceptable and expected only from cancelled or rolled-back creations.
- The requisition number is immutable.

---

# 10. Record Status, Validation and Finalization

## 10.1 Record Status Values

| Record Status | Meaning | Editable by RA? | In official reporting? |
|---|---|---|---|
| **Draft** | Record created, number assigned, document uploaded or being uploaded | Yes | No |
| **Processing** | OCR/extraction job queued or running | No (waiting for job) | No |
| **Validation Pending** | Extraction finished (or failed, or skipped) and awaits RA review | Yes | No |
| **Validated** | RA has reviewed and confirmed all required data; validation checks pass | Yes (any change returns it to Validation Pending) | No |
| **Finalized** | Data locked; record is official for reporting | No (edit request needed) | Yes |
| **Reopened** | Finalized record unlocked by an authorized user for correction | Yes | No (excluded until finalized again) |
| **Cancelled** | Record withdrawn (duplicate, uploaded in error, etc.). Terminal | No | No |

## 10.2 Allowed Transitions

| From | To | Who | Condition |
|---|---|---|---|
| Draft | Processing | System | Extraction job queued |
| Draft | Validation Pending | RA/Admin | Manual entry without OCR |
| Processing | Validation Pending | System | Job completed or failed (failure recorded; RA may retry or enter data manually) |
| Validation Pending | Validated | RA/Admin | All validation checks pass (Section 10.3) |
| Validated | Validation Pending | System | Any header or line change after validation |
| Validated | Finalized | RA/Admin | All finalization conditions pass (Section 10.4) |
| Finalized | Reopened | Admin, or Supervisor with `requisition.reopen` | Reason required |
| Reopened | Validated | RA/Admin | All validation checks pass |
| Any except Cancelled | Cancelled | Per Section 6.3 | Reason required |

Every transition is written to the audit log with the actor, time and (where required) reason.

## 10.3 Validation

Validation means the RA has reviewed and confirmed the extracted requisition information. **Validation is a data-quality state.** It does not mean invoiced, picked, dispatched or completed.

Validation checks (all MUST pass):

- Facility matched to the Facility master (`facility_id` set).
- Requisition date present (estimated is allowed if flagged).
- `received_at` present, not in the future, not later than `entry_at`, and its date not earlier than the requisition date.
- At least one requisition line.
- Every line has: a matched item (`item_id`), a programme (`programme_id`), `quantity_requested > 0`, and `unit_requested`.
- Every line has a conversion status: `resolved` (base quantity calculated) or `unknown`/`incompatible` (flagged, Section 19.3).
- No processing job for the record is queued or running.

## 10.4 Finalization

Finalization means the record has been reviewed and locked. Only Finalized requisitions are part of official reporting (Section 21.9).

Finalization conditions:

- Record Status is Validated.
- All validation checks still pass.
- The original requisition document is stored with a verified checksum.

On finalization the system records `finalized_at` and `finalized_by`.

## 10.5 What Finalization Locks

After finalization the following are locked against all changes except through an approved, unexpired edit request (Section 11) or a Reopen (Section 10.6):

- **Header fields:** facility, facility extracted text, primary programme, requisition date, requisition-date-estimated flag, received at.
- **Requisition lines:** adding, removing or changing any line field (item, programme, quantity, unit, strength, form, pack size, extracted/corrected text).
- **Page-level programme assignments.**

Always immutable, whatever the status: requisition number, entry at, first validated at, created by.

Not locked by finalization (because they are new append-only records, not changes to finalized data):

- Recording lifecycle events, fulfillment records and evidence, and their corrections, while Fulfillment Status is not Closed (Section 20.9).

One system update to finalized lines is permitted: **conversion resolution**. When an Administrator approves a unit conversion that was previously unknown, the system may fill in `base_quantity_requested`, `base_unit` and `conversion_id` for lines whose conversion status was `unknown`, setting it to `resolved`. The original quantity and unit are never touched. Each such update writes an audit event.

The lock MUST be enforced by the database (triggers that reject updates to locked columns unless the transaction carries a valid edit-request or reopen context), not only by the application.

## 10.6 Reopening

A Finalized requisition may be reopened by an Administrator or by a Supervisor with the `requisition.reopen` grant.

- A reason is required. The actor, time and reason are audited.
- While Reopened, the record is editable by RA and Admin and is **excluded from official reporting**. Dashboards show how many requisitions are excluded because they are under correction.
- Lifecycle events and fulfillment records can still be recorded while Reopened (they are append-only), but a line with fulfillment records cannot be deleted.
- To return to official reporting, the record must pass validation again and be finalized again.

Reopening is for broad corrections. For a small, specific change by an RA, the edit-request route (Section 11) keeps the record Finalized and in reporting.

## 10.7 Cancellation

- A reason is required and audited.
- Cancelled requisitions remain searchable and visible with their full history but are excluded from all reporting.
- Cancellation is terminal.

---

# 11. Edit Requests and Controlled Edit Permission

## 11.1 Purpose

If an RA needs to change a Finalized requisition, or to correct fulfillment after Fulfillment Status is Closed, the RA submits an Edit Request. The record stays Finalized and in official reporting throughout.

## 11.2 Submitting

An edit request MUST include:

- **Reason.**
- **Requested changes:** a list of items, each with entity type (requisition header, requisition line, page programme, lifecycle event, fulfillment record), entity ID (blank for a new line or record), field, current value and proposed value.

## 11.3 Decision

- Approved or rejected by an Administrator, or a Supervisor with `edit_request.approve`.
- **The requester can never approve or reject their own request.**
- A rejection requires a rejection reason.
- An approval opens a time-bound edit window. Its length is a system setting (default 24 hours).

## 11.4 Using the Permission

- While the window is open, the requester can change **only** the approved entities/fields on that requisition.
- The permission is single-use. It closes as soon as the authorized save succeeds.
- Every change made under the permission is audited with a link to the edit request. If a saved value differs from the proposed value, the difference is visible in the audit record.
- Fulfillment and lifecycle corrections made under an edit request are still new correction/void records (Section 12.8, Section 20.8), never in-place edits.

## 11.5 Edit Request Status

| Status | Meaning |
|---|---|
| Pending | Submitted, awaiting a decision |
| Approved | Approved; edit window open |
| Rejected | Rejected, with reason |
| Used | Authorized save completed; permission closed |
| Expired | Edit window closed without use, or a pending request passed its pending timeout (setting, default 7 days) |
| Withdrawn | Withdrawn by the requester before a decision |

The entity records requested, decided, used and closed timestamps (Section 31).

---

# 12. Lifecycle Stages and Lifecycle Events

## 12.1 Stages

Received → Entered → Validated → Finance → Invoicing → Pick & Pack → Dispatched → Completed

## 12.2 Foundational Stages (Derived)

The first three stages are derived from the requisition's authoritative timestamps. They have no lifecycle event records, so they can never conflict with those timestamps.

| Stage | Occurred at | Recorded at | Recorded by |
|---|---|---|---|
| Received | `received_at` | `entry_at` | `created_by` |
| Entered | `entry_at` | `entry_at` | `created_by` |
| Validated | `first_validated_at` | `first_validated_at` | user who first validated |

They cannot be marked Not Applicable.

## 12.3 Operational Stages (Recorded)

Finance, Invoicing, Pick & Pack, Dispatched and Completed are recorded as `lifecycle_event` records.

- Operational events can be recorded once the requisition has been validated at least once (`first_validated_at` is set) and is not Cancelled.
- A stage can be recorded only if every earlier operational stage has at least one effective event (Completed or Not Applicable).
- Finance, Invoicing, Pick & Pack and Dispatched may each have multiple effective Completed events (for example split dispatches). Completed has at most one effective event.
- Completed cannot be Not Applicable.

## 12.4 Lifecycle Event

Each lifecycle event contains:

- requisition
- stage
- status (`completed` or `not_applicable`)
- occurred at
- recorded at (system, immutable)
- recorded by
- notes
- not-applicable reason (required when status is Not Applicable)
- record type (`entry`, `correction`, `void`), the record it supersedes, and a correction reason (Section 12.8)

Evidence documents reference the lifecycle event (Section 12.9).

## 12.5 Stage Status (Displayed)

Each stage displays one of:

- **Completed:** the stage has at least one effective Completed event (or, for foundational stages, its timestamp is set).
- **Not Applicable:** the stage's effective event is Not Applicable. The reason is displayed.
- **Pending:** the stage has no effective event.

Pending is the absence of a record. It is not stored.

## 12.6 Current Stage

- **Current stage** = the latest stage in sequence whose status is Completed. Not Applicable stages are skipped.
- **Next stage** = the first stage in sequence that is Pending.
- **Stage occurrence time** (used for durations) = the earliest `occurred_at` among the stage's effective Completed events.

## 12.7 Occurred At Validation

When an operational lifecycle event is recorded or corrected, `occurred_at` MUST:

1. not be in the future;
2. not be earlier than `received_at`, `entry_at` or `first_validated_at`;
3. not be earlier than the stage occurrence time of any earlier stage that is Completed;
4. not be later than the stage occurrence time of any later stage that already has an effective Completed event.

**Chronology override.** When the platform is introduced, or when an RA registers a requisition after operational events have already happened, rule 2 may genuinely be broken. An Administrator may record such an event with `chronology_override = true` and a mandatory reason. Overridden events are audited and flagged, and the intervals they affect are excluded from bottleneck averages (Section 22.3). Rules 1, 3 and 4 can never be overridden.

## 12.8 Corrections (Append-Only)

Lifecycle events are never updated or deleted.

- **Correction:** a new event with `record_type = correction`, `supersedes_id` = the event being corrected, the corrected values, and a mandatory correction reason. It must be for the same requisition and stage.
- **Void:** a new event with `record_type = void`, `supersedes_id` = the event being voided, and a mandatory reason. It removes the superseded event from the effective set without replacing it.
- A record can be superseded at most once (unique `supersedes_id`). Only an effective record can be superseded.
- **Effective events** = entry or correction events that have not been superseded. Only effective events count for stage status, durations and analytics. Superseded and void events remain visible in the timeline history.
- While Fulfillment Status is not Closed, RA and Admin may correct/void events. After it is Closed, this requires an approved edit request (RA) or reopening fulfillment (Admin).

## 12.9 Evidence Documents

- A lifecycle event can have **many** evidence documents. Each evidence document references its lifecycle event (`lifecycle_event_id`).
- Evidence documents are immutable and are never deleted. If an event is corrected or voided, the evidence attached to the superseded event stays visible in the stage's evidence history, marked as belonging to a superseded event. A correction event carries its own evidence.
- Evidence for the foundational stages (for example a screenshot of the WhatsApp message for Received) is attached to the requisition as a supporting document.

Typical evidence:

| Stage | Evidence |
|---|---|
| Finance | Payment confirmation |
| Invoicing | Invoice |
| Pick & Pack | Pick slip |
| Dispatched | Dispatch document / waybill |
| Completed | Proof of delivery (POD) |

---

# 13. Documents and Storage

## 13.1 Original Requisition Document

The original requisition is preserved exactly as uploaded. Required metadata:

- File name
- File type (MIME)
- File size
- Checksum (SHA-256)
- Page count
- Uploaded at
- Uploaded by
- Storage key

The original document is immutable. A requisition MAY have more than one original file (for example several WhatsApp images of one requisition); each is preserved separately.

## 13.2 Document Categories

Documents are stored in logically separate storage categories:

1. Original requisitions
2. Processed documents (for example normalized page images produced for OCR)
3. Lifecycle evidence
4. Supporting documents
5. System backups

No document is ever overwritten. Uploaded files are validated (allowed types, size limit, checksum) before they are accepted.

## 13.3 Document Pages

Each page of an original requisition document is a `document_page` record holding its page number and its programme assignment (Section 16).

## 13.4 Document Access

- Documents are accessed only through short-lived signed URLs (lifetime is a setting, default 5 minutes). Users never receive permanent or public URLs.
- "View" opens the document inline in the browser. "Download" serves it as an attachment and is allowed only per Section 6.3.
- Every download is audited.

---

# 14. Document Processing

## 14.1 Workflow

Upload → OCR / Vision → Raw Text → Structured Parsing → Normalization → Matching → Human Review → Validation

OCR output is not authoritative structured data. Raw OCR output is retained separately from corrected structured data and is never overwritten.

## 14.2 Processing Jobs

- OCR and extraction run as asynchronous background jobs.
- Job status: Queued, Processing, Completed, Failed.
- Failed jobs retain error information and can be retried by RA or Admin. Each retry is a new job record.
- The requisition is in Record Status Processing while a job is queued or running.
- Each job records the model name and version used.

## 14.3 Source Lineage

The system preserves lineage:

Original Document → Raw OCR (processing job output) → Corrected Extraction → Match Candidate → Validated Line → Fulfillment Records and Evidence → Analytics

Any analytical value can be traced back to its source (Section 34).

---

# 15. Requisition Review Interface

The review workspace is a split screen:

- **Left:** the original requisition document, page by page.
- **Right:** the structured extracted data.

The RA can:

- Review and edit fields
- Search master data and replace suggestions
- Confirm facility and item matches
- Navigate between pages
- Assign programmes per page, and use **"Apply across pages"**
- Override the programme for an individual line
- See each line's unit-conversion status and propose a conversion where one is missing
- Validate the requisition

Where OCR provides page location/bounding-box information, selecting a field highlights its source location in the original document.

---

# 16. Programmes

Programme is selected from the Programme master (managed by Administrators). Example programmes: DRF, Essential Medicine, Family Planning, MNCH, Nutrition, IMPACT, Abba-Care, Free-MNCH.

**Programme belongs to the requisition line.** A multi-page requisition may contain different programmes on different pages, so every line MUST have its own `programme_id`.

Assignment works in layers, each only a default for the next:

1. **Primary programme** (`requisition.primary_programme_id`, optional): the requisition's main programme, used as the default for pages.
2. **Page programme** (`document_page.programme_id`): set per page; "Apply across pages" copies one programme to all pages of the document.
3. **Line programme** (`requisition_line.programme_id`, required): defaults from the line's page programme, and can be overridden per line.

The primary programme never overrides a page or line programme. All programme analytics use the **line** programme. The primary programme is used only for display and for filtering requisitions by their main programme.

---

# 17. Matching

## 17.1 Facility Matching

The extracted facility name is compared with the Facility master in this order:

1. Exact match
2. Approved alias
3. Normalized text
4. Historical match
5. Fuzzy match
6. Human selection

The system offers ranked candidates. It never silently replaces the extracted facility name with a suggestion. The extracted text is kept (`facility_extracted_text`) next to the confirmed `facility_id`.

## 17.2 Item Matching

The same principle applies to items:

1. Exact match
2. Approved alias
3. Normalized text
4. Attribute match (item name, generic name, strength, form, pack size, item code)
5. Fuzzy match
6. Human selection

## 17.3 Aliases

Aliases are stored for facilities and items. An alias record contains:

- Alias text and its normalized form
- Entity type and entity ID
- Occurrence count
- Status: Candidate, Approved, Rejected
- Approved/rejected by and when

When an RA confirms a match whose extracted text is not an existing alias, the system records or increments a **candidate** alias. Only Approved aliases are used in matching step 2. Aliases never become authoritative automatically.

## 17.4 Confidence Scoring

Model-reported confidence is not trusted on its own. The platform derives match confidence from several signals:

- Text similarity
- Alias match
- Strength match
- Form match
- Pack-size match
- Master-data validity
- Historical facility usage
- Item occurrence history

The application/database logic proposes the match. The LLM or OCR model provides an interpretation. The RA confirms.

---

# 18. Master Data

## 18.1 Facility Master

Facility ID, Facility Name, Aliases, LGA, Location, Status (Active/Inactive).

## 18.2 Item Master

Item ID, Item Code, Item Name, Generic Name, Strength, Form, Pack Size, Base Unit, Status (Active/Inactive).

## 18.3 Programme Master

Programme ID, Programme Name, Description, Status (Active/Inactive).

## 18.4 Rules

- Only Administrators manage master data, directly or by import. Every change is audited.
- Master records are deactivated, never deleted, once referenced.
- Inactive entries cannot be selected for new requisitions but remain on historical records.

---

# 19. Quantity and Unit Model

## 19.1 Original and Base Quantities

Every requisition line and every fulfillment record keeps both the original quantity and the base quantity:

- `quantity` and `unit`: exactly as written or recorded. Never overwritten by normalization.
- `base_quantity` and `base_unit`: converted into the item's base unit, when a conversion is known.

Example: Requested "20 cartons", with an approved conversion 1 carton = 100 tablets.

- quantity_requested = 20, unit_requested = carton
- base_quantity_requested = 2,000, base_unit = tablet

The UI shows both: "20 cartons (2,000 tablets)".

Quantities in different units are never added together. All aggregation uses base quantities.

## 19.2 Unit Conversions

Conversions are held in an explicit `unit_conversion` table:

- **Item-specific** conversions (for example "carton → tablet = 100 for Item X") take precedence over **generic** conversions (item blank).
- Only **Approved** conversions are used. RAs may propose a conversion; Administrators approve or retire it.
- Approved conversions are never edited. To change one, it is retired and a new one is approved.
- Each line and fulfillment record stores the `conversion_id` used, for lineage.

## 19.3 Conversion Status

Every requisition line and fulfillment record carries a conversion status:

| Status | Meaning | Base quantity |
|---|---|---|
| `resolved` | An approved conversion exists, or the unit already is the base unit | Calculated |
| `unknown` | No approved conversion exists yet | Left empty (NULL) |
| `incompatible` | The unit cannot be converted to the item's base unit (for example "bottle" for a tablet item) | Left empty (NULL) |

Where a conversion is unknown or incompatible:

- the original quantity and unit are preserved;
- base quantity is left unresolved (NULL, never zero);
- the record is flagged;
- it is excluded from OFR calculation (Section 21.2);
- it is included in OFR coverage reporting (Section 21.6).

It never silently becomes zero fulfillment.

When a conversion is approved later, `unknown` records can be resolved by the system (Section 10.5), and the resolution is audited.

---

# 20. Fulfillment Tracking

## 20.1 What Is Captured

For each requisition line, the platform captures:

- Requested quantity (on the line)
- Invoiced quantity
- Issued/picked quantity
- Delivered quantity

Example (Amoxicillin 500 mg): Requested 20, Invoiced 18, Issued 15, Delivered 15.

## 20.2 Fulfillment Stages

| Fulfillment stage | Typical source | Related lifecycle stage |
|---|---|---|
| `invoiced` | Invoice | Invoicing |
| `issued` | Pick slip | Pick & Pack |
| `delivered` | POD | Dispatched / Completed |

Fulfillment records can be captured with or after their related lifecycle event. If the related lifecycle stage has no effective event, the system warns but does not block.

## 20.3 Fulfillment Sources

Fulfillment values may come from:

1. Supporting evidence uploaded by the RA
2. Manual entry by the RA
3. A future mSupply integration/export (Section 37)

The platform does not generate invoices or pick slips. It records fulfillment information and evidence.

## 20.4 Fulfillment Record

Fulfillment is stored as independent, append-only `fulfillment_record` rows, not as columns on the line. Each record contains:

- requisition, requisition line (blank for additional items), item
- fulfillment stage
- quantity, unit, base quantity, base unit, conversion used, conversion status
- substitution flag, additional item flag
- reference (invoice number, pick-slip number, waybill number)
- supporting document
- occurred at, recorded at (system), recorded by
- notes
- record type (`entry`, `correction`, `void`), the record it supersedes, correction reason

Fulfillment records can be captured when the requisition has been validated at least once, is not Cancelled, and Fulfillment Status is not Closed (except under an approved edit request). `occurred_at` must not be in the future or earlier than `received_at`.

## 20.5 Substitutions

The item supplied may differ from the item requested. The fulfillment record therefore has its own `item_id`.

- If the fulfillment record's item differs from its line's item, `substitution_flag` MUST be true. This is enforced in the database.
- A substitution is **never** treated automatically as 1:1 fulfillment.
- A substitution contributes to the requested line's OFR **only** where an approved **substitution equivalence** rule exists for that pair of items.

**Substitution equivalence** (`substitution_equivalence` table):

- Defines a requested item, a substitute item, and a factor converting the substitute's base quantity into the requested item's base quantity.
- States its basis: strength, dosage form, pack size and/or base unit. It is never based only on two item codes being "similar".
- Is proposed by RA or Admin and **approved by an Administrator**. Only approved rules are used.
- Is never edited. To change one, it is retired and a new one is approved. Analytics use the rules approved at the time of calculation, and rule changes are audited, so any change in historical OFR can be explained.

Example: Requested Amoxicillin 500 mg capsule × 20. Issued Amoxicillin 250 mg capsule × 40.

- With an approved equivalence (basis: same form, strength ratio; factor 0.5): credited issued = 40 × 0.5 = 20 → line fully issued.
- Without an approved equivalence: credited issued = 0. The line stays eligible for OFR (it shows as a shortfall) and is flagged **"uncredited substitution"**, which is visible in the line table, in item analytics and in the coverage report.

## 20.6 Additional / Unrequested Items

Items supplied that were not requested are recorded with no requisition line and `additional_item_flag = true` (enforced: additional ⇔ no line).

They are **excluded from both the numerator and the denominator** of OFR and SKU rates. They remain fully recorded and are shown separately in requisition, facility, item and programme views as "Additional items supplied".

## 20.7 Split Fulfillment

A line may have several fulfillment records at the same stage (for example three deliveries of 40 + 30 + 30). Each is preserved separately. The line's fulfilled quantity at a stage is the sum of its effective records at that stage (100 in this example).

## 20.8 Corrections (Append-Only)

Fulfillment records are never updated or deleted.

- **Correction:** a new record with `record_type = correction`, `supersedes_id` = the record being corrected, the corrected values, and a mandatory reason. Same requisition and fulfillment stage. The line and item may change.
- **Void:** a new record with `record_type = void`, `supersedes_id` = the record being voided, no quantity, and a mandatory reason.
- A record can be superseded at most once (unique `supersedes_id`). Only an effective record can be superseded.
- **Effective records** = entry or correction records that have not been superseded. **Only effective records are counted anywhere in reporting**, so a corrected record replaces the old one without double counting. The full chain stays visible in the line's fulfillment history and the audit log.

Example: Issued 50 recorded in error. A correction for 40 supersedes it. Issued quantity = 40, not 90.

## 20.9 Fulfillment Status

| Fulfillment Status | Meaning |
|---|---|
| **Open** | No effective fulfillment records yet |
| **Partial** | At least one effective fulfillment record exists; capture still in progress |
| **Closed** | Capture is complete; the requisition's fulfillment figures are final for reporting |

- Open → Partial happens automatically when the first effective record is captured.
- **Closing** is an explicit RA/Admin action. It requires Record Status Finalized and either:
  - an effective Completed lifecycle event, or
  - a closure reason (for example "Not supplied: stock-out"), which allows closing requisitions that will never be fully processed.
- `fulfillment_closed_at`, `fulfillment_closed_by` and any closure reason are recorded and audited.
- Closed does not mean 100% fulfilled. A Closed requisition can have any OFR from 0% to 100%.
- After Closed, new fulfillment records, corrections and voids, and lifecycle corrections, require either an approved edit request (RA) or **reopening fulfillment** (Closed → Partial) by an Administrator with a reason.

---

# 21. Order Fulfillment Rate (OFR)

## 21.1 Headline Metric

The headline fulfillment metric is **Issued OFR**. Invoice OFR and Delivered OFR are calculated the same way for their stages.

## 21.2 Line Eligibility

For a fulfillment stage *s* (invoiced, issued or delivered), a requisition line is **eligible** when all of these hold:

1. It is a requested line (additional items are never lines).
2. Its requisition is in the scope being reported (Section 21.9).
3. Its conversion status is `resolved` and `base_quantity_requested > 0`.
4. Every effective fulfillment record on the line at stage *s* that would be credited (same item, or a substitute with an approved equivalence) has conversion status `resolved`.

A line failing rule 3 is excluded from OFR at all stages. A line failing rule 4 is excluded at stage *s* only. Excluded lines are counted in coverage (Section 21.6).

## 21.3 Credited Fulfillment (Line-Level Cap)

For each eligible line and stage *s*:

```
fulfilled_s  = Σ base_quantity of effective records at stage s for the requested item
             + Σ (base_quantity × equivalence factor) of effective records at stage s
                 for substitutes with an approved equivalence rule

credited_s   = MIN(fulfilled_s, base_quantity_requested)

over_s       = MAX(fulfilled_s − base_quantity_requested, 0)
```

The 100% cap is applied **per line, before aggregation**. Over-fulfillment on one line never compensates for a shortfall on another.

## 21.4 Stage OFR

```
Invoice OFR   = Σ credited_invoiced  ÷ Σ base_quantity_requested  × 100   (over lines eligible at invoiced)
Issued OFR    = Σ credited_issued    ÷ Σ base_quantity_requested  × 100   (over lines eligible at issued)
Delivered OFR = Σ credited_delivered ÷ Σ base_quantity_requested  × 100   (over lines eligible at delivered)
```

Because each line is capped, OFR can never exceed 100%. No separate display cap is needed.

## 21.5 Over-Fulfillment

Over-fulfillment is reported separately at every level as:

- total over-fulfilled base quantity per stage (Σ over_s), and
- number of over-fulfilled lines per stage.

## 21.6 OFR Coverage

Every OFR figure is shown with its coverage:

```
OFR Coverage_s = eligible lines at stage s ÷ requested lines in scope × 100
```

The coverage report breaks excluded lines down by reason:

- Requested quantity: conversion unknown
- Requested quantity: conversion incompatible
- Fulfillment record at stage *s*: conversion unknown/incompatible

It also shows, separately, the number of eligible lines with an **uncredited substitution** (eligible, but substitute quantity not credited).

## 21.7 SKU Fulfillment Rate (per Stage)

Quantity fulfillment and SKU fulfillment are different metrics. A "requested SKU" is one requested line.

A line is **fully fulfilled at stage *s*** when `fulfilled_s ≥ base_quantity_requested` (that is, `credited_s = base_quantity_requested`).

```
Invoice SKU Fulfillment Rate   = lines fully fulfilled at invoiced  ÷ lines eligible at invoiced  × 100
Issued SKU Fulfillment Rate    = lines fully fulfilled at issued    ÷ lines eligible at issued    × 100
Delivered SKU Fulfillment Rate = lines fully fulfilled at delivered ÷ lines eligible at delivered × 100
```

Lines with `0 < credited_s < requested` are reported as **partially fulfilled**. Lines with `credited_s = 0` are reported as **not fulfilled**. The headline SKU rate is the **Issued SKU Fulfillment Rate**.

## 21.8 Aggregation Principle

Aggregate OFR is always calculated from summed eligible base quantities (Σ credited ÷ Σ requested). It is **never** the average of line-level or requisition-level OFR percentages. The same principle applies at every level.

## 21.9 Reporting Scope and Time Attribution

**Official reporting scope** (the default for all dashboards, histories and analytics):

- Record Status = **Finalized**, and
- Fulfillment Status = **Closed**.

Users may switch to an **in-progress view** that also includes Finalized requisitions with Fulfillment Status Open or Partial. The in-progress view is always clearly labelled as provisional.

Never included in OFR: Draft, Processing, Validation Pending, Validated, Reopened and Cancelled requisitions. Dashboards show the count of Reopened requisitions excluded while under correction.

**Time attribution:** a requisition's lines are attributed to the period of its `received_at` date (Africa/Lagos) by default. Users may switch the basis to requisition date or entry date. The basis in use is always shown.

## 21.10 OFR Levels

OFR, coverage and SKU rates are available at every level:

1. Line
2. Item (lines grouped by requested item; substitutes are credited to the requested item)
3. Requisition
4. Facility
5. Programme (lines grouped by **line** programme)
6. Overall portfolio

All support time-based analysis by week, month, quarter, year and custom range.

## 21.11 Requisition-Level Example

| Line | Requested | Issued | Credited | Over |
|---|---|---|---|---|
| A | 600 | 700 | 600 | 100 |
| B | 400 | 200 | 200 | 0 |
| **Total** | **1,000** | **900** | **800** | **100** |

- Issued OFR = 800 ÷ 1,000 = **80%**. The uncapped ratio would be 90%, which wrongly lets line A hide line B's shortfall.
- Over-fulfillment shown separately: 100 base units on 1 line.
- Issued SKU Fulfillment Rate = 1 ÷ 2 = 50% (line A fully fulfilled, line B partial).

## 21.12 Fulfillment Drop-Off Analysis

The platform shows where fulfillment drops between stages, using credited quantities on lines eligible at all three stages:

| Stage | Credited quantity | % of requested |
|---|---|---|
| Requested | 1,000 | 100% |
| Invoiced | 950 | 95% |
| Issued | 900 | 90% |
| Delivered | 875 | 87.5% |

Together with lifecycle data, this helps management see whether the main loss happens at Finance, Invoicing, Picking, Dispatch or Delivery.

## 21.13 Fulfillment Variance

Calculated on lines eligible at the stages involved:

| Variance | Definition |
|---|---|
| Requested − Invoiced | Σ (requested − credited_invoiced) |
| Requested − Issued | Σ (requested − credited_issued) |
| Requested − Delivered | Σ (requested − credited_delivered) |
| Invoiced − Issued | Σ (fulfilled_invoiced − fulfilled_issued), uncapped |
| Issued − Delivered | Σ (fulfilled_issued − fulfilled_delivered), uncapped |

Shortfall variances use credited (capped) quantities. Stage-to-stage variances use uncapped effective quantities, so over-supply between stages stays visible. All are available at requisition, item, facility, programme and portfolio level.

---

# 22. Processing Time, Bottlenecks and Recording Latency

## 22.1 Processing Time Metrics

| Metric | Definition |
|---|---|
| **Facility-to-Receipt Delay** | date(`received_at`) − `requisition_date` (days) |
| **RA Processing Time** | `entry_at` − `received_at` |
| **Requisition-to-Entry Time** | date(`entry_at`) − `requisition_date` (days) |
| **Requisition-to-Completion Time** | date(Completed `occurred_at`) − `requisition_date` (days) |
| **Receipt-to-Completion Time** | Completed `occurred_at` − `received_at` |

- Metrics starting from `requisition_date` exclude estimated requisition dates by default and report how many were excluded.
- Completion-based metrics include only requisitions with an effective Completed event.
- Date differences use Africa/Lagos calendar days.

## 22.2 Default Processing Time

Where a single "processing time" is displayed (facility snapshot, facility comparison), it is **Requisition-to-Completion Time**, labelled as such. Requisition-to-Entry Time is displayed beside it.

## 22.3 Lifecycle Bottleneck Analytics

Average duration between consecutive stages, using stage occurrence times (Section 12.6):

- Received → Entered
- Entered → Validated
- Validated → Finance
- Finance → Invoicing
- Invoicing → Pick & Pack
- Pick & Pack → Dispatched
- Dispatched → Completed

Rules:

- If a stage is Not Applicable, the interval to the next Completed stage is measured from the most recent earlier Completed stage, and the Not Applicable stage is excluded from its own averages.
- Intervals involving an event with a chronology override are excluded and counted separately.
- Only effective events are used.

## 22.4 Recording Latency

```
Recording Latency = recorded_at − occurred_at
```

Calculated for operational lifecycle events and fulfillment records, and analyzable by stage, RA, facility, programme and time period. Foundational stages are covered by RA Processing Time instead.

---

# 23. Facility History

Facility History is a first-class feature: a performance profile, not just a list of requisitions. All figures use official reporting scope unless the user switches to the in-progress view.

## 23.1 Performance Snapshot

- Total requisitions
- Requested lines and total requested base quantity (eligible lines)
- Total invoiced, issued and delivered base quantity (credited)
- Invoice OFR, **Issued OFR**, Delivered OFR, each with coverage
- Invoice, **Issued**, Delivered SKU Fulfillment Rates
- Over-fulfillment (quantity and lines)
- Additional items supplied
- Average Requisition-to-Completion Time and Requisition-to-Entry Time
- Requisition frequency (requisitions per month; average days between requisitions)
- Last requisition: most recent `received_at`
- Last fulfillment: most recent `occurred_at` of an effective Issued record
- Last delivery: most recent `occurred_at` of an effective Delivered record

Example (Government House Clinic):

| Metric | Value |
|---|---|
| Issued OFR | 82.3% (coverage 97%) |
| Total requisitions | 42 |
| Requested base quantity | 1,250 |
| Credited issued base quantity | 1,029 |
| Avg Requisition-to-Completion Time | 3.4 days |
| Last requisition | 12 Nov 2026 |
| Last fulfillment | 16 Nov 2026 |

## 23.2 OFR Trend

OFR trends by week, month, quarter, year or custom range, for each stage.

Example monthly Issued OFR: Jan 78%, Feb 81%, Mar 84%, Apr 79%, May 86%, Jun 88%.

## 23.3 Facility Item History

Users can drill from Facility → Item → historical fulfillment:

| Month | Requested | Issued (credited) | Issued OFR |
|---|---|---|---|
| Jan | 100 | 80 | 80% |
| Feb | 120 | 100 | 83.3% |
| Mar | 150 | 120 | 80% |

This reveals persistent item-level shortages at specific facilities.

## 23.4 Facility Requisition History

A complete list of the facility's requisitions, including those outside official reporting scope, with: requisition number, requisition date (estimated marker), received date, entry date, primary programme, record status, current lifecycle stage, fulfillment status, requested quantity, issued quantity and Issued OFR. OFR is shown as provisional for requisitions not yet in official scope.

## 23.5 Lifecycle Performance

Bottleneck durations (Section 22.3) and recording latency (Section 22.4) for the facility's requisitions.

---

# 24. Item History

Item History shows, for the item as the **requested** item (official scope by default):

- Requisitions and lines containing the item
- Requested, invoiced, issued and delivered base quantity (credited)
- Invoice, Issued and Delivered OFR with coverage; SKU rates per stage
- Facility distribution
- Programme distribution (line programme)
- Trend over time

It also shows **substitution history**, in both directions:

- Times this item was substituted by another item (credited and uncredited).
- Times this item was supplied as a substitute for another item.

And it shows quantities supplied as an additional (unrequested) item.

---

# 25. Programme Performance

Programme analytics group lines by **line programme**:

- Requisitions containing at least one line in the programme
- Requested, invoiced, issued and delivered base quantity (credited)
- Invoice, Issued and Delivered OFR with coverage; SKU rates per stage
- Over-fulfillment
- Requisition-to-Completion and Requisition-to-Entry Time (for requisitions containing the programme)

---

# 26. Dashboard

The primary dashboard shows, for the selected period:

**Volume**

- Requisitions received (by `received_at`)
- Requisitions entered (by `entry_at`)

**Record Status**

- Count per record status
- **Entry backlog:** Draft + Processing + Validation Pending + Validated (received but not yet finalized)
- Reopened (excluded from reporting while under correction)

**Lifecycle**

- Count per current lifecycle stage (In Progress = current stage after Validated and before Completed; Completed)

**Fulfillment**

- Count per fulfillment status
- **Fulfillment backlog:** Finalized with Fulfillment Status Open or Partial

**Performance**

- Issued OFR (headline), Invoice OFR, Delivered OFR, each with coverage
- Issued SKU Fulfillment Rate
- Over-fulfillment
- Average Requisition-to-Entry Time
- Average Requisition-to-Completion Time
- Average RA Processing Time
- Requisitions below the OFR threshold

---

# 27. Analytics

## 27.1 Filters

Periods: Today, This Week, This Month, This Quarter, This Year, Custom Date Range.

Filters: Facility, Programme, Item, Lifecycle Stage, Record Status, Fulfillment Status, RA, scope (official / in-progress), time basis (received / requisition / entry date).

## 27.2 OFR Analytics

- Overall, facility, item, requisition, programme and time-based OFR, each with coverage.
- Comparison of Requested vs Invoiced vs Issued vs Delivered.
- Drop-off and variance (Sections 21.12–21.13).

Portfolio example:

| | Quantity | OFR |
|---|---|---|
| Requested | 100,000 | |
| Invoiced (credited) | 95,000 | 95% |
| Issued (credited) | 90,000 | 90% |
| Delivered (credited) | 87,500 | 87.5% |

## 27.3 Low OFR Monitoring

- Requisitions, facilities and items below a configurable threshold are flagged for management review.
- The threshold percentage and the stage it applies to are system settings (defaults: 80%, Issued). They are not hard-coded, and changes are audited.
- Requisition flags apply to official scope. Facility and item flags apply over the selected period.

## 27.4 Facility Performance

Facilities can be ranked and compared by Issued OFR, Delivered OFR, Issued SKU rate, Requisition-to-Completion Time, requisition frequency and fulfillment variance.

The platform identifies:

- High-performing facilities
- Low-performing facilities
- Facilities with declining OFR
- Facilities with high requisition frequency
- Facilities with persistent item-level shortages

Users can drill from any aggregate figure down to the underlying requisitions and lines.

## 27.5 Item Performance

The platform identifies:

- High-demand items
- Frequently requested items
- Low-fulfillment items
- Items with declining OFR
- Frequently substituted items (with uncredited substitutions highlighted)

## 27.6 Requisition Frequency

Frequency is analyzed by facility, item, programme and time:

- Requisitions per facility per month
- Requisitions per item per month
- Average days between requisitions
- Facilities with unusually high frequency
- Items with unusually high demand

## 27.7 Recording Latency and Bottlenecks

As defined in Sections 22.3 and 22.4, filterable by stage, RA, facility, programme and period.

---

# 28. Global Search

Global search is mandatory. Users can search by:

- Requisition number
- Facility (name or alias)
- Item (name or alias) and item code
- Programme
- Requisition date, received date, entry date
- Current lifecycle stage
- Record status
- Fulfillment status
- OFR range (with stage)

Supported queries include:

- "Show all requisitions from Facility X."
- "Find all requisitions containing Amoxicillin."
- "Show requisitions received this month."
- "Find REQ-26-11-19_001."
- "Show unfulfilled requisitions for Facility X." (Fulfillment Status Open, or Closed with Issued OFR = 0)
- "Show requisitions with Issued OFR below 80%."

Search technology: PostgreSQL with appropriate indexes. `pg_trgm` is used for fuzzy matching. Search supports exact, partial, fuzzy and alias matching.

---

# 29. Navigation and Pages

## 29.1 Primary Navigation

Dashboard · Requisitions · Facilities · Items · Programmes · Analytics · Audit Log (Supervisor/Admin) · Administration (Admin)

## 29.2 Requisitions Table

Columns: Requisition Number, Facility, Primary Programme, Requisition Date, Received At, Entry At, Record Status, Current Stage, Fulfillment Status, Requested Quantity, Issued Quantity, Issued OFR, Last Updated.

Actions (shown only when allowed per Section 6.3):

- View
- Edit (when not Finalized/Cancelled)
- Download
- Request Edit (Finalized; RA)
- Reopen (Admin, or Supervisor with grant)
- Cancel

## 29.3 Requisition Detail Page

**Header:** requisition number, facility (with extracted text), primary programme, requisition date (estimated marker), received at, entry at, record status, current lifecycle stage, fulfillment status, Invoice/Issued/Delivered OFR with coverage, Issued SKU rate.

**Line table:** each line shows:

- Item and item code
- Programme
- Requested quantity and unit
- Base quantity and conversion status
- Invoiced, issued and delivered quantity
- Invoice, Issued and Delivered OFR
- Over-fulfillment
- Substitution status (none / credited / uncredited)
- OFR eligibility per stage

Additional items supplied are listed in a separate table below the lines.

**Timeline:** all eight stages. Each stage shows its status, occurred at, recorded at, recorded by, evidence, notes and Not-Applicable reason. Superseded and void events can be expanded to show the history.

**Documents:** the original document(s) and all evidence, viewable via signed URLs.

**Audit history:** all audit events for the requisition.

**Edit requests:** all edit requests and their status.

## 29.4 Facility Page

Facility Profile · Performance Snapshot · OFR Trend · Requisition History · Item Performance · Lifecycle Performance · Analytics (Section 23)

## 29.5 Item Page

Item Profile · Demand History · Fulfillment History · OFR Trend · Facility Distribution · Programme Distribution · Substitution History (Section 24)

## 29.6 User Experience Priorities

Speed, clarity, auditability, minimal data entry, searchability and evidence visibility. The RA should be able to process a requisition without navigating through unnecessary screens.

---

# 30. Audit Log

## 30.1 What Is Logged

Every material action writes an audit event, including:

- Requisition created; record status changed (validated, finalized, reopened, cancelled)
- Document uploaded, viewed via download, downloaded
- OCR/processing job completed or failed
- Header field changed (facility, programme, requisition date, received at)
- Line added, changed or removed; page programme changed
- Unit conversion resolved on a line
- Lifecycle event recorded, corrected or voided
- Fulfillment record captured, corrected or voided
- Fulfillment closed or reopened
- Evidence uploaded
- Edit request submitted, approved, rejected, used, expired or withdrawn
- Master data, alias, unit conversion and substitution equivalence changes
- User, role and permission grant changes
- System setting changes

## 30.2 Audit Event

Each audit event records:

- requisition (blank for system or master-data events)
- actor user (blank for system actions) and actor type (user/system)
- event type, entity type, entity ID
- old value and new value
- reason
- related edit request (if any)
- request/correlation ID
- created at

## 30.3 Audit Requirements

- Audit records are **immutable at the database level**: the application's database role has INSERT and SELECT only, and triggers reject UPDATE, DELETE and TRUNCATE.
- The application is responsible for writing audit records correctly, in the same transaction as the change they describe.
- Authorized users can reconstruct the full history of any requisition from the audit log together with the append-only lifecycle and fulfillment records.

---

# 31. Data Model

## 31.1 Entities

| Group | Entities |
|---|---|
| Identity and access | `user`, `role`, `user_role`, `permission_grant` |
| Master data | `facility`, `facility_alias`, `programme`, `item`, `item_alias`, `unit_conversion`, `substitution_equivalence` |
| Requisition | `requisition`, `requisition_number_counter`, `requisition_document`, `document_page`, `requisition_line`, `match_candidate`, `processing_job` |
| Lifecycle and fulfillment | `lifecycle_event`, `fulfillment_record` |
| Control and audit | `edit_request`, `audit_event`, `system_setting` |

## 31.2 Enumerations

| Enum | Values |
|---|---|
| `record_status` | draft, processing, validation_pending, validated, finalized, reopened, cancelled |
| `lifecycle_stage` | received, entered, validated, finance, invoicing, pick_and_pack, dispatched, completed |
| `operational_stage` (stored on events) | finance, invoicing, pick_and_pack, dispatched, completed |
| `lifecycle_event_status` | completed, not_applicable |
| `fulfillment_status` | open, partial, closed |
| `fulfillment_stage` | invoiced, issued, delivered |
| `record_type` | entry, correction, void |
| `conversion_status` | resolved, unknown, incompatible |
| `approval_status` (aliases, conversions, equivalences) | candidate/proposed, approved, rejected, retired |
| `edit_request_status` | pending, approved, rejected, used, expired, withdrawn |
| `document_category` | original_requisition, processed, lifecycle_evidence, supporting |
| `job_status` | queued, processing, completed, failed |
| `role_code` | ra, supervisor, admin |

## 31.3 Identity and Access

**user:** id, external_auth_id (unique), full_name, email, phone, status (active/inactive), created_at, updated_at

**role:** code (PK), name, description

**user_role:** user_id, role_code, granted_by, granted_at, revoked_by, revoked_at

**permission_grant:** id, user_id, permission (`requisition.reopen` / `edit_request.approve` / `documents.download`), granted_by, granted_at, expires_at, revoked_by, revoked_at, reason

## 31.4 Master Data

**facility:** id, name, lga, location, status, created_at, updated_at

**facility_alias:** id, facility_id, alias, normalized_alias, occurrence_count, status, decided_by, decided_at, created_at

**programme:** id, name (unique), description, status

**item:** id, item_code (unique), name, generic_name, strength, form, pack_size, base_unit, status, created_at, updated_at

**item_alias:** id, item_id, alias, normalized_alias, occurrence_count, status, decided_by, decided_at, created_at

**unit_conversion:** id, item_id (NULL = generic), from_unit, to_unit (= base unit), factor (> 0), status, proposed_by, proposed_at, approved_by, approved_at, retired_by, retired_at, notes
- At most one approved conversion per (item_id, from_unit).

**substitution_equivalence:** id, requested_item_id, substitute_item_id, factor (> 0; substitute base units → requested base units), basis (strength / form / pack_size / base_unit, multi-valued), justification, status, proposed_by, proposed_at, approved_by, approved_at, retired_by, retired_at
- At most one approved rule per (requested_item_id, substitute_item_id). Requested and substitute items must differ.

## 31.5 Requisition

**requisition:**

| Field | Notes |
|---|---|
| id | |
| requisition_number | unique, immutable |
| entry_date | Africa/Lagos date of entry_at; immutable |
| entry_serial | immutable |
| facility_id | required for validation; locked after finalization |
| facility_extracted_text | locked after finalization |
| primary_programme_id | optional default; locked after finalization |
| requisition_date | date; locked after finalization |
| requisition_date_estimated | boolean; locked after finalization |
| received_at | required; locked after finalization |
| entry_at | system; immutable |
| record_status | enum |
| first_validated_at, first_validated_by | system; immutable once set |
| validated_at, validated_by | latest validation |
| finalized_at, finalized_by | latest finalization |
| fulfillment_status | enum, default open |
| fulfillment_closed_at, fulfillment_closed_by, fulfillment_closure_reason | |
| cancelled_at, cancelled_by, cancellation_reason | |
| created_by, created_at, updated_at | |

**requisition_number_counter:** entry_date (PK), last_serial

**requisition_document:** id, requisition_id, category, lifecycle_event_id (required for lifecycle_evidence; NULL otherwise), document_type (e.g. invoice, pick_slip, waybill, pod, payment_confirmation, whatsapp_screenshot), file_name, mime_type, storage_key, checksum_sha256, file_size, page_count, description, uploaded_by, uploaded_at
- Immutable: INSERT only.

**document_page:** id, document_id, page_number, programme_id, updated_by, updated_at
- Locked after the requisition is finalized.

**requisition_line:**

| Field | Notes |
|---|---|
| id, requisition_id, line_number | |
| page_number, bounding_box | source location |
| raw_extracted_text | from OCR; never overwritten |
| item_extracted_text, corrected_text | |
| item_id | requested item |
| programme_id | required for validation |
| quantity_requested, unit_requested | original values; never overwritten |
| base_quantity_requested, base_unit | NULL when conversion unknown/incompatible |
| conversion_id, conversion_status | |
| strength, form, pack_size | as written/confirmed |
| match_method, match_confirmed_by, match_confirmed_at | |
| created_at, updated_at | |

- All fields are locked after finalization, except conversion resolution (Section 10.5).
- A line with fulfillment records cannot be deleted.

**match_candidate:** id, requisition_id, requisition_line_id (NULL for facility candidates), target_type (facility/item), target_id, score, rank, matching_method, signals (JSON), selected, created_at

**processing_job:** id, document_id, attempt, model_name, model_version, status, queued_at, processing_started_at, processing_completed_at, raw_output, error, created_by

## 31.6 Lifecycle and Fulfillment

**lifecycle_event** (INSERT only):

| Field | Notes |
|---|---|
| id, requisition_id | |
| stage | operational_stage |
| status | completed / not_applicable |
| not_applicable_reason | required when not_applicable |
| occurred_at | validated per Section 12.7 |
| recorded_at | DB default now(); immutable |
| recorded_by | |
| notes | |
| chronology_override, override_reason | Admin only; reason required when true |
| record_type | entry / correction / void |
| supersedes_id | unique; required for correction/void; NULL for entry |
| correction_reason | required for correction/void |
| edit_request_id | when made under an edit request |

**fulfillment_record** (INSERT only):

| Field | Notes |
|---|---|
| id, requisition_id | |
| requisition_line_id | NULL ⇔ additional_item_flag = true |
| item_id | item actually supplied |
| fulfillment_stage | invoiced / issued / delivered |
| quantity, unit | original; NULL only for void |
| base_quantity, base_unit, conversion_id, conversion_status | base_quantity NULL when unresolved |
| substitution_flag | true ⇔ line present and item_id ≠ line.item_id |
| additional_item_flag | |
| reference | invoice / pick-slip / waybill number |
| document_id | supporting evidence |
| occurred_at | not future; ≥ received_at |
| recorded_at | DB default now(); immutable |
| recorded_by, notes | |
| record_type, supersedes_id (unique), correction_reason | as for lifecycle_event |
| edit_request_id | when made under an edit request |

## 31.7 Control and Audit

**edit_request:**

| Field | Notes |
|---|---|
| id, requisition_id | |
| requested_by, requested_at | |
| reason | required |
| requested_changes | JSON list of {entity_type, entity_id, field, current_value, proposed_value} |
| status | edit_request_status |
| decided_by, decided_at | decided_by ≠ requested_by |
| decision | approved / rejected |
| rejection_reason | required when rejected |
| approval_expires_at | decided_at + edit window |
| used_at | when the authorized save succeeded |
| closed_at, closure_reason | used / expired / withdrawn / rejected |

**audit_event** (INSERT only): id, requisition_id (nullable), actor_user_id (nullable), actor_type, event_type, entity_type, entity_id, old_value (JSON), new_value (JSON), reason, edit_request_id, correlation_id, created_at

**system_setting:** key (PK), value (JSON), updated_by, updated_at. Every change is audited. Initial keys:

| Key | Default |
|---|---|
| `ofr_threshold_percent` | 80 |
| `ofr_threshold_stage` | issued |
| `edit_window_hours` | 24 |
| `edit_request_pending_timeout_days` | 7 |
| `signed_url_ttl_seconds` | 300 |
| `default_reporting_time_basis` | received_at |
| `business_timezone` | Africa/Lagos |

## 31.8 Database-Enforced Integrity Rules

The following MUST be enforced in PostgreSQL (constraints, triggers, privileges), not only in application code:

1. `requisition_number` unique; generated from `requisition_number_counter` in the creating transaction.
2. `requisition_number`, `entry_at`, `entry_date`, `entry_serial`, `first_validated_at` and `created_by` cannot be updated.
3. Header fields, lines and page programmes of a Finalized requisition cannot be changed except under a valid approved, unexpired, unused edit request covering the field, or the conversion-resolution exception (Section 10.5).
4. `lifecycle_event`, `fulfillment_record`, `requisition_document` and `audit_event` reject UPDATE and DELETE.
5. `supersedes_id` unique on `lifecycle_event` and `fulfillment_record`. Correction/void rows require `supersedes_id` and `correction_reason`. The superseded row belongs to the same requisition and has the same stage.
6. Lifecycle events with status not_applicable require `not_applicable_reason`. Stage `completed` cannot be not_applicable.
7. `occurred_at` ≤ now() on lifecycle events and fulfillment records. Chronology rules of Section 12.7 are checked in the recording transaction.
8. `fulfillment_record`: `requisition_line_id IS NULL` ⇔ `additional_item_flag`. `substitution_flag` ⇔ line present and item differs from the line's item.
9. `base_quantity` NULL ⇔ `conversion_status` ≠ resolved (for both lines and fulfillment records).
10. `edit_request.decided_by` ≠ `requested_by`. Rejected requests require `rejection_reason`.
11. `received_at` ≤ `entry_at`; `requisition_date` ≤ date(`received_at`).
12. A line referenced by fulfillment records cannot be deleted.

---

# 32. Infrastructure

## 32.1 Architecture

- **Frontend:** React + TypeScript PWA, hosted on Cloudflare Pages
- **API:** Python FastAPI
- **Server:** Oracle VM running FastAPI, background worker and PostgreSQL
- **Object storage:** Cloudflare R2 for original documents, evidence and backups

## 32.2 Containerization

The application is containerized with Docker for portability. Services: Frontend (build), API, Worker, PostgreSQL.

## 32.3 PostgreSQL

PostgreSQL is the primary database. It stores requisitions, master data, lifecycle events, fulfillment records, edit requests, audit events, users/roles/grants, settings and processing jobs.

The application connects with a least-privilege role that has no UPDATE/DELETE on append-only tables (Section 31.8).

## 32.4 Object Storage

Documents are stored in Cloudflare R2, never inside PostgreSQL. The database stores metadata and the object-storage key. Storage keys are not guessable, and buckets are private.

## 32.5 Backup

- Nightly PostgreSQL backup to Cloudflare R2.
- Weekly restore test.
- A written restoration procedure is maintained.
- Backups are protected from modification and deletion by the application's credentials.

---

# 33. Security and Data Protection

## 33.1 Security Controls

- HTTPS everywhere
- Authentication (external provider) and platform-controlled RBAC with explicit grants
- Least privilege, including the database role
- Database-enforced immutability of append-only tables
- Short-lived signed document URLs
- Input validation and file validation (type, size, checksum)
- Audit logging, including document downloads
- Backup protection

## 33.2 Data Protection

The platform takes into account applicable data-protection requirements, including the Nigeria Data Protection Act where relevant.

Personal data that may be processed:

- Staff names
- Phone numbers
- User information
- Facility personnel information visible on documents

Controls:

- Role-based access
- Least privilege
- Secure document storage
- Defined retention
- Controlled and audited downloads
- Audit logging

---

# 34. Data Lineage

Every major analytical value can be traced back to its source:

Facility OFR
→ Effective fulfillment records (with conversions and substitution equivalences applied)
→ Requisition lines (with original quantity/unit and conversion)
→ Finalized requisition
→ Raw OCR output
→ Original requisition document

Superseded records, conversion approvals, equivalence approvals and edit requests are all reachable from that chain through the audit log.

---

# 35. Performance and Offline

## 35.1 Performance

Search, opening a requisition, the facility and item pages and the dashboard are optimized for normal operational use. Analytics MAY use pre-computed aggregates, provided they are rebuilt from effective records and always agree with them.

Document processing is asynchronous (Section 14.2).

## 35.2 Offline

The application is architecturally compatible with future offline/PWA operation. The MVP assumes reliable internet connectivity. Offline synchronization is not part of the MVP.

---

# 36. Model Evaluation

OCR/extraction models are evaluated against real operational requisitions on:

- Handwriting recognition
- Medicine terminology
- Tables
- Quantities and units
- Facility names and item names
- Strength, form and pack size
- Page segmentation

Model selection considers accuracy, cost, latency, infrastructure requirements and reliability. The model name and version are recorded on every processing job.

---

# 37. Future mSupply Integration

A future integration may provide:

mSupply → Invoice / Pick Slip Export → Platform → Automatic Reconciliation → OFR / Variance Analytics

It could reconcile requested quantity against mSupply invoiced quantity, mSupply issued quantity and POD quantity, reducing manual capture.

Imported values would become fulfillment records with source = integration, subject to the same append-only, conversion, substitution and audit rules. The integration is an enhancement and does not change the core architecture.

---

# 38. Success Criteria

The platform is successful when the organization can reliably answer:

1. What requisitions were received?
2. When were they received?
3. When were they entered?
4. Who processed them?
5. What was requested?
6. What was invoiced?
7. What was issued?
8. What was delivered?
9. What was the OFR, and what share of lines does it cover?
10. Which facilities have poor fulfillment?
11. Which items have poor fulfillment?
12. Where does fulfillment drop?
13. How long does each lifecycle stage take?
14. How long does it take RAs to record operational events?
15. What evidence supports each stage?
16. What changed in a requisition?
17. Who changed it?
18. Why was it changed?
19. What is the historical performance of each facility?
20. What is the historical performance of each item?

## 38.1 Core Management Questions

Management should be able to move from:

"What happened?" → "Why did it happen?" → "Where is the bottleneck?" → "Which facilities/items/programmes are affected?" → "What evidence supports this conclusion?"

The platform therefore connects operational events, fulfillment data, audit records and historical performance.

---

# 39. Core Product Value

The platform creates a reliable digital audit trail between requisition and fulfillment.

It turns a fragmented process:

WhatsApp → Images → Manual Entry → Finance → Invoicing → Warehouse → Dispatch → Delivery

into a traceable digital lifecycle.

## 39.1 End-to-End Concept

1. Facility submits requisition
2. Requisition received (`received_at`)
3. Record created and numbered (`entry_at`); original document preserved — **Record Status: Draft**
4. OCR / vision extraction — **Processing**
5. Structured extraction, facility, item and programme matching — **Validation Pending**
6. RA review and validation — **Validated** (lifecycle stage Validated)
7. Finalization — **Finalized**; the record is now official and locked
8. Finance → Invoicing → Pick & Pack → Dispatched → Completed recorded as lifecycle events with evidence
9. Invoiced, issued and delivered quantities captured as fulfillment records — **Fulfillment Status: Partial**
10. Fulfillment closed — **Fulfillment Status: Closed**
11. OFR calculated; facility, item and programme histories updated
12. Analytics and audit trail available

## 39.2 Final Product Definition

The Requisition Lifecycle & Fulfillment Audit Platform is a digital audit and visibility layer that captures the complete journey of a healthcare requisition from original request through fulfillment.

It:

- preserves the original source document;
- turns it into structured, validated data;
- records every lifecycle event and its supporting evidence;
- captures requested versus invoiced versus issued versus delivered quantities;
- calculates Order Fulfillment Rate honestly, with line-level capping and coverage;
- maintains facility and item performance histories;
- provides searchable analytics and an immutable, append-only audit trail.

It complements the existing operational ERP/WMS rather than replacing it.

Its core purpose is to make the requisition lifecycle:

Traceable.

Measurable.

Searchable.

Auditable.

And ultimately actionable.
