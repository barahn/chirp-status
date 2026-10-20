// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// Servers that changed their id in Chirp's registry, and the id each one had
// before. The record a server earned is keyed by its id, so without this a
// rename would read as the old server vanishing and a new one appearing with
// no history at all.
//
// Chirp's network/servers.json says what a server is called now; it does not
// say what it used to be called, and a list fetched after the rename cannot.
// So a rename is declared here, by a pull request, and the monitor moves the
// record the next time it starts a round.
//
// A line stays after it has been applied. Applying it again does nothing —
// there is no longer anything under the old id — and the monitor is a single
// Durable Object that Cloudflare may replace at any time, so the line has to
// survive long enough for every replacement to have seen it. Deleting one is
// safe only once no storage anywhere still holds the old id.
//
// If `from` was probed again during the deployment window (before Chirp's
// registry updated to `to`), both ids have rows: the monitor merges `from`'s
// interim probes into `to` and drops `from`, keeping the record contiguous.

/** The renames, newest last: `from` is the id the record is under, `to` is the
 * id the registry lists now. */
export const RENAMES: readonly { from: string; to: string }[] = [
  // Fabrintek's node, named for its hypervisor and rack; renamed for the
  // nickname its host already answers to.
  { from: "pve-dc-01", to: "bradador-vector" },
];
