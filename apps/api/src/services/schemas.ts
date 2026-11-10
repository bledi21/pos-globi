import { z } from 'zod';

const money = z.union([z.number(), z.string()]).transform((v) => Number(v)).pipe(z.number().finite().nonnegative());
const positiveMoney = money.pipe(z.number().positive());

export const orderItemInput = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  qty: z.number().positive().max(10000),
  note: z.string().max(500).optional(),
  // Çmimi që terminali tregoi klientit (përdoret vetëm për porositë offline).
  unitPrice: money.optional(),
});

export const createOrderInput = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  shiftId: z.uuid().optional(),
  type: z.enum(['dine_in', 'takeaway', 'delivery']).default('dine_in'),
  tableLabel: z.string().max(50).optional(),
  customerName: z.string().max(200).optional(),
  customerPhone: z.string().max(50).optional(),
  deliveryAddress: z.string().max(500).optional(),
  note: z.string().max(500).optional(),
  clientCreatedAt: z.iso.datetime({ offset: true }).optional(),
  items: z.array(orderItemInput).max(200).default([]),
});

export const addItemsInput = z.object({ orderId: z.uuid(), items: z.array(orderItemInput).min(1).max(200) });

export const paymentInput = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  shiftId: z.uuid().optional(),
  method: z.enum(['cash', 'card', 'bank', 'driver_cash']),
  amount: positiveMoney,
});

export const cancelOrderInput = z.object({ orderId: z.uuid(), reason: z.string().min(3).max(500) });
export const discountInput = z.object({ orderId: z.uuid(), amount: money, reason: z.string().max(500).optional() });

export const openShiftInput = z.object({ id: z.uuid(), branchId: z.uuid(), openingCash: money.default(0) });
export const closeShiftInput = z.object({ shiftId: z.uuid(), countedCash: money });

export const expenseInput = z.object({
  id: z.uuid(), branchId: z.uuid(), shiftId: z.uuid().optional(),
  category: z.string().min(2).max(100), amount: positiveMoney,
  paidFromDrawer: z.boolean().default(true), note: z.string().max(500).optional(),
});

export const assignDriverInput = z.object({ orderId: z.uuid(), driverId: z.uuid() });
export const deliveryStatusInput = z.object({ orderId: z.uuid(), status: z.enum(['assigned', 'on_the_way', 'delivered', 'failed']) });
export const driverSettlementInput = z.object({ id: z.uuid(), branchId: z.uuid(), driverId: z.uuid(), shiftId: z.uuid().optional(), amount: positiveMoney });
export const kitchenStatusInput = z.object({ itemId: z.uuid(), status: z.enum(['preparing', 'ready', 'served']) });
