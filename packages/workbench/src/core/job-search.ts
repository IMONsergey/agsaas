import type { Job } from "bullmq";

export type JobSearchQuery = {
  filters: Record<string, string>;
  text: string;
};

/**
 * Parse field:value filters without importing queues or opening Redis clients.
 * Quoted values may contain spaces; incomplete tokens remain searchable text.
 */
export function parseSearchQuery(query: string): JobSearchQuery {
  const filters: Record<string, string> = {};
  const textParts: string[] = [];
  const len = query.length;
  let i = 0;

  while (i < len) {
    while (i < len && query[i] === " ") i++;
    if (i >= len) break;

    let j = i;
    while (j < len && /\w/.test(query[j]!)) j++;

    if (j > i && j < len && query[j] === ":") {
      const field = query.slice(i, j);
      j++;

      let value: string;
      if (j < len && query[j] === '"') {
        j++;
        const closeQuote = query.indexOf('"', j);
        if (closeQuote !== -1) {
          value = query.slice(j, closeQuote);
          j = closeQuote + 1;
        } else {
          value = query.slice(j);
          j = len;
        }
      } else {
        const valueStart = j;
        while (j < len && query[j] !== " ") j++;
        value = query.slice(valueStart, j);
      }

      if (value) {
        filters[field] = value;
      } else {
        textParts.push(`${field}:`);
      }
      i = j;
    } else {
      const start = i;
      while (i < len && query[i] !== " ") i++;
      textParts.push(query.slice(start, i));
    }
  }

  return { filters, text: textParts.filter(Boolean).join(" ") };
}

export function matchesJobTags(
  data: unknown,
  filters: Record<string, string>,
): boolean {
  if (!data || typeof data !== "object") {
    return Object.keys(filters).length === 0;
  }

  const record = data as Record<string, unknown>;
  return Object.entries(filters).every(([field, value]) => {
    const jobValue = record[field];
    return (
      jobValue !== undefined &&
      jobValue !== null &&
      String(jobValue).toLowerCase().includes(value.toLowerCase())
    );
  });
}

export function searchableJobData(data: unknown): string {
  // Job data is normally JSON, but jobs without data must not abort a search.
  return JSON.stringify(data)?.toLowerCase() ?? "";
}

export function matchesJobText(
  job: Pick<Job, "id" | "name" | "data">,
  text: string,
): boolean {
  const lowerText = text.toLowerCase();
  return !!(
    job.id?.toLowerCase().includes(lowerText) ||
    job.name?.toLowerCase().includes(lowerText) ||
    searchableJobData(job.data).includes(lowerText)
  );
}
