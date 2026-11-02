import {
  hasInvoiceFinancialChanges,
  type InvoiceMoneyInput,
} from "@midday/invoice/calculate";
import { create } from "zustand";
import {
  captureInvoiceFinancialSnapshot,
  type InvoiceEditorSnapshot,
} from "../components/invoice/utils/summary-values";

export type InvoiceSaveTicket = {
  invoiceId: string;
  epoch: number;
  requestId: number;
};

interface InvoiceEditorState {
  /** Serialized snapshot of the fully hydrated form values */
  snapshot: string;

  /** Whether the snapshot has been captured after the last reset */
  initialized: boolean;
  invoiceId: string | null;
  epoch: number;
  nextRequestId: number;
  acknowledgedRequestId: number;
  financialSnapshot: InvoiceEditorSnapshot | undefined;

  /** Called after form.reset() — invalidates the current snapshot so the next
   *  debounce cycle captures a fresh baseline (after child effects settle). */
  markReset: (values: InvoiceEditorSnapshot) => void;

  /** Bind a save to one editor/reset generation, not just an invoice id. */
  beginSave: (invoiceId: string) => InvoiceSaveTicket | undefined;
  acknowledgeSave: (
    ticket: InvoiceSaveTicket,
    values: InvoiceEditorSnapshot,
  ) => boolean;

  /** Called on the first debounce after a reset — captures the fully hydrated
   *  form values (post-Summary, post-all child effects) as the baseline. */
  initialize: (values: unknown) => void;

  /** Capture a new snapshot after a successful save.
   *  Accepts either the form values object or a pre-serialized JSON string. */
  setSnapshot: (valuesOrSerialized: unknown, ticket: InvoiceSaveTicket) => void;

  /** Returns true if the current values differ from the snapshot.
   *  Returns false if not yet initialized (prevents saving during hydration). */
  hasChanged: (values: unknown) => boolean;

  /** Clear everything when the invoice sheet closes */
  reset: () => void;
}

export const useInvoiceEditorStore = create<InvoiceEditorState>()(
  (set, get) => ({
    snapshot: "",
    initialized: false,
    invoiceId: null,
    epoch: 0,
    nextRequestId: 0,
    acknowledgedRequestId: 0,
    financialSnapshot: undefined,

    markReset: (values) => {
      set({
        snapshot: "",
        initialized: false,
        invoiceId: values.id,
        epoch: get().epoch + 1,
        nextRequestId: 0,
        acknowledgedRequestId: 0,
        financialSnapshot: captureInvoiceFinancialSnapshot(values),
      });
    },

    beginSave: (invoiceId) => {
      const state = get();
      if (!state.initialized || state.invoiceId !== invoiceId) return undefined;
      const requestId = state.nextRequestId + 1;
      set({ nextRequestId: requestId });
      return { invoiceId, epoch: state.epoch, requestId };
    },

    acknowledgeSave: (ticket, values) => {
      const state = get();
      if (
        state.invoiceId !== ticket.invoiceId ||
        values.id !== ticket.invoiceId ||
        state.epoch !== ticket.epoch ||
        ticket.requestId <= state.acknowledgedRequestId
      )
        return false;
      set({
        financialSnapshot: captureInvoiceFinancialSnapshot(values),
        acknowledgedRequestId: ticket.requestId,
      });
      return true;
    },

    initialize: (values) => {
      set({ snapshot: JSON.stringify(values), initialized: true });
    },

    setSnapshot: (valuesOrSerialized, ticket) => {
      const state = get();
      if (
        state.invoiceId !== ticket.invoiceId ||
        state.epoch !== ticket.epoch ||
        state.acknowledgedRequestId !== ticket.requestId
      )
        return;
      set({
        snapshot:
          typeof valuesOrSerialized === "string"
            ? valuesOrSerialized
            : JSON.stringify(valuesOrSerialized),
      });
    },

    hasChanged: (values) => {
      const { snapshot, initialized, financialSnapshot } = get();
      if (!initialized) return false;
      // The draft may have committed while its recurring-template update failed.
      // Reverting to the old serialized form is still a financial edit relative
      // to the acknowledged invoice and must not be mistaken for a no-op.
      return (
        JSON.stringify(values) !== snapshot ||
        Boolean(
          financialSnapshot &&
            values &&
            typeof values === "object" &&
            hasInvoiceFinancialChanges(
              financialSnapshot,
              values as InvoiceMoneyInput,
            ),
        )
      );
    },

    reset: () => {
      set({
        snapshot: "",
        initialized: false,
        invoiceId: null,
        epoch: get().epoch + 1,
        nextRequestId: 0,
        acknowledgedRequestId: 0,
        financialSnapshot: undefined,
      });
    },
  }),
);
