/**
 * The contract page's outcome line — where focus lands once the Sign card is
 * gone, never `<body>`. In a module of its own, NOT the `"use client"` card's:
 * a constant exported from a client module and read by a server component is
 * a client reference, not the string (AGENTS.md's standing trap).
 */
export const OUTCOME_ID = "portal-contract-outcome";
