import type { ChatMessage, RoutineRunContext } from "./model.ts";

export function isRoutineRun(message: ChatMessage | null | undefined): message is ChatMessage & { context: RoutineRunContext };
export function parsePass(text: string): { quiet: true; summary: string } | { quiet: false };
export function routineRunText(context: RoutineRunContext, timeZone?: string): string;
export function mergedRoutineRunText(merged: { count: number; last: RoutineRunContext }, timeZone?: string): string;
export function groupQuietRuns(messages: ChatMessage[]): Array<{
  message: ChatMessage;
  hidden?: true;
  merged?: { count: number; last: RoutineRunContext };
}>;
