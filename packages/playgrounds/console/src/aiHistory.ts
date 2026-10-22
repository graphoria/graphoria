import { useSyncExternalStore } from "react";

import type { AiAnswerResponse } from "./client";

import { apiPost } from "./client";

export type AiEntry = {
  id: number;
  role: string;
  prompt: string;
  status: "pending" | "done" | "error" | "cancelled";
  answer?: AiAnswerResponse;
  error?: string;
  elapsedMs?: number;
};

// Module state, not component state: a question keeps running, and its card
// stays, while the operator is on another console page.
let entries: AiEntry[] = [];
let nextId = 1;
const controllers = new Map<number, AbortController>();
const listeners = new Set<() => void>();

const setEntries = (next: AiEntry[]) => {
  entries = next;
  for (const listener of listeners) listener();
};

const settle = (id: number, patch: Partial<AiEntry>) =>
  setEntries(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useAiHistory = () => useSyncExternalStore(subscribe, () => entries);

export const ask = async (role: string, prompt: string) => {
  const id = nextId++;
  const controller = new AbortController();
  controllers.set(id, controller);
  setEntries([{ id, role, prompt, status: "pending" }, ...entries]);

  const started = performance.now();
  try {
    const answer = await apiPost<AiAnswerResponse>("/ai", { prompt, role }, controller.signal);
    settle(id, { status: "done", answer, elapsedMs: performance.now() - started });
  } catch (error) {
    settle(id, {
      status: controller.signal.aborted ? "cancelled" : "error",
      error: (error as Error).message,
      elapsedMs: performance.now() - started,
    });
  } finally {
    controllers.delete(id);
  }
};

/** Stops waiting for the answer; the agent still finishes its run on the server. */
export const cancel = (id: number) => controllers.get(id)?.abort();

export const clearAiHistory = () => {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  setEntries([]);
};
