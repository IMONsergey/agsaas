import {
  globalSearchSchema,
  searchAttachmentsSchema,
} from "@api/schemas/search";
import { createTRPCRouter, protectedProcedure } from "@api/trpc/init";
import {
  generateLLMFilters,
  isSearchAIConfigured,
} from "@api/utils/search-filters";
import {
  getInboxSearch,
  getInvoices,
  globalSearchQuery,
  globalSemanticSearchQuery,
} from "@midday/db/queries";

export const searchRouter = createTRPCRouter({
  global: protectedProcedure
    .input(globalSearchSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      const { searchTerm } = input;

      // AI is optional and only supplements multi-word queries with no local hits.
      const shouldUseLLMFilters =
        !!searchTerm &&
        searchTerm.trim().split(/\s+/).length > 1 &&
        isSearchAIConfigured();

      const results = await globalSearchQuery(db, {
        teamId: teamId!,
        ...input,
        searchTerm: searchTerm,
        // Preserve the existing assisted-search threshold only when its fallback
        // is available; ordinary local search keeps the caller's own threshold.
        relevanceThreshold: shouldUseLLMFilters
          ? 0.01
          : input.relevanceThreshold,
      });

      if (shouldUseLLMFilters && !results.length) {
        try {
          const filters = await generateLLMFilters(searchTerm);
          if (filters) {
            return await globalSemanticSearchQuery(db, {
              teamId: teamId!,
              itemsPerTableLimit: input.itemsPerTableLimit,
              ...filters,
            });
          }
        } catch {
          // The primary local query already succeeded. Optional AI enrichment
          // (including a generated filter rejected by SQL) must not break it.
        }
      }

      return results;
    }),

  attachments: protectedProcedure
    .input(searchAttachmentsSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      const { q, transactionId, limit = 30 } = input;

      const [inboxResults, invoiceResults] = await Promise.all([
        getInboxSearch(db, {
          teamId: teamId!,
          q: q ?? undefined,
          transactionId: transactionId ?? undefined,
          limit: limit,
        }),
        getInvoices(db, {
          teamId: teamId!,
          q: q ?? undefined,
          statuses: ["unpaid", "overdue", "paid"],
          pageSize: limit,
          sort: null,
        }),
      ]);

      // Transform inbox results
      const inboxItems =
        inboxResults.map((item) => ({
          type: "inbox" as const,
          id: item.id,
          fileName: item.fileName ?? null,
          filePath: item.filePath ?? [],
          displayName: item.displayName ?? null,
          amount: item.amount ?? null,
          currency: item.currency ?? null,
          contentType: item.contentType ?? null,
          date: item.date ?? null,
          size: item.size ?? null,
          description: item.description ?? null,
          status: item.status ?? null,
          website: item.website ?? null,
          baseAmount: item.baseAmount ?? null,
          baseCurrency: item.baseCurrency ?? null,
          taxAmount: item.taxAmount ?? null,
          taxRate: item.taxRate ?? null,
          taxType: item.taxType ?? null,
          createdAt: item.createdAt,
        })) ?? [];

      // Transform invoice results
      const invoices =
        invoiceResults.data.map((invoice) => ({
          type: "invoice" as const,
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber ?? null,
          customerName: invoice.customerName ?? null,
          amount: invoice.amount ?? null,
          currency: invoice.currency ?? null,
          filePath: invoice.filePath ?? [],
          dueDate: invoice.dueDate ?? null,
          status: invoice.status,
          size: invoice.fileSize ?? null,
          createdAt: invoice.createdAt,
        })) ?? [];

      // Combine and return results
      return [...inboxItems, ...invoices];
    }),
});
