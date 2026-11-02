import { beforeEach, describe, expect, test } from "bun:test";
import { getInvoiceEditorSummary } from "../components/invoice/utils/summary-values";
import { useInvoiceEditorStore } from "./invoice-editor";

const historical = {
  id: "invoice-a",
  status: "unpaid",
  amount: 0.06,
  subtotal: 0.05,
  vat: 0.01,
  tax: 0.01,
  discount: 0,
  template: {
    currency: "USD",
    includeVat: true,
    includeTax: true,
    vatRate: 10,
    taxRate: 10,
  },
  lineItems: [{ price: 0.05, quantity: 1 }],
  noteDetails: "Original note",
};
const repriced = {
  ...historical,
  lineItems: [{ price: 0.1, quantity: 1 }],
  amount: 0.12,
  subtotal: 0.1,
};

function load(values = historical) {
  const store = useInvoiceEditorStore.getState();
  store.markReset(values);
  store.initialize(values);
  return store;
}

describe("acknowledged invoice editor financial snapshot", () => {
  beforeEach(() => {
    useInvoiceEditorStore.getState().reset();
  });

  test("source edit, successful save, then source revert uses the acknowledged invoice, not original history", () => {
    const store = load();
    const ticket = store.beginSave(historical.id)!;
    expect(store.acknowledgeSave(ticket, repriced)).toBe(true);
    store.setSnapshot(repriced, ticket);
    const latest = useInvoiceEditorStore.getState();
    const revert = getInvoiceEditorSummary(
      latest.financialSnapshot,
      historical,
    );
    expect(revert.preserveSnapshot).toBe(false);
    expect(revert.values.amount).toBe(0.07);
    expect(latest.hasChanged(historical)).toBe(true);
  });

  test("an ack cannot overwrite newer unsaved price or metadata edits", () => {
    const store = load();
    const submitted = JSON.stringify(repriced);
    const ticket = store.beginSave(historical.id)!;
    const newer = {
      ...repriced,
      lineItems: [{ price: 0.2, quantity: 1 }],
      noteDetails: "Newer unsaved note",
    };
    store.acknowledgeSave(ticket, repriced);
    store.setSnapshot(submitted, ticket);
    const latest = useInvoiceEditorStore.getState();
    expect(newer).toMatchObject({
      lineItems: [{ price: 0.2 }],
      noteDetails: "Newer unsaved note",
    });
    expect(latest.hasChanged(newer)).toBe(true);
    expect(
      getInvoiceEditorSummary(latest.financialSnapshot, newer).values.amount,
    ).toBe(0.24);
    expect(latest.snapshot).toBe(submitted);
  });

  test("draft success advances finances even while recurring-template failure leaves full save uncommitted", () => {
    const initial = { ...historical, amount: 0.07 };
    const store = load(initial);
    const ticket = store.beginSave(initial.id)!;
    store.acknowledgeSave(ticket, repriced);
    // No setSnapshot: only the draft succeeded, not its recurring-template save.
    const latest = useInvoiceEditorStore.getState();
    expect(latest.snapshot).toBe(JSON.stringify(initial));
    expect(latest.hasChanged(repriced)).toBe(true);
    // Even an exact return to the old serialized form now needs a DB save.
    expect(latest.hasChanged(initial)).toBe(true);
    expect(
      getInvoiceEditorSummary(latest.financialSnapshot, initial).values.amount,
    ).toBe(0.07);
  });

  test("late response after same-id reset, switch or close cannot mutate the new baseline or saved snapshot", () => {
    for (const action of ["reset", "switch", "close"] as const) {
      const store = load();
      const ticket = store.beginSave(historical.id)!;
      if (action === "close") store.reset();
      else
        store.markReset({
          ...historical,
          id: action === "switch" ? "invoice-b" : historical.id,
          amount: 0.09,
        });
      const before = useInvoiceEditorStore.getState().financialSnapshot;
      expect(store.acknowledgeSave(ticket, repriced)).toBe(false);
      store.setSnapshot(repriced, ticket);
      expect(useInvoiceEditorStore.getState().financialSnapshot).toEqual(
        before,
      );
      expect(useInvoiceEditorStore.getState().snapshot).toBe("");
    }
  });

  test("out-of-order or duplicate callbacks cannot roll back an already acknowledged request", () => {
    const store = load();
    const older = store.beginSave(historical.id)!;
    const newer = store.beginSave(historical.id)!;
    expect(store.acknowledgeSave(newer, repriced)).toBe(true);
    store.setSnapshot(repriced, newer);
    expect(store.acknowledgeSave(older, historical)).toBe(false);
    expect(store.acknowledgeSave(newer, historical)).toBe(false);
    store.setSnapshot(historical, older);
    expect(useInvoiceEditorStore.getState().financialSnapshot?.amount).toBe(
      0.12,
    );
    expect(useInvoiceEditorStore.getState().snapshot).toBe(
      JSON.stringify(repriced),
    );
  });

  test("stored source snapshots are copies, not mutable aliases into RHF or server response objects", () => {
    const mutable = {
      ...historical,
      template: { ...historical.template },
      lineItems: historical.lineItems.map((item) => ({ ...item })),
    };
    load(mutable);
    mutable.lineItems[0]!.price = 99;
    mutable.template.taxRate = 90;
    expect(useInvoiceEditorStore.getState().financialSnapshot).toMatchObject({
      lineItems: [{ price: 0.05 }],
      template: { taxRate: 10 },
    });
  });
});
