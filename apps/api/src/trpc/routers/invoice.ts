import {
  cancelScheduledInvoiceSchema,
  createInvoiceSchema,
  deleteInvoiceSchema,
  draftInvoiceSchema,
  duplicateInvoiceSchema,
  getInvoiceByIdSchema,
  getInvoiceByTokenSchema,
  getInvoicesSchema,
  invoiceSummarySchema,
  remindInvoiceSchema,
  searchInvoiceNumberSchema,
  updateInvoiceSchema,
  updateScheduledInvoiceSchema,
} from "@api/schemas/invoice";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@api/trpc/init";
import { parseInputValue } from "@api/utils/parse";
import { UTCDate } from "@date-fns/utc";
import {
  allocateTrackerEntriesToInvoice,
  issueInvoice as persistInvoiceIssue,
  scheduleInvoice as persistInvoiceSchedule,
  cancelInvoiceSchedule as persistInvoiceScheduleCancel,
  getAverageDaysToPayment,
  getAverageInvoiceSize,
  getCustomerById,
  getInactiveClientsCount,
  getInvoiceById,
  getInvoiceSummary,
  getInvoices,
  getInvoiceTemplate,
  getMostActiveClient,
  getNewCustomersCount,
  getNextInvoiceNumber,
  getPaymentStatus,
  getPublishedInvoiceById,
  getTeamById,
  getTopRevenueClient,
  getTrackerProjectById,
  getUnbilledTrackerEntriesForInvoice,
  getUserById,
  deleteInvoice as persistInvoiceDelete,
  draftInvoice as persistInvoiceDraft,
  duplicateInvoice as persistInvoiceDuplicate,
  updateInvoiceWithIntent as persistInvoiceUpdate,
  searchInvoiceNumber,
} from "@midday/db/queries";
import { DEFAULT_TEMPLATE } from "@midday/invoice";
import {
  InvoiceAmountError,
  InvoiceFinancialStateError,
} from "@midday/invoice/calculate";
import { verify } from "@midday/invoice/token";
import { transformCustomerToContent } from "@midday/invoice/utils";
import { triggerJob } from "@midday/job-client";
import { TRPCError } from "@trpc/server";
import { addDays, format, parseISO } from "date-fns";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

// Use the shared default template from @midday/invoice
const defaultTemplate = DEFAULT_TEMPLATE;

function invoiceWriteError(error: unknown): never {
  if (
    error instanceof InvoiceAmountError ||
    error instanceof InvoiceFinancialStateError
  ) {
    throw new TRPCError({
      code: error instanceof InvoiceAmountError ? "BAD_REQUEST" : "CONFLICT",
      message: error.message,
      cause: error,
    });
  }
  throw error;
}

async function draftInvoice(...args: Parameters<typeof persistInvoiceDraft>) {
  try {
    return await persistInvoiceDraft(...args);
  } catch (error) {
    return invoiceWriteError(error);
  }
}

async function updateInvoice(...args: Parameters<typeof persistInvoiceUpdate>) {
  try {
    return await persistInvoiceUpdate(...args);
  } catch (error) {
    invoiceWriteError(error);
  }
}

async function issueInvoice(...args: Parameters<typeof persistInvoiceIssue>) {
  try {
    return await persistInvoiceIssue(...args);
  } catch (error) {
    return invoiceWriteError(error);
  }
}
async function scheduleInvoice(
  ...args: Parameters<typeof persistInvoiceSchedule>
) {
  try {
    return await persistInvoiceSchedule(...args);
  } catch (error) {
    return invoiceWriteError(error);
  }
}
async function cancelInvoiceSchedule(
  ...args: Parameters<typeof persistInvoiceScheduleCancel>
) {
  try {
    return await persistInvoiceScheduleCancel(...args);
  } catch (error) {
    return invoiceWriteError(error);
  }
}

async function deleteInvoice(...args: Parameters<typeof persistInvoiceDelete>) {
  try {
    return await persistInvoiceDelete(...args);
  } catch (error) {
    invoiceWriteError(error);
  }
}

async function duplicateInvoice(
  ...args: Parameters<typeof persistInvoiceDuplicate>
) {
  try {
    return await persistInvoiceDuplicate(...args);
  } catch (error) {
    return invoiceWriteError(error);
  }
}

