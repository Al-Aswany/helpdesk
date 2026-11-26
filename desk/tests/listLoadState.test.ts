import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { listLoadState } from "../src/listLoadState.ts";

const EMPTY_TITLE = "No tickets found";

test("a clean list with no rows is empty", () => {
  assert.equal(
    listLoadState({ loading: false, error: null, rowCount: 0 }),
    "empty"
  );
});

test("rows stay on screen while a later request loads or fails", () => {
  assert.equal(
    listLoadState({ loading: true, error: null, rowCount: 3 }),
    "rows"
  );
  assert.equal(
    listLoadState({ loading: false, error: new Error("boom"), rowCount: 2 }),
    "rows"
  );
});

test("an API error with no rows is an error, never the empty title", () => {
  const state = listLoadState({
    loading: false,
    error: { exc_type: "CSRFTokenError", messages: ["Invalid Request"] },
    rowCount: 0,
  });
  assert.equal(state, "error");
  assert.notEqual(state, "empty");
  const title = state === "empty" ? EMPTY_TITLE : "Couldn't load tickets";
  assert.equal(title, "Couldn't load tickets");
  assert.notEqual(title, EMPTY_TITLE);
});

test("the first load shows a spinner instead of an empty or error state", () => {
  assert.equal(
    listLoadState({ loading: true, error: null, rowCount: 0 }),
    "loading"
  );
});

test("the tickets list renders a retry state instead of the empty title", () => {
  const list = readFileSync(
    new URL("../src/components/ListViewBuilder.vue", import.meta.url),
    "utf8"
  );
  const tickets = readFileSync(
    new URL("../src/pages/ticket/Tickets.vue", import.meta.url),
    "utf8"
  );
  const errorAt = list.indexOf("loadState === 'error'");
  const emptyAt = list.indexOf("loadState === 'empty'");
  assert.ok(errorAt > 0 && emptyAt > errorAt);
  assert.match(list, /listErrorCopy\.action/);
  assert.match(tickets, /Couldn't load tickets/);
  assert.match(tickets, /Retry/);

  const errorBlock = tickets.slice(
    tickets.indexOf("errorState"),
    tickets.indexOf("rowRoute")
  );
  assert.equal(errorBlock.includes(EMPTY_TITLE), false);
  assert.match(tickets, /No tickets found/);
});
