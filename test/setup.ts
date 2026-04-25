// Ledgix ALCV — Test Setup
// MSW server for HTTP mocking + shared test helpers

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

// ──────────────────────────────────────────────────────────────────────
// MSW Server
// ──────────────────────────────────────────────────────────────────────

export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

export { http, HttpResponse };
