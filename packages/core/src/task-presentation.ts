/** A compact label from the original request; the complete request remains available in details. */
export function taskTitle(prompt: string): string {
  return (prompt.split(/\r?\n/).find((line) => line.trim()) ?? "")
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1");
}