export const invoiceRouter = createTRPCRouter({
  get: protectedProcedure
    .input(getInvoicesSchema.optional())
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getInvoices(db, {
        teamId: teamId!,
        ...input,
      });
    }),

  getById: protectedProcedure
    .input(getInvoiceByIdSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return getInvoiceById(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  getInvoiceByToken: publicProcedure
    .input(getInvoiceByTokenSchema)
    .query(async ({ input, ctx: { db } }) => {
      let id: string | undefined;

      try {
        const payload = (await verify(decodeURIComponent(input.token))) as {
          id?: string;
        };
        id = payload.id;
      } catch {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (!id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const invoice = await getPublishedInvoiceById(db, { id });
      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return { ...invoice, token: input.token };
    }),

  paymentStatus: protectedProcedure.query(async ({ ctx: { db, teamId } }) => {
    return getPaymentStatus(db, teamId!);
  }),

  searchInvoiceNumber: protectedProcedure
    .input(searchInvoiceNumberSchema)
    .query(async ({ input, ctx: { db, teamId } }) => {
      return searchInvoiceNumber(db, {
        teamId: teamId!,
        query: input.query,
      });
    }),

  invoiceSummary: protectedProcedure
    .input(invoiceSummarySchema.optional())
    .query(async ({ ctx: { db, teamId }, input }) => {
      return getInvoiceSummary(db, {
        teamId: teamId!,
        statuses: input?.statuses,
      });
    }),

  createFromTracker: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        dateFrom: z.string(),
        dateTo: z.string(),
      }),
    )
    .mutation(async ({ ctx: { db, teamId, session }, input }) => {
      const { projectId, dateFrom, dateTo } = input;

      // Get project data and tracker entries
      const [projectData, team, template, user] = await Promise.all([
        getTrackerProjectById(db, { id: projectId, teamId: teamId! }),
        getTeamById(db, teamId!),
        getInvoiceTemplate(db, teamId!),
        getUserById(db, session.user.id),
      ]);

      if (!projectData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "PROJECT_NOT_FOUND",
        });
      }

      const fullCustomer = projectData.customerId
        ? await getCustomerById(db, {
            id: projectData.customerId,
            teamId: teamId!,
          })
        : null;
      return db
        .transaction(async (tx) => {
          const allEntries = await getUnbilledTrackerEntriesForInvoice(tx, {
            teamId: teamId!,
            projectId,
            from: dateFrom,
            to: dateTo,
          });
          const hasHistoricalRate = allEntries.some(
            (entry) => (entry.rate ?? 0) > 0,
          );
          if (!projectData.billable && !hasHistoricalRate) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "PROJECT_NOT_BILLABLE",
            });
          }
          if (
            (!projectData.rate || projectData.rate <= 0) &&
            !hasHistoricalRate
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "PROJECT_NO_RATE",
            });
          }
          const rateGroups = new Map<
            string,
            { rate: number; currency: string; seconds: number }
          >();
          for (const entry of allEntries) {
            const rate = Number(entry.rate ?? projectData.rate ?? 0);
            const currency = (
              entry.currency ??
              projectData.currency ??
              team?.baseCurrency ??
              "USD"
            ).toUpperCase();
            if (rate <= 0 || !entry.duration) continue;
            const key = `${currency}/${rate}`;
            const group = rateGroups.get(key) ?? { rate, currency, seconds: 0 };
            group.seconds += entry.duration;
            rateGroups.set(key, group);
          }
          const groups = [...rateGroups.values()].filter(
            (group) => Math.round(group.seconds / 36) > 0,
          );
          if (groups.length === 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "NO_TRACKED_HOURS",
            });
          }
          if (new Set(groups.map((group) => group.currency)).size > 1) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This work spans multiple currencies. Select a period in one currency for each invoice.",
            });
          }

          const nextInvoiceNumber = await getNextInvoiceNumber(tx, teamId!);

          const invoiceId = uuidv4();
          const currency = groups[0]!.currency;
          const amount = groups.reduce(
            (total, group) =>
              total + (Math.round(group.seconds / 36) / 100) * group.rate,
            0,
          );

          // Get user's preferred date format
          const userDateFormat =
            template?.dateFormat ??
            user?.dateFormat ??
            defaultTemplate.dateFormat;

          // Format the date range for the line item description
          // Use parseISO to avoid timezone shifts when parsing date strings
          const formattedDateFrom = format(parseISO(dateFrom), userDateFormat);
          const formattedDateTo = format(parseISO(dateTo), userDateFormat);
          const dateRangeDescription = `${projectData.name} (${formattedDateFrom} - ${formattedDateTo})`;

          // Create draft invoice with tracker data
          const templateData = {
            ...defaultTemplate,
            ...(template
              ? Object.fromEntries(
                  Object.entries(template).map(([key, value]) => [
                    key,
                    value === null ? undefined : value,
                  ]),
                )
              : {}),
            // Project rates are denominated in the project currency. A default
            // invoice template must not relabel them as another currency.
            currency: currency.toUpperCase(),
            size: (template?.size === "a4" || template?.size === "letter"
              ? template.size
              : defaultTemplate.size) as "a4" | "letter",
            deliveryType: (template?.deliveryType === "create" ||
            template?.deliveryType === "create_and_send"
              ? template.deliveryType
              : defaultTemplate.deliveryType) as
              | "create"
              | "create_and_send"
              | undefined,
          };

          const invoiceData = {
            id: invoiceId,
            teamId: teamId!,
            userId: session.user.id,
            customerId: projectData.customerId,
            customerName: fullCustomer?.name,
            invoiceNumber: nextInvoiceNumber,
            currency: currency.toUpperCase(),
            amount,
            lineItems: groups.map((group) => ({
              name: dateRangeDescription,
              quantity: Math.round(group.seconds / 36) / 100,
              price: group.rate,
              vat: 0,
            })),
            issueDate: new Date().toISOString(),
            dueDate: addDays(
              new Date(),
              template?.paymentTermsDays ?? 30,
            ).toISOString(),
            template: templateData,
            fromDetails: (template?.fromDetails || null) as string | null,
            paymentDetails: (template?.paymentDetails || null) as string | null,
            customerDetails: fullCustomer
              ? JSON.stringify(transformCustomerToContent(fullCustomer))
              : null,
            noteDetails: null,
            topBlock: null,
            bottomBlock: null,
            vat: null,
            tax: null,
            discount: null,
            subtotal: null,
          };

          const saved = await draftInvoice(tx, invoiceData);
          const billedGroups = new Set(
            groups.map((group) => `${group.currency}/${group.rate}`),
          );
          const entryIds = allEntries
            .filter((entry) =>
              billedGroups.has(
                `${(entry.currency ?? currency).toUpperCase()}/${entry.rate ?? projectData.rate ?? 0}`,
              ),
            )
            .map((entry) => entry.id);
          await allocateTrackerEntriesToInvoice(tx, {
            teamId: teamId!,
            invoiceId,
            entryIds,
          });
          return saved;
        })
        .catch(invoiceWriteError);
    }),

  defaultSettings: protectedProcedure.query(
    async ({ ctx: { db, teamId, session, geo } }) => {
      // Fetch invoice number, template, and team details concurrently
      const [nextInvoiceNumber, template, team, user] = await Promise.all([
        getNextInvoiceNumber(db, teamId!),
        getInvoiceTemplate(db, teamId!),
        getTeamById(db, teamId!),
        getUserById(db, session.user.id),
      ]);

      const locale = user?.locale ?? geo?.locale ?? "en";
      const timezone = user?.timezone ?? geo?.timezone ?? "America/New_York";
      const currency =
        template?.currency ?? team?.baseCurrency ?? defaultTemplate.currency;
      const dateFormat =
        template?.dateFormat ?? user?.dateFormat ?? defaultTemplate.dateFormat;
      const logoUrl = template?.logoUrl ?? defaultTemplate.logoUrl;
      const countryCode = geo?.country ?? "US";

      // Default to letter size for US/CA, A4 for rest of world
      const size = ["US", "CA"].includes(countryCode) ? "letter" : "a4";

      // Default to include sales tax for countries where it's common
      const includeTax = ["US", "CA", "AU", "NZ", "SG", "MY", "IN"].includes(
        countryCode,
      );

      const savedTemplate = {
        id: template?.id,
        name: template?.name ?? "Default",
        isDefault: template?.isDefault ?? true,
        title: template?.title ?? defaultTemplate.title,
        logoUrl,
        currency,
        size: template?.size ?? defaultTemplate.size,
        includeTax: template?.includeTax ?? includeTax,
        includeVat: template?.includeVat ?? !includeTax,
        includeDiscount:
          template?.includeDiscount ?? defaultTemplate.includeDiscount,
        includeDecimals:
          template?.includeDecimals ?? defaultTemplate.includeDecimals,
        includeUnits: template?.includeUnits ?? defaultTemplate.includeUnits,
        includeQr: template?.includeQr ?? defaultTemplate.includeQr,
        includeLineItemTax:
          template?.includeLineItemTax ?? defaultTemplate.includeLineItemTax,
        lineItemTaxLabel:
          template?.lineItemTaxLabel ?? defaultTemplate.lineItemTaxLabel,
        includePdf: template?.includePdf ?? defaultTemplate.includePdf,
        sendCopy: template?.sendCopy ?? defaultTemplate.sendCopy,
        customerLabel: template?.customerLabel ?? defaultTemplate.customerLabel,
        fromLabel: template?.fromLabel ?? defaultTemplate.fromLabel,
        invoiceNoLabel:
          template?.invoiceNoLabel ?? defaultTemplate.invoiceNoLabel,
        subtotalLabel: template?.subtotalLabel ?? defaultTemplate.subtotalLabel,
        issueDateLabel:
          template?.issueDateLabel ?? defaultTemplate.issueDateLabel,
        totalSummaryLabel:
          template?.totalSummaryLabel ?? defaultTemplate.totalSummaryLabel,
        dueDateLabel: template?.dueDateLabel ?? defaultTemplate.dueDateLabel,
        discountLabel: template?.discountLabel ?? defaultTemplate.discountLabel,
        descriptionLabel:
          template?.descriptionLabel ?? defaultTemplate.descriptionLabel,
        priceLabel: template?.priceLabel ?? defaultTemplate.priceLabel,
        quantityLabel: template?.quantityLabel ?? defaultTemplate.quantityLabel,
        totalLabel: template?.totalLabel ?? defaultTemplate.totalLabel,
        vatLabel: template?.vatLabel ?? defaultTemplate.vatLabel,
        taxLabel: template?.taxLabel ?? defaultTemplate.taxLabel,
        paymentLabel: template?.paymentLabel ?? defaultTemplate.paymentLabel,
        noteLabel: template?.noteLabel ?? defaultTemplate.noteLabel,
        dateFormat,
        deliveryType: template?.deliveryType ?? defaultTemplate.deliveryType,
        taxRate: template?.taxRate ?? defaultTemplate.taxRate,
        vatRate: template?.vatRate ?? defaultTemplate.vatRate,
        fromDetails: template?.fromDetails ?? defaultTemplate.fromDetails,
        paymentDetails:
          template?.paymentDetails ?? defaultTemplate.paymentDetails,
        noteDetails: template?.noteDetails ?? defaultTemplate.noteDetails,
        timezone,
        locale,
        paymentEnabled:
          template?.paymentEnabled ?? defaultTemplate.paymentEnabled,
        paymentTermsDays: template?.paymentTermsDays ?? 30,
        emailSubject: template?.emailSubject ?? null,
        emailHeading: template?.emailHeading ?? null,
        emailBody: template?.emailBody ?? null,
        emailButtonText: template?.emailButtonText ?? null,
      };

      // Calculate due date based on payment terms (default 30 days)
      const paymentTermsDays = savedTemplate.paymentTermsDays ?? 30;

      return {
        // Default values first
        id: uuidv4(),
        currency,
        status: "draft",
        size,
        includeTax: savedTemplate?.includeTax ?? includeTax,
        includeVat: savedTemplate?.includeVat ?? !includeTax,
        includeDiscount: false,
        includeDecimals: false,
        includePdf: false,
        sendCopy: false,
        includeUnits: false,
        includeQr: true,
        invoiceNumber: nextInvoiceNumber,
        timezone,
        locale,
        fromDetails: savedTemplate.fromDetails,
        paymentDetails: savedTemplate.paymentDetails,
        customerDetails: undefined,
        noteDetails: savedTemplate.noteDetails,
        customerId: undefined,
        issueDate: new UTCDate().toISOString(),
        dueDate: addDays(new UTCDate(), paymentTermsDays).toISOString(),
        lineItems: [{ name: "", quantity: 0, price: 0, vat: 0 }],
        tax: undefined,
        token: undefined,
        discount: undefined,
        subtotal: undefined,
        topBlock: undefined,
        bottomBlock: undefined,
        amount: undefined,
        customerName: undefined,
        logoUrl: undefined,
        vat: undefined,
        template: savedTemplate,
      };
    },
  ),

  update: protectedProcedure
    .input(updateInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      return updateInvoice(db, {
        ...input,
        teamId: teamId!,
        userId: session.user.id,
      });
    }),

  delete: protectedProcedure
    .input(deleteInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      return deleteInvoice(db, {
        id: input.id,
        teamId: teamId!,
      });
    }),

  draft: protectedProcedure
    .input(draftInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      // Generate invoice number if not provided
      const invoiceNumber =
        input.invoiceNumber || (await getNextInvoiceNumber(db, teamId!));

      return draftInvoice(db, {
        ...input,
        invoiceNumber,
        teamId: teamId!,
        userId: session.user.id,
        paymentDetails: parseInputValue(input.paymentDetails),
        fromDetails: parseInputValue(input.fromDetails),
        customerDetails: parseInputValue(input.customerDetails),
        noteDetails: parseInputValue(input.noteDetails),
      });
    }),

  create: protectedProcedure
    .input(createInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId, session } }) => {
      const data =
        input.deliveryType === "scheduled"
          ? await scheduleInvoice(db, {
              id: input.id,
              teamId: teamId!,
              userId: session.user.id,
              scheduledAt: input.scheduledAt ?? "",
            })
          : await issueInvoice(db, {
              id: input.id,
              teamId: teamId!,
              userId: session.user.id,
              deliveryType: input.deliveryType,
            });
      if (!data)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      return data;
    }),

  remind: protectedProcedure
    .input(remindInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const invoice = await getInvoiceById(db, {
        id: input.id,
        teamId: teamId!,
      });
      if (!invoice)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      if (invoice.status !== "unpaid" && invoice.status !== "overdue") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only unpaid or overdue invoices can receive reminders",
        });
      }
      await triggerJob(
        "send-invoice-reminder",
        {
          invoiceId: input.id,
        },
        "invoices",
      );

      // Queue acceptance is not email acceptance. Only the delivery worker
      // records reminderSentAt, using the provider's accepted timestamp.
      return invoice;
    }),

  duplicate: protectedProcedure
    .input(duplicateInvoiceSchema)
    .mutation(async ({ input, ctx: { db, session, teamId } }) => {
      const nextInvoiceNumber = await getNextInvoiceNumber(db, teamId!);

      return duplicateInvoice(db, {
        id: input.id,
        userId: session.user.id,
        invoiceNumber: nextInvoiceNumber!,
        teamId: teamId!,
      });
    }),

  updateSchedule: protectedProcedure
    .input(updateScheduledInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const invoice = await scheduleInvoice(db, {
        id: input.id,
        teamId: teamId!,
        scheduledAt: input.scheduledAt,
        requireScheduled: true,
      });
      if (!invoice)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Scheduled invoice not found",
        });
      return invoice;
    }),

  cancelSchedule: protectedProcedure
    .input(cancelScheduledInvoiceSchema)
    .mutation(async ({ input, ctx: { db, teamId } }) => {
      const invoice = await cancelInvoiceSchedule(db, {
        id: input.id,
        teamId: teamId!,
      });
      if (!invoice)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Scheduled invoice not found",
        });
      return invoice;
    }),

  mostActiveClient: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      return getMostActiveClient(db, { teamId: teamId! });
    },
  ),

  inactiveClientsCount: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      return getInactiveClientsCount(db, { teamId: teamId! });
    },
  ),

  averageDaysToPayment: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      return getAverageDaysToPayment(db, { teamId: teamId! });
    },
  ),

  averageInvoiceSize: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      return getAverageInvoiceSize(db, { teamId: teamId! });
    },
  ),

  topRevenueClient: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      return getTopRevenueClient(db, { teamId: teamId! });
    },
  ),

  newCustomersCount: protectedProcedure.query(
    async ({ ctx: { db, teamId } }) => {
      return getNewCustomersCount(db, { teamId: teamId! });
    },
  ),
});
